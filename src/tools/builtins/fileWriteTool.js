/**
 * Built-in tool: file_write
 *
 * Phase 2A holistic refactor (2026-05-03, post-Codex round 7+):
 * The flow is split into two phases so we never write to disk
 * before the user has approved the operation.
 *
 *   Pre-approval phase (zero target side-effect):
 *     1. precheckHardBlockedWrite (lstat-based, no read)
 *     2. for overwrite: briefly open(O_RDONLY|O_NOFOLLOW) → read →
 *        close. Captures oldHash + diff for the UI prompt. The
 *        target file isn't modified or created.
 *     3. requestWrite (UI prompt with diff)
 *     4. commitOperation (verifies lexical→real mapping unchanged)
 *
 *   Post-approval phase (the only writes):
 *     5. mkdir parent dirs (recursive, after approval)
 *     6. open(O_RDWR | (O_CREAT|O_EXCL)? | O_NOFOLLOW) — the inode
 *        we will write to. EEXIST (create raced), ELOOP (symlink
 *        race), ENOENT (deleted post-precheck) all surface as
 *        explicit error codes.
 *     7. inode anchor check: lstat(realPath).ino === fh.stat().ino
 *        (overwrite only — for create we just made the inode).
 *     8. stale check via readFromStart(fh) — for overwrite compare
 *        to oldHash; for create the baseline is sha256('') so a
 *        racer who wrote between commit and our open is detected.
 *     9. snapshot via preReadContent buffer (no second open).
 *    10. fh.truncate(0) + fh.write(content).
 *    11. recordAfterDiff. finally: fh.close + (createdEmptyFile &&
 *        !staleContentDetected) → unlink the empty placeholder.
 *
 * Race classification:
 *   • precheck → write-open: caught by O_NOFOLLOW (ELOOP) +
 *     O_EXCL (EEXIST on create) + inode-anchor (post-commit
 *     swap to a different regular file)
 *   • write-open → close: kernel locks the inode under fh; any
 *     path swap doesn't affect us
 *   • commit lexical→real mismatch: caught by gate.commitOperation
 *
 * Pending-approval invariant:
 *   • pending approval has zero target side-effect — no file
 *     created, no content modified, no directory mkdir'd
 *   • deny / timeout leave the disk untouched
 */

import { unlink, lstat, mkdir } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve, dirname } from 'node:path';

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

const { O_RDONLY, O_RDWR, O_CREAT, O_EXCL, O_NOFOLLOW } = fsConstants;

let _postCommitHookForTests = null;
export function _setPostCommitHookForTests(hook) {
  _postCommitHookForTests = typeof hook === 'function' ? hook : null;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// fh.readFile() advances position so re-reads return empty. This
// helper uses an explicit position=0 chunked read so both pre-
// approval and post-commit reads return the full file content.
async function readFromStart(fh) {
  const st = await fh.stat();
  if (st.size === 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(st.size);
  let total = 0;
  while (total < st.size) {
    const { bytesRead } = await fh.read(buf, total, st.size - total, total);
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

export const fileWriteTool = {
  id: 'file_write',
  name: 'FileWrite',
  description:
    'Create a new file or overwrite an existing file with the given content. ' +
    'Parent directories are created automatically (after the user approves the write). ' +
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

    const absPath = isAbsolute(filePath)
      ? filePath
      : resolve(workspacePath || process.cwd(), filePath);

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

    // ── 2. Pre-approval read (overwrite only — no fs side-effect) ─────
    // For overwrite, we briefly open O_RDONLY|O_NOFOLLOW just to
    // read the current content for the diff preview. The fh is
    // closed before the UI prompt. Create has nothing to read.
    let oldBuffer = Buffer.alloc(0);
    if (!isCreate) {
      let preFh;
      try {
        preFh = await open(realPath, O_RDONLY | O_NOFOLLOW);
      } catch (err) {
        if (err && err.code === 'ELOOP') {
          return {
            ok: false,
            output:
              `Target ${realPath} became a symlink between precheck and read — ` +
              `kernel refused via O_NOFOLLOW.`,
            error: 'COMMIT_FAILED',
            meta: { lexicalPath: absPath, realPath, raceKind: 'symlink-eloop' },
          };
        }
        if (err && err.code === 'ENOENT') {
          // Disappeared between precheck and read — flip to create.
          return {
            ok: false,
            output: `Target ${realPath} disappeared between precheck and read.`,
            error: 'COMMIT_FAILED',
            meta: { lexicalPath: absPath, realPath, raceKind: 'enoent' },
          };
        }
        if (err && err.code === 'EISDIR') {
          return {
            ok: false,
            output: `Refusing to overwrite directory ${realPath} with file content.`,
            error: 'TARGET_IS_DIR',
          };
        }
        return { ok: false, output: `Open error: ${err.message}`, error: err.message };
      }
      try {
        oldBuffer = await readFromStart(preFh);
      } finally {
        await preFh.close().catch(() => {});
      }
    }

    const oldContent = oldBuffer.toString('utf8');
    const oldHash = isCreate ? null : sha256(oldContent);
    const newHash = sha256(content);
    const diffPreview = isCreate ? null : buildDiffPreview(oldContent, content);

    // ── 3. UI approval — until this returns, ZERO disk side-effect ────
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

    // ── 4. Commit verifies lexical→real mapping unchanged ────────────
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

    // Test-only post-commit hook (race injection).
    if (_postCommitHookForTests) {
      try { await _postCommitHookForTests({ realPath, isCreate, lexicalPath: absPath }); } catch {}
    }

    // ── 5. Post-approval mkdir parents + open the write fh ────────────
    // Auto-create parent dirs as documented in the tool's
    // description. mkdir(recursive:true) with normal kernel
    // resolution; if a parent in the chain is a symlink that
    // somehow resolves to a sensitive path, the precheck ran
    // safeResolvePath earlier and already classified the leaf;
    // for sensitive-parent edge cases the gate's commit re-resolve
    // would have caught the path-mapping change. mkdir failure
    // surfaces as a clean error rather than a silent ENOENT later.
    try {
      await mkdir(dirname(realPath), { recursive: true });
    } catch (err) {
      return { ok: false, output: `Cannot create parent directory: ${err.message}`, error: err.message };
    }

    let fh;
    let createdEmptyFile = false;
    try {
      if (isCreate) {
        // O_RDWR (not O_WRONLY) so the stale-check below can read.
        fh = await open(realPath, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
        createdEmptyFile = true;
      } else {
        fh = await open(realPath, O_RDWR | O_NOFOLLOW);
      }
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        return {
          ok: false,
          output:
            `Target ${realPath} appeared between approval and write — ` +
            `re-run as overwrite or pick a different path.`,
          error: 'STALE_CONTENT',
          meta: { lexicalPath: absPath, realPath, raceKind: 'create-eexist' },
        };
      }
      if (err && err.code === 'ELOOP') {
        return {
          ok: false,
          output:
            `Target ${realPath} became a symlink between approval and write — ` +
            `kernel refused via O_NOFOLLOW.`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, realPath, raceKind: 'symlink-eloop' },
        };
      }
      if (err && err.code === 'EISDIR') {
        return {
          ok: false,
          output: `Refusing to overwrite directory ${realPath} with file content.`,
          error: 'TARGET_IS_DIR',
        };
      }
      if (err && err.code === 'ENOENT') {
        return {
          ok: false,
          output:
            `Target ${realPath} disappeared between approval and write ` +
            `(deleted by a concurrent process).`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, realPath, raceKind: 'enoent' },
        };
      }
      return { ok: false, output: `Open error: ${err.message}`, error: err.message };
    }

    let staleContentDetected = false;
    try {
      // ── 6. Inode anchor (overwrite only) ─────────────────────────────
      // Confirm the path STILL points at the inode we just opened.
      // Mismatch (or symlink at the path) means an attacker rm+
      // recreated the entry between commit and open; our fh now
      // refers to the OLD inode (orphaned) and writing through it
      // would silently lose the user's bytes. For create, the
      // inode is ours by construction (O_EXCL succeeded).
      if (!isCreate) {
        const fhStat = await fh.stat();
        const pathStat = await lstat(realPath).catch(() => null);
        if (
          !pathStat ||
          pathStat.isSymbolicLink() ||
          pathStat.ino !== fhStat.ino
        ) {
          return {
            ok: false,
            output:
              `Target ${realPath} was replaced (inode changed or now a symlink) ` +
              `between approval and write — kernel-level race detected.`,
            error: 'COMMIT_FAILED',
            meta: { lexicalPath: absPath, realPath, raceKind: 'symlink-eloop' },
          };
        }
      }

      // ── 7. Stale check via fh ────────────────────────────────────────
      // Overwrite: compare against the oldHash captured pre-approval.
      // Create: baseline is sha256('') — a racer who wrote to our
      // newly-created inode during the approval window flips this
      // to a non-empty hash and we abort.
      const baselineHash = isCreate ? sha256('') : oldHash;
      const currentBuffer = await readFromStart(fh);
      if (sha256(currentBuffer.toString('utf8')) !== baselineHash) {
        staleContentDetected = true;
        if (isCreate) {
          // Don't unlink — racer's bytes are at our inode.
          createdEmptyFile = false;
        }
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

      // ── 8. Snapshot from the buffer we already have ──────────────────
      const snap = await snapshotBeforeWrite(realPath, {
        chatId,
        requestedBy: 'file_write',
        reason: isCreate ? 'create' : 'overwrite',
        lexicalPath: absPath,
        preReadContent: isCreate ? null : oldBuffer,
      });

      // ── 9. Truncate + write via fh ───────────────────────────────────
      const writeBuf = Buffer.from(content, 'utf8');
      if (!isCreate) {
        await fh.truncate(0);
      }
      await fh.write(writeBuf, 0, writeBuf.length, 0);

      // ── 10. Record diff for restore-with-context ─────────────────────
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
        },
      };
    } catch (err) {
      return {
        ok: false,
        output: `Write error: ${err.message}`,
        error: err.message,
      };
    } finally {
      await fh.close().catch(() => {});
      if (createdEmptyFile && !staleContentDetected) {
        try { await unlink(realPath); } catch {}
      }
    }
  },
};
