/**
 * Built-in tool: glob
 *
 * Fast file pattern matching using glob syntax.
 * No permission required — read-only, safe.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

// ─── Minimal glob implementation ──────────────────────────────────────────────
// Converts a glob pattern to a RegExp.
// Supported: * (non-separator wildcard), ** (any path), ? (single char), {a,b} (alternation)

function globToRegex(pattern) {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i++; // skip trailing slash after **
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        i++;
      } else {
        const alts = pattern.slice(i + 1, end).split(',').map(escapeRegex);
        re += `(?:${alts.join('|')})`;
        i = end + 1;
      }
    } else if (ch === '[') {
      // Pass bracket expressions through as-is
      const end = pattern.indexOf(']', i);
      if (end === -1) {
        re += '\\[';
        i++;
      } else {
        re += pattern.slice(i, end + 1);
        i = end + 1;
      }
    } else {
      re += escapeRegex(ch);
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

function escapeRegex(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

// ─── Recursive directory walk ──────────────────────────────────────────────────

const IGNORED = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', '.turbo',
  '__pycache__', '.venv', 'venv', '.env', 'target', 'vendor',
  '.cache', '.parcel-cache', 'coverage', '.nyc_output', 'out',
  '.svelte-kit', '.nuxt', '.output', 'elm-stuff', '.dart_tool',
]);

async function walk(dir, baseDir, regex, results, signal, maxResults = 500) {
  if (results.length >= maxResults) return;
  if (signal?.aborted) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxResults) break;
    if (IGNORED.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(baseDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      await walk(fullPath, baseDir, regex, results, signal, maxResults);
    } else if (entry.isFile() && regex.test(relPath)) {
      results.push(relPath);
    }
  }
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export const globTool = {
  id: 'glob',
  name: 'Glob',
  description:
    'Find files matching a glob pattern in the workspace. ' +
    'Returns matching paths relative to the workspace root. ' +
    'Supports *, **, ?, and {a,b} patterns.',
  category: 'filesystem',
  requiresPermission: false,
  isConcurrencySafe: true,
  parametersSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern, e.g. "src/**/*.js", "**/*.{ts,tsx}".',
      },
      cwd: {
        type: 'string',
        description: 'Directory to search in (default: workspace root).',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return (default: 200).',
      },
    },
    required: ['pattern'],
  },
  examples: [
    { pattern: 'src/**/*.js' },
    { pattern: '**/*.{ts,tsx}' },
    { pattern: '**/*.test.*' },
  ],

  /**
   * @param {{ pattern: string, cwd?: string, max_results?: number }} args
   * @param {import('../tool.js').ToolRunContext} context
   * @returns {Promise<import('../tool.js').ToolResult>}
   */
  async run(args, context = {}) {
    const { pattern, cwd, max_results = 200 } = args;
    const { workspacePath, signal } = context;

    const baseDir = resolve(cwd || workspacePath || process.cwd());
    const maxResults = Math.min(Math.max(1, max_results), 1000);

    let regex;
    try {
      regex = globToRegex(pattern);
    } catch (err) {
      return { ok: false, output: `Invalid glob pattern: ${err.message}`, error: err.message };
    }

    const results = [];
    try {
      await walk(baseDir, baseDir, regex, results, signal, maxResults);
    } catch (err) {
      return { ok: false, output: `Walk error: ${err.message}`, error: err.message };
    }

    results.sort();

    if (!results.length) {
      return { ok: true, output: `No files matched pattern: ${pattern}`, meta: { count: 0 } };
    }

    return {
      ok: true,
      output: results.join('\n'),
      meta: { count: results.length, truncated: results.length >= maxResults },
    };
  },
};
