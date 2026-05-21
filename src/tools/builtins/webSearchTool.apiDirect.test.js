/**
 * Stage G-2b round-5 闭环 (2026-05-21 Codex ⚪ closeout): focused
 * webSearchTool **producer-side** tests for the api-direct meta.contentItems
 * serialization.
 *
 * Adapter consumer-side tests live in src/services/search/searchTask.test.js
 * (asserts isPartial / body decision based on contentItems).  This file
 * asserts the OTHER half of the contract: that webSearchTool actually emits
 * `meta.contentItems` with the right shape when api-direct.ok fires.  Without
 * this gate, a future refactor could:
 *   - forget to slice contentItems alongside results (length mismatch)
 *   - serialize undefined or null entries into contentItems
 *   - misalign by URL (contentItems[i].url not matching results[i].url)
 * ...and consumer tests would still pass (they take the shape as given).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webSearchTool, _resetWebSearchCacheForTests } from './webSearchTool.js';

// Same MELO_HOME isolation pattern as cdpChrome / swrAbort tests.
let prevHome, tmpHome;
test.beforeEach(() => {
  prevHome = process.env.MELO_HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'melo-websearch-api-direct-test-'));
  process.env.MELO_HOME = tmpHome;
  _resetWebSearchCacheForTests();
});
test.afterEach(() => {
  if (prevHome === undefined) delete process.env.MELO_HOME;
  else process.env.MELO_HOME = prevHome;
  _resetWebSearchCacheForTests();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

test('api-direct.ok: meta.contentItems is serialized from contentMap, aligned with results by URL', async () => {
  // Fake an api-direct hit with mixed body availability — Wikipedia URL
  // has body, HN URL does NOT (link-only story).  This is the realistic
  // mixed scenario that consumer-side per-item isPartial tests rely on.
  const wpUrl = 'https://en.wikipedia.org/wiki/GraphQL';
  const hnUrl = 'https://news.ycombinator.com/item?id=12345';
  const wpExtract = 'GraphQL is a query language and runtime for APIs that lets clients request exactly the fields they need.';
  const fakeApiResult = {
    provider: 'wikipedia',
    ok: true,
    results: [
      { title: 'GraphQL', url: wpUrl, snippet: wpExtract },
      { title: 'HN discussion', url: hnUrl, snippet: '152 points · 89 comments' },
    ],
    contentMap: new Map([[wpUrl, wpExtract]]), // HN intentionally absent
    latencyMs: 220,
  };

  const result = await webSearchTool.run(
    { query: 'graphql', num_results: 2, noCache: true },
    {
      _tryApiDirect: async () => fakeApiResult,
      // Other seams should not be touched on the api-direct.ok path —
      // their invocation would mean api-direct didn't short-circuit.
      _searchViaPlaywright: async () => { throw new Error('PW must not run on api-direct.ok'); },
      _searchViaDdg: async () => { throw new Error('DDG must not run on api-direct.ok'); },
      _isPlaywrightCliAvailable: async () => true,
    },
  );

  assert.equal(result.ok, true);

  // Core invariant: contentItems exists and is an array (not undefined).
  assert.ok(Array.isArray(result.meta.contentItems),
    'meta.contentItems must be present and an array on api-direct.ok');

  // Shape: each entry is { url: string, content: string }, no null/undefined.
  for (const item of result.meta.contentItems) {
    assert.equal(typeof item.url, 'string', 'contentItems.url must be string');
    assert.equal(typeof item.content, 'string', 'contentItems.content must be string');
    assert.ok(item.url.length > 0);
    assert.ok(item.content.length > 0);
  }

  // Alignment invariant: contentItems URLs are a SUBSET of results URLs
  // (HN's link-only story has no body, so contentItems is shorter — but
  // every contentItems URL must appear in results).
  const resultUrls = new Set(result.meta.results.map(r => r.url));
  for (const item of result.meta.contentItems) {
    assert.ok(resultUrls.has(item.url),
      `contentItems URL ${item.url} must appear in results URLs (alignment)`);
  }

  // The Wikipedia body must be carried; the HN URL must NOT be in contentItems.
  const itemByUrl = new Map(result.meta.contentItems.map(c => [c.url, c.content]));
  assert.equal(itemByUrl.get(wpUrl), wpExtract,
    'Wikipedia body must be serialized from contentMap into contentItems');
  assert.equal(itemByUrl.has(hnUrl), false,
    'HN URL absent from contentMap must NOT appear in contentItems (no synthetic empty entries)');

  // Length / count invariants — guards against accidental rewrites that
  // pad contentItems with empty objects or copy results blindly.
  assert.equal(result.meta.contentFetched, fakeApiResult.contentMap.size,
    'meta.contentFetched must equal contentMap.size (== contentItems.length here)');
  assert.equal(result.meta.contentItems.length, 1,
    'only 1 URL had a body, so contentItems should have exactly 1 entry');
  assert.equal(result.meta.results.length, 2,
    'all 2 SERP results preserved in meta.results regardless of body availability');
  assert.equal(result.meta.resultCount, 2);
});

test('api-direct.ok with num_results=1 limit: contentItems clipped alongside results', async () => {
  // Limit shouldn't desynchronize results vs contentItems.  api-direct
  // provider may return 3 items but caller asked for 1 → both arrays
  // get clipped to 1.
  const urls = [
    'https://github.com/tokio-rs/tokio',
    'https://github.com/async-rs/async-std',
    'https://github.com/smol-rs/smol',
  ];
  const fakeApiResult = {
    provider: 'github',
    ok: true,
    results: urls.map((u, i) => ({
      title: u.split('/').slice(-2).join('/'),
      url: u,
      snippet: `★ ${10000 - i * 1000} · Rust · updated 2026-05-20`,
    })),
    contentMap: new Map(urls.map((u, i) => [u, `description for repo ${i}`])),
    latencyMs: 300,
  };

  const result = await webSearchTool.run(
    { query: 'github repo rust async', num_results: 1, noCache: true },
    {
      _tryApiDirect: async () => fakeApiResult,
      _searchViaPlaywright: async () => { throw new Error('PW must not run'); },
      _searchViaDdg: async () => { throw new Error('DDG must not run'); },
      _isPlaywrightCliAvailable: async () => true,
    },
  );

  assert.equal(result.meta.results.length, 1, 'results clipped to num_results=1');
  // contentItems: built from the SLICED results (not the full apiResult.results),
  // so should reference only the top URL.
  assert.equal(result.meta.contentItems.length, 1,
    'contentItems clipped to match results slice — no orphan bodies');
  assert.equal(result.meta.contentItems[0].url, urls[0],
    'contentItems[0] aligns with results[0] (the only slice survivor)');
});

test('api-direct.ok with all bodies present: contentItems.length === results.length', async () => {
  // Counterpoint to the mixed-availability test — when contentMap is
  // complete for all returned URLs, contentItems and results have
  // matching cardinality.  Pins the happy-path equality.
  const urls = ['https://en.wikipedia.org/wiki/A', 'https://en.wikipedia.org/wiki/B'];
  const fakeApiResult = {
    provider: 'wikipedia',
    ok: true,
    results: urls.map((u, i) => ({ title: `Article ${i}`, url: u, snippet: `Body ${i}` })),
    contentMap: new Map(urls.map((u, i) => [u, `Body ${i}`])),
    latencyMs: 150,
  };

  const result = await webSearchTool.run(
    { query: 'multi wiki', num_results: 5, noCache: true },
    {
      _tryApiDirect: async () => fakeApiResult,
      _searchViaPlaywright: async () => { throw new Error('PW must not run'); },
      _searchViaDdg: async () => { throw new Error('DDG must not run'); },
      _isPlaywrightCliAvailable: async () => true,
    },
  );

  assert.equal(result.meta.results.length, 2);
  assert.equal(result.meta.contentItems.length, 2);
  // Order parity — contentItems[i].url corresponds to results[i].url when
  // every URL has a body (since contentItems is built by iterating the
  // sliced results array).
  for (let i = 0; i < 2; i++) {
    assert.equal(result.meta.contentItems[i].url, result.meta.results[i].url,
      `contentItems[${i}] must align by URL with results[${i}] when all bodies present`);
  }
});
