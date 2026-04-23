import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { buildSearchSnippet, fuzzySearchScore } from './scoring.js';
import { debugWarn } from '../debug.js';

// ─── Ripgrep binary resolution ───────────────────────────────────────────────
// Production resolution order:
//   1. The `@vscode/ripgrep` npm package, which vendors a platform-specific
//      `rg` binary.  This is the happy path — users do not need to install
//      ripgrep themselves, and the binary version is pinned by package.json.
//   2. Plain `rg` on PATH, as a last-resort fallback for environments where
//      node_modules hasn't been unpacked or the vendored binary isn't
//      executable (e.g. certain bundler targets).
// The test hook (_setRipgrepBinaryForTests) forces a specific name to
// exercise the "rg not installed" error branch without touching PATH.
function resolveBundledRipgrep() {
  try {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line import/no-unresolved -- dynamically resolved.
    const mod = require('@vscode/ripgrep');
    if (mod?.rgPath && existsSync(mod.rgPath)) {
      return mod.rgPath;
    }
  } catch (err) {
    debugWarn('search.file.rg', '@vscode/ripgrep unavailable, falling back to PATH', err?.message || err);
  }
  return 'rg';
}

let _ripgrepBinary = resolveBundledRipgrep();

/** @internal test-only — pass a name that definitely does not exist on PATH
 *  to simulate a missing ripgrep install, or null to restore the default
 *  (which is the bundled @vscode/ripgrep binary when available, else 'rg'). */
export function _setRipgrepBinaryForTests(name) {
  _ripgrepBinary = typeof name === 'string' && name ? name : resolveBundledRipgrep();
}

export function normalizeRipgrepPath(filePath = '') {
  return String(filePath || '').replace(/^\.\//, '');
}

export function createFileSearchHit({ path = '', lineNumber = 0, text = '', query = '' } = {}) {
  const normalizedPath = normalizeRipgrepPath(path);
  const normalizedLineNumber = Number(lineNumber) || 0;
  const normalizedText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalizedPath || !normalizedLineNumber) {
    return null;
  }

  return {
    id: `file-hit:${normalizedPath}:${normalizedLineNumber}`,
    kind: 'file-hit',
    iconKey: 'file',
    title: normalizedPath,
    subtitle: buildSearchSnippet(normalizedText, query, 104),
    meta: `Line ${normalizedLineNumber}`,
    updatedAt: new Date().toISOString(),
    filePath: normalizedPath,
    lineNumber: normalizedLineNumber,
    lineText: normalizedText,
    action: { type: 'open-file-match' },
    score: fuzzySearchScore(query, `${normalizedPath}\n${normalizedText}`) + 84,
  };
}

export function parseRipgrepJsonLine(rawLine = '', query = '') {
  if (!String(rawLine || '').trim()) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawLine);
  } catch (err) {
    debugWarn('search.file.rg', 'ripgrep emitted non-JSON line', err?.message || err);
    return null;
  }

  if (parsed.type !== 'match') {
    return null;
  }

  return createFileSearchHit({
    path: parsed.data?.path?.text || '',
    lineNumber: parsed.data?.line_number || 0,
    text: parsed.data?.lines?.text || '',
    query,
  });
}

export async function* streamWorkspaceContent(
  rootPath,
  query,
  { maxMatches = 18, fixedStrings = true } = {},
) {
  if (!rootPath || !String(query || '').trim()) {
    return;
  }

  // Search audit B-3: treat user queries as literal strings by default.
  // Without `--fixed-strings`, ripgrep parses the input as a regex, which
  // (a) silently crashes on unbalanced parentheses / brackets and (b)
  // turns `.` / `*` / `?` into metacharacters users don't mean.  Callers
  // that actually want regex semantics pass `fixedStrings: false`.
  // Search audit P2: broaden the exclude list so `--hidden --no-ignore` doesn't
  // drag in secrets (.env*), editor swap files, stale backups, Finder cruft,
  // or iCloud placeholder stubs.  --max-count drops from 6 → 3 so a single
  // densely-matching file cannot exhaust the maxMatches budget and starve the
  // rest of the workspace from appearing in the result list.
  const args = [
    '--json',
    '--line-number',
    '--hidden',
    '--no-ignore',
    '--glob',
    '!.git',
    '--glob',
    '!node_modules',
    '--glob',
    '!dist',
    '--glob',
    '!build',
    '--glob',
    '!.env*',
    '--glob',
    '!*.swp',
    '--glob',
    '!*.bak',
    '--glob',
    '!*.orig',
    '--glob',
    '!.DS_Store',
    '--glob',
    '!*.icloud',
    '--max-count',
    '3',
    '--smart-case',
  ];
  if (fixedStrings) args.push('--fixed-strings');
  args.push(query, '.');

  const child = spawn(
    _ripgrepBinary,
    args,
    {
      cwd: rootPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  child.stderr.resume();

  const readLines = createInterface({ input: child.stdout });
  let emitted = 0;
  let processError = null;

  child.once('error', error => {
    processError = error;
  });

  // Bug 3: pre-register the 'close' listener BEFORE we start consuming the
  // iterator.  'close' is a single-fire event — if we only bound it after the
  // for-await loop, a child that dies before our await registration (e.g.
  // ENOENT or a very fast no-match) could fire close without anyone listening,
  // leaving us awaiting a promise that never resolves.
  let closeCode = null;
  let closeSignal = null;
  const closed = new Promise(resolve => {
    child.once('close', (code, signal) => {
      closeCode = code;
      closeSignal = signal;
      resolve();
    });
  });

  try {
    for await (const line of readLines) {
      if (emitted >= maxMatches) {
        break;
      }

      const hit = parseRipgrepJsonLine(line, query);
      if (!hit) {
        continue;
      }

      yield hit;
      emitted += 1;
    }
  } finally {
    readLines.close();
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }

  await closed;

  // Bug 1: if the rg binary can't be launched (ENOENT from the bundled
  // @vscode/ripgrep path missing OR a fallback-to-PATH miss), degrade
  // silently — callers observe zero results and the rest of their search
  // pipeline keeps working.  A one-time debug warning helps diagnose but
  // doesn't escalate to an exception the caller has to unwind.
  if (processError && processError.code === 'ENOENT') {
    debugWarn(
      'search.file.rg',
      'ripgrep binary not found (bundled + PATH both missed) — file search disabled',
    );
    return;
  }
  if (processError) {
    throw processError;
  }

  // Bug 2: a signal-death (our own SIGTERM on early break, or any other
  // outside signal) is a normal termination path, not an error.  Without
  // this guard the old `closeCode !== 0 && !== 1 && !== null` check would
  // throw a spurious "rg exited with code 143" whenever a caller hit
  // maxMatches early.
  if (closeSignal) {
    return;
  }
  // Final guard: rg's documented exit codes are 0 (match found), 1 (no
  // match), 2 (error).  Anything else — including libuv's -2 for spawn
  // failures that somehow slipped past the processError branch — is
  // treated as an error.
  if (closeCode !== 0 && closeCode !== 1 && closeCode !== null) {
    throw new Error(`rg exited with code ${closeCode}`);
  }
}

// ─── By-file aggregation ─────────────────────────────────────────────────────
// Search audit P2 follow-up #6: the line-level stream above is exactly right
// for the raw ripgrep transport, but UI renders look cluttered when a single
// file produces many hits — 10 lines from config.json crowd out the 9 other
// files that matched once each.
//
// `streamWorkspaceContentByFile` groups line hits by filePath and emits one
// file-group event per file, carrying up to `hitsPerFile` representative
// lines sorted by score (descending).  A group is flushed the moment it hits
// `hitsPerFile` matches — we don't wait for end-of-stream — so the UI can
// render incrementally.  Files that never reach `hitsPerFile` are flushed
// when the underlying stream ends.
//
// The caller's `maxFiles` cap bounds the total number of groups emitted.
// The underlying line stream is asked for `maxFiles * hitsPerFile` matches
// which is enough to fill every bucket, but the generator can also stop
// early if maxFiles groups fill first.
export async function* streamWorkspaceContentByFile(
  rootPath,
  query,
  { maxFiles = 10, hitsPerFile = 3, fixedStrings = true } = {},
) {
  if (!rootPath || !String(query || '').trim()) {
    return;
  }
  const safeMaxFiles = Math.max(1, Number(maxFiles) || 10);
  const safeHitsPerFile = Math.max(1, Number(hitsPerFile) || 3);

  const byPath = new Map(); // filePath → { hits: [...], emitted: boolean }
  let emittedGroups = 0;

  const inner = streamWorkspaceContent(rootPath, query, {
    maxMatches: safeMaxFiles * safeHitsPerFile,
    fixedStrings,
  });

  try {
    for await (const hit of inner) {
      const existing = byPath.get(hit.filePath);
      if (existing?.emitted) {
        // This file already produced a group — ignore further lines.
        continue;
      }
      const bucket = existing || { hits: [], emitted: false };
      bucket.hits.push(hit);
      byPath.set(hit.filePath, bucket);

      if (bucket.hits.length >= safeHitsPerFile) {
        bucket.emitted = true;
        yield makeFileGroup(bucket.hits, query);
        emittedGroups += 1;
        if (emittedGroups >= safeMaxFiles) {
          return;
        }
      }
    }
  } finally {
    // inner is an async generator — its own finally already kills rg.
  }

  // Flush any under-filled buckets in insertion order (ripgrep streams hits
  // in filesystem traversal order, which is a reasonable tie-break).
  for (const bucket of byPath.values()) {
    if (bucket.emitted) continue;
    if (!bucket.hits.length) continue;
    yield makeFileGroup(bucket.hits, query);
    emittedGroups += 1;
    if (emittedGroups >= safeMaxFiles) return;
  }
}

function makeFileGroup(hits, query) {
  // Sort representative lines by score (desc) then by line number so ties
  // feel natural ("earlier in the file wins").
  const sorted = [...hits].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.lineNumber || 0) - (b.lineNumber || 0);
  });
  const top = sorted[0];
  const filePath = top.filePath;
  return {
    id: `file-group:${filePath}`,
    kind: 'file-group',
    iconKey: 'file',
    title: filePath,
    subtitle: top.subtitle,
    meta: sorted.length > 1 ? `${sorted.length} lines` : `Line ${top.lineNumber}`,
    updatedAt: top.updatedAt,
    filePath,
    lineNumber: top.lineNumber,
    lineText: top.lineText,
    hits: sorted,
    action: { type: 'open-file-match' },
    // Group score = best-in-group, plus a small group-bonus so a file with
    // two medium hits outranks a file with one (slightly-worse) single hit.
    score: top.score + Math.min(30, (sorted.length - 1) * 10),
    query,
  };
}
