/**
 * Built-in tool: file_write
 *
 * Creates a new file or completely overwrites an existing one.
 * Phase 2A (2026-05-03): every write goes through the FileSafetyGate
 * — sensitivity rejected, symlink chain shown to the user, automatic
 * snapshot to `.melo-backups/<opId>/` before the actual writeFile,
 * and the post-write diff recorded for restore-with-context.
 *
 * Use file_edit for targeted in-place edits; use file_write when:
 *   - Creating a file from scratch
 *   - The new content is entirely different from the original
 */

import { writeFile, mkdir, readFile, stat, open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve, dirname } from 'node:path';

const { O_WRONLY, O_CREAT, O_TRUNC, O_EXCL, O_NOFOLLOW } = fsConstants;

// Test-only seam (Codex D Phase 2A round 5): post-commit hook fired
// AFTER commitOperation but BEFORE the actual fs write. Tests use
// it to inject a symlink swap or competing create to prove the
// O_NOFOLLOW + O_EXCL kernel-level defences fire. No-op in
// production. Never call from production code.
let _postCommitHookForTests = null;
export function _setPostCommitHookForTests(hook) {
  _postCommitHookForTests = typeof hook === 'function' ? hook : null;
}

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

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Compact unified-diff-ish preview of the change. Not a real diff;
// the goal is to give the UI enough to render a side-by-side view
// without shipping a full diff library. Truncated to keep prompt
// payload small.
function buildDiffPreview(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const out = [];
  out.push(`--- old (${oldLines.length} lines, ${oldText.length} bytes)`);
  out.push(`+++ new (${newLines.length} lines, ${newText.length} bytes)`);
  // Show first 40 lines of each side so the UI has something concrete
  // for visual comparison; UI may render a real diff client-side.
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

    // ── Sensitivity pre-check — Codex D Phase 2A round 1 (2026-05-03) ─
    // MUST run before any stat / readFile / snapshot. A sensitive
    // path returns DENIED with zero fs touch — no content read into
    // memory, no backup folder created, no UI prompt.
    const precheck = await precheckHardBlockedWrite(absPath);
    if (precheck.blocked) {
      return {
        ok: false,
        output: precheck.denyReason,
        error: 'DENIED',
        meta: { denied: true, category: precheck.category },
      };
    }

    // ── Read old content (if any) for diff + backup ────────────────────
    // Safe to fs-touch now: precheck confirmed the path is non-sensitive.
    let oldContent = '';
    let isCreate = true;
    try {
      const st = await stat(absPath);
      if (st.isFile()) {
        oldContent = await readFile(absPath, 'utf8');
        isCreate = false;
      } else if (st.isDirectory()) {
        return {
          ok: false,
          output: `Refusing to overwrite directory ${absPath} with file content.`,
          error: 'TARGET_IS_DIR',
        };
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        return { ok: false, output: `Cannot stat target: ${err.message}`, error: err.message };
      }
      // ENOENT → it's a create; oldContent stays ''.
    }

    const oldHash = isCreate ? null : sha256(oldContent);
    const newHash = sha256(content);
    const diffPreview = isCreate ? null : buildDiffPreview(oldContent, content);

    // ── FileSafetyGate approval + atomic commit ────────────────────────
    // Note: snapshotBeforeWrite is now AFTER approval (was pre-approval
    // before round 1 — that left .melo-backups entries on deny).
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

    let resolvedTarget;
    try {
      const committed = await commitOperation(approved.operationToken, {
        expectedKinds: [OP_KIND.WRITE_NEW, OP_KIND.WRITE_OVERWRITE],
      });
      resolvedTarget = committed.resolvedTarget;
    } catch (err) {
      return {
        ok: false,
        output: `Atomic commit failed: ${err.message}`,
        error: 'COMMIT_FAILED',
      };
    }

    // Codex C Phase 2A round 4 (2026-05-03): stale-content check.
    // Between the moment we read oldContent (pre-approval) and now
    // (post-approval, post-commit), the user could have edited the
    // file in another window — silently overwriting their edit
    // would be data loss. For overwrite, re-read at the resolved
    // target and compare sha256(current) === oldHash; mismatch →
    // abort with STALE_CONTENT and let the agent re-prompt.
    if (!isCreate && oldHash) {
      let currentContent;
      try {
        currentContent = await readFile(resolvedTarget, 'utf8');
      } catch (err) {
        return {
          ok: false,
          output: `Cannot re-read target for stale-content check: ${err.message}`,
          error: 'COMMIT_FAILED',
        };
      }
      if (sha256(currentContent) !== oldHash) {
        return {
          ok: false,
          output:
            `File at ${resolvedTarget} changed between approval and write — ` +
            `stale-content check failed. Re-run file_write with the latest content.`,
          error: 'STALE_CONTENT',
          meta: { lexicalPath: absPath, resolvedTarget },
        };
      }
    }

    // ── Backup AFTER approval (Codex D round 1 fix), BEFORE write ──────
    // A user deny earlier short-circuited above with zero fs touch; we
    // only get here once the user has actively approved. We snapshot
    // here so a crash between the snapshot and the actual writeFile
    // still leaves a recoverable backup.
    //
    // Codex D round 2 (2026-05-03): snapshot uses the COMMIT-RESOLVED
    // realpath, not the lexical input. This closes the commit→snapshot
    // race window where a symlink swap could cause snapshot to copy a
    // sensitive file (e.g. /etc/hosts) into .melo-backups/. The
    // user-facing lexical path is recorded separately for UI display.
    let snap;
    try {
      snap = await snapshotBeforeWrite(resolvedTarget, {
        chatId,
        requestedBy: 'file_write',
        reason: isCreate ? 'create' : 'overwrite',
        lexicalPath: absPath,
      });
    } catch (err) {
      return {
        ok: false,
        output: `Backup snapshot failed: ${err.message}`,
        error: 'SNAPSHOT_FAILED',
      };
    }

    // ── Actual write — to the commit-resolved real target ──────────────
    try {
      await mkdir(dirname(resolvedTarget), { recursive: true });
    } catch (err) {
      return { ok: false, output: `Cannot create directory: ${err.message}`, error: err.message };
    }

    // Test-only injection point (post-commit, pre-write).
    if (_postCommitHookForTests) {
      try { await _postCommitHookForTests({ resolvedTarget, isCreate, lexicalPath: absPath }); } catch {}
    }

    // Codex D Phase 2A round 5 (2026-05-03): O_NOFOLLOW + O_EXCL.
    //   - O_NOFOLLOW: if the target was swapped to a symlink between
    //     commit and now (kernel-level race), open() returns ELOOP
    //     and we surface COMMIT_FAILED rather than writing through
    //     the new symlink to /etc/hosts / etc.
    //   - O_EXCL on the create flow: if the target appeared between
    //     approval and now (someone else created the file), open()
    //     returns EEXIST and we surface STALE_CONTENT rather than
    //     overwriting their content.
    const flags = isCreate
      ? O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW
      : O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW;
    let fh;
    try {
      fh = await open(resolvedTarget, flags, 0o644);
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        return {
          ok: false,
          output:
            `Target ${resolvedTarget} appeared between approval and write — ` +
            `re-run as overwrite or pick a different path.`,
          error: 'STALE_CONTENT',
          meta: { lexicalPath: absPath, resolvedTarget, raceKind: 'create-eexist' },
        };
      }
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
      await fh.writeFile(content, 'utf8');
    } catch (err) {
      return { ok: false, output: `Write error: ${err.message}`, error: err.message };
    } finally {
      await fh.close().catch(() => {});
    }

    // ── Record the diff for the backup so a future restore can
    // show "what this write changed" without re-reading the live file.
    if (!isCreate && diffPreview) {
      try { await recordAfterDiff(snap.operationId, diffPreview); } catch {}
    }

    const lineCount = content.split('\n').length;
    return {
      ok: true,
      output: `Written ${resolvedTarget} — ${lineCount} line(s), ${content.length} bytes.`,
      meta: {
        path: resolvedTarget,
        lexicalPath: absPath,
        lines: lineCount,
        bytes: content.length,
        backupOperationId: snap.operationId,
        wasCreate: isCreate,
      },
    };
  },
};
