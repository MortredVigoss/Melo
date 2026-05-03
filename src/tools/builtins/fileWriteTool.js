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

import { writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve, dirname } from 'node:path';

import {
  requestWrite,
  commitOperation,
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

    // ── Read old content (if any) for diff + backup ────────────────────
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

    // ── Phase 1 backup BEFORE asking for approval ──────────────────────
    // We snapshot first so even if the user clicks Allow and then we
    // crash mid-write, the previous content is recoverable. The
    // snapshot is independent of the gate and can be purged on
    // restore success.
    let snap;
    try {
      snap = await snapshotBeforeWrite(absPath, {
        chatId,
        requestedBy: 'file_write',
        reason: isCreate ? 'create' : 'overwrite',
      });
    } catch (err) {
      return {
        ok: false,
        output: `Backup snapshot failed: ${err.message}`,
        error: 'SNAPSHOT_FAILED',
      };
    }

    // ── FileSafetyGate approval + atomic commit ────────────────────────
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

    // ── Actual write — to the commit-resolved real target ──────────────
    try {
      await mkdir(dirname(resolvedTarget), { recursive: true });
    } catch (err) {
      return { ok: false, output: `Cannot create directory: ${err.message}`, error: err.message };
    }

    try {
      await writeFile(resolvedTarget, content, 'utf8');
    } catch (err) {
      return { ok: false, output: `Write error: ${err.message}`, error: err.message };
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
