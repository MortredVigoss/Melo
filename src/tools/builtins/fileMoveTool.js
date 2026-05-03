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

import { rename, mkdir, lstat } from 'node:fs/promises';
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

    // Codex C Phase 2A round 4 (2026-05-03): no-follow rename. The
    // earlier cut passed the commit-resolved real paths to fs.rename;
    // when src was a symlink (e.g. workspace/link → outside/file),
    // that meant fs.rename moved the EXTERNAL FILE the link pointed
    // to, leaving a broken link behind. fs.rename actually does NOT
    // follow leaf symlinks (it operates on the directory entry), so
    // by passing the LEXICAL paths we get the right "move the link
    // itself" behaviour for symlink leafs and the same-as-resolved
    // behaviour for non-symlink leafs (the gate's commit step
    // already verified that the lexical→real mapping is what we
    // want). resolvedSrc/resolvedDst are kept only for return meta
    // / sensitivity classification.
    //
    // Defence: if dst already exists as a symlink, refuse to
    // overwrite it. fs.rename would silently replace the symlink
    // entry; the safer behaviour is to surface the conflict so the
    // user explicitly chooses to delete the old link first.
    let dstLst = null;
    try { dstLst = await lstat(absDst); } catch {}
    if (dstLst && dstLst.isSymbolicLink()) {
      return {
        ok: false,
        output:
          `Refusing to overwrite an existing symlink at destination ${absDst}. ` +
          `Delete the symlink first via file_delete and retry.`,
        error: 'DST_IS_SYMLINK',
      };
    }

    // Ensure destination parent exists.
    try {
      await mkdir(dirname(absDst), { recursive: true });
    } catch (err) {
      return { ok: false, output: `Cannot create directory: ${err.message}`, error: err.message };
    }

    try {
      await rename(absSrc, absDst);
    } catch (err) {
      return { ok: false, output: `Move error: ${err.message}`, error: err.message };
    }

    return {
      ok: true,
      output: `Moved ${absSrc} → ${absDst}.`,
      meta: {
        src: absSrc,
        dst: absDst,
        resolvedSrc,
        resolvedDst,
      },
    };
  },
};
