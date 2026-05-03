/**
 * Built-in tool: grep
 *
 * Phase 2B (2026-05-04) + follow-up #2 (Codex 🔴, 2026-05-04):
 *
 *   - requestRead({path: targetPath}) — gate classifies the search
 *     base. Workspace-internal silent; outside-benign prompts once;
 *     sensitive (system / credential / $MELO_HOME) prompts per call.
 *   - JS walker enumerates safe files (sensitive subtrees skipped
 *     unless the base itself is sensitive). Per-file content read
 *     uses dirfd-bound atomicOpenLeaf with O_NOFOLLOW + O_NONBLOCK,
 *     and post-open S_ISREG check rejects FIFOs / device files.
 *
 *   - **rg fast path was REMOVED** in Phase 2B follow-up #2 (Codex
 *     🔴): even with pre-enumerated safe paths, handing the list
 *     to an external `rg` process meant rg re-opened each file by
 *     PATH (not by our dirfd-bound fd). Between our enumeration's
 *     atomicLstat and rg's open, an attacker could swap the leaf
 *     for a symlink and rg would happily read the swapped target.
 *     The only TOCTOU-safe rg integration would spawn rg per-file
 *     with the fd as stdin, completely losing rg's batch perf
 *     advantage. So: kill the fast path, ship the JS walker, and
 *     leave perf optimization to a future phase that proves
 *     fd-bound semantics. melo workspaces are typically < 10k
 *     files, where JS grep is acceptable.
 *
 * Approval model: single base-dir approval covers the whole walk.
 */

import { join, relative, resolve, isAbsolute } from 'node:path';
import { fstatSync, readSync } from 'node:fs';

import { requestRead } from '../../safety/fileSafetyGate.js';
import { classifyPath, PATH_CATEGORY } from '../../safety/sensitivePaths.js';
import {
  atomicOpenLeaf,
  openParentDirFd,
  splitParentLeaf,
  _raw as dirfdRaw,
  C as DC,
} from '../../safety/dirfdOps.js';

const IGNORED = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', '.turbo',
  '__pycache__', '.venv', 'venv', '.env', 'target', 'vendor',
  '.cache', '.parcel-cache', 'coverage', '.nyc_output', 'out',
  '.svelte-kit', '.nuxt', '.output', 'elm-stuff', '.dart_tool',
]);
const MAX_FILE_SIZE = 500_000;

function isSensitiveSubtree(absPath) {
  const cat = classifyPath(absPath);
  return cat === PATH_CATEGORY.SYSTEM
      || cat === PATH_CATEGORY.CREDENTIAL
      || cat === PATH_CATEGORY.MELO_INTERNAL;
}

// ─── Glob → regex ──────────────────────────────────────────────────────

function globToRegex(pattern) {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i += 2; if (pattern[i] === '/') i++; }
      else { re += '[^/]*'; i++; }
    } else if (ch === '?') { re += '[^/]'; i++; }
    else if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) { re += '\\{'; i++; }
      else {
        const alts = pattern.slice(i + 1, end).split(',').map(s => s.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
        re += `(?:${alts.join('|')})`;
        i = end + 1;
      }
    } else { re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&'); i++; }
  }
  re += '$';
  return new RegExp(re);
}

// ─── File-level search via dirfd-bound open ────────────────────────────

function readFileContentViaFd(fd, maxSize) {
  const st = fstatSync(fd);
  if (st.size === 0 || st.size > maxSize) return null;
  const buf = Buffer.allocUnsafe(st.size);
  let total = 0;
  while (total < st.size) {
    const n = readSync(fd, buf, total, st.size - total, total);
    if (n === 0) break;
    total += n;
  }
  return buf.subarray(0, total);
}

async function searchFileAtomic(absPath, relPath, searchRe, contextLines, maxMatchesPerFile) {
  // atomicOpenLeaf adds O_NOFOLLOW automatically. O_NONBLOCK avoids
  // hangs on FIFOs / device files (the open returns immediately
  // even if the FIFO has no writer). The post-open S_ISREG check
  // then rejects non-regular files before we read.
  const [parent, leaf] = splitParentLeaf(absPath);
  let openLeaf;
  try {
    openLeaf = await atomicOpenLeaf(parent, leaf, DC.O_RDONLY | DC.O_NONBLOCK);
  } catch {
    return [];
  }
  try {
    // S_IFMT mask 0o170000, S_IFREG = 0o100000. Skip silently if not
    // a regular file (FIFO / dev / socket would otherwise read garbage
    // or block, and shouldn't be in a grep result anyway).
    if ((openLeaf.leafStat.mode & 0o170000) !== 0o100000) return [];
    const buf = readFileContentViaFd(openLeaf.leafFd, MAX_FILE_SIZE);
    if (!buf) return [];
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxMatchesPerFile) break;
      if (searchRe.test(lines[i])) {
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        const ctx = lines.slice(start, end + 1).map((l, off) => ({
          lineNo: start + off + 1,
          text: l,
          isMatch: start + off === i,
        }));
        matches.push({ file: relPath, line: i + 1, text: lines[i], context: ctx });
      }
    }
    return matches;
  } finally {
    openLeaf.closeLeaf();
  }
}

/**
 * TOCTOU-safe pre-classified safe-file enumeration (Phase 2B
 * follow-up #3). Each recursion step opens the child dir through
 * `openat(parentFd, name, O_DIRECTORY|O_NOFOLLOW)` so a dir entry
 * swapped to a symlink between readdirAt and our openat returns
 * ELOOP and is silently skipped. The resulting child fd binds the
 * inode; readdirAt only sees that inode's entries.
 *
 * Sensitive-subtree skip is bypassed when `filterSensitive` is
 * false (user explicitly approved a sensitive base).
 */
async function enumerateSafeFiles(baseDir, fileRe, signal, skipped, filterSensitive, maxFiles) {
  const out = [];
  let baseFd;
  try { baseFd = openParentDirFd(baseDir); }
  catch { return out; }

  async function recurse(parentFd, parentRelDir) {
    if (out.length >= maxFiles) return;
    if (signal?.aborted) return;
    let entries;
    try { entries = dirfdRaw.readdirAt(parentFd); }
    catch { return; }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (IGNORED.has(entry.name)) continue;
      const fullPath = parentRelDir
        ? join(baseDir, parentRelDir, entry.name)
        : join(baseDir, entry.name);
      if (filterSensitive && isSensitiveSubtree(fullPath)) {
        skipped.sensitive++;
        continue;
      }
      const relPath = parentRelDir ? `${parentRelDir}/${entry.name}` : entry.name;
      if (entry.kind === 'dir') {
        let childFd = -1;
        try {
          childFd = dirfdRaw.openat(
            parentFd,
            entry.name,
            DC.O_RDONLY | DC.O_DIRECTORY | DC.O_NOFOLLOW,
          );
        } catch {
          continue;  // ELOOP / ENOENT — skip swapped/missing entry
        }
        try { await recurse(childFd, relPath); }
        finally { try { dirfdRaw.closeFd(childFd); } catch {} }
      } else if (entry.kind === 'file' && (!fileRe || fileRe.test(relPath))) {
        out.push(fullPath);
      }
    }
  }

  try { await recurse(baseFd, ''); }
  finally { try { dirfdRaw.closeFd(baseFd); } catch {} }
  return out;
}

async function searchFileListAtomic(fileList, baseDir, searchRe, contextLines, maxMatches) {
  const results = [];
  for (const absPath of fileList) {
    if (results.length >= maxMatches) break;
    const relPath = relative(baseDir, absPath).replace(/\\/g, '/');
    const fileMatches = await searchFileAtomic(absPath, relPath, searchRe, contextLines, 20);
    results.push(...fileMatches.slice(0, maxMatches - results.length));
  }
  return results;
}

// ─── Tool ──────────────────────────────────────────────────────────────

export const grepTool = {
  id: 'grep',
  name: 'Grep',
  description:
    'Search file contents for a pattern using regex or literal text. ' +
    'The base directory is gated by FileSafetyGate (workspace-internal silent; outside-benign prompts once; ' +
    'sensitive — system / credential / $MELO_HOME — prompts per call). ' +
    'During the walk, sensitive subtrees are silently skipped unless the base itself is sensitive ' +
    '(meta.skippedSensitive reports how many). ' +
    'Per-file reads use dirfd-bound O_NOFOLLOW open (a leaf that becomes a symlink mid-walk is skipped, never followed). ' +
    'Returns matching lines with optional surrounding context. Use include to restrict to certain file types (e.g. "*.js").',
  category: 'filesystem',
  // Round 13 Phase 2B follow-up #1 (Codex 🟡): FileSafetyGate owns
  // path-level approval; toolId-level requiresPermission would
  // double-prompt (executor's generic "allow grep?" before our
  // base-dir classification fires).
  requiresPermission: false,
  isConcurrencySafe: true,
  parametersSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Search pattern. Treated as a JavaScript regular expression.',
      },
      path: {
        type: 'string',
        description: 'Directory or file to search (default: workspace root).',
      },
      include: {
        type: 'string',
        description: 'Glob pattern to restrict which files are searched, e.g. "*.ts" or "src/**".',
      },
      context_lines: {
        type: 'number',
        description: 'Lines of context before/after each match (default: 0).',
      },
      case_insensitive: {
        type: 'boolean',
        description: 'Case-insensitive search (default: false).',
      },
      max_results: {
        type: 'number',
        description: 'Maximum total matches to return (default: 100).',
      },
    },
    required: ['pattern'],
  },
  examples: [
    { pattern: 'TODO', include: '*.js' },
    { pattern: 'function\\s+\\w+', context_lines: 2 },
    { pattern: 'import.*from', case_insensitive: true },
  ],

  async run(args, context = {}) {
    const {
      pattern,
      path: searchPath,
      include,
      context_lines = 0,
      case_insensitive = false,
      max_results = 100,
    } = args;
    const { workspacePath, signal, sseEmitter, chatId } = context;

    if (typeof pattern !== 'string' || !pattern) {
      return { ok: false, output: 'pattern must be a non-empty string.', error: 'INVALID_ARGS' };
    }

    const workspaceRoot = resolve(workspacePath || process.cwd());
    const targetPath = isAbsolute(searchPath || '')
      ? searchPath
      : resolve(workspaceRoot, searchPath || '.');
    const maxResults = Math.min(Math.max(1, max_results), 500);
    const ctxLines = Math.min(Math.max(0, context_lines), 10);

    let searchRe;
    try {
      searchRe = new RegExp(pattern, case_insensitive ? 'i' : '');
    } catch (err) {
      return { ok: false, output: `Invalid regex pattern: ${err.message}`, error: err.message };
    }

    // ── Gate the base ────────────────────────────────────────────────
    let approved;
    try {
      approved = await requestRead({
        path: targetPath,
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
    const realBase = approved.resolvedTarget;
    const baseDir = realBase;
    const filterSensitive = !isSensitiveSubtree(realBase);

    const allMatches = [];
    const skipped = { sensitive: 0 };

    let fileRe = null;
    if (include) {
      try { fileRe = globToRegex(include); } catch { /* ignore */ }
    }

    try {
      const { stat } = await import('node:fs/promises');
      const s = await stat(realBase).catch(() => null);

      // Single-file base: just search that one file.
      if (s?.isFile()) {
        const relPath = relative(baseDir, realBase).replace(/\\/g, '/');
        const fileMatches = await searchFileAtomic(realBase, relPath, searchRe, ctxLines, maxResults);
        allMatches.push(...fileMatches);
      } else {
        // Directory base: enumerate safe files via JS walker, then
        // search each via dirfd-bound atomicOpenLeaf. rg fast path
        // was removed in Phase 2B follow-up #2 — passing paths to
        // an external rg process let it re-open files by path,
        // bypassing our O_NOFOLLOW + O_NONBLOCK + S_ISREG checks
        // and reintroducing leaf-swap TOCTOU. JS walker only.
        const safeFiles = await enumerateSafeFiles(
          realBase, fileRe, signal, skipped, filterSensitive, 5000,
        );
        const jsMatches = await searchFileListAtomic(safeFiles, baseDir, searchRe, ctxLines, maxResults);
        allMatches.push(...jsMatches);
      }
    } catch (err) {
      return { ok: false, output: `Search error: ${err.message}`, error: err.message };
    }

    const skipNote = skipped.sensitive > 0
      ? ` (${skipped.sensitive} sensitive entries skipped)`
      : '';

    if (!allMatches.length) {
      return {
        ok: true,
        output: `No matches found for: ${pattern}${skipNote}`,
        meta: { count: 0, skippedSensitive: skipped.sensitive, baseDir: realBase },
      };
    }

    const lines = [];
    let lastFile = null;
    for (const m of allMatches) {
      if (m.file !== lastFile) {
        if (lastFile !== null) lines.push('');
        lines.push(`${m.file}:`);
        lastFile = m.file;
      }
      if (ctxLines > 0 && m.context) {
        for (const c of m.context) {
          const marker = c.isMatch ? '>' : ' ';
          lines.push(`  ${marker} ${c.lineNo}:\t${c.text}`);
        }
        lines.push('  ---');
      } else {
        lines.push(`  ${m.line}:\t${m.text}`);
      }
    }
    if (skipNote) lines.push(`# ${skipNote}`);

    return {
      ok: true,
      output: lines.join('\n'),
      meta: {
        count: allMatches.length,
        truncated: allMatches.length >= maxResults,
        skippedSensitive: skipped.sensitive,
        baseDir: realBase,
      },
    };
  },
};
