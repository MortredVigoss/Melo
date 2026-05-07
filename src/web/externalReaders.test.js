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
