/**
 * Built-in tool: file_move
 *
 * Phase 2A (2026-05-03): rename / move a file (or directory) through
 * the FileSafetyGate. Both the source and destination are vetted for
 * sensitivity (system / credential / $MELO_HOME) and the user sees a
 * confirmation dialog showing the lexical paths plus their realpaths.
 * The actual rename uses the commit-resolved real paths so a symlink
 * swap between approval and rename can't redirect the move at a
 * sensitive target.
 */

import { rename, mkdir } from 'node:fs/promises';
import { isAbsolute, resolve, dirname } from 'node:path';

import {
  requestMove,
  commitOperation,
  OP_KIND,
} from '../../safety/fileSafetyGate.js';

export const fileMoveTool = {
  id: 'file_move',
  name: 'FileMove',
  description:
    'Rename or move a file (or directory) from src to dst. ' +
    'The user sees a confirmation dialog showing both paths and their realpaths; ' +
    'sensitive sources or destinations are hard-rejected. ' +
    'Both ends of the move are TOCTOU-protected — a symlink swap between approval and rename aborts the operation.',
  category: 'filesystem',
  requiresPermission: true,
  isConcurrencySafe: false,
  parametersSchema: {
    type: 'object',
    properties: {
      src: {
        type: 'string',
        description: 'Absolute or workspace-relative source path.',
      },
      dst: {
        type: 'string',
        description: 'Absolute or workspace-relative destination path. Parent directories are created as needed.',
      },
    },
    required: ['src', 'dst'],
  },
  examples: [
    {
      src: 'old/foo.txt',
      dst: 'new/foo.txt',
    },
  ],

  /**
   * @param {{ src: string, dst: string }} args
   * @param {import('../tool.js').ToolRunContext} context
   * @returns {Promise<import('../tool.js').ToolResult>}
   */
  async run(args, context = {}) {
    const { src, dst } = args;
    const { workspacePath, sseEmitter, signal, chatId } = context;

    if (typeof src !== 'string' || typeof dst !== 'string' || !src || !dst) {
      return {
        ok: false,
        output: 'src and dst must be non-empty strings.',
        error: 'INVALID_ARGS',
      };
    }

    const absSrc = isAbsolute(src) ? src : resolve(workspacePath || process.cwd(), src);
    const absDst = isAbsolute(dst) ? dst : resolve(workspacePath || process.cwd(), dst);

    // ── FileSafetyGate approval + atomic commit ────────────────────────
    let approved;
    try {
      approved = await requestMove({
        src: absSrc,
        dst: absDst,
        chatId,
        sseEmitter,
        signal,
        workspacePath,
        baseDir: workspacePath,
      });
    } catch (err) {
      return {
        ok: false,
        output: err.message,
        error: err.code === 'FILE_SAFETY_DENIED' ? 'DENIED' : 'GATE_ERROR',
        meta: { denied: err.code === 'FILE_SAFETY_DENIED' },
      };
    }

    let resolvedSrc;
    let resolvedDst;
    try {
      const committed = await commitOperation(approved.operationToken, {
        expectedKinds: [OP_KIND.MOVE],
      });
      // requestMove binds [src, dst] in that order — see fileSafetyGate.js.
      [resolvedSrc, resolvedDst] = committed.resolvedTargets;
    } catch (err) {
      return {
        ok: false,
        output: `Atomic commit failed: ${err.message}`,
        error: 'COMMIT_FAILED',
      };
    }

    // Ensure destination parent exists.
    try {
      await mkdir(dirname(resolvedDst), { recursive: true });
    } catch (err) {
      return { ok: false, output: `Cannot create directory: ${err.message}`, error: err.message };
    }

    try {
      await rename(resolvedSrc, resolvedDst);
    } catch (err) {
      return { ok: false, output: `Move error: ${err.message}`, error: err.message };
    }

    return {
      ok: true,
      output: `Moved ${resolvedSrc} → ${resolvedDst}.`,
      meta: {
        src: resolvedSrc,
        dst: resolvedDst,
        lexicalSrc: absSrc,
        lexicalDst: absDst,
      },
    };
  },
};
