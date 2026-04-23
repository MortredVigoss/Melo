import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { buildSearchSnippet, fuzzySearchScore } from './scoring.js';
import { debugWarn } from '../debug.js';

// ─── Ripgrep binary resolution ───────────────────────────────────────────────
// The binary name is overridable for tests so we can exercise the "rg not
// installed" path (Bug 1) without poking at PATH.  Production code always
// uses plain `rg`, which resolves via execvp on the operating system PATH.
let _ripgrepBinary = 'rg';

/** @internal test-only — pass a name that definitely does not exist on PATH
 *  to simulate a missing ripgrep install, or null to restore the default. */
export function _setRipgrepBinaryForTests(name) {
  _ripgrepBinary = typeof name === 'string' && name ? name : 'rg';
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
    '--max-count',
    '6',
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

  // Bug 1: if rg is not installed on PATH (execvp returns ENOENT), degrade
  // silently — callers observe zero results and the rest of their search
  // pipeline keeps working.  A one-time debug warning helps diagnose but
  // doesn't escalate to an exception the caller has to unwind.
  if (processError && processError.code === 'ENOENT') {
    debugWarn(
      'search.file.rg',
      'ripgrep (rg) not found on PATH — workspace file search disabled',
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
