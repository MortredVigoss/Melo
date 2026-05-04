/**
 * gatedRead.js — Phase 2C primitive (2026-05-04).
 *
 * Rich-media tools (pdf, image, xlsx, knowledge) historically called
 * library functions that took a PATH and did their own fs reads.
 * That bypasses the FileSafetyGate entirely and reintroduces the
 * round-13 TOCTOU window (approval-then-library-reopens-by-path).
 *
 * `gatedReadIntoBuffer` is the unified safe-read primitive for any
 * tool that needs a file's bytes. It:
 *   1. Resolves the absolute path through `requestRead` (gate
 *      classifies workspace silent / external prompt / sensitive
 *      per-call). DENIED short-circuits with the gate's error.
 *   2. Splits the gate-approved real path into parent + leaf and
 *      opens the leaf via `atomicOpenLeaf(O_RDONLY|O_NONBLOCK)`
 *      so the open is dirfd-bound (parent ancestor walk uses the
 *      Phase 2B follow-up #4 chain walker — no ancestor symlink
 *      can redirect us). O_NONBLOCK avoids hangs on FIFOs;
 *      O_NOFOLLOW (added by atomicOpenLeaf) refuses leaf symlinks.
 *   3. Verifies the leaf is a regular file via post-open S_ISREG;
 *      rejects FIFOs / dev / sockets / dirs before any read.
 *   4. Verifies size against `maxBytes` (per-tool budget). Reads
 *      the whole file via the dirfd-bound fd into a Buffer and
 *      returns it to the caller, who then passes the buffer (NOT
 *      the path) to the underlying library. The library never
 *      touches fs, so no race between approval and library read.
 *
 * Returns `{ ok: true, realPath, lexicalPath, buffer, sizeBytes }`
 * or `{ ok: false, error, output, denied? }`. The shape mirrors a
 * Tool result so callers can early-return on failure.
 */

import { fstatSync, readSync } from 'node:fs';

import { requestRead } from './fileSafetyGate.js';
import { atomicOpenLeaf, splitParentLeaf, C as DC } from './dirfdOps.js';

/**
 * @param {string} absPath absolute path the user/agent requested
 * @param {object} ctx { workspacePath, sseEmitter, signal, chatId }
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=50*1024*1024] per-tool size cap
 * @param {string} [opts.toolName='read'] for error context
 * @returns {Promise<{ok:true, realPath:string, lexicalPath:string, buffer:Buffer, sizeBytes:number}
 *   | {ok:false, error:string, output:string, denied?:boolean, meta?:object}>}
 */
export async function gatedReadIntoBuffer(absPath, ctx = {}, opts = {}) {
  const { workspacePath, sseEmitter, signal, chatId } = ctx;
  const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
  const toolName = opts.toolName || 'read';

  if (typeof absPath !== 'string' || !absPath) {
    return { ok: false, error: 'INVALID_ARGS', output: 'absPath must be a non-empty string.' };
  }

  // ── 1. Gate ────────────────────────────────────────────────────────
  let approved;
  try {
    approved = await requestRead({
      path: absPath,
      chatId,
      sseEmitter,
      signal,
      workspacePath,
      baseDir: workspacePath,
    });
  } catch (err) {
    return {
      ok: false,
      error: err.code === 'FILE_SAFETY_DENIED' ? 'DENIED' : 'GATE_ERROR',
      output: err.message,
      denied: err.code === 'FILE_SAFETY_DENIED',
    };
  }

  const realPath = approved.resolvedTarget;
  const [parent, leaf] = splitParentLeaf(realPath);

  // ── 2. Dirfd-bound open ────────────────────────────────────────────
  let openLeaf;
  try {
    openLeaf = await atomicOpenLeaf(parent, leaf, DC.O_RDONLY | DC.O_NONBLOCK);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, error: 'ENOENT', output: `${toolName}: file not found: ${absPath}` };
    }
    if (err.code === 'ELOOP' || err.code === 'ENOTDIR') {
      return {
        ok: false,
        error: 'COMMIT_FAILED',
        output: `${toolName}: ${absPath} or one of its ancestors became a symlink between approval and read.`,
        meta: { lexicalPath: absPath, realPath, raceKind: 'symlink-eloop' },
      };
    }
    if (err.code === 'EACCES') {
      return { ok: false, error: 'EACCES', output: `${toolName}: permission denied: ${absPath}` };
    }
    return { ok: false, error: err.code || err.message, output: `${toolName} open error: ${err.message}` };
  }

  try {
    // ── 3. S_ISREG check (BEFORE any read) ────────────────────────────
    if ((openLeaf.leafStat.mode & 0o170000) !== 0o100000) {
      return { ok: false, error: 'NOT_FILE', output: `${toolName}: not a regular file: ${absPath}` };
    }
    // ── 4. Size cap, then read into Buffer ────────────────────────────
    const size = openLeaf.leafStat.size;
    if (size > maxBytes) {
      return {
        ok: false,
        error: 'FILE_TOO_LARGE',
        output: `${toolName}: file is ${(size / 1024 / 1024).toFixed(1)} MB, exceeds ${(maxBytes / 1024 / 1024).toFixed(0)} MB cap.`,
        meta: { sizeBytes: size, maxBytes },
      };
    }
    if (size === 0) {
      return { ok: true, realPath, lexicalPath: absPath, buffer: Buffer.alloc(0), sizeBytes: 0 };
    }
    const buf = Buffer.allocUnsafe(size);
    let total = 0;
    while (total < size) {
      const n = readSync(openLeaf.leafFd, buf, total, size - total, total);
      if (n === 0) break;
      total += n;
    }
    return {
      ok: true,
      realPath,
      lexicalPath: absPath,
      buffer: buf.subarray(0, total),
      sizeBytes: total,
    };
  } finally {
    openLeaf.closeLeaf();
  }
}
