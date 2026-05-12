import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import {
  readUrlWithExternalReader,
  readUrlWithExternalReaders,
} from './externalReaders.js';

const LONG_MARKDOWN = [
  '# Example article',
  '',
  'This is a stable extracted body with enough text to pass the useful-content gate.',
  'It represents a readable web page after an optional external reader succeeds.',
  'The content is intentionally long enough for Melo to treat it as real page text.',
].join('\n');

test('readUrlWithExternalReader: crawl4ai uses crwl markdown-fit output', async () => {
  const seen = [];
  const result = await readUrlWithExternalReader('crawl4ai', 'https://example.com/a', {
    _runCommand: async (command, args) => {
      seen.push({ command, args });
      return LONG_MARKDOWN;
    },
  });

  assert.equal(result.method, 'crawl4ai');
  assert.match(result.content, /Example article/);
  assert.equal(seen[0].command, process.env.MELO_CRAWL4AI_BIN || 'crwl');
  assert.deepEqual(seen[0].args.slice(0, 5), ['crawl', 'https://example.com/a', '-o', 'markdown-fit', '--bypass-cache']);
});

test('readUrlWithExternalReader: scrapling writes and reads markdown output file', async () => {
  let outputPath = '';
  let seenArgs = [];
  const result = await readUrlWithExternalReader('scrapling', 'https://example.com/a', {
    cookies: 'session=abc',
    _runCommand: async (command, args) => {
      outputPath = args[3];
      seenArgs = args;
      await writeFile(outputPath, LONG_MARKDOWN, 'utf8');
      return '';
    },
  });

  assert.equal(result.method, 'scrapling');
  assert.match(result.content, /stable extracted body/);
  assert.ok(outputPath.endsWith('content.md'));
  assert.deepEqual(seenArgs.slice(-2), ['-H', 'Cookie: session=abc']);
});

test('readUrlWithExternalReader: camoufox accepts JSON payload from local Python wrapper', async () => {
  const result = await readUrlWithExternalReader('camoufox', 'https://example.com/a', {
    _runCommand: async () => JSON.stringify({
      method: 'camoufox',
      url: 'https://example.com/final',
      content: LONG_MARKDOWN,
    }),
  });

  assert.equal(result.method, 'camoufox');
  assert.equal(result.finalUrl, 'https://example.com/final');
  assert.match(result.content, /Example article/);
});

test('readUrlWithExternalReaders: tries readers in order and skips misses', async () => {
  const calls = [];
  const result = await readUrlWithExternalReaders('https://example.com/a', {
    preferred: ['crawl4ai', 'camoufox'],
    _runCommand: async (command) => {
      calls.push(command);
      if (command === (process.env.MELO_CRAWL4AI_BIN || 'crwl')) {
        return 'too short';
      }
      return JSON.stringify({ method: 'camoufox', content: LONG_MARKDOWN });
    },
  });

  assert.equal(result.method, 'camoufox');
  assert.equal(calls.length, 2);
});

// ─── §6 regression guards (2026-05-12 audit follow-up) ─────────────────────
//
// Codex's original change introduced the `MELO_EXTERNAL_READERS_DIR` env
// var + derived dir arrays as module-load consts.  That's the same CLAUDE.md
// §6 violation pattern the G-6 audit (6/6, b73c118) just cleaned up across
// the repo: a fresh `process.env.MELO_EXTERNAL_READERS_DIR` set after import
// wouldn't take effect.  These guards lock the lazy form in so a future
// "simplify by hoisting to module-load const" refactor breaks loudly.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function _externalReadersSourceWithoutComments() {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, 'externalReaders.js'), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/\/\/[^\n]*/g, '');         // line comments
}

test('§6 guard: MELO_EXTERNAL_READERS_DIR is NOT captured into a module-load const', () => {
  const code = _externalReadersSourceWithoutComments();
  assert.equal(
    /const\s+MELO_EXTERNAL_READERS_DIR\s*=\s*process\.env\.MELO_EXTERNAL_READERS_DIR/.test(code),
    false,
    'MELO_EXTERNAL_READERS_DIR must be inside a function body (lazy resolver), not a top-level const — that re-introduces the §6 freeze the G-6 audit cleaned up',
  );
});

test('§6 guard: derived dir arrays are NOT module-load consts', () => {
  const code = _externalReadersSourceWithoutComments();
  assert.equal(
    /\bconst\s+EXTERNAL_READERS_DIRS\s*=/.test(code),
    false,
    'EXTERNAL_READERS_DIRS must be a lazy function (externalReadersDirs), not a const — its value derives from the env-dependent getter',
  );
  assert.equal(
    /\bconst\s+EXTERNAL_READERS_BIN_DIRS\s*=/.test(code),
    false,
    'EXTERNAL_READERS_BIN_DIRS must be lazy (externalReadersBinDirs function)',
  );
  assert.equal(
    /\bconst\s+EXTERNAL_READERS_PIPX_VENVS_DIRS\s*=/.test(code),
    false,
    'EXTERNAL_READERS_PIPX_VENVS_DIRS must be lazy (externalReadersPipxVenvsDirs function)',
  );
  assert.equal(
    /\bconst\s+PIPX_VENVS_DIRS\s*=/.test(code),
    false,
    'PIPX_VENVS_DIRS must be lazy (pipxVenvsDirs function) — derived from externalReadersPipxVenvsDirs which is env-dependent',
  );
});

test('§6 positive: lazy resolver functions are defined and reach process.env', () => {
  const code = _externalReadersSourceWithoutComments();
  assert.match(
    code,
    /function\s+meloExternalReadersDir\s*\(\)\s*\{[\s\S]*?return\s+process\.env\.MELO_EXTERNAL_READERS_DIR/,
    'meloExternalReadersDir() must be the call-time getter that re-reads process.env on each invocation',
  );
  assert.match(code, /function\s+externalReadersDirs\s*\(\)\s*\{/);
  assert.match(code, /function\s+externalReadersBinDirs\s*\(\)\s*\{/);
  assert.match(code, /function\s+externalReadersPipxVenvsDirs\s*\(\)\s*\{/);
  assert.match(code, /function\s+pipxVenvsDirs\s*\(\)\s*\{/);
});

test('§6 positive: all 3 readWith* candidates use the lazy getters (function calls), not the old uppercase consts', () => {
  const code = _externalReadersSourceWithoutComments();
  // readWithCrawl4AI: must spread externalReadersBinDirs() + externalReadersPipxVenvsDirs()
  assert.match(code, /externalReadersBinDirs\(\)\.map\([^)]*'crwl'/, 'readWithCrawl4AI must invoke externalReadersBinDirs()');
  assert.match(code, /externalReadersPipxVenvsDirs\(\)\.map\([^)]*'crawl4ai'/, 'readWithCrawl4AI must invoke externalReadersPipxVenvsDirs()');

  // readWithScrapling: same pattern but with 'scrapling'
  assert.match(code, /externalReadersBinDirs\(\)\.map\([^)]*'scrapling'\)/, 'readWithScrapling must invoke externalReadersBinDirs()');

  // readWithCamoufox: uses pipxVenvsDirs() which transitively includes the external-readers paths
  assert.match(code, /pipxVenvsDirs\(\)\.map\([^)]*'camoufox/, 'readWithCamoufox python lookup must invoke pipxVenvsDirs()');
});

test('§6 path-derived consts (PROJECT_ROOT / MELO_FOLDER_ROOT) remain module-load — they only depend on __dirname, not env', () => {
  // These are intentionally kept as module-load consts because they derive
  // from import.meta.url (file location), which can never change at runtime.
  // Anti-regression: if someone moves this file to a different src depth and
  // forgets to update the dirname chain, this test catches the breakage.
  const code = _externalReadersSourceWithoutComments();
  assert.match(code, /const\s+PROJECT_ROOT\s*=\s*dirname\(dirname\(__dirname\)\)/);
  assert.match(code, /const\s+MELO_FOLDER_ROOT\s*=\s*dirname\(PROJECT_ROOT\)/);
});

// ─── §6 real-behavior test (Codex ⚪ closeout) ─────────────────────────────
//
// Source-level guards above lock the lazy form structurally.  Codex's review
// suggested also a real-behavior test that flips MELO_EXTERNAL_READERS_DIR
// mid-process and verifies the candidate-list lookup re-resolves.  This
// closes the lessons-learned #2 invariant ("real behavior > source grep")
// for THIS specific change.
//
// How: plant a fake `crwl` executable at $MELO_EXTERNAL_READERS_DIR/bin/crwl
// in a temp dir; verify that `readUrlWithExternalReader('crawl4ai', ...)`
// resolves to that exact path (via the `_runCommand` stub capturing the
// resolved command).  Then flip the env to a SECOND temp dir with a
// different fake crwl, run again, assert the new path is now used.

import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * Plant a fake `crwl` shell script that echoes the given marker text.
 * Marker is padded to clear the MIN_USEFUL_CHARS=120 non-whitespace gate so
 * readWithCrawl4AI's `isUsefulContent` returns true and we get the content
 * back to inspect.  The script ignores all args.
 */
function plantFakeCrwl(marker) {
  const root = mkdtempSync(join(tmpdir(), 'melo-extreaders-test-'));
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const crwlPath = join(binDir, 'crwl');
  // Output something distinctive (the marker) + filler text to pass the
  // useful-content gate (>= 120 non-whitespace chars).  Single quotes around
  // marker so any shell metacharacters in the temp path don't break the
  // heredoc.
  const filler = 'X'.repeat(150);
  writeFileSync(crwlPath, `#!/bin/sh\necho '${marker}'\necho '${filler}'\n`);
  chmodSync(crwlPath, 0o755);
  return { root, crwlPath };
}

test('§6 real behavior: MELO_EXTERNAL_READERS_DIR flip mid-process reroutes the candidate (path resolution re-reads env)', async () => {
  // This is the Codex ⚪ closure: source-level guards above pin "the lazy
  // form exists" structurally, but only an end-to-end env-flip test proves
  // the candidate-list resolution actually RE-EXECUTES the env-reading
  // function on each call.  A frozen const would have been baked in at
  // first import, and the round-2 call below would still pick homeA's
  // fake crwl instead of homeB's.
  const homeA = plantFakeCrwl('FROM_HOME_A');
  const homeB = plantFakeCrwl('FROM_HOME_B');
  const prevEnv = process.env.MELO_EXTERNAL_READERS_DIR;
  // Also clear MELO_CRAWL4AI_BIN — resolveExecutable short-circuits if it's
  // set (env-explicit wins over candidates) and the test loses its signal.
  const prevBin = process.env.MELO_CRAWL4AI_BIN;
  delete process.env.MELO_CRAWL4AI_BIN;

  try {
    // Round 1: point env at home A → real spawn of homeA/bin/crwl → content
    // includes 'FROM_HOME_A'.
    process.env.MELO_EXTERNAL_READERS_DIR = homeA.root;
    const resultA = await readUrlWithExternalReader('crawl4ai', 'https://example.com/a', {
      timeoutMs: 5000,
    });
    assert.ok(resultA, 'round 1 must produce a result (fake crwl wrote enough chars to pass useful-content gate)');
    assert.match(resultA.content, /FROM_HOME_A/,
      `round 1 must resolve to homeA's fake (got content: ${resultA.content.slice(0, 200)})`);

    // Round 2: flip env to home B.  If MELO_EXTERNAL_READERS_DIR were
    // captured at module-load (the §6 bug), this call would STILL pick
    // homeA's crwl and yield 'FROM_HOME_A'.  Lazy resolution re-reads env
    // each call → picks homeB → yields 'FROM_HOME_B'.
    process.env.MELO_EXTERNAL_READERS_DIR = homeB.root;
    const resultB = await readUrlWithExternalReader('crawl4ai', 'https://example.com/b', {
      timeoutMs: 5000,
    });
    assert.ok(resultB, 'round 2 must produce a result');
    assert.match(resultB.content, /FROM_HOME_B/,
      `round 2 must resolve to homeB's fake — frozen-const bug would have kept homeA. got: ${resultB.content.slice(0, 200)}`);
    assert.doesNotMatch(resultB.content, /FROM_HOME_A/,
      'round 2 content must NOT contain homeA marker (the frozen-const regression signal)');
  } finally {
    if (prevEnv === undefined) delete process.env.MELO_EXTERNAL_READERS_DIR;
    else process.env.MELO_EXTERNAL_READERS_DIR = prevEnv;
    if (prevBin === undefined) delete process.env.MELO_CRAWL4AI_BIN;
    else process.env.MELO_CRAWL4AI_BIN = prevBin;
    try { rmSync(homeA.root, { recursive: true, force: true }); } catch {}
    try { rmSync(homeB.root, { recursive: true, force: true }); } catch {}
  }
});
