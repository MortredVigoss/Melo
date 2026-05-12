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
