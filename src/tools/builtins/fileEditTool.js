/**
 * Built-in tool: file_edit
 *
 * Phase 2A holistic refactor (2026-05-03): every fs read/write
 * happens through a SINGLE FileHandle (fh) opened with O_NOFOLLOW
 * right after the safety pre-check. See fileWriteTool.js for the
 * full flow rationale.
 */

import { unlink, lstat } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
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

const { O_RDWR, O_NOFOLLOW } = fsConstants;

let _postCommitHookForTests = null;
export function _setPostCommitHookForTests(hook) {
  _postCommitHookForTests = typeof hook === 'function' ? hook : null;
}

// Always read from offset 0 — fh.readFile() advances position so
// repeated calls would return empty. See fileWriteTool for rationale.
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
  name: 'FileEdit',
  description:
    'Replace an exact string in a file with new content. ' +
    'The old_string must match exactly (including whitespace/indentation). ' +
    'The user sees a confirmation dialog with the old/new diff preview before any disk write happens; ' +
    'a backup of the previous file is taken so the change can be rolled back. ' +
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

    if (!precheck.exists) {
      return {
        ok: false,
        output: `Cannot read file: ${absPath} does not exist.`,
        error: 'NOT_FOUND',
      };
    }

    const realPath = precheck.realPath;

    // ── 2. Open fh — sole gateway to the fs from here on ───────────────
    let fh;
    try {
      fh = await open(realPath, O_RDWR | O_NOFOLLOW);
    } catch (err) {
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
      if (err && err.code === 'ENOENT') {
        return {
          ok: false,
          output:
            `Target ${realPath} disappeared between precheck and open.`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, realPath, raceKind: 'enoent' },
        };
      }
      if (err && err.code === 'EISDIR') {
        return {
          ok: false,
          output: `${realPath} is a directory, not a file.`,
          error: 'TARGET_IS_DIR',
        };
      }
      return { ok: false, output: `Open error: ${err.message}`, error: err.message };
    }

    try {
      // ── 3. Read old via fh ───────────────────────────────────────────
      const oldBuffer = await readFromStart(fh);
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

      // ── 4. UI approval ───────────────────────────────────────────────
      const approved = await requestEdit({
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

      // ── 5. Commit ────────────────────────────────────────────────────
      await commitOperation(approved.operationToken, {
        expectedKinds: [OP_KIND.EDIT],
      });

      if (_postCommitHookForTests) {
        try { await _postCommitHookForTests({ realPath, lexicalPath: absPath }); } catch {}
      }

      // ── 5b. Inode anchor check ───────────────────────────────────────
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
            `between approval and edit — kernel-level race detected.`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, realPath, raceKind: 'symlink-eloop' },
        };
      }

      // ── 6. Stale check via fh ────────────────────────────────────────
      const currentBuffer = await readFromStart(fh);
      const currentOriginal = currentBuffer.toString('utf8');
      if (currentOriginal !== original) {
        throw Object.assign(new Error('stale-content'), { __staleContent: true });
      }

      // ── 7. Snapshot from the oldBuffer we already have ───────────────
      const snap = await snapshotBeforeWrite(realPath, {
        chatId,
        requestedBy: 'file_edit',
        reason: replace_all ? `edit ${count}×` : 'edit 1×',
        lexicalPath: absPath,
        preReadContent: oldBuffer,
      });

      // ── 8. Truncate + write via fh ───────────────────────────────────
      const writeBuf = Buffer.from(updated, 'utf8');
      await fh.truncate(0);
      await fh.write(writeBuf, 0, writeBuf.length, 0);

      // ── 9. recordAfterDiff ───────────────────────────────────────────
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
          backupOperationId: snap.operationId,
        },
      };
    } catch (err) {
      if (err && err.__staleContent) {
        return {
          ok: false,
          output:
            `File at ${realPath} changed between approval and edit — ` +
            `stale-content check failed. Re-run file_edit with the latest content.`,
          error: 'STALE_CONTENT',
          meta: { lexicalPath: absPath, realPath },
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
        output: `Edit error: ${err.message}`,
        error: err.message,
      };
    } finally {
      await fh.close().catch(() => {});
    }
  },
};
