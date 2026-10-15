import {missingWorkspaceResult} from '../workspace.js';
/**
 * Built-in tool: file_edit
 *
 * Round 13 architectural refactor (2026-05-03, post-Codex round 12 D):
 * Same dirfd-bound pattern as fileWriteTool — see that file's
 * header for the threat-model rationale. file_edit is always an
 * overwrite (no create branch), so the flow is simpler:
 *
 *   1. precheck (sensitivity)
 *   2. open parent dirfd briefly → record parent {dev, ino} for
 *      cross-check (catches "parent dir replaced" later)
 *   3. atomicOpenLeaf(parent, leaf, O_RDONLY) → read content +
 *      capture preReadInoIdent → close. Pre-approval; zero target
 *      mutation.
 *   4. compute diff, occurrence count, validate replacement
 *   5. requestEdit (UI) + commit (lexical→real verify)
 *   6. atomicOpenLeaf(parent, leaf, O_RDWR) → leafFd. Parent dirfd
 *      bound through the same call; cross-check parent {dev, ino}.
 *   7. inode anchor: leafStat ↔ preReadInoIdent
 *   8. stale check via readFromStartFd(leafFd) — content must
 *      match what we read pre-approval
 *   9. snapshot via preReadContent
 *  10. ftruncate + write via leafFd (bound to inode)
 *  11. post-write semantic check — same as write tool
 *  12. recordAfterDiff. closeFd in finally.
 */

import { readSync, writeSync, ftruncateSync, fstatSync, closeSync as closeFdSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import {
  requestEdit,
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
  atomicLstat,
  openParentDirFd,
  splitParentLeaf,
  C as DC,
} from '../../safety/dirfdOps.js';

let _postCommitHookForTests = null;
export function _setPostCommitHookForTests(hook) {
  _postCommitHookForTests = typeof hook === 'function' ? hook : null;
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

function fetchParentInoIdent(parentDir) {
  let dirfd;
  try { dirfd = openParentDirFd(parentDir); }
  catch (err) { return { ok: false, error: err }; }
  try {
    const st = fstatSync(dirfd);
    return { ok: true, dev: st.dev, ino: st.ino };
  } catch (err) {
    return { ok: false, error: err };
  } finally {
    try { closeFdSync(dirfd); } catch {}
  }
}

function buildEditDiffPreview(oldString, newString, count, replaceAll) {
  const oldLines = oldString.split('\n');
  const newLines = newString.split('\n');
  const head = replaceAll
    ? `replace_all: ${count} occurrence(s)`
    : `replace: 1 occurrence (file contains ${count})`;
  const out = [`# ${head}`];
  out.push('--- old_string');
  out.push(...oldLines.slice(0, 40));
  if (oldLines.length > 40) out.push(`... (${oldLines.length - 40} more lines)`);
  out.push('+++ new_string');
  out.push(...newLines.slice(0, 40));
  if (newLines.length > 40) out.push(`... (${newLines.length - 40} more lines)`);
  return out.join('\n');
}

export const fileEditTool = {
  id: 'file_edit',
  name: 'File Edit',
  description:
    'Replace an exact string in a file with new content. ' +
    'The old_string must match exactly (including whitespace/indentation). ' +
    'The user sees a confirmation dialog with the old/new diff preview; nothing is written before approval. ' +
    'A backup of the previous file is taken so the change can be rolled back. ' +
    'Use file_read first to confirm the exact text to replace.',
  category: 'filesystem',
  requiresPermission: true,
  isConcurrencySafe: false,
  parametersSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or workspace-relative path to the file.',
      },
      old_string: {
        type: 'string',
        description: 'Exact text to find and replace.',
      },
      new_string: {
        type: 'string',
        description: 'Text to substitute in place of old_string.',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace every occurrence of old_string instead of requiring a unique match. Useful for renaming variables/identifiers. Default: false.',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  examples: [
    {
      path: 'src/index.js',
      old_string: 'const foo = 1;',
      new_string: 'const foo = 2;',
    },
    {
      path: 'src/index.js',
      old_string: 'oldFunctionName',
      new_string: 'newFunctionName',
      replace_all: true,
    },
  ],

  async run(args, context = {}) {
    const { path: filePath, old_string, new_string, replace_all = false } = args;
    const { workspacePath, sseEmitter, signal, chatId } = context;

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
    if (!precheck.exists) {
      return {
        ok: false,
        output: `Cannot read file: ${absPath} does not exist.`,
        error: 'NOT_FOUND',
      };
    }

    const realPath = precheck.realPath;
    const [parentDir, leafName] = splitParentLeaf(realPath);

    // ── 2. Parent dirfd open (sanity + capture {dev,ino}) ────────────
    const parentIdent = fetchParentInoIdent(parentDir);
    if (!parentIdent.ok) {
      const err = parentIdent.error;
      if (err.code === 'ELOOP') {
        return { ok: false, output: `Parent ${parentDir} is a symlink.`, error: 'PARENT_NOT_DIR' };
      }
      if (err.code === 'ENOENT') {
        return { ok: false, output: `Parent ${parentDir} does not exist.`, error: 'PARENT_NOT_FOUND' };
      }
      return { ok: false, output: `Cannot open parent ${parentDir}: ${err.message}`, error: err.message };
    }
    const parentInoAtPrecheck = parentIdent.ino;
    const parentDevAtPrecheck = parentIdent.dev;

    // ── 3. Pre-approval read ──────────────────────────────────────────
    let oldBuffer;
    let preReadInoIdent;
    {
      let preLeaf;
      try {
        preLeaf = await atomicOpenLeaf(parentDir, leafName, DC.O_RDONLY);
      } catch (err) {
        if (err.code === 'ELOOP') {
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
          return { ok: false, output: `${realPath} is a directory, not a file.`, error: 'TARGET_IS_DIR' };
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

    const original = oldBuffer.toString('utf8');

    const count = original.split(old_string).length - 1;
    if (count === 0) {
      return {
        ok: false,
        output: `old_string not found in ${realPath}.\nMake sure to copy the exact text (including whitespace) from file_read output.`,
        error: 'NOT_FOUND',
      };
    }
    if (count > 1 && !replace_all) {
      return {
        ok: false,
        output: `old_string appears ${count} times in ${realPath}. Provide more surrounding context to make it unique, or set replace_all: true to replace all occurrences.`,
        error: 'AMBIGUOUS',
      };
    }

    const updated = replace_all
      ? original.split(old_string).join(new_string)
      : original.replace(old_string, new_string);

    const diffPreview = buildEditDiffPreview(old_string, new_string, count, replace_all);

    // ── 4. UI approval — until this returns, ZERO disk side-effect ────
    let approved;
    try {
      approved = await requestEdit({
        path: absPath,
        chatId,
        sseEmitter,
        signal,
        workspacePath,
        baseDir: workspacePath,
        oldString: old_string,
        newString: new_string,
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

    // ── 5. Commit ────────────────────────────────────────────────────
    try {
      await commitOperation(approved.operationToken, {
        expectedKinds: [OP_KIND.EDIT],
      });
    } catch (err) {
      return { ok: false, output: `Atomic commit failed: ${err.message}`, error: 'COMMIT_FAILED' };
    }

    if (_postCommitHookForTests) {
      try { await _postCommitHookForTests({ realPath, lexicalPath: absPath }); } catch {}
    }

    // ── 6. Post-approval atomicOpenLeaf — bind through parent dirfd ──
    let openLeaf;
    try {
      openLeaf = await atomicOpenLeaf(parentDir, leafName, DC.O_RDWR);
    } catch (err) {
      if (err.code === 'ELOOP') {
        return {
          ok: false,
          output: `Parent or leaf became a symlink between approval and edit — kernel refused via O_NOFOLLOW.`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, realPath, raceKind: 'symlink-eloop' },
        };
      }
      if (err.code === 'ENOENT') {
        return {
          ok: false,
          output: `Target ${realPath} disappeared between approval and edit.`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, realPath, raceKind: 'enoent' },
        };
      }
      if (err.code === 'EISDIR') {
        return { ok: false, output: `${realPath} is a directory, not a file.`, error: 'TARGET_IS_DIR' };
      }
      if (err.code === 'ENOTDIR') {
        return {
          ok: false,
          output: `Parent ${parentDir} stopped being a directory between approval and edit.`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, realPath, raceKind: 'parent-swap' },
        };
      }
      return { ok: false, output: `Open error: ${err.message}`, error: err.message };
    }

    const leafFd = openLeaf.leafFd;
    try {
      // ── 6b. Cross-check parent {dev, ino} matches precheck ──────────
      if (
        openLeaf.parentDev !== parentDevAtPrecheck ||
        openLeaf.parentIno !== parentInoAtPrecheck
      ) {
        return {
          ok: false,
          output: `Parent ${parentDir} was replaced (inode/device changed) between approval and edit.`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, realPath, raceKind: 'parent-swap' },
        };
      }

      // ── 7. Inode anchor: leafStat ↔ preReadInoIdent ─────────────────
      if (
        openLeaf.leafStat.ino !== preReadInoIdent.ino ||
        openLeaf.leafStat.dev !== preReadInoIdent.dev
      ) {
        return {
          ok: false,
          output:
            `Target ${realPath} was replaced (inode/device changed) ` +
            `between approval and edit — kernel-level race detected.`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, realPath, raceKind: 'inode-mismatch' },
        };
      }

      // ── 8. Stale check via leafFd ───────────────────────────────────
      const currentBuffer = readFromStartFd(leafFd);
      const currentOriginal = currentBuffer.toString('utf8');
      if (currentOriginal !== original) {
        return {
          ok: false,
          output:
            `File at ${realPath} changed between approval and edit — ` +
            `stale-content check failed. Re-run file_edit with the latest content.`,
          error: 'STALE_CONTENT',
          meta: { lexicalPath: absPath, realPath },
        };
      }

      // ── 9. Snapshot from oldBuffer ──────────────────────────────────
      const snap = await snapshotBeforeWrite(realPath, {
        chatId,
        requestedBy: 'file_edit',
        reason: replace_all ? `edit ${count}×` : 'edit 1×',
        lexicalPath: absPath,
        preReadContent: oldBuffer,
      });

      // ── 10. Truncate + write via leafFd ─────────────────────────────
      const writeBuf = Buffer.from(updated, 'utf8');
      ftruncateSync(leafFd, 0);
      writeSync(leafFd, writeBuf, 0, writeBuf.length, 0);

      // ── 10b. Post-write semantic check ──────────────────────────────
      // Round 13 follow-up #2 (Codex 🟡): atomicLstat throwing is
      // ALSO an orphan signal — don't silently report success.
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
            `Target ${realPath} was unlinked or replaced after edit completed ` +
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

      // ── 11. recordAfterDiff ─────────────────────────────────────────
      try { await recordAfterDiff(snap.operationId, diffPreview); } catch {}

      const oldLines = old_string.split('\n').length;
      const newLines = new_string.split('\n').length;
      const replaced = replace_all ? count : 1;

      return {
        ok: true,
        output: `Edited ${realPath} — replaced ${replaced} occurrence(s) of ${oldLines} line(s) with ${newLines} line(s).`,
        meta: {
          path: realPath,
          lexicalPath: absPath,
          oldLines,
          newLines,
          occurrencesReplaced: replaced,
          change: { kind: 'replacement', path: realPath, before: old_string.slice(0, 8000), after: new_string.slice(0, 8000), truncated: old_string.length > 8000 || new_string.length > 8000 },
          backupOperationId: snap.operationId,
        },
      };
    } catch (err) {
      return { ok: false, output: `Edit error: ${err.message}`, error: err.message };
    } finally {
      openLeaf.closeLeaf();
    }
  },
};
