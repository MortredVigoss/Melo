/**
 * Built-in tool: file_move
 *
 * Round 13 (2026-05-03, terminal): atomic via dirfd-bound renameat.
 * Both src and dst parent directories are bound through file
 * descriptors before the rename syscall — kernel resolves both
 * leaves relative to dirfd inodes, not paths. Cross-directory
 * rename is supported.
 *
 * Round 13 follow-up (post-Codex D #2):
 *   • Precheck phase: probe srcParent + dstParent dirfds, capture
 *     {dev, ino}. After commit, when re-opening dirfds for renameat,
 *     cross-check {dev, ino} matches precheck — catches "parent dir
 *     was rmdir'd + new dir mkdir'd at same path during approval"
 *     (different inode, same path).
 *   • dst-symlink check uses _raw.fstatat on the SAME dstFd that
 *     renameat will use. Eliminates the "two-dirfd-open" race where
 *     atomicLstat opened a fresh dirfd that could differ from the
 *     dirfd passed to renameat.
 *
 * No-follow leaf semantics: renameat (like rename) operates on the
 * directory entry, never the file the entry points to. Moving a
 * symlink moves the link, not the target file.
 */

import { isAbsolute, resolve, dirname } from 'node:path';
import { realpath } from 'node:fs/promises';

import {
  requestMove,
  commitOperation,
  OP_KIND,
} from '../../safety/fileSafetyGate.js';
import {
  openParentDirFd,
  splitParentLeaf,
  _raw,
  C as DC,
} from '../../safety/dirfdOps.js';
import { closeSync as closeFdSync, fstatSync } from 'node:fs';

// Round 13 follow-up #3 (Codex 🔴): refuse moves where any ancestor
// of the lexical path is a symlink. Otherwise approval/commit binds
// the resolved leaf, but our parent dirfd open uses the lexical
// parent — an attacker could swap a parent-symlink between commit
// and our dirfd open to redirect renameat. Detection is cheap:
// realpath() on the parent must equal its lexical form (no symlink
// in any ancestor). When refused we suggest the resolved path so
// the agent retries with a non-symlinked equivalent.
async function parentHasSymlinkAncestor(parentPath) {
  let real;
  try { real = await realpath(parentPath); }
  catch (err) {
    // ENOENT/ENOTDIR/ELOOP propagate to caller for a clear error.
    return { error: err };
  }
  if (real !== parentPath) return { hasSymlink: true, resolved: real };
  return { hasSymlink: false, resolved: real };
}

// Test-only seam: fires AFTER the post-commit probe captures
// {dev, ino} but BEFORE the dirfd is reopened for renameat.
// Tests use this to swap src/dst parent and prove the cross-check
// catches it. Default null = no-op in production.
let _postProbeHookForTests = null;
export function _setPostProbeHookForTests(hook) {
  _postProbeHookForTests = typeof hook === 'function' ? hook : null;
}

function probeParentInoIdent(parent) {
  let fd;
  try {
    fd = openParentDirFd(parent);
    const st = fstatSync(fd);
    return { ok: true, dev: st.dev, ino: st.ino };
  } catch (err) {
    return { ok: false, error: err };
  } finally {
    if (fd != null) try { closeFdSync(fd); } catch {}
  }
}

export const fileMoveTool = {
  id: 'file_move',
  name: 'FileMove',
  description:
    'Rename or move a file (or symlink) atomically. Both src and dst parent directories ' +
    'must already exist AND must NOT contain any symlinked ancestor (a parent symlink is ' +
    'refused with PARENT_HAS_SYMLINK and a hint pointing at the resolved path — retry with ' +
    'that). Cross-directory moves are supported (renameat binds both parents through dirfd ' +
    'handles, race-free). The user sees a confirmation dialog showing both paths and their ' +
    'realpaths; sensitive sources or destinations are hard-rejected. Leaf no-follow rename: ' +
    'a symlink at src moves the link itself, never the file the link points to. Existing ' +
    'symlink at dst is refused (use file_delete first).',
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

    const [srcParent, srcLeaf] = splitParentLeaf(absSrc);
    const [dstParent, dstLeaf] = splitParentLeaf(absDst);

    // ── Sensitivity check happens INSIDE requestMove ─────────────────
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

    // ── Refuse moves whose lexical parent contains a symlink ─────────
    // Round 13 follow-up #3 (Codex 🔴): without this guard, an attacker
    // could swap a parent-symlink between commit and dirfd open to
    // redirect renameat — bypassing the resolvedSrc/resolvedDst that
    // the gate's commit verified. Run AFTER sensitivity check so
    // sensitive paths (e.g. /etc/hosts whose parent /etc resolves
    // through /private/etc on macOS) hard-reject as DENIED first.
    const srcParentResolve = await parentHasSymlinkAncestor(srcParent);
    if (srcParentResolve.error) {
      const e = srcParentResolve.error;
      if (e.code === 'ENOENT') {
        return { ok: false, output: `Source parent ${srcParent} does not exist.`, error: 'PARENT_NOT_FOUND' };
      }
      if (e.code === 'ELOOP') {
        return { ok: false, output: `Source parent ${srcParent} is a symlink loop.`, error: 'PARENT_NOT_DIR' };
      }
      if (e.code === 'ENOTDIR') {
        return { ok: false, output: `Source parent ${srcParent} is not a directory.`, error: 'PARENT_NOT_DIR' };
      }
      return { ok: false, output: `Cannot resolve source parent ${srcParent}: ${e.message}`, error: e.message };
    }
    if (srcParentResolve.hasSymlink) {
      return {
        ok: false,
        output:
          `Source path contains a symlinked ancestor (${srcParent} → ${srcParentResolve.resolved}). ` +
          `file_move refuses these to avoid post-approval ancestor-swap races. ` +
          `Retry with the resolved path: ${srcParentResolve.resolved}/${srcLeaf}`,
        error: 'PARENT_HAS_SYMLINK',
        meta: { lexicalPath: absSrc, resolvedParent: srcParentResolve.resolved, leaf: srcLeaf },
      };
    }
    const dstParentResolve = await parentHasSymlinkAncestor(dstParent);
    if (dstParentResolve.error) {
      const e = dstParentResolve.error;
      if (e.code === 'ENOENT') {
        return {
          ok: false,
          output: `Destination parent ${dstParent} does not exist. Use file_mkdir to create it first.`,
          error: 'PARENT_NOT_FOUND',
        };
      }
      if (e.code === 'ELOOP') {
        return { ok: false, output: `Destination parent ${dstParent} is a symlink loop.`, error: 'PARENT_NOT_DIR' };
      }
      if (e.code === 'ENOTDIR') {
        return { ok: false, output: `Destination parent ${dstParent} is not a directory.`, error: 'PARENT_NOT_DIR' };
      }
      return { ok: false, output: `Cannot resolve destination parent ${dstParent}: ${e.message}`, error: e.message };
    }
    if (dstParentResolve.hasSymlink) {
      return {
        ok: false,
        output:
          `Destination path contains a symlinked ancestor (${dstParent} → ${dstParentResolve.resolved}). ` +
          `file_move refuses these to avoid post-approval ancestor-swap races. ` +
          `Retry with the resolved path: ${dstParentResolve.resolved}/${dstLeaf}`,
        error: 'PARENT_HAS_SYMLINK',
        meta: { lexicalPath: absDst, resolvedParent: dstParentResolve.resolved, leaf: dstLeaf },
      };
    }

    // ── Probe parent {dev, ino} for cross-check at final-open ────────
    // Why probe AFTER commit: the gate already verified the lexical→
    // real mapping is unchanged from approval time, so a probe here
    // captures the inode the user effectively approved against. Then
    // when we re-open the dirfd below for the actual renameat, we
    // cross-check {dev, ino} matches — catches "parent dir was
    // rmdir'd + new dir mkdir'd at same path" (different inode, same
    // path).
    const srcProbe = probeParentInoIdent(srcParent);
    if (!srcProbe.ok) {
      const err = srcProbe.error;
      if (err.code === 'ENOENT') {
        return { ok: false, output: `Source parent ${srcParent} does not exist.`, error: 'PARENT_NOT_FOUND' };
      }
      if (err.code === 'ELOOP') {
        return { ok: false, output: `Source parent ${srcParent} is a symlink.`, error: 'PARENT_NOT_DIR' };
      }
      if (err.code === 'ENOTDIR') {
        return { ok: false, output: `Source parent ${srcParent} is not a directory.`, error: 'PARENT_NOT_DIR' };
      }
      return { ok: false, output: `Cannot probe source parent ${srcParent}: ${err.message}`, error: err.message };
    }
    let dstProbe;
    if (srcParent === dstParent) {
      dstProbe = srcProbe;
    } else {
      dstProbe = probeParentInoIdent(dstParent);
      if (!dstProbe.ok) {
        const err = dstProbe.error;
        if (err.code === 'ENOENT') {
          return {
            ok: false,
            output: `Destination parent ${dstParent} does not exist. Use file_mkdir to create it first.`,
            error: 'PARENT_NOT_FOUND',
          };
        }
        if (err.code === 'ELOOP') {
          return { ok: false, output: `Destination parent ${dstParent} is a symlink.`, error: 'PARENT_NOT_DIR' };
        }
        if (err.code === 'ENOTDIR') {
          return { ok: false, output: `Destination parent ${dstParent} is not a directory.`, error: 'PARENT_NOT_DIR' };
        }
        return { ok: false, output: `Cannot probe destination parent ${dstParent}: ${err.message}`, error: err.message };
      }
    }

    if (_postProbeHookForTests) {
      try { await _postProbeHookForTests({ srcParent, dstParent, absSrc, absDst }); } catch {}
    }

    // ── Open the dirfds we'll actually pass to renameat ──────────────
    let srcFd = -1;
    let dstFd = -1;
    try {
      try {
        srcFd = openParentDirFd(srcParent);
      } catch (err) {
        if (err.code === 'ELOOP') {
          return {
            ok: false,
            output: `Source parent ${srcParent} became a symlink between approval and rename.`,
            error: 'COMMIT_FAILED',
            meta: { lexicalPath: absSrc, raceKind: 'parent-swap' },
          };
        }
        return { ok: false, output: `Cannot open source parent: ${err.message}`, error: err.message };
      }
      const srcSt = fstatSync(srcFd);
      // Cross-check: the parent inode this dirfd points at MUST match
      // what we probed above. If not, an attacker rmdir'd + mkdir'd
      // the parent path between probe and this open — different inode,
      // same path. renameat would bind to the new inode (atomic w.r.t.
      // the syscall) but the new dir is NOT what the user approved.
      if (srcSt.dev !== srcProbe.dev || srcSt.ino !== srcProbe.ino) {
        return {
          ok: false,
          output: `Source parent ${srcParent} was replaced (inode/device changed) between approval and rename.`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absSrc, raceKind: 'parent-swap' },
        };
      }

      if (srcParent === dstParent) {
        dstFd = srcFd;
      } else {
        try {
          dstFd = openParentDirFd(dstParent);
        } catch (err) {
          if (err.code === 'ELOOP') {
            return {
              ok: false,
              output: `Destination parent ${dstParent} became a symlink between approval and rename.`,
              error: 'COMMIT_FAILED',
              meta: { lexicalPath: absDst, raceKind: 'parent-swap' },
            };
          }
          return { ok: false, output: `Cannot open destination parent: ${err.message}`, error: err.message };
        }
        const dstSt = fstatSync(dstFd);
        if (dstSt.dev !== dstProbe.dev || dstSt.ino !== dstProbe.ino) {
          return {
            ok: false,
            output: `Destination parent ${dstParent} was replaced (inode/device changed) between approval and rename.`,
            error: 'COMMIT_FAILED',
            meta: { lexicalPath: absDst, raceKind: 'parent-swap' },
          };
        }
      }

      // ── dst-symlink check on the SAME dstFd renameat will use ──────
      // Round 13 follow-up (Codex D #2): atomicLstat opens a separate
      // dirfd; between that open and the renameat, dst parent could
      // be replaced. Use _raw.fstatat on the existing dstFd so the
      // check and the rename observe the same dirfd inode.
      // ENOENT = no entry yet (the common case), proceed.
      try {
        const dstStat = _raw.fstatat(dstFd, dstLeaf, DC.AT_SYMLINK_NOFOLLOW);
        if (dstStat.isSymlink) {
          return {
            ok: false,
            output:
              `Refusing to overwrite an existing symlink at destination ${absDst}. ` +
              `Delete the symlink first via file_delete and retry.`,
            error: 'DST_IS_SYMLINK',
          };
        }
      } catch (err) {
        if (err.errno !== 2 /* ENOENT */ && err.code !== 'ENOENT') {
          return { ok: false, output: `Cannot check destination: ${err.message}`, error: err.message };
        }
        // ENOENT: dst doesn't exist — fine, that's the normal case.
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
