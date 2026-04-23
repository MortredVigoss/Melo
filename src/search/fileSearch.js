import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { buildSearchSnippet, fuzzySearchScore } from './scoring.js';
import { debugWarn } from '../debug.js';

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
    'rg',
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

  const exitCode = await new Promise(resolve => {
    child.once('close', code => resolve(code));
  });

  if (processError && processError.code !== 'ENOENT') {
    throw processError;
  }

  if (exitCode !== 0 && exitCode !== 1 && exitCode !== null) {
    throw new Error(`rg exited with code ${exitCode}`);
  }
}
