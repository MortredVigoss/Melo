/**
 * dirfdOps.js — high-level atomic file ops bound to a parent dirfd.
 *
 * Why this exists (Codex Phase 2A round 13 architectural fix):
 * Path-based syscalls (open / rename / mkdir / unlink) re-resolve
 * the parent directory at the kernel moment. Even after we lstat()
 * the parent and verify its inode, an attacker can swap the parent
 * to a symlink in the microseconds before our open()/rename()
 * lands — and `O_NOFOLLOW` only protects the LEAF, not the parent
 * walk. Codex pre-pp evaluation graded this D for 12+ rounds.
 *
 * Fix: hold an open file descriptor on the parent directory across
 * the entire op. The kernel's `openat`/`renameat`/`mkdirat`/
 * `unlinkat` resolve relative to that fd's INODE, not its path. Once
 * the dirfd is open, the parent inode is anchored; subsequent path
 * swaps on the parent are invisible to our op. Combined with leaf
 * `O_NOFOLLOW`, the entire write/edit/move/mkdir/delete pipeline
 * becomes race-free.
 *
 * Layering:
 *   - `native/dirfd_ops.cc` exposes raw POSIX `*at()` syscalls.
 *   - This module wraps them in three high-level primitives that
 *     close all fds on every exit path:
 *       - `withParentDirFd(parentPath, fn)` — opens parent (O_DIRECTORY|O_NOFOLLOW),
 *         runs fn(dirfd, parentStat), closes dirfd.
 *       - `atomicOpenLeaf(parentPath, leafName, flags, mode?)` —
 *         opens parent + openat leaf with O_NOFOLLOW; returns
 *         { leafFd, leafStat, parentDev, parentIno, closeAll }.
 *       - `atomicRename(srcParent, srcName, dstParent, dstName)`,
 *         `atomicMkdir`, `atomicUnlink`, `atomicLstat` — wrapped.
 *
 * Tools must use these — never call `fs.open(absPath, ...)` for
 * the leaf, because that re-walks the parent path.
 *
 * Caller never sees raw fds for the parent — the wrappers manage
 * dirfd lifecycle. Leaf fds ARE handed out (returned) so the caller
 * can read/write/truncate, but the wrapper records the parent dirfd
 * close in `closeAll()` for cleanup.
 *
 * Errors: addon throws JS Error with .errno (number) + .syscall
 * (string) + .code (string). We re-throw with a small wrapper layer
 * that adds context (which path was being acted on) so logs are
 * traceable.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, basename, join } from 'node:path';
import { fstatSync, closeSync } from 'node:fs';

const requireCjs = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let addon;
try {
  // The addon lives at <project-root>/build/Release/dirfd_ops.node.
  // From src/safety/ that's two levels up.
  addon = requireCjs(join(__dirname, '..', '..', 'build', 'Release', 'dirfd_ops.node'));
} catch (err) {
  // npm install runs `node-gyp rebuild` via postinstall (no fallback —
  // we deliberately fail npm install if the addon can't compile, so
  // the runtime can rely on it being present). If we get here, either
  // the user is mid-checkout before `npm install`, or postinstall
  // somehow ran in an environment without Xcode CLT / build-essential.
  throw new Error(
    `[dirfdOps] failed to load native addon at build/Release/dirfd_ops.node: ${err.message}\n` +
    `melo's file-safety gate requires the dirfd_ops addon to provide atomic *at() syscalls.\n` +
    `Fix: install your platform's C++ toolchain and run \`npm run build:native\`:\n` +
    `  • macOS: xcode-select --install\n` +
    `  • Linux (Debian/Ubuntu): sudo apt-get install build-essential python3`
  );
}

export const C = addon.constants;

// ─── Raw bindings (test seam) ──────────────────────────────────────────
export const _raw = {
  openat: addon.openat,
  openIdentityAt: addon.openIdentityAt,
  mkdirat: addon.mkdirat,
  unlinkat: addon.unlinkat,
  renameat: addon.renameat,
  fstatat: addon.fstatat,
  readlinkat: addon.readlinkat,
  symlinkat: addon.symlinkat,
  readdirAt: addon.readdirAt,
  closeFd: addon.closeFd,
};

// ─── Helpers ────────────────────────────────────────────────────────────

function wrapErr(err, ctx) {
  // Preserve errno/syscall/code from the addon error; just add a path
  // prefix to .message so logs/test failures are traceable.
  const wrapped = new Error(`${ctx}: ${err.message || String(err)}`);
  wrapped.errno = err.errno;
  wrapped.syscall = err.syscall;
  wrapped.code = err.code;
  wrapped.cause = err;
  wrapped.raceKind = err.raceKind;
  return wrapped;
}

function safeCloseFd(fd) {
  if (fd == null || fd < 0) return;
  try { addon.closeFd(fd); } catch { /* close errors are non-recoverable here */ }
}

/**
 * Open an absolute directory path component-by-component, applying
 * `O_DIRECTORY | O_NOFOLLOW` at every segment. Round 13 Phase 2B
 * follow-up #4 (Codex 🔴): a single `open(absPath, O_NOFOLLOW)`
 * only protects the trailing component (POSIX trait of O_NOFOLLOW).
 * If any ancestor of `absPath` is swapped to a symlink between our
 * checks and this open, the kernel still follows it. Result: an
 * attacker who can swap a workspace parent for a symlink to
 * `$HOME` makes `/tmp/ws/.ssh/id_rsa` resolve to `~/.ssh/id_rsa`
 * — bypassing every sensitivity check that ran on the lexical path.
 *
 * Chain walk fix: open `/` (or root) first — there's no ancestor
 * for root, so an absolute open of "/" is intrinsically safe. Then
 * for each subsequent path component, `openat(curFd, segment,
 * O_DIRECTORY|O_NOFOLLOW)` and close the previous fd. ELOOP at any
 * segment throws ELOOP and we clean up.
 *
 * Throws:
 *   - ENOENT: missing component
 *   - ENOTDIR: a non-final component isn't a directory
 *   - ELOOP: any component is a symlink
 *   - EACCES: traversal permission denied
 *
 * @param {string} absPath absolute path to a directory
 * @returns {number} dirfd of the final directory
 */
function openDirNoFollowChain(absPath) {
  if (typeof absPath !== 'string' || !absPath.startsWith('/')) {
    throw new Error(`openDirNoFollowChain requires an absolute path, got ${JSON.stringify(absPath)}`);
  }
  const fs = requireCjs('node:fs');
  // Step 1: root open. There's no ancestor; this is intrinsically
  // safe. We use fs.openSync because '/' is a single-component
  // absolute path and openat with AT_FDCWD-style relative paths
  // isn't easier here. The root inode for the running process is
  // fixed by the kernel.
  let curFd;
  try {
    curFd = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  } catch (err) {
    throw wrapErr(err, `openDirNoFollowChain root open`);
  }

  // Step 2: walk each non-empty component.
  const segments = absPath.split('/').filter(s => s.length > 0);
  for (const segment of segments) {
    let nextFd;
    try {
      nextFd = addon.openat(
        curFd,
        segment,
        C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW,
      );
    } catch (err) {
      safeCloseFd(curFd);
      throw wrapErr(err, `openDirNoFollowChain segment "${segment}" of ${absPath}`);
    }
    safeCloseFd(curFd);
    curFd = nextFd;
  }
  return curFd;
}

/**
 * Open a parent directory as O_DIRECTORY|O_NOFOLLOW dirfd, walking
 * the ENTIRE path component-by-component so no ancestor symlink
 * can redirect us. See openDirNoFollowChain for full rationale.
 *
 * @param {string} parentPath absolute path to parent directory
 * @returns {number} dirfd
 * @throws errno error: ENOENT (missing), ENOTDIR (not a dir), ELOOP
 *   (any path component is a symlink), EACCES (no perms)
 */
export function openParentDirFd(parentPath) {
  return openDirNoFollowChain(parentPath);
}

/**
 * Open the parent dir, run an async callback with the dirfd, close
 * the dirfd on every exit path (success / throw).
 *
 * The callback receives (dirfd, parentStat) where parentStat comes
 * from fstatat(dirfd, "", AT_SYMLINK_NOFOLLOW)... actually we use
 * fs.fstatSync on the dirfd directly because that doesn't need the
 * "" name semantics.
 *
 * @template T
 * @param {string} parentPath
 * @param {(dirfd: number, parentStat: import('node:fs').Stats) => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withParentDirFd(parentPath, fn) {
  const fs = requireCjs('node:fs');
  const dirfd = openParentDirFd(parentPath);
  try {
    const parentStat = fs.fstatSync(dirfd);
    return await fn(dirfd, parentStat);
  } finally {
    safeCloseFd(dirfd);
  }
}

/**
 * Atomic open of a leaf file under a parent dirfd. Always uses
 * O_NOFOLLOW on the leaf so a symlink-leaf is rejected (ELOOP).
 *
 * Returns { leafFd, leafStat (after open), closeLeaf } — caller
 * owns leafFd and must call closeLeaf() when done. Parent dirfd is
 * already closed by this function (we open + openat + close
 * dirfd, returning the leafFd whose parent inode is now anchored
 * by virtue of having been opened relative to the dirfd).
 *
 * If you need to do MORE than one op under the same parent
 * (e.g. open + later mkdirat), use `withParentDirFd` and call the
 * raw addon yourself.
 *
 * @param {string} parentPath
 * @param {string} leafName
 * @param {number} flags  O_RDONLY/O_RDWR/O_WRONLY [|O_CREAT|O_EXCL|O_TRUNC] |O_NOFOLLOW added auto
 * @param {number} [mode] file mode for O_CREAT
 * @returns {Promise<{leafFd: number, leafStat: object, parentDev: number, parentIno: number, closeLeaf: () => void}>}
 */
export async function atomicOpenLeaf(parentPath, leafName, flags, mode = 0o644, identity = null) {
  const fs = requireCjs('node:fs');
  const dirfd = openParentDirFd(parentPath);
  let parentStat;
  try {
    parentStat = fs.fstatSync(dirfd);
    if (identity) requireFileIdentity(identity, parentPath, leafName).assertEntry(dirfd);
  } catch (err) {
    safeCloseFd(dirfd);
    throw wrapErr(err, `fstat parent dirfd (${parentPath})`);
  }
  // Delay truncation until the opened inode is checked. Missing targets use
  // O_EXCL at their call sites, so a raced creation cannot be overwritten.
  const flagsWithNoFollow = (identity ? flags & ~C.O_TRUNC : flags) | C.O_NOFOLLOW
    | (identity && !identity.existed && (flags & C.O_CREAT) ? C.O_EXCL : 0);
  let leafFd;
  try {
    leafFd = addon.openat(dirfd, leafName, flagsWithNoFollow, mode);
  } catch (err) {
    safeCloseFd(dirfd);
    throw wrapErr(err, `openat ${parentPath}/${leafName}`);
  }
  let leafStat;
  try {
    leafStat = fs.fstatSync(leafFd);
    if (identity) {
      identity.assertOpened(leafFd);
      if (flags & C.O_TRUNC) fs.ftruncateSync(leafFd, 0);
    }
  } catch (err) {
    safeCloseFd(leafFd);
    safeCloseFd(dirfd);
    throw wrapErr(err, `fstat leaf fd (${parentPath}/${leafName})`);
  }
  // Parent dirfd not needed after openat — the leaf fd already binds
  // the inode pair. Close to avoid fd leak.
  safeCloseFd(dirfd);
  return {
    leafFd,
    leafStat,
    parentDev: parentStat.dev,
    parentIno: parentStat.ino,
    closeLeaf: () => safeCloseFd(leafFd),
  };
}

/**
 * Atomic rename. Both src and dst parents are bound through dirfds.
 * Cross-dir rename is supported (renameat takes two dirfds).
 *
 * @param {string} srcParent
 * @param {string} srcName
 * @param {string} dstParent
 * @param {string} dstName
 */
export async function atomicRename(srcParent, srcName, dstParent, dstName) {
  const srcFd = openParentDirFd(srcParent);
  let dstFd = -1;
  try {
    if (srcParent === dstParent) {
      dstFd = srcFd; // reuse for same-parent rename
    } else {
      dstFd = openParentDirFd(dstParent);
    }
    try {
      addon.renameat(srcFd, srcName, dstFd, dstName);
    } catch (err) {
      throw wrapErr(err, `renameat ${srcParent}/${srcName} → ${dstParent}/${dstName}`);
    }
  } finally {
    safeCloseFd(srcFd);
    if (dstFd !== -1 && dstFd !== srcFd) safeCloseFd(dstFd);
  }
}

/**
 * Atomic mkdir of a single leaf under a parent dirfd.
 * Caller must ensure the leaf doesn't already exist (or accept
 * EEXIST being thrown).
 *
 * @param {string} parentPath
 * @param {string} leafName
 * @param {number} mode
 */
export async function atomicMkdir(parentPath, leafName, mode = 0o755) {
  const dirfd = openParentDirFd(parentPath);
  try {
    addon.mkdirat(dirfd, leafName, mode);
  } catch (err) {
    throw wrapErr(err, `mkdirat ${parentPath}/${leafName}`);
  } finally {
    safeCloseFd(dirfd);
  }
}

/**
 * Atomic unlink of a leaf under a parent dirfd.
 *
 * @param {string} parentPath
 * @param {string} leafName
 * @param {object} [opts]
 * @param {boolean} [opts.removeDir] AT_REMOVEDIR — remove an empty dir
 */
export async function atomicUnlink(parentPath, leafName, { removeDir = false } = {}) {
  const dirfd = openParentDirFd(parentPath);
  try {
    addon.unlinkat(dirfd, leafName, removeDir ? C.AT_REMOVEDIR : 0);
  } catch (err) {
    throw wrapErr(err, `unlinkat ${parentPath}/${leafName}${removeDir ? ' (rmdir)' : ''}`);
  } finally {
    safeCloseFd(dirfd);
  }
}

/**
 * Atomic symlink creation through a parent dirfd. The new link's
 * parent is bound by the dirfd; `target` is the link's contents
 * (kernel does not interpret it at creation time).
 *
 * @param {string} parentPath
 * @param {string} leafName  the link's own name (basename of new symlink)
 * @param {string} target    what the link points at (string contents)
 */
export async function atomicSymlink(parentPath, leafName, target) {
  const dirfd = openParentDirFd(parentPath);
  try {
    addon.symlinkat(target, dirfd, leafName);
  } catch (err) {
    throw wrapErr(err, `symlinkat ${parentPath}/${leafName} → ${target}`);
  } finally {
    safeCloseFd(dirfd);
  }
}

/**
 * Checked operations require a live identity captured BEFORE approval/backup.
 * Holding the parent prevents inode reuse; holding the entry detects same-
 * content replacement. Recheck the freshly opened parent, then use that same
 * dirfd for the syscall. A bare dev/ino snapshot is never an authority.
 */
export async function unlinkatChecked(parentPath, leafName, identity, { removeDir = false } = {}) {
  requireFileIdentity(identity, parentPath, leafName);
  const dirfd = openParentDirFd(parentPath);
  try {
    identity.assertEntry(dirfd);
    addon.unlinkat(dirfd, leafName, removeDir ? C.AT_REMOVEDIR : 0);
  } catch (err) {
    if (err.code === 'FILE_SAFETY_DENIED') throw err;
    throw wrapErr(err, `unlinkatChecked ${parentPath}/${leafName}${removeDir ? ' (rmdir)' : ''}`);
  } finally {
    safeCloseFd(dirfd);
  }
}

export async function symlinkatChecked(parentPath, leafName, target, identity) {
  requireFileIdentity(identity, parentPath, leafName);
  const dirfd = openParentDirFd(parentPath);
  try {
    // A restore may have just unlinked the old slot under this same lease.
    // symlinkat itself refuses any entry created in the gap (EEXIST).
    identity.assertParent(dirfd);
    addon.symlinkat(target, dirfd, leafName);
  } catch (err) {
    if (err.code === 'FILE_SAFETY_DENIED') throw err;
    throw wrapErr(err, `symlinkatChecked ${parentPath}/${leafName} → ${target}`);
  } finally {
    safeCloseFd(dirfd);
  }
}

// Roll back a failed create only while its original FD is still held. A path
// may already refer to somebody else's replacement; never unlink that entry.
export function unlinkOpenedLeaf(parentPath, leafName, leafFd, identity) {
  requireFileIdentity(identity, parentPath, leafName);
  const fd = openParentDirFd(parentPath);
  let current = null;
  try {
    identity.assertParent(fd);
    current = identityAt(fd, leafName);
    if (current === null) return;
    if (!same(fstatSync(leafFd, { bigint: true }), fstatSync(current, { bigint: true }))) {
      throw denied('Failed-create cleanup refuses to remove a replacement file.', 'inode-mismatch');
    }
    addon.unlinkat(fd, leafName, 0);
  } finally {
    safeCloseFd(current);
    safeCloseFd(fd);
  }
}

/**
 * Atomic lstat of a leaf under a parent dirfd. Always uses
 * AT_SYMLINK_NOFOLLOW (lstat semantics, not stat).
 *
 * Returns null on ENOENT (parent doesn't have the entry).
 * Throws otherwise.
 *
 * @param {string} parentPath
 * @param {string} leafName
 * @returns {Promise<object|null>}
 */
export async function atomicLstat(parentPath, leafName) {
  const dirfd = openParentDirFd(parentPath);
  try {
    return addon.fstatat(dirfd, leafName, C.AT_SYMLINK_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw wrapErr(err, `fstatat ${parentPath}/${leafName}`);
  } finally {
    safeCloseFd(dirfd);
  }
}

/**
 * Helper: split an absolute path into [parent, leaf]. Refuses '/'
 * (no parent) and trailing-slash paths.
 *
 * @param {string} absPath
 * @returns {[string, string]}
 */
export function splitParentLeaf(absPath) {
  if (absPath === '/' || absPath.endsWith('/')) {
    throw new Error(`splitParentLeaf: refuses to split ${JSON.stringify(absPath)}`);
  }
  const parent = dirname(absPath);
  const leaf = basename(absPath);
  if (!leaf) {
    throw new Error(`splitParentLeaf: empty leaf in ${JSON.stringify(absPath)}`);
  }
  return [parent, leaf];
}

const live = new WeakSet();
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
function denied(message, raceKind = null) {
  return Object.assign(new Error(message), { code: 'FILE_SAFETY_DENIED', raceKind });
}
function identityAt(fd, name) {
  try { return _raw.openIdentityAt(fd, name); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// A snapshot of numbers is insufficient: an unlinked inode can be reused.
// Keep the actual parent AND existing entry open until the operation ends.
// Missing entries are also an explicit precondition; a late create is refused.
export function captureFileIdentity(path) {
  const parent = dirname(path);
  const leaf = basename(path);
  const parentFd = openParentDirFd(parent);
  let leafFd = null;
  try {
    leafFd = identityAt(parentFd, leaf);
    const parentStat = fstatSync(parentFd, { bigint: true });
    const leafStat = leafFd === null ? null : fstatSync(leafFd, { bigint: true });
    const lease = {
      path, parent, leaf, existed: leafStat !== null,
      assertParent(fd) {
        if (!live.has(lease)) throw denied('File identity is missing or already released.');
        if (!same(parentStat, fstatSync(fd, { bigint: true }))) {
          throw denied(`Parent ${parent} was replaced (inode/device changed) during approval.`, 'parent-swap');
        }
      },
      assertEntry(fd) {
        lease.assertParent(fd);
        const current = identityAt(fd, leaf);
        try {
          const st = current === null ? null : fstatSync(current, { bigint: true });
          if (leafStat === null ? st !== null : st === null || !same(leafStat, st)) {
            throw denied(`File ${path} was replaced during approval.`,
              leafStat === null ? 'create-eexist' : st?.isSymbolicLink() ? 'symlink-eloop' : 'inode-mismatch');
          }
        } finally { if (current !== null) closeSync(current); }
      },
      assertOpened(fd) {
        if (!live.has(lease)) throw denied('File identity is already released.');
        if (leafStat !== null && !same(leafStat, fstatSync(fd, { bigint: true }))) {
          throw denied(`File ${path} was replaced before open.`, 'inode-mismatch');
        }
      },
      assertCurrent() {
        const fd = openParentDirFd(parent);
        try { lease.assertEntry(fd); } finally { closeSync(fd); }
      },
      close() {
        if (!live.delete(lease)) return;
        safeCloseFd(leafFd);
        safeCloseFd(parentFd);
      },
    };
    live.add(lease);
    return lease;
  } catch (error) {
    if (leafFd !== null) closeSync(leafFd);
    closeSync(parentFd);
    throw error;
  }
}

export function requireFileIdentity(identity, parent, leaf) {
  if (!live.has(identity) || identity.parent !== parent || identity.leaf !== leaf) {
    throw denied('A live file identity for this path is required; numeric inode snapshots are not accepted.');
  }
  return identity;
}

// Explicit operation ownership. Token → consumer transfer removes the lease
// from its old owner, so finally/expiry cleanup cannot close a live consumer FD.
export class FileIdentityOwner {
  #leases = new Set();
  capture(path) {
    const existing = this.get(path);
    if (existing) { existing.assertCurrent(); return existing; }
    return this.add(captureFileIdentity(path));
  }
  add(lease) { this.#leases.add(lease); return lease; }
  get(path) { return [...this.#leases].find(lease => lease.path === path); }
  take(lease) { this.#leases.delete(lease); return lease; }
  takeAll() { const all = [...this.#leases]; this.#leases.clear(); return all; }
  close() { for (const lease of this.takeAll()) lease.close(); }
}
