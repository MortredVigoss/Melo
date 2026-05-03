/**
 * Built-in tool: file_move
 *
 * Round 13 (2026-05-03, post-Codex round 12 D): re-enabled cross-dir
 * rename via the `renameat` syscall — it accepts two dirfds, so we
 * can atomically bind both source and destination parent dirs through
 * fd handles. Round 12's CROSS_DIR_MOVE_REFUSED is no longer needed.
 *
 * Atomic semantics:
 *   - openParentDirFd(srcParent) → srcDirfd (O_DIRECTORY|O_NOFOLLOW)
 *   - openParentDirFd(dstParent) → dstDirfd (or reuse srcDirfd if same)
 *   - renameat(srcDirfd, srcLeaf, dstDirfd, dstLeaf) — kernel resolves
 *     both leaves relative to dirfd inodes. Path swaps on either parent
 *     during/after this op cannot redirect the rename.
 *
 * No-follow leaf semantics: renameat (like rename) operates on the
 * directory entry, never the file the entry points to. Moving a
 * symlink moves the link, not the target file. (No O_NOFOLLOW
 * needed on rename — it's never a follow-the-leaf op.)
 *
 * Pre-existing-symlink dst: `atomicLstat(dstParent, dstLeaf)`
 * detects an existing symlink at dst and refuses (use file_delete
 * first); without this guard, renameat would silently replace the
 * link entry.
 */

import { isAbsolute, resolve } from 'node:path';

import {
  requestMove,
  commitOperation,
  OP_KIND,
} from '../../safety/fileSafetyGate.js';
import {
  openParentDirFd,
  atomicLstat,
  splitParentLeaf,
  _raw,
  C as DC,
} from '../../safety/dirfdOps.js';
import { closeSync as closeFdSync, fstatSync } from 'node:fs';

export const fileMoveTool = {
  id: 'file_move',
  name: 'FileMove',
  description:
    'Rename or move a file (or directory) atomically. Both src and dst parent directories ' +
    'must already exist. Cross-directory moves are supported (renameat binds both parents ' +
    'through dirfd handles, race-free). The user sees a confirmation dialog showing both ' +
    'paths and their realpaths; sensitive sources or destinations are hard-rejected. ' +
    'Leaf no-follow rename: a symlink at src moves the link itself, never the file the link ' +
    'points to. Existing symlink at dst is refused (use file_delete first).',
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
    { src: 'old/foo.txt', dst: 'new/foo.txt' },
    { src: 'tmp.json', dst: 'data/snapshot.json' },
  ],

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

    // Sensitivity check happens INSIDE requestMove — that runs before
    // the parent-dir checks so /etc/hosts / ~/.ssh report DENIED.
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
      [resolvedSrc, resolvedDst] = committed.resolvedTargets;
    } catch (err) {
      return {
        ok: false,
        output: `Atomic commit failed: ${err.message}`,
        error: 'COMMIT_FAILED',
      };
    }

    // Use LEXICAL paths for the rename so leaf-symlink semantics
    // are preserved (move-the-link, not move-the-target).
    const [srcParent, srcLeaf] = splitParentLeaf(absSrc);
    const [dstParent, dstLeaf] = splitParentLeaf(absDst);

    // ── Open parent dirfds atomically ─────────────────────────────────
    let srcFd = -1;
    let dstFd = -1;
    let srcParentDev, srcParentIno, dstParentDev, dstParentIno;
    try {
      try {
        srcFd = openParentDirFd(srcParent);
      } catch (err) {
        if (err.code === 'ENOENT') {
          return {
            ok: false,
            output: `Source parent ${srcParent} does not exist.`,
            error: 'PARENT_NOT_FOUND',
          };
        }
        if (err.code === 'ELOOP') {
          return {
            ok: false,
            output: `Source parent ${srcParent} is a symlink — refusing.`,
            error: 'PARENT_NOT_DIR',
          };
        }
        if (err.code === 'ENOTDIR') {
          return { ok: false, output: `Source parent ${srcParent} is not a directory.`, error: 'PARENT_NOT_DIR' };
        }
        throw err;
      }
      const srcSt = fstatSync(srcFd);
      srcParentDev = srcSt.dev;
      srcParentIno = srcSt.ino;

      if (srcParent === dstParent) {
        dstFd = srcFd;
        dstParentDev = srcParentDev;
        dstParentIno = srcParentIno;
      } else {
        try {
          dstFd = openParentDirFd(dstParent);
        } catch (err) {
          if (err.code === 'ENOENT') {
            return {
              ok: false,
              output: `Destination parent ${dstParent} does not exist. Use file_mkdir to create it first.`,
              error: 'PARENT_NOT_FOUND',
            };
          }
          if (err.code === 'ELOOP') {
            return { ok: false, output: `Destination parent ${dstParent} is a symlink — refusing.`, error: 'PARENT_NOT_DIR' };
          }
          if (err.code === 'ENOTDIR') {
            return { ok: false, output: `Destination parent ${dstParent} is not a directory.`, error: 'PARENT_NOT_DIR' };
          }
          throw err;
        }
        const dstSt = fstatSync(dstFd);
        dstParentDev = dstSt.dev;
        dstParentIno = dstSt.ino;
      }

      // ── Refuse to overwrite an existing symlink at dst ─────────────
      // renameat would silently replace the link entry; surface the
      // conflict so the user explicitly chooses to delete the old
      // link first via file_delete.
      const dstLst = await atomicLstat(dstParent, dstLeaf);
      if (dstLst && dstLst.isSymlink) {
        return {
          ok: false,
          output:
            `Refusing to overwrite an existing symlink at destination ${absDst}. ` +
            `Delete the symlink first via file_delete and retry.`,
          error: 'DST_IS_SYMLINK',
        };
      }

      // ── renameat — kernel binds both parents through dirfds ────────
      try {
        _raw.renameat(srcFd, srcLeaf, dstFd, dstLeaf);
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
    } finally {
      if (srcFd !== -1) { try { closeFdSync(srcFd); } catch {} }
      if (dstFd !== -1 && dstFd !== srcFd) { try { closeFdSync(dstFd); } catch {} }
    }
  },
};
