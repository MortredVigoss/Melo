/**
 * Built-in tool: file_read
 *
 * Phase 2B (2026-05-04): wired through the FileSafetyGate.
 *   1. requestRead({path}) — gate classifies:
 *        - hard-blocked categories (handled inside requestRead's
 *          sensitivity branch — sensitive reads are ALWAYS prompted,
 *          per-call, never granted session-wide)
 *        - workspace-internal benign → silent allow
 *        - benign external → user prompt with grant options
 *      Denied → DENIED return, no fs touch.
 *   2. atomicOpenLeaf(parent, leaf, O_RDONLY) — dirfd-bound open
 *      with O_NOFOLLOW added auto. Catches leaf swapped to symlink
 *      between approval and our open (ELOOP). Reads via fd so the
 *      open binds the inode regardless of subsequent path changes.
 *   3. Apply line range if requested; return numbered text.
 *
 * No backup is taken (read-only). No commit token (read is
 * idempotent — the gate's sensitivity check + UI approval is
 * enough; we don't need TOCTOU re-resolution because we open the
 * commit-resolved real path through atomicOpenLeaf and any swap is
 * caught at open time).
 */

import { fstatSync, readSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { requestRead } from '../../safety/fileSafetyGate.js';
import {
  atomicOpenLeaf,
  splitParentLeaf,
  C as DC,
} from '../../safety/dirfdOps.js';

const MAX_READ_BYTES = 200_000; // ~200 KB safety cap

function readFromStartFd(fd) {
  const st = fstatSync(fd);
  if (st.size === 0) return { buf: Buffer.alloc(0), size: 0 };
  if (st.size > MAX_READ_BYTES) {
    return { buf: null, size: st.size, tooLarge: true };
  }
  const buf = Buffer.allocUnsafe(st.size);
  let total = 0;
  while (total < st.size) {
    const bytesRead = readSync(fd, buf, total, st.size - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return { buf: buf.subarray(0, total), size: st.size };
}

export const fileReadTool = {
  id: 'file_read',
  name: 'FileRead',
  description:
    'Read the contents of a file at the given path. Returns the file text. ' +
    'Paths may be absolute or relative to the workspace root. ' +
    'Workspace-internal files are read silently; sensitive paths (system, credential, $MELO_HOME) ' +
    'always require user approval per call (no session-wide grant). ' +
    'External-but-benign files prompt once with optional file/dir grant.',
  category: 'filesystem',
  requiresPermission: true,
  isConcurrencySafe: true,
  parametersSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or workspace-relative path to the file.',
      },
      start_line: {
        type: 'number',
        description: 'First line to return (1-based, inclusive). Omit to start from line 1.',
      },
      end_line: {
        type: 'number',
        description: 'Last line to return (1-based, inclusive). Omit to read to end of file.',
      },
    },
    required: ['path'],
  },
  examples: [
    { path: 'src/index.js' },
    { path: 'src/index.js', start_line: 10, end_line: 50 },
  ],

  /**
   * @param {{ path: string, start_line?: number, end_line?: number }} args
   * @param {import('../tool.js').ToolRunContext} context
   * @returns {Promise<import('../tool.js').ToolResult>}
   */
  async run(args, context = {}) {
    const { path: filePath, start_line, end_line } = args;
    const { workspacePath, sseEmitter, signal, chatId } = context;

    if (typeof filePath !== 'string' || !filePath) {
      return { ok: false, output: 'path must be a non-empty string.', error: 'INVALID_ARGS' };
    }

    const absPath = isAbsolute(filePath)
      ? filePath
      : resolve(workspacePath || process.cwd(), filePath);

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
        output: err.message,
        error: err.code === 'FILE_SAFETY_DENIED' ? 'DENIED' : 'GATE_ERROR',
        meta: { denied: err.code === 'FILE_SAFETY_DENIED' },
      };
    }

    const realPath = approved.resolvedTarget;
    const [parent, leaf] = splitParentLeaf(realPath);

    // ── 2. Dirfd-bound open + read ────────────────────────────────────
    let openLeaf;
    try {
      openLeaf = await atomicOpenLeaf(parent, leaf, DC.O_RDONLY);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { ok: false, output: `File not found: ${absPath}`, error: 'ENOENT' };
      }
      if (err.code === 'ELOOP') {
        return {
          ok: false,
          output: `Target ${realPath} became a symlink between approval and read — refused (O_NOFOLLOW).`,
          error: 'COMMIT_FAILED',
          meta: { lexicalPath: absPath, realPath, raceKind: 'symlink-eloop' },
        };
      }
      if (err.code === 'EISDIR') {
        return { ok: false, output: `Not a file: ${absPath}`, error: 'NOT_FILE' };
      }
      if (err.code === 'EACCES') {
        return { ok: false, output: `Permission denied: ${absPath}`, error: 'EACCES' };
      }
      return { ok: false, output: `Open error: ${err.message}`, error: err.code || err.message };
    }

    try {
      const { buf, size, tooLarge } = readFromStartFd(openLeaf.leafFd);
      if (tooLarge) {
        return {
          ok: false,
          output: `File too large (${(size / 1024).toFixed(0)} KB). Use start_line/end_line to read a portion.`,
          error: 'FILE_TOO_LARGE',
        };
      }

      // Verify the leaf we opened is a regular file (not a dir, etc).
      // S_IFMT mask 0o170000, S_IFREG = 0o100000.
      if ((openLeaf.leafStat.mode & 0o170000) !== 0o100000) {
        return { ok: false, output: `Not a file: ${absPath}`, error: 'NOT_FILE' };
      }

      const text = buf.toString('utf8');

      // Apply line range if requested.
      if (start_line != null || end_line != null) {
        const lines = text.split('\n');
        const s = Math.max(1, start_line ?? 1) - 1;
        const e = Math.min(lines.length, end_line ?? lines.length);
        const slice = lines.slice(s, e);
        const numbered = slice.map((l, i) => `${s + i + 1}\t${l}`).join('\n');
        return {
          ok: true,
          output: numbered,
          meta: { path: realPath, lexicalPath: absPath, lines: slice.length, totalLines: lines.length },
        };
      }

      const lines = text.split('\n');
      const numbered = lines.map((l, i) => `${i + 1}\t${l}`).join('\n');
      return {
        ok: true,
        output: numbered,
        meta: { path: realPath, lexicalPath: absPath, lines: lines.length },
      };
    } catch (err) {
      return { ok: false, output: `Read error: ${err.message}`, error: err.code || err.message };
    } finally {
      openLeaf.closeLeaf();
    }
  },
};
