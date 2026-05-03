/**
 * Built-in tool: file_move
 *
 * Phase 2A (2026-05-03): rename / move a file (or directory) through
 * the FileSafetyGate. Both the source and destination are vetted for
 * sensitivity (system / credential / $MELO_HOME) and the user sees a
 * confirmation dialog showing the lexical paths plus their realpaths.
 *
 * No-follow semantics (Codex C round 4): fs.rename operates on the
 * leaf directory entry, not the file the entry points to. We pass
 * the LEXICAL paths to fs.rename so that:
 *   - moving a workspace symlink moves the link entry itself, not
 *     the external file the link aliases
 *   - moving a regular file works as expected
 * resolvedSrc/resolvedDst from commit are kept only for return meta
 * (the gate's commit step already verified the lexical→real
 * mapping); no further fs op references them.
 *
 * Known limitation (Codex D Phase 2A round 5): there is no Node.js
 * exposure of `renameat2` with `AT_NO_AUTOMOUNT` / `RENAME_NOREPLACE`
 * style atomicity guards. If a parent directory of src or dst is
 * swapped to a symlink between commit and the actual rename
 * syscall, the rename will land at the new resolution. Mitigations
 * in place:
 *   - commit re-resolves both endpoints right before this fn runs
 *   - lstat dst rejects existing-symlink-dst before rename
 *   - the residual race is a microsecond-scale kernel-level window
 *     that requires an attacker already with write access to a
 *     parent directory — outside melo's threat model for desktop
 *     use, but worth surfacing.
 */

import { rename, lstat } from 'node:fs/promises';
import { isAbsolute, resolve, dirname } from 'node:path';

import {
  requestMove,
  commitOperation,
  precheckParentDir,
  assertParentDirUnchanged,
  OP_KIND,
} from '../../safety/fileSafetyGate.js';

export const fileMoveTool = {
  id: 'file_move',
  name: 'FileMove',
  description:
    'Rename a file (or directory) within the SAME parent directory. ' +
    'src and dst MUST share the same dirname; cross-directory moves are refused — ' +
    'use file_write at the destination + file_delete at the source for cross-dir moves. ' +
    'The user sees a confirmation dialog showing both paths and their realpaths; ' +
    'sensitive sources or destinations are hard-rejected. ' +
    'Leaf no-follow rename: a symlink at src moves the link itself, never the file the link points to. ' +
    'Existing symlink at dst is refused (use file_delete first).',
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
        description: 'Absolute or workspace-relative destination path. The destination parent directory MUST already exist (use file_mkdir to create missing parents one component at a time).',
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

    // Codex Phase 2A round 12 (2026-05-03): restrict to same-parent
    // renames. Cross-parent moves can't be safely defended without
    // renameat2's RENAME_NOREPLACE / dir-fd binding (not exposed by
    // Node), so we refuse them outright. Agents that need a true
    // cross-dir move can file_write at the destination + file_delete
    // the source — both go through individual safety prompts.
    if (dirname(absSrc) !== dirname(absDst)) {
      return {
        ok: false,
        output:
          `file_move only supports same-directory renames. ` +
          `src parent (${dirname(absSrc)}) and dst parent ` +
          `(${dirname(absDst)}) differ; use file_write+file_delete ` +
          `for cross-directory moves.`,
        error: 'CROSS_DIR_MOVE_REFUSED',
      };
    }

    // ── FileSafetyGate approval + atomic commit ────────────────────────
    // (Sensitivity check happens INSIDE requestMove — must run
    // before the parent-dir checks below so /etc/hosts / ~/.ssh
    // are reported as DENIED, not "PARENT_NOT_DIR".)
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

    // Codex Phase 2A round 10: parent-dir precheck happens after
    // sensitivity has been cleared. Source parent + destination
    // parent must both already exist (no auto-mkdir, no recursive
    // walk — Node has no openat to make recursive create safe).
    const srcParentPrecheck = await precheckParentDir(absSrc);
    if (!srcParentPrecheck.ok) {
      return {
        ok: false,
        output:
          `Cannot move from ${absSrc}: source parent directory ` +
          `${srcParentPrecheck.parent} ${srcParentPrecheck.error}.`,
        error: srcParentPrecheck.error,
      };
    }
    const dstParentPrecheck = await precheckParentDir(absDst);
    if (!dstParentPrecheck.ok) {
      return {
        ok: false,
        output:
          `Cannot move to ${absDst}: destination parent directory ` +
          `${dstParentPrecheck.parent} ${dstParentPrecheck.error}. ` +
          `Use file_mkdir to create the destination's parent first.`,
        error: dstParentPrecheck.error,
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

    // Re-verify both parent dirs right before the rename — race
    // detection per Phase 2A round 10.
    try {
      await assertParentDirUnchanged(absSrc, srcParentPrecheck.ino, srcParentPrecheck.dev);
      await assertParentDirUnchanged(absDst, dstParentPrecheck.ino, dstParentPrecheck.dev);
    } catch (err) {
      return {
        ok: false,
        output: err.message,
        error: 'COMMIT_FAILED',
        meta: { raceKind: 'parent-swap' },
      };
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
