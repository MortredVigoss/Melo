/**
 * pathResolver.js — symlink-aware path resolution for FileSafetyGate.
 *
 * Codex C round 1 (2026-05-03) flagged that the gate's lexical
 * `isWithinWorkspace()` + `classifyPath()` could be bypassed by a
 * symlink inside the workspace pointing at `~/.ssh` or `/etc/hosts`.
 * This module is the gate's single safe path-resolution primitive:
 * every `request*()` entry point now goes through it before deciding
 * sensitivity / workspace / grant.
 *
 * Returns:
 *   {
 *     lexicalPath: string,         // input path, normalize()'d
 *     realPath: string,            // realpath() result; falls back to
 *                                  // lexical if path doesn't exist
 *                                  // and no ancestor can be resolved
 *     hasSymlinkInChain: boolean,  // realPath !== lexicalPath
 *     exists: boolean,             // whether the full path exists
 *   }
 *
 * Missing-file semantics: if the full path doesn't exist (typical
 * "create new file" case), we walk up to the deepest existing
 * ancestor, realpath() that, then re-append the missing leaf
 * segments. This catches the "create file under a symlinked dir"
 * case — `~/badlink/foo.txt` where `~/badlink -> ~/.ssh` resolves
 * to `~/.ssh/foo.txt` even though the leaf doesn't exist yet.
 *
 * Errors other than ENOENT/ENOTDIR (e.g. EACCES, EMFILE) propagate to
 * the caller so the gate can report them as a hard failure rather
 * than silently treating them as "no symlink".
 */

import { realpath, lstat, readlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

const MAX_WALK_DEPTH = 4096;
const MAX_LINK_RECURSION = 32;

function isExpectedMissError(err) {
  if (!err || typeof err !== 'object') return false;
  return err.code === 'ENOENT' || err.code === 'ENOTDIR';
}

// Codex D Phase 2A round 3 (2026-05-03): when realpath() fails on the
// full lexical path it could be either:
//   (a) the leaf doesn't exist AND its parent's resolution is normal
//       — the legitimate "create new file" case, walk up handles it
//   (b) the leaf is a symlink whose TARGET doesn't exist (broken
//       symlink) — walk-up alone misses this because dirname's
//       realpath returns a benign workspace dir, and the leaf path
//       reconstructed under it looks benign too. But writeFile on
//       the leaf STILL follows the symlink to its missing target
//       (creating a file at the link's target). If the target is
//       /etc/hosts or ~/.ssh/*, that's a hard-block bypass.
//
// This helper catches case (b) by lstat'ing the leaf — if it IS a
// symlink (broken or otherwise), we readlink to get the target and
// recursively resolve THAT. The returned realPath is the target's
// resolution, so isHardBlockedWrite(real) sees the right path.
async function resolveLeafSymlink(absPath, depth = 0) {
  if (depth > MAX_LINK_RECURSION) {
    // Symlink loop or pathological depth — safe default: report
    // lexical and let downstream sensitivity / TOCTOU checks decide.
    return null;
  }
  let lst;
  try {
    lst = await lstat(absPath);
  } catch (err) {
    if (isExpectedMissError(err)) return null;
    throw err;
  }
  if (!lst.isSymbolicLink()) return null;

  const target = await readlink(absPath);
  const absTarget = isAbsolute(target)
    ? normalize(target)
    : normalize(join(dirname(absPath), target));

  // Recurse safeResolvePath on the target — it might itself be a
  // chain of broken symlinks, or eventually point at a real file.
  const inner = await safeResolvePath(absTarget, depth + 1);
  return {
    realPath: inner.realPath,
    // We are unconditionally a symlink chain — depth >= 1.
    hasSymlinkInChain: true,
    exists: inner.exists,
  };
}

export async function safeResolvePath(absPath, _depth = 0) {
  if (typeof absPath !== 'string' || !absPath) {
    return {
      lexicalPath: '',
      realPath: '',
      hasSymlinkInChain: false,
      exists: false,
    };
  }
  if (!isAbsolute(absPath)) {
    throw new Error(`safeResolvePath requires an absolute path; got: ${absPath}`);
  }
  if (_depth > MAX_LINK_RECURSION) {
    return {
      lexicalPath: normalize(absPath),
      realPath: normalize(absPath),
      hasSymlinkInChain: false,
      exists: false,
    };
  }

  const lexical = normalize(absPath);

  // Fast path: the full path resolves directly.
  try {
    const real = normalize(await realpath(lexical));
    return {
      lexicalPath: lexical,
      realPath: real,
      hasSymlinkInChain: real !== lexical,
      exists: true,
    };
  } catch (err) {
    if (!isExpectedMissError(err)) throw err;
  }

  // Codex D Phase 2A round 3: BEFORE walking up, check if the leaf
  // itself is a (possibly broken) symlink. If so, resolve through
  // its target — the kernel will follow the link on writeFile, so
  // the gate must classify by where the link POINTS, not by the
  // benign reconstructed path.
  const leafResolved = await resolveLeafSymlink(lexical, _depth);
  if (leafResolved) {
    return {
      lexicalPath: lexical,
      realPath: leafResolved.realPath,
      hasSymlinkInChain: true,
      exists: leafResolved.exists,
    };
  }

  // Walk up to the deepest existing ancestor, then reconstruct.
  const tail = [];
  let cur = lexical;
  let safety = 0;
  while (safety++ < MAX_WALK_DEPTH) {
    const parent = dirname(cur);
    if (parent === cur) break; // hit root without finding any parent
    tail.unshift(basename(cur));
    cur = parent;
    try {
      const real = normalize(await realpath(cur));
      const reconstructed = tail.length ? join(real, ...tail) : real;
      return {
        lexicalPath: lexical,
        realPath: reconstructed,
        hasSymlinkInChain: reconstructed !== lexical,
        exists: false,
      };
    } catch (err) {
      if (!isExpectedMissError(err)) throw err;
      // ancestor doesn't exist either; keep walking
    }
  }

  // Total miss — return lexical as a safe default. Callers must
  // still apply lexical-prefix sensitivity checks (the gate already
  // does) so a never-existed path under /etc still hard-blocks.
  return {
    lexicalPath: lexical,
    realPath: lexical,
    hasSymlinkInChain: false,
    exists: false,
  };
}
