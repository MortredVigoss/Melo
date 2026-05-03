/**
 * Built-in tool: file_delete
 *
 * Phase 2A (2026-05-03): the ONLY way for an agent to delete files
 * in melo. Goes through the FileSafetyGate's two-stage approval
 * (intent confirmation + filename / "DELETE" string confirmation),
 * then moves the targets into the trash quarantine via
 * `safeDeleteToTrash`. Files can be restored from
 * `$MELO_HOME/.melo-trash/` for at least 7 days.
 *
 * Symlinks are deleted with no-follow semantics (the link itself
 * disappears, the file the link points to is never touched). See
 * src/safety/trash.js for the full lstat-based unlink contract.
 *
 * Phase 2D (TBD) will route destructive bash commands (rm / git
 * clean / find -delete) through this tool so every delete still
 * goes through the same two-stage approval. Until then, bashTool
 * has not been wired to bashRiskParser/requestBashOp.
 */

import { isAbsolute, resolve } from 'node:path';

import {
  requestDelete,
} from '../../safety/fileSafetyGate.js';
import { safeDeleteToTrash } from '../../safety/trash.js';

export const fileDeleteTool = {
  id: 'file_delete',
  name: 'FileDelete',
  description:
    'Move one or more files (or directories, or symlinks) into the trash quarantine. ' +
    'The user sees TWO confirmation dialogs: an intent prompt followed by a filename / "DELETE" string check. ' +
    'Files land in $MELO_HOME/.melo-trash/ and can be restored for at least 7 days. ' +
    'Sensitive paths (system, credential, $MELO_HOME) are hard-rejected. ' +
    'Symlinks are removed with no-follow semantics — the link disappears, never the target.',
  category: 'filesystem',
  requiresPermission: true,
  isConcurrencySafe: false,
  parametersSchema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Absolute or workspace-relative paths to delete. All paths must pass safety checks; any rejection aborts the entire batch.',
      },
      reason: {
        type: 'string',
        description: 'Optional human-readable reason shown in the approval dialog.',
      },
    },
    required: ['paths'],
  },
  examples: [
    {
      paths: ['build/old-output.txt'],
      reason: 'cleanup after migration',
    },
    {
      paths: ['tmp/a.log', 'tmp/b.log'],
    },
  ],

  /**
   * @param {{ paths: string[], reason?: string }} args
   * @param {import('../tool.js').ToolRunContext} context
   * @returns {Promise<import('../tool.js').ToolResult>}
   */
  async run(args, context = {}) {
    const { paths, reason } = args;
    const { workspacePath, sseEmitter, signal, chatId } = context;

    if (!Array.isArray(paths) || !paths.length) {
      return {
        ok: false,
        output: 'paths must be a non-empty array of strings.',
        error: 'INVALID_PATHS',
      };
    }

    const absPaths = paths.map(p =>
      isAbsolute(p) ? p : resolve(workspacePath || process.cwd(), p),
    );

    // ── FileSafetyGate two-stage approval ──────────────────────────────
    let approved;
    try {
      approved = await requestDelete({
        paths: absPaths,
        chatId,
        sseEmitter,
        signal,
        workspacePath,
        baseDir: workspacePath,
        reason: reason || null,
      });
    } catch (err) {
      return {
        ok: false,
        output: err.message,
        error: err.code === 'FILE_SAFETY_DENIED' ? 'DENIED' : 'GATE_ERROR',
        meta: { denied: err.code === 'FILE_SAFETY_DENIED' },
      };
    }

    // ── safeDeleteToTrash with the gate-issued tokens ──────────────────
    let result;
    try {
      result = await safeDeleteToTrash({
        operationTokens: approved.operationTokens,
        ctx: {
          chatId,
          requestedBy: 'file_delete',
          reason: reason || null,
          workspacePath,
        },
      });
    } catch (err) {
      return {
        ok: false,
        output: `Delete error: ${err.message}`,
        error: err.code === 'FILE_SAFETY_DENIED' ? 'DENIED' : 'DELETE_FAILED',
      };
    }

    const removedCount = result.removed.length;
    const failedCount = result.failed.length;
    const summary = failedCount === 0
      ? `Moved ${removedCount} item(s) to trash (operationId=${result.operationId}). Restorable from $MELO_HOME/.melo-trash/.`
      : `Moved ${removedCount} item(s) to trash; ${failedCount} unlink(s) failed.`;

    return {
      ok: failedCount === 0,
      output: summary,
      meta: {
        operationId: result.operationId,
        folderName: result.folderName,
        manifestPath: result.manifestPath,
        removed: result.removed,
        failed: result.failed,
      },
    };
  },
};
