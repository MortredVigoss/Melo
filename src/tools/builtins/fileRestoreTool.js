import { missingWorkspaceResult } from '../workspace.js';
/**
 * Built-in tool: file_restore
 *
 * The way back for file_delete. Until 2026-11-14 there was none: file_delete
 * told the model and the user that files "can be restored for at least 7
 * days", and the functions that restore (src/safety/trash.js) had no caller
 * outside their tests. Getting a file back meant digging through a hidden
 * folder by hand.
 *
 * Two actions:
 *   list     what can be restored from here
 *   restore  put every file of one delete operation back where it was
 *
 * "From here" is a boundary, not a convenience. The trash is one folder for
 * the whole Melo home, so a conversation only sees, and can only restore, an
 * operation that was made in this conversation or under its workspace.
 * Without that, any chat could read the file names another project deleted.
 *
 * A restore writes files, so it asks like a write does: every file goes
 * through the same FileSafetyGate.requestWrite as file_write (inside the
 * workspace silently, outside it with the user's approval). A file that is
 * back at its path already is left alone unless `overwrite` is true.
 *
 * Nothing here removes anything from the trash except a fully restored
 * operation (trash.js does that). Purging stays a decision for the user.
 */

import { isAbsolute, relative, sep } from 'node:path';

import { listTrash, restoreFromTrash } from '../../safety/trash.js';

const LIST_LIMIT = 40;
const PATHS_PER_ENTRY = 6;

/** Whether `entry` (a trash manifest) belongs to this conversation or its workspace. */
export function trashEntryInScope(entry, { chatId, workspacePath } = {}) {
  if (!entry || entry.restorable === false) return false;
  if (chatId && entry.chatId && entry.chatId === chatId) return true;
  return Boolean(workspacePath && entry.workspacePath && entry.workspacePath === workspacePath);
}

function displayPath(path, workspacePath) {
  if (!workspacePath || !isAbsolute(String(path))) return String(path);
  const inside = relative(workspacePath, String(path));
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside.split(sep).join('/') : String(path);
}

function describeEntry(entry, workspacePath) {
  const paths = (Array.isArray(entry.files) ? entry.files.map(file => file.originalPath) : entry.originalPaths || []).map(path => displayPath(path, workspacePath));
  const shown = paths.slice(0, PATHS_PER_ENTRY).join(', ') + (paths.length > PATHS_PER_ENTRY ? `, … (${paths.length - PATHS_PER_ENTRY} more)` : '');
  return `- operationId=${entry.operationId} · deleted ${entry.deletedAt} · ${paths.length} file(s): ${shown}${entry.reason ? ` · reason: ${entry.reason}` : ''}`;
}

export const fileRestoreTool = {
  id: 'file_restore',
  name: 'File Restore',
  description:
    'Bring back files that file_delete moved to the trash. ' +
    'action "list" shows what can be restored from this conversation: one line per delete operation with its operationId, when it happened and the original paths. ' +
    'action "restore" puts every file of one operation back at its original path; pass the operationId from "list" or from the file_delete result. ' +
    'A file that exists at its path again is left untouched unless overwrite is true (then it is replaced, with the user\'s approval where a write needs one). ' +
    'Only operations made in this conversation or under its workspace can be listed or restored. ' +
    'Nothing is ever removed from the trash by this tool except an operation that was restored completely.',
  category: 'filesystem',
  requiresPermission: true,
  permissionGate: 'file-safety', // listing prompts for nothing; a restore asks per file through the gate, like file_write.
  isConcurrencySafe: false,
  concurrency: args => args?.action === 'list',
  // Self-description (tools/tool.js).
  capability: 'writeFiles',
  needsWorkspace: true,
  uiModule: 'files',
  inputKeys: ['action', 'operationId'],
  parametersSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'restore'],
        description: '"list" to see what can be restored, "restore" to put one operation\'s files back.',
      },
      operationId: {
        type: 'string',
        description: 'For restore: the operationId shown by "list" or returned by file_delete.',
      },
      overwrite: {
        type: 'boolean',
        description: 'For restore: replace a file that exists at the original path again. Default false: such a file is skipped and reported.',
      },
    },
    required: ['action'],
  },
  examples: [
    { action: 'list' },
    { action: 'restore', operationId: '3f0c1d2e-5a6b-4c7d-8e9f-0a1b2c3d4e5f' },
  ],

  /**
   * @param {{ action: 'list'|'restore', operationId?: string, overwrite?: boolean }} args
   * @param {import('../tool.js').ToolRunContext} context
   * @returns {Promise<import('../tool.js').ToolResult>}
   */
  async run(args = {}, context = {}) {
    const { action, operationId } = args;
    const overwrite = args.overwrite === true;
    const { workspacePath, sseEmitter, signal, chatId } = context;

    if (!['list', 'restore'].includes(action)) {
      return { ok: false, output: 'action must be "list" or "restore".', error: 'INVALID_ACTION', meta: { executionStarted: false } };
    }
    const missingWorkspace = missingWorkspaceResult(workspacePath);
    if (missingWorkspace) return missingWorkspace;

    let entries;
    try {
      entries = (await listTrash()).filter(entry => trashEntryInScope(entry, { chatId, workspacePath }));
    } catch (err) {
      return { ok: false, output: `Could not read the trash: ${err.message}`, error: 'TRASH_UNREADABLE', meta: { executionStarted: false } };
    }

    if (action === 'list') {
      if (!entries.length) {
        return { ok: true, output: 'Nothing to restore: no file deleted in this conversation or under its workspace is in the trash.', meta: { count: 0, entries: [] } };
      }
      const shown = entries.slice(0, LIST_LIMIT);
      const more = entries.length > shown.length ? `\n… and ${entries.length - shown.length} older operation(s).` : '';
      return {
        ok: true,
        output: `${entries.length} delete operation(s) can be restored (newest first):\n${shown.map(entry => describeEntry(entry, workspacePath)).join('\n')}${more}`,
        meta: {
          count: entries.length,
          entries: shown.map(entry => ({ operationId: entry.operationId, deletedAt: entry.deletedAt, paths: (entry.files || []).map(file => file.originalPath) })),
        },
      };
    }

    if (typeof operationId !== 'string' || !operationId.trim()) {
      return { ok: false, output: 'restore needs the operationId of a delete operation (see action "list").', error: 'INVALID_OPERATION_ID', meta: { executionStarted: false } };
    }
    const target = entries.find(entry => entry.operationId === operationId.trim());
    if (!target) {
      // The same answer for "no such operation" and "not yours": an id from
      // another conversation must not be confirmed to exist.
      return { ok: false, output: `No delete operation ${operationId.trim()} can be restored from this conversation. Use action "list" to see the ones that can.`, error: 'NOT_FOUND', meta: { executionStarted: false } };
    }
    // A restore decided by the model always goes through the gate. The path
    // of restoreFromTrash without a UI skips it; that one is for a button the
    // user presses, and nothing here may reach it.
    if (!sseEmitter || !chatId) {
      return { ok: false, output: 'Restoring files needs a conversation that can ask for approval.', error: 'PERMISSION_NO_SURFACE', meta: { executionStarted: false, denied: true } };
    }

    let result;
    try {
      result = await restoreFromTrash(target.operationId, { sseEmitter, chatId, signal, workspacePath, overwrite });
    } catch (err) {
      const denied = ['FILE_SAFETY_DENIED', 'PERMISSION_NO_SURFACE'].includes(err.code);
      return {
        ok: false,
        output: `Restore did not complete: ${err.message} Files restored before this point stay restored; the operation is still in the trash and can be tried again.`,
        error: err.code === 'FILE_SAFETY_DENIED' ? 'DENIED' : err.code === 'PERMISSION_NO_SURFACE' ? err.code : 'RESTORE_FAILED',
        meta: { operationId: target.operationId, denied },
      };
    }

    const restored = result.restored.map(path => displayPath(path, workspacePath));
    const skipped = result.skipped.map(item => ({ path: displayPath(item.path, workspacePath), reason: item.reason }));
    const lines = [];
    if (restored.length) lines.push(`Restored ${restored.length} file(s): ${restored.join(', ')}.`);
    if (skipped.length) {
      lines.push(`Left untouched ${skipped.length} file(s) that exist at their path again: ${skipped.map(item => item.path).join(', ')}. ` +
        'Nothing was overwritten. The operation stays in the trash; call restore again with overwrite: true to replace them.');
    }
    if (!restored.length && !skipped.length) lines.push('The operation held no files.');
    return {
      // Skipping an existing file is the documented default, not a failure;
      // the call fails only when it restored nothing at all.
      ok: restored.length > 0 || skipped.length === 0,
      output: lines.join(' '),
      ...(restored.length === 0 && skipped.length > 0 ? { error: 'ALREADY_EXISTS' } : {}),
      meta: {
        operationId: target.operationId,
        restored: result.restored,
        skipped: result.skipped,
        fullyRestored: result.fullyRestored,
        path: result.restored[0] || null,
      },
    };
  },
};
