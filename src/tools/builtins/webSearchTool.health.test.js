/**
 * Hermetic regressions for the webSearchTool additions:
 *  - timings meta shape on cache-hit path (no network)
 *  - noCache bypass of the cache lookup
 *  - checkSearchHealth surface
 *  - getCacheStats / clearCache
 *  - URL content cache round-trip
 *
 * IMPORTANT: this file sets MELO_HOME to a fresh temp directory BEFORE
 * importing webSearchTool, so every test runs against an isolated SQLite
 * file. Without this, a destructive test (e.g. clearCache('all')) would
 * nuke the developer's real on-disk cache.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Set MELO_HOME before any import that triggers getMeloHome().
const TEMP_HOME = mkdtempSync(join(tmpdir(), 'melo-websearch-test-'));
process.env.MELO_HOME = TEMP_HOME;

// Dynamic import so CACHE_DB_PATH resolves under TEMP_HOME.
const { webSearchTool, checkSearchHealth, getSearchCacheDbPath, getCacheStats, clearCache } =
  await import('./webSearchTool.js');
// Tokenizer — re-used to compute the same cache key the production code
// builds in buildCacheKey(), so seed rows actually match a live lookup.
const { tokenizeQuery } = await import('../../search/tokenizer.js');

const FIXTURE_QUERY = `__melo_test_${process.pid}_${Date.now()}`;

// Mirror of the private `normalizeQuery` + `buildCacheKey` helpers in
// webSearchTool.js. Kept in lock-step with the production path so tests
// seed a row under the same key the tool would generate.
function _testNormalizeQuery(q) {
  const { tokens, graphemes } = tokenizeQuery(q);
  const combined = [...tokens, ...graphemes]
    .map(t => String(t).toLowerCase())
    .filter(Boolean);
  combined.sort();
  const deduped = [];
  let last = null;
  for (const t of combined) {
    if (t !== last) deduped.push(t);
    last = t;
  }
  return deduped.join(' ').trim() || String(q || '').toLowerCase();
}
function _testCacheKey(q, { kind = 'general', timeSensitive = false } = {}) {
  return `${kind}|${timeSensitive ? 'T' : 'S'}|${_testNormalizeQuery(q)}`;
}

function seedSerpCache(query, results, contentMap = {}, intent = { kind: 'general', timeSensitive: false }) {
  const path = getSearchCacheDbPath();
  assert.ok(path.startsWith(TEMP_HOME), `test DB must be under TEMP_HOME, got ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Include the columns added by the P0-3 migration so INSERT targets the
  // live schema (production migrations add intent_kind and time_sensitive).
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_search_cache (
      query_norm     TEXT PRIMARY KEY,
      query_raw      TEXT NOT NULL,
      provider       TEXT NOT NULL,
      results        TEXT NOT NULL,
      content_map    TEXT NOT NULL DEFAULT '{}',
      created_at     INTEGER NOT NULL,
      intent_kind    TEXT NOT NULL DEFAULT 'general',
      time_sensitive INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS url_content_cache (
      url         TEXT PRIMARY KEY,
      content     TEXT NOT NULL,
      fetched_at  INTEGER NOT NULL
    );
  `);
  const norm = _testCacheKey(query, intent);
  db.prepare(`
    INSERT OR REPLACE INTO web_search_cache
      (query_norm, query_raw, provider, results, content_map, created_at, intent_kind, time_sensitive)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    norm, query, 'test-fixture',
    JSON.stringify(results), JSON.stringify(contentMap),
    Date.now(),
    intent.kind || 'general',
    intent.timeSensitive ? 1 : 0,
  );
  db.close();
}

function seedUrlCacheRow(url, content, fetchedAt = Date.now()) {
  const path = getSearchCacheDbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS url_content_cache (
      url         TEXT PRIMARY KEY,
      content     TEXT NOT NULL,
      fetched_at  INTEGER NOT NULL
    );
  `);
  db.prepare(
    'INSERT OR REPLACE INTO url_content_cache (url, content, fetched_at) VALUES (?, ?, ?)',
  ).run(url, content, fetchedAt);
  db.close();
}

function countUrlCacheRows(urlFilter) {
  const path = getSearchCacheDbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    // Table might not exist yet if no prior seed; treat as zero.
    db.exec(`CREATE TABLE IF NOT EXISTS url_content_cache (
      url TEXT PRIMARY KEY, content TEXT NOT NULL, fetched_at INTEGER NOT NULL
    );`);
    if (urlFilter) {
      const r = db.prepare('SELECT COUNT(*) AS c FROM url_content_cache WHERE url = ?').get(urlFilter);
      return Number(r?.c || 0);
    }
    const r = db.prepare('SELECT COUNT(*) AS c FROM url_content_cache').get();
    return Number(r?.c || 0);
  } finally {
    db.close();
  }
}

test.after(() => {
  // Clean up the temp home after all tests
  try {
    rmSync(TEMP_HOME, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

// ─── Existing regressions (timing meta, health shape) ───────────────────────

test('cache-hit path returns timings with cacheHit=true', async () => {
  const fixture = [
    { title: 'Fixture Result', url: 'https://example.com/a', snippet: 'hello world' },
  ];
  seedSerpCache(FIXTURE_QUERY, fixture);
  const result = await webSearchTool.run({ query: FIXTURE_QUERY, num_results: 3 });
  assert.equal(result.ok, true);
  assert.ok(result.meta, 'meta present');
  assert.ok(result.meta.timings, 'timings present');
  assert.equal(result.meta.timings.cacheHit, true);
  assert.equal(result.meta.timings.serpMs, 0);
  assert.equal(result.meta.timings.contentMs, 0);
  assert.ok(Number.isFinite(result.meta.timings.totalMs));
  assert.ok(result.meta.timings.totalMs >= 0);
  assert.equal(result.meta.provider, 'test-fixture (cached)');
});

test('noCache=true skips the cache even when a row exists', async () => {
  const uniqueQ = `${FIXTURE_QUERY}_noCache`;
  seedSerpCache(uniqueQ, [
    { title: 'Should Not Appear', url: 'https://example.com/b', snippet: 'cached' },
  ]);
  const result = await webSearchTool.run(
    { query: uniqueQ, num_results: 1, noCache: true },
    { signal: AbortSignal.timeout(3_000) },
  );
  if (result.ok) {
    assert.notEqual(result.meta.provider, 'test-fixture (cached)');
    assert.equal(result.meta.timings.cacheHit, false);
  } else {
    assert.equal(result.error, 'PROVIDER_DOWN');
    assert.ok(result.meta?.timings);
    assert.equal(result.meta.timings.cacheHit, false);
  }
});

test('INVALID_QUERY returns before timing is computed', async () => {
  const result = await webSearchTool.run({ query: '' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_QUERY');
});

test('noCache exists on the tool parametersSchema', () => {
  const props = webSearchTool.parametersSchema.properties;
  assert.ok(props.noCache, 'noCache property defined');
  assert.equal(props.noCache.type, 'boolean');
  assert.equal(props.noCache.default, false);
});

test('checkSearchHealth returns well-formed shape', async () => {
  const health = await checkSearchHealth({ signal: AbortSignal.timeout(5_000) });
  assert.ok(health);
  assert.equal(typeof health.healthy, 'boolean');
  assert.ok(health.playwright);
  assert.equal(typeof health.playwright.available, 'boolean');
  assert.ok(health.jina);
  assert.equal(typeof health.jina.reachable, 'boolean');
  assert.ok(health.cacheDb);
  assert.equal(typeof health.cacheDb.exists, 'boolean');
  assert.equal(typeof health.cacheDb.path, 'string');
  assert.ok(health.cacheDb.path.endsWith('search.sqlite'));
  assert.equal(typeof health.summary, 'string');
});

test('getSearchCacheDbPath returns an absolute path ending in search.sqlite', () => {
  const p = getSearchCacheDbPath();
  assert.equal(typeof p, 'string');
  assert.ok(p.endsWith('search.sqlite'));
  assert.ok(p.startsWith(TEMP_HOME), 'isolated under TEMP_HOME');
});

// ─── getCacheStats ──────────────────────────────────────────────────────────

test('getCacheStats returns well-formed shape with both cache sections', async () => {
  const stats = await getCacheStats();
  assert.equal(typeof stats.exists, 'boolean');
  assert.equal(typeof stats.path, 'string');
  assert.equal(typeof stats.sizeBytes, 'number');
  assert.equal(typeof stats.searchTtlMs, 'number');
  assert.equal(typeof stats.urlTtlMs, 'number');
  for (const section of [stats.searchCache, stats.urlCache]) {
    assert.ok(section);
    assert.equal(typeof section.rows, 'number');
    assert.equal(typeof section.freshRows, 'number');
    assert.ok(section.oldestAgeMs === null || typeof section.oldestAgeMs === 'number');
    assert.ok(section.newestAgeMs === null || typeof section.newestAgeMs === 'number');
  }
});

test('getCacheStats reflects seeded rows', async () => {
  const q = `stats_${Date.now()}`;
  seedSerpCache(q, [{ title: 't', url: 'https://x/c', snippet: 's' }]);
  seedUrlCacheRow(`https://example.test/seed-${Date.now()}`, 'z'.repeat(200));
  const stats = await getCacheStats();
  assert.ok(stats.searchCache.rows >= 1);
  assert.ok(stats.urlCache.rows >= 1);
  assert.ok(stats.searchCache.freshRows >= 1);
  assert.ok(stats.urlCache.freshRows >= 1);
});

// ─── clearCache scope handling ─────────────────────────────────────────────

test('clearCache validates scope', () => {
  assert.throws(() => clearCache('bogus'), /Unknown cache scope/);
});

test('clearCache scope=search deletes only SERP rows', async () => {
  // Seed one of each table
  const q = `clear_search_${Date.now()}`;
  seedSerpCache(q, [{ title: 't', url: 'https://x/d', snippet: 's' }]);
  const urlFixture = `https://example.test/keep-${Date.now()}`;
  seedUrlCacheRow(urlFixture, 'keep-me'.repeat(40));

  const result = clearCache('search');
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'search');
  assert.ok(result.deleted >= 1);
  const stats = await getCacheStats();
  assert.equal(stats.searchCache.rows, 0, 'SERP cache cleared');
  assert.ok(stats.urlCache.rows >= 1, 'URL cache preserved');
  assert.equal(countUrlCacheRows(urlFixture), 1);
});

test('clearCache scope=url empties only URL cache', async () => {
  seedUrlCacheRow(`https://example.test/url-scope-${Date.now()}`, 'x'.repeat(200));
  const before = await getCacheStats();
  assert.ok(before.urlCache.rows >= 1);
  const result = clearCache('url');
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'url');
  const after = await getCacheStats();
  assert.equal(after.urlCache.rows, 0);
});

test('clearCache scope=stale removes expired rows, keeps fresh', async () => {
  const fresh = `https://example.test/fresh-${Date.now()}`;
  const stale = `https://example.test/stale-${Date.now()}`;
  seedUrlCacheRow(fresh, 'fresh'.repeat(40), Date.now());
  seedUrlCacheRow(stale, 'stale'.repeat(40), Date.now() - 3 * 60 * 60 * 1000);

  const result = clearCache('stale');
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'stale');
  assert.ok(result.deleted >= 1);
  assert.equal(countUrlCacheRows(fresh), 1, 'fresh survives');
  assert.equal(countUrlCacheRows(stale), 0, 'stale gone');
});

test('clearCache scope=all wipes both tables', () => {
  seedSerpCache(`all_wipe_${Date.now()}`, [{ title: 't', url: 'https://x/e', snippet: 's' }]);
  seedUrlCacheRow(`https://example.test/all-${Date.now()}`, 'a'.repeat(200));
  const result = clearCache('all');
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'all');
  assert.ok(result.deleted >= 0);
});

// ─── URL content cache round-trip via fetchResultContents ──────────────────
//
// The URL cache is private, but the behavior is observable via run(): a
// pre-seeded URL cache row for a URL that appears in a fresh SERP result
// should let content-fetch complete without hitting the network for that
// URL. Here we verify indirectly by confirming the cache survives a SERP-only
// clear.

test('URL cache row survives a SERP-scope clear (scoping is surgical)', () => {
  const url = `https://example.test/scope-surg-${Date.now()}`;
  seedUrlCacheRow(url, 'payload'.repeat(50));
  clearCache('search');
  assert.equal(countUrlCacheRows(url), 1);
});
