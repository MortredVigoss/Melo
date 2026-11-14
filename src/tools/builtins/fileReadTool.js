import {missingWorkspaceResult} from '../workspace.js';
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

// Round 13 Phase 2B follow-up #1 (Codex ⚪): test-only seam fired
// AFTER gate approval but BEFORE atomicOpenLeaf. Tests use this to
// inject a leaf-swap-to-symlink race and assert atomicOpenLeaf
// rejects via O_NOFOLLOW (ELOOP). Default null = no-op.
let _postApprovalHookForTests = null;
export function _setPostApprovalHookForTests(hook) {
  _postApprovalHookForTests = typeof hook === 'function' ? hook : null;
}

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

const SCAN_CHUNK_BYTES = 64 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024; // how far into a large file a line range is looked for

// A line range of a file over MAX_READ_BYTES. Walks the file through the same
// descriptor (the inode the approval was bound to), keeps only the requested
// lines, and stops as soon as the range is complete, the output cap is reached
// or the scan budget is spent. Lines are the pieces between '\n' bytes, numbered
// exactly as the whole-file path numbers them.
function readLineRangeFd(fd, size, startLine, endLine) {
  const first = Math.max(1, Math.floor(Number(startLine ?? 1)) || 1);
  const last = endLine == null || !Number.isFinite(Number(endLine)) ? Infinity : Math.floor(Number(endLine));
  const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
  const lines = [];
  let pieces = [];            // bytes of the line being walked, when it is wanted
  let keptBytes = 0;
  let line = 1;
  let position = 0;
  let stopped = null;         // 'cap' | 'scan' — why the walk ended before the range did
  let ended = false;          // the file itself ended
  const wanted = () => line >= first && line <= last;
  const finishLine = () => {
    if (wanted()) lines.push(Buffer.concat(pieces).toString('utf8'));
    pieces = [];
    line += 1;
  };

  walk: while (position < size && line <= last) {
    if (position >= MAX_SCAN_BYTES) { stopped = 'scan'; break; }
    const read = readSync(fd, chunk, 0, SCAN_CHUNK_BYTES, position);
    if (read === 0) { ended = true; break; }
    position += read;
    let offset = 0;
    while (offset < read) {
      const newline = chunk.indexOf(0x0A, offset);
      const end = newline === -1 || newline >= read ? read : newline;
      if (wanted() && end > offset) {
        let take = end - offset;
        if (keptBytes + take > MAX_READ_BYTES) {
          // Cut on a character boundary; a line longer than the cap is returned in part.
          take = MAX_READ_BYTES - keptBytes;
          while (take > 0 && (chunk[offset + take] & 0xC0) === 0x80) take -= 1;
          if (take > 0) pieces.push(Buffer.from(chunk.subarray(offset, offset + take)));
          if (pieces.length) lines.push(Buffer.concat(pieces).toString('utf8'));
          pieces = [];
          stopped = 'cap';
          break walk;
        }
        pieces.push(Buffer.from(chunk.subarray(offset, end)));
        keptBytes += take;
      }
      if (end === read) break;          // the line continues in the next chunk
      finishLine();
      offset = end + 1;
      if (line > last) break walk;
    }
  }
  // The piece after the last '\n' is a line too (empty when the file ends with one).
  const reachedEnd = !stopped && (ended || position >= size) && line <= last;
  if (reachedEnd) finishLine();
  return { lines, first, stopped, totalLines: reachedEnd ? line - 1 : null };
}

export const fileReadTool = {
  id: 'file_read',
  name: 'File Read',
  description:
    'Read the contents of a file at the given path. Returns the file text. ' +
    'Paths may be absolute or relative to the workspace root. ' +
    'Workspace-internal files are read silently; sensitive paths (system, credential, $MELO_HOME) ' +
    'always require user approval per call (no session-wide grant). ' +
    'External-but-benign files prompt once with optional file/dir grant.',
  category: 'filesystem',
  // Round 13 Phase 2B follow-up #1 (Codex 🟡): FileSafetyGate owns
  // path-level approval (workspace silent / external prompt /
  // sensitive per-call). Setting requiresPermission:true would make
  // executor.js fire its toolId-level prompt FIRST, breaking the
  // "workspace read silent" contract (user gets a generic "allow
  // file_read?" prompt before any path classification runs).
  requiresPermission: false,
  isConcurrencySafe: true,
  // Self-description (tools/tool.js); see that file for the fallback tables.
  capability: 'readFiles',
  needsWorkspace: true,
  uiModule: 'files',
  inputKeys: ['path', 'start_line', 'end_line'],
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

    const missingWorkspace = missingWorkspaceResult(workspacePath);
    if (missingWorkspace) return missingWorkspace;

    const absPath = isAbsolute(filePath)
      ? filePath
      : resolve(workspacePath, filePath);

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

    if (_postApprovalHookForTests) {
      try { await _postApprovalHookForTests({ realPath, parent, leaf, lexicalPath: absPath }); } catch {}
    }

    // ── 2. Dirfd-bound open + read ────────────────────────────────────
    // O_NONBLOCK avoids hangs on FIFOs / device files (the open
    // returns immediately even with no writer attached). The post-
    // open S_ISREG check rejects non-regular leaves before any read.
    let openLeaf;
    try {
      openLeaf = await atomicOpenLeaf(parent, leaf, DC.O_RDONLY | DC.O_NONBLOCK);
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
      // Round 13 Phase 2B follow-up #2 (Codex 🟡): S_ISREG check
      // happens BEFORE any read. atomicOpenLeaf returns the leaf
      // stat post-open; a FIFO / device / socket / dir leaf is
      // rejected with NOT_FILE without touching read(). O_NONBLOCK
      // on the open ensures FIFOs don't block at open time.
      // S_IFMT mask 0o170000, S_IFREG = 0o100000.
      if ((openLeaf.leafStat.mode & 0o170000) !== 0o100000) {
        return { ok: false, output: `Not a file: ${absPath}`, error: 'NOT_FILE' };
      }

      const { buf, size, tooLarge } = readFromStartFd(openLeaf.leafFd);
      if (tooLarge) {
        const kb = (size / 1024).toFixed(0);
        if (start_line == null && end_line == null) {
          return {
            ok: false,
            output: `File too large (${kb} KB). Use start_line/end_line to read a portion.`,
            error: 'FILE_TOO_LARGE',
          };
        }
        // The message above tells the model to ask for a range; that request
        // used to be refused by the same size check.
        const range = readLineRangeFd(openLeaf.leafFd, size, start_line, end_line);
        if (!range.lines.length && range.stopped === 'scan') {
          return {
            ok: false,
            output: `Line ${range.first} was not reached within the first ${MAX_SCAN_BYTES / 1024 / 1024} MB of this ${kb} KB file.`,
            error: 'RANGE_NOT_REACHED',
          };
        }
        const numbered = range.lines.map((l, i) => `${range.first + i}\t${l}`).join('\n');
        const lastShown = range.first + range.lines.length - 1;
        const note = range.stopped === 'cap'
          ? `\n...(stopped at line ${lastShown}: a single read returns at most ${MAX_READ_BYTES / 1000} KB; ask for the following lines separately)`
          : range.stopped === 'scan'
            ? `\n...(stopped after line ${lastShown}: the first ${MAX_SCAN_BYTES / 1024 / 1024} MB of the file were searched)`
            : '';
        return {
          ok: true,
          output: numbered + note,
          meta: {
            path: realPath,
            lexicalPath: absPath,
            lines: range.lines.length,
            ...(range.totalLines == null ? {} : { totalLines: range.totalLines }),
            sizeBytes: size,
            ...(range.stopped ? { truncated: true } : {}),
          },
        };
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
