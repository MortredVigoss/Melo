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

import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

const MAX_WALK_DEPTH = 4096;

function isExpectedMissError(err) {
  if (!err || typeof err !== 'object') return false;
  return err.code === 'ENOENT' || err.code === 'ENOTDIR';
}

export async function safeResolvePath(absPath) {
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
