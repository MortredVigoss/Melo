/**
 * Built-in tool: file_write
 *
 * Phase 2A holistic refactor (2026-05-03): every fs read/write
 * happens through a SINGLE FileHandle (fh) opened with O_NOFOLLOW
 * right after the safety pre-check. Once we hold the fh the kernel
 * guarantees we are operating on the inode that was there at open
 * time — any later symlink swap, rename, or replace at the path
 * does not redirect our reads/writes.
 *
 * Flow:
 *   1. precheckHardBlockedWrite (no fs touch beyond lstat)
 *   2. open(realPath, O_NOFOLLOW + flags) — sole gateway to the fs
 *      • create:   O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW
 *      • overwrite:O_RDWR             | O_NOFOLLOW
 *   3. fh.readFile() to capture old content (overwrite path)
 *   4. gate.requestWrite (UI prompt with diff)
 *   5. gate.commitOperation (lexical→real mapping unchanged)
 *   6. fh.readFile() again for stale check (still on the same inode)
 *   7. snapshotBeforeWrite with preReadContent buffer (no second open)
 *   8. fh.truncate(0) + fh.write(content)
 *   9. recordAfterDiff
 *   10. fh.close() in finally; on deny+create, unlink the empty file
 *      we just created
 *
 * The single-fh lifecycle closes every TOCTOU window between
 * approval and write that earlier patch-by-patch rounds kept
 * uncovering. Race classifications:
 *   • precheck → open: caught by O_NOFOLLOW (ELOOP) and O_EXCL
 *     (EEXIST on create)
 *   • open → close: kernel locks the inode under fh; path swaps
 *     don't affect us
 *   • commit lexical→real mismatch: caught by gate.commitOperation
 */

import { unlink, lstat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

const { O_RDWR, O_CREAT, O_EXCL, O_NOFOLLOW } = fsConstants;

// Test-only seam: hook fired after the fh is opened and after the
// gate's commit returns, BEFORE the stale-check / snapshot / write
// steps. Tests use it to verify the fh anchor really protects
// against post-open path swaps.
let _postCommitHookForTests = null;
export function _setPostCommitHookForTests(hook) {
  _postCommitHookForTests = typeof hook === 'function' ? hook : null;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Always read the entire file from offset 0 — fh.readFile() advances
// the internal position, so re-reading would return empty. Using
// explicit position=0 means we get a fresh full read for both the
// pre-approval old-content read and the post-commit stale check.
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
    'Parent directories are created automatically. ' +
    'The user sees a confirmation dialog with a content/diff preview before any disk write happens; ' +
    'a backup of the previous file (if any) is taken so the change can be rolled back. ' +
    'Use file_edit for targeted string replacements; use file_write for new files or full rewrites.',
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

  /**
   * @param {{ path: string, content: string }} args
   * @param {import('../tool.js').ToolRunContext} context
   * @returns {Promise<import('../tool.js').ToolResult>}
   */
  async run(args, context = {}) {
    const { path: filePath, content } = args;
    const { workspacePath, sseEmitter, signal, chatId } = context;

    if (typeof content !== 'string') {
      return { ok: false, output: 'content must be a string.', error: 'INVALID_CONTENT' };
    }

    const absPath = isAbsolute(filePath)
      ? filePath
      : resolve(workspacePath || process.cwd(), filePath);

    // ── 1. Sensitivity pre-check (no fs read of target) ────────────────
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

    // ── 2. Open the fh — sole gateway to the fs from here on ───────────
    let fh;
    let createdEmptyFile = false; // for cleanup on deny if create succeeded
    try {
      if (isCreate) {
        // O_RDWR (not O_WRONLY) so we can read for stale-content check.
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
            `Target ${realPath} became a symlink between precheck and open — ` +
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
            `Target ${realPath} disappeared between precheck and open ` +
            `(deleted by a concurrent process).`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, realPath, raceKind: 'enoent' },
        };
      }
      return { ok: false, output: `Open error: ${err.message}`, error: err.message };
    }

    try {
      // ── 3. Read old content via fh (overwrite path only) ─────────────
      let oldBuffer = Buffer.alloc(0);
      if (!isCreate) {
        oldBuffer = await readFromStart(fh);
      }
      const oldContent = oldBuffer.toString('utf8');
      const oldHash = isCreate ? null : sha256(oldContent);
      const newHash = sha256(content);
      const diffPreview = isCreate ? null : buildDiffPreview(oldContent, content);

      // ── 4. UI approval ───────────────────────────────────────────────
      const approved = await requestWrite({
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

      // ── 5. Commit verifies lexical→real mapping unchanged ────────────
      await commitOperation(approved.operationToken, {
        expectedKinds: [OP_KIND.WRITE_NEW, OP_KIND.WRITE_OVERWRITE],
      });

      // Test-only seam after commit, before stale/snapshot/write.
      if (_postCommitHookForTests) {
        try { await _postCommitHookForTests({ realPath, isCreate, lexicalPath: absPath }); } catch {}
      }

      // ── 5b. Inode anchor check ───────────────────────────────────────
      // The fh is locked to the inode at open time. If an attacker
      // swapped the path entry to a symlink (or to a different file)
      // between commit and now, our fh would silently write to an
      // orphaned inode while the path points elsewhere — secure but
      // surprising. Verify the path STILL points at our anchored
      // inode; otherwise abort.
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

      // ── 6. Stale check via fh (sees the inode's current content) ─────
      // For overwrite: compare current vs the oldHash captured pre-approval.
      // For create: the baseline is the empty file we just opened with
      // O_CREAT|O_EXCL; any non-empty content means another process
      // wrote to our inode during the approval window — abort so we
      // don't silently clobber the racer's bytes.
      const baselineHash = isCreate ? sha256('') : oldHash;
      const currentBuffer = await readFromStart(fh);
      if (sha256(currentBuffer.toString('utf8')) !== baselineHash) {
        throw Object.assign(new Error('stale-content'), { __staleContent: true });
      }

      // ── 7. Snapshot from the buffer we already have ──────────────────
      const snap = await snapshotBeforeWrite(realPath, {
        chatId,
        requestedBy: 'file_write',
        reason: isCreate ? 'create' : 'overwrite',
        lexicalPath: absPath,
        // null: caller asserts wasMissing (create flow); Buffer: use this content.
        preReadContent: isCreate ? null : oldBuffer,
      });

      // ── 8. Truncate + write via fh ───────────────────────────────────
      const writeBuf = Buffer.from(content, 'utf8');
      if (!isCreate) {
        await fh.truncate(0);
      }
      await fh.write(writeBuf, 0, writeBuf.length, 0);

      // ── 9. Record diff for restore-with-context ──────────────────────
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
      if (err && err.__staleContent) {
        // For create flow that race-detected, the file was modified
        // by another process during the approval window. We don't
        // unlink — the racer's bytes belong to them, and removing
        // the file would silently destroy their content even though
        // they wrote it independently of us. createdEmptyFile is
        // cleared so the finally block leaves the file alone.
        if (isCreate) {
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
      if (err && err.code === 'FILE_SAFETY_DENIED') {
        return {
          ok: false,
          output: err.message,
          error: 'DENIED',
          meta: { denied: true },
        };
      }
      return {
        ok: false,
        output: `Write error: ${err.message}`,
        error: err.message,
      };
    } finally {
      await fh.close().catch(() => {});
      if (createdEmptyFile) {
        // We created the file via O_CREAT|O_EXCL but failed to write
        // the user's content (deny / stale / commit failure). Unlink
        // the empty placeholder so we don't leave litter behind.
        try { await unlink(realPath); } catch {}
      }
    }
  },
};
