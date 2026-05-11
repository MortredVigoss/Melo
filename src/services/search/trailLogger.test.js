/**
 * Phase 2 instrumentation regression coverage.
 *
 * Real-behavior assertions per lessons-learned #2 (not just source grep):
 *   - env var off → no file written
 *   - env var on → JSONL line appended per call, parseable JSON
 *   - 3 sources route correctly when wrapped tool is invoked
 *   - body / output truncated at 500 chars
 *   - logging failure is best-effort (never crashes caller)
 *
 * Isolated MELO_HOME per test — same `mkdtempSync` pattern as the
 * dreaming tests (G-1 fix) so we never write into ~/.melo/desktop/.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isTrailLoggingEnabled,
  trailLogPathFor,
  logSearchTrail,
  wrapWithTrailLog,
} from './trailLogger.js';

let _isolatedHome = null;
let _prevMeloHome;
let _prevEnvLog;

test.beforeEach(() => {
  _prevMeloHome = process.env.MELO_HOME;
  _prevEnvLog = process.env.MELO_SEARCH_TRAIL_LOG;
  _isolatedHome = mkdtempSync(join(tmpdir(), 'melo-trail-log-test-'));
  process.env.MELO_HOME = _isolatedHome;
  delete process.env.MELO_SEARCH_TRAIL_LOG;
});

test.afterEach(() => {
  try { rmSync(_isolatedHome, { recursive: true, force: true }); } catch {}
  _isolatedHome = null;
  if (_prevMeloHome === undefined) delete process.env.MELO_HOME;
  else process.env.MELO_HOME = _prevMeloHome;
  if (_prevEnvLog === undefined) delete process.env.MELO_SEARCH_TRAIL_LOG;
  else process.env.MELO_SEARCH_TRAIL_LOG = _prevEnvLog;
});

// ─── env gate ──────────────────────────────────────────────────────────────

test('isTrailLoggingEnabled: default off', () => {
  assert.equal(isTrailLoggingEnabled(), false);
});

test('isTrailLoggingEnabled: flips on with env var = "1"', () => {
  process.env.MELO_SEARCH_TRAIL_LOG = '1';
  assert.equal(isTrailLoggingEnabled(), true);
});

test('isTrailLoggingEnabled: other truthy strings stay off (only literal "1")', () => {
  for (const v of ['true', 'yes', 'on', '2', '0', '']) {
    process.env.MELO_SEARCH_TRAIL_LOG = v;
    assert.equal(isTrailLoggingEnabled(), false, `env="${v}" must not enable`);
  }
});

// ─── path resolution ───────────────────────────────────────────────────────

test('trailLogPathFor: builds YYYY-MM-DD.jsonl under MELO_HOME/desktop/search-trail-log', () => {
  const path = trailLogPathFor('2026-05-11T10:00:00.000Z');
  assert.ok(path.endsWith('search-trail-log/2026-05-11.jsonl'),
    `path must end with date/jsonl; got ${path}`);
  assert.ok(path.startsWith(_isolatedHome),
    `path must live under isolated MELO_HOME=${_isolatedHome}; got ${path}`);
});

test('trailLogPathFor: re-resolves at call time when MELO_HOME flips between calls', () => {
  const a = trailLogPathFor('2026-05-11T00:00:00Z');
  const newHome = mkdtempSync(join(tmpdir(), 'melo-trail-log-flip-'));
  process.env.MELO_HOME = newHome;
  try {
    const b = trailLogPathFor('2026-05-11T00:00:00Z');
    assert.notEqual(a, b, 'second call must use the new MELO_HOME (CLAUDE.md §6 lazy resolution)');
    assert.ok(b.startsWith(newHome));
  } finally {
    try { rmSync(newHome, { recursive: true, force: true }); } catch {}
  }
});

// ─── logSearchTrail core behavior ──────────────────────────────────────────

test('logSearchTrail: no-op when env off (no file created)', () => {
  logSearchTrail({
    source: 'url-fetch',
    input: { url: 'https://example.com' },
    result: { ok: true, output: 'body', meta: { url: 'https://example.com' }, evidenceTrail: [] },
  });
  // Whatever path it would have written to — should not exist.
  const path = trailLogPathFor();
  assert.equal(existsSync(path), false, 'no file when env disabled');
});

test('logSearchTrail: env on + url-fetch → JSONL line appended, parseable, schema intact', () => {
  process.env.MELO_SEARCH_TRAIL_LOG = '1';
  logSearchTrail({
    source: 'url-fetch',
    input: { url: 'https://example.com/a' },
    result: {
      ok: true,
      output: 'body content',
      meta: { url: 'https://example.com/a', method: 'jina', length: 12 },
      evidenceTrail: [{ tier: 'jina', outcome: 'ok', latencyMs: 600 }],
    },
  });
  const path = trailLogPathFor();
  assert.ok(existsSync(path), `log file must exist at ${path}`);
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.source, 'url-fetch');
  assert.equal(entry.input.url, 'https://example.com/a');
  assert.equal(entry.ok, true);
  assert.equal(entry.meta.method, 'jina');
  assert.equal(entry.evidenceTrail[0].tier, 'jina');
  assert.equal(entry.output, 'body content');
  assert.ok(typeof entry.ts === 'string' && entry.ts.length >= 20);
});

test('logSearchTrail: long output truncated at 500 chars + marker note', () => {
  process.env.MELO_SEARCH_TRAIL_LOG = '1';
  const longBody = 'X'.repeat(800);
  logSearchTrail({
    source: 'web-search',
    input: { query: 'big body test' },
    result: {
      ok: true,
      output: longBody,
      meta: { provider: 'duckduckgo', results: [] },
      evidenceTrail: [],
    },
  });
  const entry = JSON.parse(readFileSync(trailLogPathFor(), 'utf8').trim());
  assert.ok(entry.output.length < longBody.length, 'output must be truncated');
  assert.match(entry.output, /\[truncated \d+c\]$/);
});

test('logSearchTrail: socialLink body field (not output) also gets truncated', () => {
  process.env.MELO_SEARCH_TRAIL_LOG = '1';
  const longBody = 'Y'.repeat(900);
  logSearchTrail({
    source: 'social-link',
    input: { url: 'https://xhslink.com/a/abc' },
    result: {
      body: longBody,
      via: 'yt-dlp',
      canonicalUrl: 'https://www.xiaohongshu.com/explore/abc',
      evidenceTrail: [],
    },
  });
  const entry = JSON.parse(readFileSync(trailLogPathFor(), 'utf8').trim());
  assert.match(entry.body, /\[truncated \d+c\]$/);
});

test('logSearchTrail: appends multiple entries across multiple calls (JSONL append-only)', () => {
  process.env.MELO_SEARCH_TRAIL_LOG = '1';
  for (let i = 0; i < 3; i += 1) {
    logSearchTrail({
      source: 'url-fetch',
      input: { url: `https://example.com/${i}` },
      result: { ok: i % 2 === 0, output: `body ${i}`, meta: {}, evidenceTrail: [] },
    });
  }
  const lines = readFileSync(trailLogPathFor(), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0]).input.url, 'https://example.com/0');
  // i=2 is even → result.ok=true; i=1 is odd → false. Pin both.
  assert.equal(JSON.parse(lines[1]).ok, false);
  assert.equal(JSON.parse(lines[2]).ok, true);
});

test('logSearchTrail: webSearch meta.results[] capped at 12 to bound log size', () => {
  process.env.MELO_SEARCH_TRAIL_LOG = '1';
  const fakeResults = Array.from({ length: 20 }, (_, i) => ({
    title: `r${i}`, url: `https://r${i}`, snippet: 's',
  }));
  logSearchTrail({
    source: 'web-search',
    input: { query: 'many results' },
    result: {
      ok: true,
      output: '...',
      meta: { provider: 'google', results: fakeResults, timings: { totalMs: 100 } },
      evidenceTrail: [],
    },
  });
  const entry = JSON.parse(readFileSync(trailLogPathFor(), 'utf8').trim());
  assert.equal(entry.meta.results.length, 12, 'meta.results capped at 12');
});

test('logSearchTrail: failure is best-effort — never throws', () => {
  process.env.MELO_SEARCH_TRAIL_LOG = '1';
  // Point MELO_HOME at a path we cannot create under (using a file as
  // a "directory" produces ENOTDIR).  logSearchTrail must swallow.
  const _origHome = process.env.MELO_HOME;
  process.env.MELO_HOME = '/dev/null';  // not a writable dir
  try {
    assert.doesNotThrow(() => logSearchTrail({
      source: 'url-fetch',
      input: { url: 'https://x' },
      result: { ok: true, output: 'body', meta: {}, evidenceTrail: [] },
    }));
  } finally {
    process.env.MELO_HOME = _origHome;
  }
});

// ─── wrapWithTrailLog — forwards args/this/return verbatim ─────────────────

test('wrapWithTrailLog: pass-through return unchanged + records to log when enabled', async () => {
  process.env.MELO_SEARCH_TRAIL_LOG = '1';
  const origResult = {
    ok: true,
    output: 'wrapped body',
    meta: { url: 'https://wrapped' },
    evidenceTrail: [{ tier: 'jina', outcome: 'ok', latencyMs: 100 }],
  };
  let wasCalled = false;
  const fakeRun = async function (args, opts) {
    wasCalled = true;
    assert.equal(args.url, 'https://wrapped');
    assert.equal(opts?.config?.test, true);
    return origResult;
  };
  const wrapped = wrapWithTrailLog('url-fetch', fakeRun);
  const got = await wrapped({ url: 'https://wrapped' }, { config: { test: true } });
  assert.ok(wasCalled);
  assert.equal(got, origResult, 'wrap returns the exact same object the inner runFn returned');
  const entry = JSON.parse(readFileSync(trailLogPathFor(), 'utf8').trim());
  assert.equal(entry.source, 'url-fetch');
  assert.equal(entry.input.url, 'https://wrapped');
  assert.equal(entry.ok, true);
});

test('wrapWithTrailLog: no log writes when env disabled (still forwards correctly)', async () => {
  // env intentionally NOT set
  const fakeRun = async () => ({ ok: false, error: 'INVALID_URL', evidenceTrail: [] });
  const wrapped = wrapWithTrailLog('url-fetch', fakeRun);
  const got = await wrapped({ url: '' }, {});
  assert.equal(got.ok, false);
  assert.equal(existsSync(trailLogPathFor()), false);
});
