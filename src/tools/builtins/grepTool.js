/**
 * Built-in tool: grep
 *
 * Phase 2B (2026-05-04): wired through the FileSafetyGate.
 *
 *   - requestRead({path: targetPath}) — gate classifies the search
 *     base. Workspace-internal silent; outside-benign prompts once;
 *     sensitive (system / credential / $MELO_HOME) prompts per call.
 *   - During the walk, sensitive subtrees are silently skipped
 *     UNLESS the base itself was sensitive (the user explicitly
 *     opted in by approving a sensitive base).
 *   - JS fallback per-file content reads use atomicOpenLeaf with
 *     O_NOFOLLOW (added auto). A leaf that becomes a symlink mid-
 *     walk is silently skipped (treated as if it doesn't exist for
 *     grep purposes — we won't follow into /etc via a swapped link).
 *   - Native ripgrep (`rg`) path: invoke with --no-follow so rg
 *     doesn't follow symlinks; results are post-filtered to drop
 *     anything classifying as sensitive (defence-in-depth).
 *
 * Approval model: a single base-dir approval covers the whole
 * walk. The user does NOT see one prompt per file — that would
 * be unusable for any real grep against thousands of files.
 */

import { readdir } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fstatSync, readSync } from 'node:fs';

import { requestRead } from '../../safety/fileSafetyGate.js';
import { classifyPath, PATH_CATEGORY } from '../../safety/sensitivePaths.js';
import {
  atomicOpenLeaf,
  splitParentLeaf,
  C as DC,
} from '../../safety/dirfdOps.js';

const execFileAsync = promisify(execFile);

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

// ─── ripgrep ───────────────────────────────────────────────────────────

let _rgAvailable = null;
async function isRgAvailable() {
  if (_rgAvailable !== null) return _rgAvailable;
  try {
    await execFileAsync('rg', ['--version'], { timeout: 3000 });
    _rgAvailable = true;
  } catch {
    _rgAvailable = false;
  }
  return _rgAvailable;
}

async function searchViaRg(pattern, targetPath, baseDir, opts) {
  const { include, contextLines, caseInsensitive, maxResults, signal, filterSensitive } = opts;
  const args = [
    '--json',
    '--max-count', '1',
    '--max-filesize', '500K',
    '--no-follow',  // do NOT follow symlinks during walk
  ];
  if (caseInsensitive) args.push('--ignore-case');
  if (contextLines > 0) args.push('--context', String(contextLines));
  if (include) args.push('--glob', include);
  args.push('--', pattern, targetPath);

  let raw;
  try {
    const { stdout } = await execFileAsync('rg', args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 20_000,
      signal,
    });
    raw = stdout;
  } catch (err) {
    if (err.code === 1) return { matches: [], skippedSensitive: 0 };
    throw err;
  }

  const matches = [];
  let skippedSensitive = 0;
  const lines = raw.split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== 'match') continue;

    const absFile = msg.data?.path?.text || '';

    // Defence-in-depth: drop sensitive matches if the base wasn't
    // explicitly sensitive. rg shouldn't have walked into /etc but
    // verify per-result anyway.
    if (filterSensitive && isSensitiveSubtree(absFile)) {
      skippedSensitive++;
      continue;
    }

    const relFile = relative(baseDir, absFile).replace(/\\/g, '/');
    const lineNo = msg.data?.line_number ?? 0;
    const matchText = msg.data?.lines?.text?.trimEnd() ?? '';
    const context = [];
    if (msg.data?.lines) {
      context.push({ lineNo, text: matchText, isMatch: true });
    }
    matches.push({ file: relFile, line: lineNo, text: matchText, context });
    if (matches.length >= maxResults) break;
  }
  return { matches, skippedSensitive };
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
  // atomicOpenLeaf adds O_NOFOLLOW automatically. If the leaf is now
  // a symlink (race or pre-existing in the walk), this throws ELOOP
  // and we silently skip — grep should never silently follow into
  // an unexpected target.
  const [parent, leaf] = splitParentLeaf(absPath);
  let openLeaf;
  try {
    openLeaf = await atomicOpenLeaf(parent, leaf, DC.O_RDONLY);
  } catch {
    return [];
  }
  try {
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

async function walk(dir, baseDir, fileRe, searchRe, results, contextLines, maxMatches, signal, skipped, filterSensitive) {
  if (results.length >= maxMatches) return;
  if (signal?.aborted) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxMatches) break;
    if (IGNORED.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);

    if (filterSensitive && isSensitiveSubtree(fullPath)) {
      skipped.sensitive++;
      continue;
    }

    const relPath = relative(baseDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      await walk(fullPath, baseDir, fileRe, searchRe, results, contextLines, maxMatches, signal, skipped, filterSensitive);
    } else if (entry.isFile() && (!fileRe || fileRe.test(relPath))) {
      const fileMatches = await searchFileAtomic(fullPath, relPath, searchRe, contextLines, 20);
      results.push(...fileMatches.slice(0, maxMatches - results.length));
    }
  }
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
  requiresPermission: true,
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

    try {
      if (await isRgAvailable()) {
        const { matches: rgMatches, skippedSensitive } = await searchViaRg(pattern, realBase, baseDir, {
          include,
          contextLines: ctxLines,
          caseInsensitive: case_insensitive,
          maxResults,
          signal,
          filterSensitive,
        });
        allMatches.push(...rgMatches);
        skipped.sensitive += skippedSensitive;
      } else {
        let fileRe = null;
        if (include) {
          try { fileRe = globToRegex(include); } catch { /* ignore */ }
        }

        const { stat } = await import('node:fs/promises');
        const s = await stat(realBase).catch(() => null);

        if (s?.isFile()) {
          const relPath = relative(baseDir, realBase).replace(/\\/g, '/');
          const fileMatches = await searchFileAtomic(realBase, relPath, searchRe, ctxLines, maxResults);
          allMatches.push(...fileMatches);
        } else {
          await walk(realBase, baseDir, fileRe, searchRe, allMatches, ctxLines, maxResults, signal, skipped, filterSensitive);
        }
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
