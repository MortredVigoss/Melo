/**
 * Built-in tool: file_edit
 *
 * Replaces an exact string occurrence in a file.
 * Phase 2A (2026-05-03): every edit goes through the FileSafetyGate
 * — sensitivity rejected, symlink chain shown to the user, automatic
 * snapshot to `.melo-backups/<opId>/` before the actual writeFile,
 * and the post-write diff recorded for restore-with-context.
 */

import { readFile, writeFile, open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const { O_WRONLY, O_TRUNC, O_NOFOLLOW } = fsConstants;

// Test-only seam (Codex D Phase 2A round 5): post-commit hook
// fired AFTER commitOperation but BEFORE the actual fs write. Tests
// use it to inject a symlink swap to prove the O_NOFOLLOW kernel
// defence fires. No-op in production.
let _postCommitHookForTests = null;
export function _setPostCommitHookForTests(hook) {
  _postCommitHookForTests = typeof hook === 'function' ? hook : null;
}

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

  /**
   * @param {{ path: string, old_string: string, new_string: string, replace_all?: boolean }} args
   * @param {import('../tool.js').ToolRunContext} context
   * @returns {Promise<import('../tool.js').ToolResult>}
   */
  async run(args, context = {}) {
    const { path: filePath, old_string, new_string, replace_all = false } = args;
    const { workspacePath, sseEmitter, signal, chatId } = context;

    const absPath = isAbsolute(filePath)
      ? filePath
      : resolve(workspacePath || process.cwd(), filePath);

    // ── Sensitivity pre-check — Codex D Phase 2A round 1 (2026-05-03) ─
    // MUST run before any readFile / occurrence count / snapshot. A
    // sensitive path returns DENIED immediately so a probing edit
    // attempt against /etc/hosts or ~/.ssh/* never reads the file
    // and never leaks "old_string not found" / "ambiguous" signals
    // about the file's contents.
    const precheck = await precheckHardBlockedWrite(absPath);
    if (precheck.blocked) {
      return {
        ok: false,
        output: precheck.denyReason,
        error: 'DENIED',
        meta: { denied: true, category: precheck.category },
      };
    }

    let original;
    try {
      original = await readFile(absPath, 'utf8');
    } catch (err) {
      return { ok: false, output: `Cannot read file: ${err.message}`, error: err.message };
    }

    const count = original.split(old_string).length - 1;
    if (count === 0) {
      return {
        ok: false,
        output: `old_string not found in ${absPath}.\nMake sure to copy the exact text (including whitespace) from file_read output.`,
        error: 'NOT_FOUND',
      };
    }
    if (count > 1 && !replace_all) {
      return {
        ok: false,
        output: `old_string appears ${count} times in ${absPath}. Provide more surrounding context to make it unique, or set replace_all: true to replace all occurrences.`,
        error: 'AMBIGUOUS',
      };
    }

    const updated = replace_all
      ? original.split(old_string).join(new_string)
      : original.replace(old_string, new_string);

    const diffPreview = buildEditDiffPreview(old_string, new_string, count, replace_all);

    // ── FileSafetyGate approval + atomic commit ────────────────────────
    // snapshotBeforeWrite is intentionally AFTER approval (Codex D
    // round 1 fix) so a deny path leaves zero .melo-backups residue.
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

    let resolvedTarget;
    try {
      const committed = await commitOperation(approved.operationToken, {
        expectedKinds: [OP_KIND.EDIT],
      });
      resolvedTarget = committed.resolvedTarget;
    } catch (err) {
      return {
        ok: false,
        output: `Atomic commit failed: ${err.message}`,
        error: 'COMMIT_FAILED',
      };
    }

    // Test-only injection point: fired RIGHT AFTER commit, BEFORE
    // any post-commit fs read/write. Lets tests inject a symlink
    // swap so the stale check (and downstream snapshot/write) all
    // hit the kernel-level O_NOFOLLOW guard.
    if (_postCommitHookForTests) {
      try { await _postCommitHookForTests({ resolvedTarget, lexicalPath: absPath, phase: 'post-commit' }); } catch {}
    }

    // Codex D Phase 2A round 6 (2026-05-03): stale-content check is
    // fd-based with O_NOFOLLOW. Path-level readFile would have
    // followed a post-commit symlink swap and read the sensitive
    // target into memory before the later O_NOFOLLOW write caught it.
    let currentOriginal;
    let stalefh;
    try {
      stalefh = await open(resolvedTarget, fsConstants.O_RDONLY | O_NOFOLLOW);
    } catch (err) {
      if (err && err.code === 'ELOOP') {
        return {
          ok: false,
          output:
            `Target ${resolvedTarget} became a symlink between approval and stale-check — ` +
            `kernel refused via O_NOFOLLOW.`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, resolvedTarget, raceKind: 'symlink-eloop' },
        };
      }
      return {
        ok: false,
        output: `Cannot re-read target for stale-content check: ${err.message}`,
        error: 'COMMIT_FAILED',
      };
    }
    try {
      const buf = await stalefh.readFile();
      currentOriginal = buf.toString('utf8');
    } finally {
      await stalefh.close().catch(() => {});
    }
    if (currentOriginal !== original) {
      return {
        ok: false,
        output:
          `File at ${resolvedTarget} changed between approval and edit — ` +
          `stale-content check failed. Re-run file_edit with the latest content.`,
        error: 'STALE_CONTENT',
        meta: { lexicalPath: absPath, resolvedTarget },
      };
    }

    // Backup AFTER approval, BEFORE write — so deny leaves no entry.
    // Codex D round 2 (2026-05-03): snapshot uses the COMMIT-RESOLVED
    // realpath, not the lexical input. Closes commit→snapshot race
    // (see fileWriteTool for the full rationale).
    let snap;
    try {
      snap = await snapshotBeforeWrite(resolvedTarget, {
        chatId,
        requestedBy: 'file_edit',
        reason: replace_all ? `edit ${count}×` : 'edit 1×',
        lexicalPath: absPath,
      });
    } catch (err) {
      return {
        ok: false,
        output: `Backup snapshot failed: ${err.message}`,
        error: 'SNAPSHOT_FAILED',
      };
    }

    // Codex D Phase 2A round 5 (2026-05-03): O_NOFOLLOW. If the
    // target was swapped to a symlink between commit and now,
    // open() returns ELOOP and we surface COMMIT_FAILED rather
    // than writing through the new symlink.
    let fh;
    try {
      fh = await open(resolvedTarget, O_WRONLY | O_TRUNC | O_NOFOLLOW);
    } catch (err) {
      if (err && err.code === 'ELOOP') {
        return {
          ok: false,
          output:
            `Target ${resolvedTarget} became a symlink between approval and write — ` +
            `kernel refused via O_NOFOLLOW.`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, resolvedTarget, raceKind: 'symlink-eloop' },
        };
      }
      return { ok: false, output: `Open error: ${err.message}`, error: err.message };
    }
    try {
      await fh.writeFile(updated, 'utf8');
    } catch (err) {
      return { ok: false, output: `Write error: ${err.message}`, error: err.message };
    } finally {
      await fh.close().catch(() => {});
    }

    try { await recordAfterDiff(snap.operationId, diffPreview); } catch {}

    const oldLines = old_string.split('\n').length;
    const newLines = new_string.split('\n').length;
    const replaced = replace_all ? count : 1;

    return {
      ok: true,
      output: `Edited ${resolvedTarget} — replaced ${replaced} occurrence(s) of ${oldLines} line(s) with ${newLines} line(s).`,
      meta: {
        path: resolvedTarget,
        lexicalPath: absPath,
        oldLines,
        newLines,
        occurrencesReplaced: replaced,
        backupOperationId: snap.operationId,
      },
    };
  },
};
