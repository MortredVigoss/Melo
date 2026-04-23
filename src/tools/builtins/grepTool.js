/**
 * Built-in tool: grep
 *
 * Search file contents for a regex or literal pattern.
 * Delegates to native ripgrep (rg) when available for 10-100x speed on large repos.
 * Falls back to pure-JS recursive walk otherwise.
 * No permission required — read-only, safe.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Directories to skip in the JS fallback walker
const IGNORED = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', '.turbo',
  '__pycache__', '.venv', 'venv', '.env', 'target', 'vendor',
  '.cache', '.parcel-cache', 'coverage', '.nyc_output', 'out',
  '.svelte-kit', '.nuxt', '.output', 'elm-stuff', '.dart_tool',
]);
const MAX_FILE_SIZE = 500_000; // 500 KB

// ─── Native ripgrep delegation ────────────────────────────────────────────────

/**
 * Check if rg (ripgrep) is available. Cached after first check.
 */
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

/**
 * Run ripgrep and return structured match objects compatible with the JS fallback.
 */
async function searchViaRg(pattern, targetPath, baseDir, { include, contextLines, caseInsensitive, maxResults, signal }) {
  const args = [
    '--json',
    '--max-count', '1',         // per-file match cap handled by maxResults total
    '--max-filesize', '500K',
  ];

  if (caseInsensitive) args.push('--ignore-case');
  if (contextLines > 0) args.push('--context', String(contextLines));
  if (include) args.push('--glob', include);
  args.push('--', pattern, targetPath);

  let raw;
  try {
    const { stdout } = await execFileAsync('rg', args, {
      maxBuffer: 10 * 1024 * 1024,  // 10 MB
      timeout: 20_000,
      signal,
    });
    raw = stdout;
  } catch (err) {
    // rg exits 1 when no matches — not an error
    if (err.code === 1) return [];
    throw err;
  }

  const matches = [];
  const lines = raw.split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type !== 'match') continue;

    const absFile = msg.data?.path?.text || '';
    const relFile = relative(baseDir, absFile).replace(/\\/g, '/');
    const lineNo = msg.data?.line_number ?? 0;
    const matchText = msg.data?.lines?.text?.trimEnd() ?? '';

    // Build context from submatches or surrounding lines
    const context = [];
    if (msg.data?.lines) {
      context.push({ lineNo, text: matchText, isMatch: true });
    }

    matches.push({ file: relFile, line: lineNo, text: matchText, context });
    if (matches.length >= maxResults) break;
  }

  return matches;
}

// ─── Glob pattern → regex (lightweight, mirrors globTool) ─────────────────────

function globToRegex(pattern) {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i++;
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) { re += '\\{'; i++; }
      else {
        const alts = pattern.slice(i + 1, end).split(',').map(s => s.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
        re += `(?:${alts.join('|')})`;
        i = end + 1;
      }
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

// ─── File-level search ────────────────────────────────────────────────────────

/**
 * Search a single file for lines matching `searchRe`.
 * Returns up to `maxMatchesPerFile` match objects.
 */
async function searchFile(absPath, relPath, searchRe, contextLines, maxMatchesPerFile) {
  let text;
  try {
    text = await readFile(absPath, 'utf8');
  } catch {
    return [];
  }

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
}

// ─── Recursive directory walk ─────────────────────────────────────────────────

async function walk(dir, baseDir, fileRe, searchRe, results, contextLines, maxMatches, maxFiles, signal) {
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
    const relPath = relative(baseDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      await walk(fullPath, baseDir, fileRe, searchRe, results, contextLines, maxMatches, maxFiles, signal);
    } else if (entry.isFile() && (!fileRe || fileRe.test(relPath))) {
      const fileMatches = await searchFile(fullPath, relPath, searchRe, contextLines, 20);
      results.push(...fileMatches.slice(0, maxMatches - results.length));
    }
  }
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export const grepTool = {
  id: 'grep',
  name: 'Grep',
  description:
    'Search file contents for a pattern using regex or literal text. ' +
    'Returns matching lines with optional surrounding context. ' +
    'Use include to restrict to certain file types (e.g. "*.js").',
  category: 'filesystem',
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

  /**
   * @param {{ pattern: string, path?: string, include?: string, context_lines?: number, case_insensitive?: boolean, max_results?: number }} args
   * @param {import('../tool.js').ToolRunContext} context
   * @returns {Promise<import('../tool.js').ToolResult>}
   */
  async run(args, context = {}) {
    const {
      pattern,
      path: searchPath,
      include,
      context_lines = 0,
      case_insensitive = false,
      max_results = 100,
    } = args;
    const { workspacePath, signal } = context;

    const workspaceRoot = resolve(workspacePath || process.cwd());
    const targetPath = searchPath ? resolve(workspaceRoot, searchPath) : workspaceRoot;
    const baseDir = targetPath;
    const maxResults = Math.min(Math.max(1, max_results), 500);
    const ctxLines = Math.min(Math.max(0, context_lines), 10);

    // Validate the pattern early (needed for both paths)
    try {
      new RegExp(pattern, case_insensitive ? 'i' : '');
    } catch (err) {
      return { ok: false, output: `Invalid regex pattern: ${err.message}`, error: err.message };
    }

    const allMatches = [];

    try {
      // ── Native rg path ─────────────────────────────────────────────────────
      if (await isRgAvailable()) {
        const rgMatches = await searchViaRg(pattern, targetPath, baseDir, {
          include,
          contextLines: ctxLines,
          caseInsensitive: case_insensitive,
          maxResults,
          signal,
        });
        allMatches.push(...rgMatches);
      } else {
        // ── JS fallback ──────────────────────────────────────────────────────
        const searchRe = new RegExp(pattern, case_insensitive ? 'i' : '');
        let fileRe = null;
        if (include) {
          try { fileRe = globToRegex(include); } catch { /* ignore */ }
        }

        const { stat } = await import('node:fs/promises');
        const s = await stat(targetPath).catch(() => null);

        if (s?.isFile()) {
          const relPath = relative(baseDir, targetPath).replace(/\\/g, '/');
          const fileMatches = await searchFile(targetPath, relPath, searchRe, ctxLines, maxResults);
          allMatches.push(...fileMatches);
        } else {
          await walk(targetPath, baseDir, fileRe, searchRe, allMatches, ctxLines, maxResults, 1000, signal);
        }
      }
    } catch (err) {
      return { ok: false, output: `Search error: ${err.message}`, error: err.message };
    }

    if (!allMatches.length) {
      return { ok: true, output: `No matches found for: ${pattern}`, meta: { count: 0 } };
    }

    // Format output
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

    return {
      ok: true,
      output: lines.join('\n'),
      meta: { count: allMatches.length, truncated: allMatches.length >= maxResults },
    };
  },
};
