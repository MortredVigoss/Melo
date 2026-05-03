/**
 * Built-in tool: glob
 *
 * Phase 2B (2026-05-04): wired through the FileSafetyGate.
 *
 * Base-dir safety:
 *   - requestRead({path: baseDir}) — gate classifies. Workspace-internal
 *     base is silent; outside-but-benign base prompts once per glob;
 *     sensitive base (system / credential / $MELO_HOME) prompts every
 *     time (never granted session-wide).
 *
 * Walk-time sensitivity skip:
 *   - During the recursive directory walk, skip any subtree whose
 *     classifyPath says system / credential / $MELO_HOME — the agent
 *     never sees their contents leak into glob results, even when
 *     globbing from a benign parent like ~/.
 *
 * Returns matching paths (no content reads). The walk uses readdir
 * with withFileTypes — no symlink follow on directory entries (a
 * symlinked dir is treated as a non-directory entry and not
 * recursed into).
 */

import { readdir } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';

import { requestRead } from '../../safety/fileSafetyGate.js';
import { classifyPath, PATH_CATEGORY } from '../../safety/sensitivePaths.js';

// ─── Minimal glob implementation ──────────────────────────────────────────────

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
        const alts = pattern.slice(i + 1, end).split(',').map(escapeRegex);
        re += `(?:${alts.join('|')})`;
        i = end + 1;
      }
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i);
      if (end === -1) { re += '\\['; i++; }
      else { re += pattern.slice(i, end + 1); i = end + 1; }
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

// ─── Walk ──────────────────────────────────────────────────────────────

const IGNORED = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', '.turbo',
  '__pycache__', '.venv', 'venv', '.env', 'target', 'vendor',
  '.cache', '.parcel-cache', 'coverage', '.nyc_output', 'out',
  '.svelte-kit', '.nuxt', '.output', 'elm-stuff', '.dart_tool',
]);

// Sensitive sub-trees: skip silently during the walk so glob
// results never leak ~/.ssh/* or /etc/* into the agent's view.
// classifyPath returns `safe` for benign paths and one of the
// hard-blocked categories for the rest.
function isSensitiveSubtree(absPath) {
  const cat = classifyPath(absPath);
  return cat === PATH_CATEGORY.SYSTEM
      || cat === PATH_CATEGORY.CREDENTIAL
      || cat === PATH_CATEGORY.MELO_INTERNAL;
}

async function walk(dir, baseDir, regex, results, signal, maxResults, skipped, filterSensitive) {
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

    // Skip sensitive subtrees only when the BASE was benign — if the
    // user explicitly approved a sensitive base (e.g. they're
    // globbing /etc), don't filter entries inside it.
    if (filterSensitive && isSensitiveSubtree(fullPath)) {
      skipped.sensitive++;
      continue;
    }

    const relPath = relative(baseDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      await walk(fullPath, baseDir, regex, results, signal, maxResults, skipped, filterSensitive);
    } else if (entry.isFile() && regex.test(relPath)) {
      results.push(relPath);
    }
  }
}

export const globTool = {
  id: 'glob',
  name: 'Glob',
  description:
    'Find files matching a glob pattern under a base directory. ' +
    'The base directory is gated by FileSafetyGate (workspace-internal silent; ' +
    'outside-benign prompts once; sensitive — system / credential / $MELO_HOME — prompts per call). ' +
    'During the walk, sensitive subtrees (e.g. ~/.ssh, /etc) are silently skipped so their ' +
    'paths never leak into the result; meta.skippedSensitive reports how many. ' +
    'Returns matching paths relative to the base directory. Supports *, **, ?, and {a,b} patterns.',
  category: 'filesystem',
  // Round 13 Phase 2B follow-up #1 (Codex 🟡): FileSafetyGate owns
  // path-level approval; toolId-level requiresPermission would
  // double-prompt (executor's generic "allow glob?" before our
  // base-dir classification fires).
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
        description: 'Base directory to search in (default: workspace root).',
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

  async run(args, context = {}) {
    const { pattern, cwd, max_results = 200 } = args;
    const { workspacePath, signal, sseEmitter, chatId } = context;

    if (typeof pattern !== 'string' || !pattern) {
      return { ok: false, output: 'pattern must be a non-empty string.', error: 'INVALID_ARGS' };
    }

    const baseDir = isAbsolute(cwd || '')
      ? cwd
      : resolve(workspacePath || process.cwd(), cwd || '.');

    const maxResults = Math.min(Math.max(1, max_results), 1000);

    let regex;
    try {
      regex = globToRegex(pattern);
    } catch (err) {
      return { ok: false, output: `Invalid glob pattern: ${err.message}`, error: err.message };
    }

    // ── Gate the base dir ────────────────────────────────────────────
    let approved;
    try {
      approved = await requestRead({
        path: baseDir,
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
    // Filter sensitive subtrees only if the BASE itself is benign.
    const filterSensitive = !isSensitiveSubtree(realBase);

    const results = [];
    const skipped = { sensitive: 0 };
    try {
      await walk(realBase, realBase, regex, results, signal, maxResults, skipped, filterSensitive);
    } catch (err) {
      return { ok: false, output: `Walk error: ${err.message}`, error: err.message };
    }

    results.sort();

    const skipNote = skipped.sensitive > 0
      ? ` (${skipped.sensitive} sensitive entries skipped)`
      : '';

    if (!results.length) {
      return {
        ok: true,
        output: `No files matched pattern: ${pattern}${skipNote}`,
        meta: { count: 0, skippedSensitive: skipped.sensitive, baseDir: realBase },
      };
    }

    return {
      ok: true,
      output: results.join('\n') + (skipNote ? `\n# ${skipNote}` : ''),
      meta: {
        count: results.length,
        truncated: results.length >= maxResults,
        skippedSensitive: skipped.sensitive,
        baseDir: realBase,
      },
    };
  },
};
