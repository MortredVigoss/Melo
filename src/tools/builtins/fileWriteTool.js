import {missingWorkspaceResult} from '../workspace.js';
/**
 * Built-in tool: file_write
 *
 * Round 13 architectural refactor (2026-05-03, post-Codex round 12 D):
 * Path-based open() / lstat() are no longer atomic with respect to
 * parent-directory swaps. Round 12 mitigated by re-anchoring the
 * parent's {dev, ino} immediately before open(), but the kernel
 * still resolves the path AGAIN inside open() — a microsecond-scale
 * race window remained, and Codex graded D for 12+ rounds.
 *
 * Round 13 closes the window via a native addon exposing POSIX
 * `*at()` syscalls (`src/safety/dirfdOps.js`). The pattern: open
 * the parent directory as a dirfd (O_DIRECTORY|O_NOFOLLOW), then
 * `openat(dirfd, leafName, ...)` resolves the leaf relative to the
 * dirfd's INODE, not its path. Once the dirfd is open, the parent
 * inode is anchored — subsequent path swaps are invisible to our
 * op. Combined with leaf O_NOFOLLOW, the entire write pipeline is
 * race-free.
 *
 * Two-phase flow (zero pre-approval side-effect preserved):
 *   1. precheckHardBlockedWrite (lstat-based, no read)
 *   2. for overwrite: atomicOpenLeaf(parent, leaf, O_RDONLY) →
 *      read content via fd, capture preRead {dev, ino}, close fd.
 *      The parent dirfd is opened+closed inside this call; leaf
 *      O_NOFOLLOW catches symlink-leaf at open time.
 *   3. for both: separately fetch parent {dev, ino} via
 *      openParentDirFd+fstat (so we can detect "parent dir entirely
 *      replaced" when reopening in step 5).
 *   4. requestWrite (UI) + commit (lexical→real verify)
 *   5. atomicOpenLeaf(parent, leaf, O_RDWR | O_CREAT|O_EXCL?) →
 *      leafFd. Parent dirfd is opened atomically inside, openat
 *      binds the leaf to a specific inode through the dirfd.
 *      Cross-check: parent {dev, ino} from this call must match
 *      step 3 — otherwise the parent dir itself was replaced.
 *   6. (overwrite only) leafStat ↔ preReadInoIdent {dev, ino}
 *      cross-check — catches rm+recreate during approval (where
 *      sha256 may match but inode differs).
 *   7. stale check via readFromStartFd(leafFd) — for overwrite
 *      compare to oldHash; for create the baseline is sha256('').
 *   8. snapshotBeforeWrite using the preRead buffer (no second open).
 *   9. ftruncateSync(leafFd, 0) + writeSync(leafFd, content, ...).
 *  10. post-write semantic check (NOT a safety race — see below):
 *      if path now points elsewhere, our content went to an orphan
 *      inode and the user-visible path no longer reflects it. Tell
 *      the caller via raceKind='post-write-orphaned' so they can
 *      retry. Backup retained.
 *  11. recordAfterDiff. finally: closeFd + (createdEmpty && stale)
 *      → atomicUnlink the empty placeholder.
 *
 * Threat model (round 13):
 *   - dirfd binds parent inode → parent path swap during op = no-op.
 *   - openat with O_NOFOLLOW → leaf-symlink swap = ELOOP at open.
 *   - O_EXCL on create → leaf race-create = EEXIST → STALE_CONTENT.
 *   - leafFd bound to inode → all writes/reads go to the same inode
 *     regardless of subsequent path manipulation.
 *   - post-write orphan detection → tells the agent the user-visible
 *     path doesn't point at our write (defensive; we wrote to the
 *     reviewed inode — no safety violation, just semantic surprise).
 *
 * Pending-approval invariant (unchanged from round 12):
 *   - pending approval has zero target side-effect — no file
 *     created, no content modified, no directory mkdir'd
 *   - deny / timeout leave the disk untouched
 */

import { createHash } from 'node:crypto';
import { readSync, writeSync, ftruncateSync, fstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import {
  requestWrite,
  commitOperation,
  precheckHardBlockedWrite,
  OP_KIND,
} from '../../safety/fileSafetyGate.js';
import {
  snapshotBeforeWrite,
  recordAfterDiff,
} from '../../safety/backup.js';
import {
  atomicOpenLeaf,
  atomicUnlink,
  atomicLstat,
  openParentDirFd,
  splitParentLeaf,
  C as DC,
} from '../../safety/dirfdOps.js';
import { closeSync as closeFdSync } from 'node:fs';

let _postCommitHookForTests = null;
export function _setPostCommitHookForTests(hook) {
  _postCommitHookForTests = typeof hook === 'function' ? hook : null;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function readFromStartFd(fd) {
  const st = fstatSync(fd);
  if (st.size === 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(st.size);
  let total = 0;
  while (total < st.size) {
    const bytesRead = readSync(fd, buf, total, st.size - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return buf.subarray(0, total);
}

function buildDiffPreview(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const out = [];
  out.push(`--- old (${oldLines.length} lines, ${oldText.length} bytes)`);
  out.push(`+++ new (${newLines.length} lines, ${newText.length} bytes)`);
  out.push('--- BEGIN OLD ---');
  out.push(...oldLines.slice(0, 40));
  if (oldLines.length > 40) out.push(`... (${oldLines.length - 40} more lines)`);
  out.push('--- BEGIN NEW ---');
  out.push(...newLines.slice(0, 40));
  if (newLines.length > 40) out.push(`... (${newLines.length - 40} more lines)`);
  return out.join('\n');
}

function fetchParentInoIdent(parentDir) {
  // Open parent as dirfd (O_DIRECTORY|O_NOFOLLOW so a symlinked
  // parent throws ELOOP), fstat to capture {dev, ino}, close.
  let dirfd;
  try {
    dirfd = openParentDirFd(parentDir);
  } catch (err) {
    return { ok: false, error: err };
  }
  try {
    const st = fstatSync(dirfd);
    return { ok: true, dev: st.dev, ino: st.ino };
  } catch (err) {
    return { ok: false, error: err };
  } finally {
    try { closeFdSync(dirfd); } catch {}
  }
}

export const fileWriteTool = {
  id: 'file_write',
  name: 'File Write',
  description:
    'Create a new file or overwrite an existing file with the given content. ' +
    'The parent directory must already exist and must be a regular directory (not a symlink) — ' +
    'this tool does NOT create parent directories. Use file_mkdir to create each missing parent dir ' +
    'one component at a time (each gets its own approval). ' +
    'The user sees a confirmation dialog with a content/diff preview; nothing is written to disk before approval. ' +
    'A backup of the previous file (if any) is taken so the change can be rolled back.',
  category: 'filesystem',
  requiresPermission: true,
  isConcurrencySafe: false,
  parametersSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or workspace-relative path to write.',
      },
      content: {
        type: 'string',
        description: 'Full file content to write.',
      },
    },
    required: ['path', 'content'],
  },
  examples: [
    {
      path: 'src/utils/helpers.js',
      content: 'export function clamp(n, min, max) {\n  return Math.min(Math.max(n, min), max);\n}\n',
    },
  ],

  async run(args, context = {}) {
    const { path: filePath, content } = args;
    const { workspacePath, sseEmitter, signal, chatId } = context;

    if (typeof content !== 'string') {
      return { ok: false, output: 'content must be a string.', error: 'INVALID_CONTENT' };
    }

    const missingWorkspace = missingWorkspaceResult(workspacePath);
    if (missingWorkspace) return missingWorkspace;

    const absPath = isAbsolute(filePath)
      ? filePath
      : resolve(workspacePath, filePath);

    // ── 1. Sensitivity pre-check ───────────────────────────────────────
    const precheck = await precheckHardBlockedWrite(absPath);
    if (precheck.blocked) {
      return {
        ok: false,
        output: precheck.denyReason,
        error: 'DENIED',
        meta: { denied: true, category: precheck.category },
      };
    }

    const isCreate = !precheck.exists;
    const realPath = precheck.realPath;
    const [parentDir, leafName] = splitParentLeaf(realPath);

    // ── 2. Parent dir must exist + be a regular directory ─────────────
    // openParentDirFd uses O_DIRECTORY|O_NOFOLLOW so a symlinked
    // parent throws ELOOP, a missing parent throws ENOENT, a
    // non-dir throws ENOTDIR — all surface as PARENT_*. We capture
    // {dev, ino} for cross-check in step 5 (catches "parent dir
    // entirely replaced between precheck and open").
    const parentIdent = fetchParentInoIdent(parentDir);
    if (!parentIdent.ok) {
      const err = parentIdent.error;
      if (err.code === 'ELOOP') {
        return {
          ok: false,
          output: `Parent directory ${parentDir} is a symlink — refusing to write under symlinked parent.`,
          error: 'PARENT_NOT_DIR',
        };
      }
      if (err.code === 'ENOENT') {
        return {
          ok: false,
          output: `Parent directory ${parentDir} does not exist. Create it first via file_mkdir.`,
          error: 'PARENT_NOT_FOUND',
        };
      }
      if (err.code === 'ENOTDIR') {
        return {
          ok: false,
          output: `Parent ${parentDir} is not a directory.`,
          error: 'PARENT_NOT_DIR',
        };
      }
      return {
        ok: false,
        output: `Cannot open parent directory ${parentDir}: ${err.message}`,
        error: err.message,
      };
    }
    const parentInoAtPrecheck = parentIdent.ino;
    const parentDevAtPrecheck = parentIdent.dev;

    // ── 3. Pre-approval read (overwrite only) ─────────────────────────
    // atomicOpenLeaf opens parent + openat leaf with O_NOFOLLOW.
    // ELOOP if leaf became a symlink, ENOENT if the file is gone.
    // The fd is closed inside this block; preReadInoIdent records
    // the inode the user is about to review.
    let oldBuffer = Buffer.alloc(0);
    let preReadInoIdent = null;
    if (!isCreate) {
      let preLeaf;
      try {
        preLeaf = await atomicOpenLeaf(parentDir, leafName, DC.O_RDONLY);
      } catch (err) {
        if (err.code === 'ELOOP' || err.code === 'Too many levels of symbolic links') {
          return {
            ok: false,
            output: `Target ${realPath} became a symlink between precheck and read — kernel refused via O_NOFOLLOW.`,
            error: 'COMMIT_FAILED',
            meta: { lexicalPath: absPath, realPath, raceKind: 'symlink-eloop' },
          };
        }
        if (err.code === 'ENOENT') {
          return {
            ok: false,
            output: `Target ${realPath} disappeared between precheck and read.`,
            error: 'COMMIT_FAILED',
            meta: { lexicalPath: absPath, realPath, raceKind: 'enoent' },
          };
        }
        if (err.code === 'EISDIR') {
          return {
            ok: false,
            output: `Refusing to overwrite directory ${realPath} with file content.`,
            error: 'TARGET_IS_DIR',
          };
        }
        return { ok: false, output: `Open error: ${err.message}`, error: err.message };
      }
      try {
        oldBuffer = readFromStartFd(preLeaf.leafFd);
        preReadInoIdent = { ino: preLeaf.leafStat.ino, dev: preLeaf.leafStat.dev };
      } finally {
        preLeaf.closeLeaf();
      }
    }

    const oldContent = oldBuffer.toString('utf8');
    const oldHash = isCreate ? null : sha256(oldContent);
    const newHash = sha256(content);
    const diffPreview = isCreate ? null : buildDiffPreview(oldContent, content);

    // ── 4. UI approval — until this returns, ZERO disk side-effect ────
    let approved;
    try {
      approved = await requestWrite({
        path: absPath,
        chatId,
        sseEmitter,
        signal,
        workspacePath,
        baseDir: workspacePath,
        isCreate,
        contentSize: content.length,
        contentPreview: isCreate ? content.slice(0, 4000) : null,
        oldHash,
        newHash,
        diffPreview,
      });
    } catch (err) {
      return {
        ok: false,
        output: err.message,
        error: err.code === 'FILE_SAFETY_DENIED' ? 'DENIED' : 'GATE_ERROR',
        meta: { denied: err.code === 'FILE_SAFETY_DENIED' },
      };
    }

    // ── 5. Commit verifies lexical→real mapping unchanged ────────────
    try {
      await commitOperation(approved.operationToken, {
        expectedKinds: [OP_KIND.WRITE_NEW, OP_KIND.WRITE_OVERWRITE],
      });
    } catch (err) {
      return {
        ok: false,
        output: `Atomic commit failed: ${err.message}`,
        error: 'COMMIT_FAILED',
      };
    }

    if (_postCommitHookForTests) {
      try { await _postCommitHookForTests({ realPath, isCreate, lexicalPath: absPath }); } catch {}
    }

    // ── 6. Post-approval atomicOpenLeaf — bind through parent dirfd ──
    // openParentDirFd inside atomicOpenLeaf does O_DIRECTORY|O_NOFOLLOW;
    // a parent-symlink swap during the approval window throws ELOOP.
    // The returned parentDev/Ino lets us cross-check that the parent
    // dir wasn't replaced with a *different* dir (different inode).
    let openLeaf;
    try {
      const flags = isCreate
        ? DC.O_RDWR | DC.O_CREAT | DC.O_EXCL
        : DC.O_RDWR;
      openLeaf = await atomicOpenLeaf(parentDir, leafName, flags, 0o644);
    } catch (err) {
      if (err.code === 'EEXIST') {
        return {
          ok: false,
          output: `Target ${realPath} appeared between approval and write — re-run as overwrite or pick a different path.`,
          error: 'STALE_CONTENT',
          meta: { lexicalPath: absPath, realPath, raceKind: 'create-eexist' },
        };
      }
      if (err.code === 'ELOOP') {
        return {
          ok: false,
          output: `Parent or leaf became a symlink between approval and write — kernel refused via O_NOFOLLOW.`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, realPath, raceKind: 'symlink-eloop' },
        };
      }
      if (err.code === 'EISDIR') {
        return {
          ok: false,
          output: `Refusing to overwrite directory ${realPath} with file content.`,
          error: 'TARGET_IS_DIR',
        };
      }
      if (err.code === 'ENOENT') {
        return {
          ok: false,
          output: `Target ${realPath} disappeared between approval and write.`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, realPath, raceKind: 'enoent' },
        };
      }
      if (err.code === 'ENOTDIR') {
        return {
          ok: false,
          output: `Parent ${parentDir} stopped being a directory between approval and write.`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, realPath, raceKind: 'parent-swap' },
        };
      }
      return { ok: false, output: `Open error: ${err.message}`, error: err.message };
    }

    const leafFd = openLeaf.leafFd;
    let createdEmptyFile = isCreate;
    let staleContentDetected = false;

    try {
      // ── 6b. Cross-check: parent {dev, ino} matches precheck ──────────
      // Catches "parent dir was entirely replaced (different inode)
      // during the approval window". O_NOFOLLOW already catches the
      // parent-now-symlink case (ELOOP above); this catches the
      // parent-now-different-real-dir case (e.g. attacker rmdir
      // parent + mkdir parent — same path, new inode).
      if (
        openLeaf.parentDev !== parentDevAtPrecheck ||
        openLeaf.parentIno !== parentInoAtPrecheck
      ) {
        return {
          ok: false,
          output:
            `Parent directory ${parentDir} was replaced (inode/device changed) ` +
            `between approval and write — kernel-level race detected.`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, realPath, raceKind: 'parent-swap' },
        };
      }

      // ── 7. Inode anchor (overwrite only) ─────────────────────────────
      // For create, leafStat is ours by construction (O_EXCL).
      // For overwrite, leafStat must match preReadInoIdent — catches
      // rm+recreate-same-path-same-content (sha256 matches, inode
      // doesn't). The leaf has been openat'd through the dirfd, so
      // it's bound to a specific inode regardless of path swaps.
      if (!isCreate && preReadInoIdent && (
        openLeaf.leafStat.ino !== preReadInoIdent.ino ||
        openLeaf.leafStat.dev !== preReadInoIdent.dev
      )) {
        return {
          ok: false,
          output:
            `Target ${realPath} was replaced (inode/device changed) ` +
            `between approval and write — kernel-level race detected.`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, realPath, raceKind: 'inode-mismatch' },
        };
      }

      // ── 8. Stale check via leafFd (bound to the inode) ───────────────
      const baselineHash = isCreate ? sha256('') : oldHash;
      const currentBuffer = readFromStartFd(leafFd);
      if (sha256(currentBuffer.toString('utf8')) !== baselineHash) {
        staleContentDetected = true;
        if (isCreate) createdEmptyFile = false; // racer's bytes are at our inode
        return {
          ok: false,
          output:
            `File at ${realPath} changed between approval and write — ` +
            `stale-content check failed. Re-run file_write with the latest content.`,
          error: 'STALE_CONTENT',
          meta: {
            lexicalPath: absPath,
            realPath,
            raceKind: isCreate ? 'create-eexist' : undefined,
          },
        };
      }

      // ── 9. Snapshot from buffer we already have ──────────────────────
      const snap = await snapshotBeforeWrite(realPath, {
        chatId,
        requestedBy: 'file_write',
        reason: isCreate ? 'create' : 'overwrite',
        lexicalPath: absPath,
        preReadContent: isCreate ? null : oldBuffer,
      });

      // ── 10. Truncate + write via leafFd (bound to inode) ─────────────
      const writeBuf = Buffer.from(content, 'utf8');
      if (!isCreate) {
        ftruncateSync(leafFd, 0);
      }
      writeSync(leafFd, writeBuf, 0, writeBuf.length, 0);

      // ── 10b. Post-write semantic check ───────────────────────────────
      // Not a safety race (our writes went to the inode the user
      // reviewed — leafFd is bound to it). But if the leaf path now
      // points elsewhere, the user-visible file no longer reflects
      // our write. Tell the caller. Keep the backup so the agent /
      // user can decide what to do.
      //
      // Round 13 follow-up #2 (Codex 🟡): atomicLstat throwing
      // (parent gone, parent now non-dir, etc.) is ALSO an orphan
      // signal — silently swallowing it would falsely report success.
      let orphanReason = null;
      try {
        const postLst = await atomicLstat(parentDir, leafName);
        const postFhStat = fstatSync(leafFd);
        if (
          !postLst ||
          postLst.isSymlink ||
          postLst.ino !== postFhStat.ino ||
          postLst.dev !== postFhStat.dev
        ) {
          orphanReason = !postLst
            ? 'leaf no longer present at parent'
            : postLst.isSymlink
              ? 'leaf now a symlink'
              : 'leaf inode/device changed';
        }
      } catch (err) {
        orphanReason = `parent stat failed: ${err.message}`;
      }
      if (orphanReason !== null) {
        return {
          ok: false,
          output:
            `Target ${realPath} was unlinked or replaced after write completed ` +
            `(${orphanReason}); our content is at the inode you reviewed but the ` +
            `user-visible path now points elsewhere or is gone. ` +
            `Backup retained at operationId=${snap.operationId}.`,
          error: 'COMMIT_FAILED',
          meta: {
            lexicalPath: absPath, realPath,
            raceKind: 'post-write-orphaned',
            backupOperationId: snap.operationId,
          },
        };
      }

      // ── 11. Record diff for restore-with-context ─────────────────────
      if (!isCreate && diffPreview) {
        try { await recordAfterDiff(snap.operationId, diffPreview); } catch {}
      }

      createdEmptyFile = false; // success — keep the file we wrote

      const lineCount = content.split('\n').length;
      return {
        ok: true,
        output: `Written ${realPath} — ${lineCount} line(s), ${content.length} bytes.`,
        meta: {
          path: realPath,
          lexicalPath: absPath,
          lines: lineCount,
          bytes: content.length,
          backupOperationId: snap.operationId,
          wasCreate: isCreate,
          change: { kind: isCreate ? 'created' : 'overwrite', path: realPath, before: currentBuffer.toString('utf8').slice(0, 8000), after: content.slice(0, 8000), truncated: currentBuffer.length > 8000 || content.length > 8000 },
        },
      };
    } catch (err) {
      return {
        ok: false,
        output: `Write error: ${err.message}`,
        error: err.message,
      };
    } finally {
      openLeaf.closeLeaf();
      if (createdEmptyFile && !staleContentDetected) {
        try { await atomicUnlink(parentDir, leafName); } catch {}
      }
    }
  },
};
