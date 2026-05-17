/**
 * Stage 2c: webSearchTool content-fetch CDP-chrome integration tests.
 *
 * Stage 2c routes the content-fetch fallback (Stage 3 inside
 * fetchResultContents) through cdp-chrome when MELO_CDP_ENABLED=1,
 * preserving the existing Playwright path when env is off.  Tests:
 *
 *   • env on + Jina misses → cdp-chrome fallback runs, PW NOT touched.
 *   • env off (default) → existing PW fallback runs, CDP NOT touched.
 *   • trail extra.method reflects which tier handled the fallback batch.
 *   • cdp-chrome miss for a URL → that URL is dropped same as PW miss.
 *
 * All Chrome interaction mocked via the `_fetchViaCdpChrome` seam —
 * no real network, no real Chrome.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webSearchTool, _resetWebSearchCacheForTests } from './webSearchTool.js';

// MELO_HOME isolation — webSearchTool reads getMeloHome() for cache DB
// path, debug log path, etc.  Without isolation the test could write into
// the real ~/.melo/.
let prevHome, prevCdpEnv, tmpHome;
test.beforeEach(() => {
  prevHome = process.env.MELO_HOME;
  prevCdpEnv = process.env.MELO_CDP_ENABLED;
  tmpHome = mkdtempSync(join(tmpdir(), 'melo-websearch-cdp-test-'));
  process.env.MELO_HOME = tmpHome;
  // Default env OFF — tests opt in explicitly.
  delete process.env.MELO_CDP_ENABLED;
  _resetWebSearchCacheForTests();
});
test.afterEach(() => {
  if (prevHome === undefined) delete process.env.MELO_HOME;
  else process.env.MELO_HOME = prevHome;
  if (prevCdpEnv === undefined) delete process.env.MELO_CDP_ENABLED;
  else process.env.MELO_CDP_ENABLED = prevCdpEnv;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

// Fake SERP provider — raceSerpProviders calls pwSearchImpl(query, limit)
// and expects an Array of {title, url, snippet} (`r.length` is checked).
// Returning the wrapper {results, provider} would fail r.length>0 → the
// race waits for the Jina/DDG leg → test never reaches content-fetch.
function fakeSerpProvider(urls) {
  return async () => urls.map((u, i) => ({
    title: `Result ${i + 1}`,
    url: u,
    snippet: `Snippet for ${u}`,
  }));
}

// ─── env on: cdp-chrome runs as content-fetch fallback ──────────────────────

test('content-fetch + MELO_CDP_ENABLED=1: cdp-chrome handles Jina misses (PW NOT touched)', async () => {
  process.env.MELO_CDP_ENABLED = '1';
  const url = 'https://example.com/needs-real-browser';

  let cdpCallCount = 0;
  let pwCallCount = 0;
  const result = await webSearchTool.run(
    { query: 'test query needing content fetch', num_results: 1, noCache: true },
    {
      _searchViaPlaywright: fakeSerpProvider([url]),
      _searchViaDdg: fakeSerpProvider([]),
      _isPlaywrightCliAvailable: async () => true,
      // Jina returns shell (under MIN_USEFUL_CHARS), forcing fallback.
      _fetchViaJina: async () => ({ url, content: '', notModified: false }),
      // PW must NOT be touched when env on.
      _fetchViaPlaywrightCli: async () => {
        pwCallCount += 1;
        return { url, content: 'PW content (should not run when CDP enabled)' };
      },
      _fetchViaCdpChrome: async () => {
        cdpCallCount += 1;
        return {
          url,
          content: 'CDP-chrome fetched content from the user\'s logged-in browser session — long enough to pass the 100-char minimum content threshold so the result actually lands in the output map.',
        };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(cdpCallCount, 1, 'cdp-chrome fallback must run when env on + Jina miss');
  assert.equal(pwCallCount, 0, 'PW must NOT run when env on (cdp-chrome replaces it)');
  const cfEntry = result.evidenceTrail.find(e => e.tier === 'content-fetch');
  assert.equal(cfEntry?.method, 'cdp-chrome', `trail method must be cdp-chrome; got ${cfEntry?.method}`);
  assert.equal(cfEntry?.outcome, 'ok');
  // Result includes the CDP-fetched body in meta.results' content
  const resultBody = result.meta?.results?.[0];
  assert.ok(resultBody, 'top result must be present');
});

test('content-fetch + env OFF: PW runs as content-fetch fallback, cdp-chrome NOT touched', async () => {
  // env intentionally NOT set
  const url = 'https://example.com/headless-pw-path';

  let cdpCallCount = 0;
  let pwCallCount = 0;
  const result = await webSearchTool.run(
    { query: 'test query env off', num_results: 1, noCache: true },
    {
      _searchViaPlaywright: fakeSerpProvider([url]),
      _searchViaDdg: fakeSerpProvider([]),
      _isPlaywrightCliAvailable: async () => true,
      _fetchViaJina: async () => ({ url, content: '', notModified: false }),
      _fetchViaPlaywrightCli: async () => {
        pwCallCount += 1;
        return {
          url,
          content: 'PW headless content for the env-off path — pre-Stage-2c behavior preserved, padded over the 100-char content-acceptance threshold so this lands in the results map.',
        };
      },
      _fetchViaCdpChrome: async () => {
        cdpCallCount += 1;
        return { url, content: 'should not run' };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(pwCallCount, 1, 'PW must run when env off (pre-Stage-2c behavior)');
  assert.equal(cdpCallCount, 0, 'cdp-chrome must NOT run when env off');
  const cfEntry = result.evidenceTrail.find(e => e.tier === 'content-fetch');
  assert.equal(cfEntry?.method, 'playwright',
    `trail method must be playwright when env off; got ${cfEntry?.method}`);
});

// ─── env on: cdp-chrome miss for a URL → URL dropped, no PW retry ──────────

test('content-fetch + env on: cdp-chrome returning empty drops the URL (no PW retry)', async () => {
  process.env.MELO_CDP_ENABLED = '1';
  const url = 'https://example.com/cdp-empty-body';

  let pwCallCount = 0;
  const result = await webSearchTool.run(
    { query: 'cdp empty test', num_results: 1, noCache: true },
    {
      _searchViaPlaywright: fakeSerpProvider([url]),
      _searchViaDdg: fakeSerpProvider([]),
      _isPlaywrightCliAvailable: async () => true,
      _fetchViaJina: async () => ({ url, content: '', notModified: false }),
      _fetchViaPlaywrightCli: async () => {
        pwCallCount += 1;
        return { url, content: 'should not retry via PW when env on' };
      },
      _fetchViaCdpChrome: async () => ({ url, content: null }),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(pwCallCount, 0, 'env-on path must NOT retry via PW when CDP returns empty');
  const cfEntry = result.evidenceTrail.find(e => e.tier === 'content-fetch');
  assert.equal(cfEntry?.method, 'cdp-chrome');
  // contentItems should be 0 (URL dropped)
  assert.equal(cfEntry?.extra?.contentItems, 0);
});

// ─── env on: cdp-chrome throws → drop URL, no PW retry ──────────────────────

test('content-fetch + env on: cdp-chrome throw drops URL gracefully (no crash)', async () => {
  process.env.MELO_CDP_ENABLED = '1';
  const url = 'https://example.com/cdp-throws';

  const result = await webSearchTool.run(
    { query: 'cdp throw test', num_results: 1, noCache: true },
    {
      _searchViaPlaywright: fakeSerpProvider([url]),
      _searchViaDdg: fakeSerpProvider([]),
      _isPlaywrightCliAvailable: async () => true,
      _fetchViaJina: async () => ({ url, content: '', notModified: false }),
      _fetchViaCdpChrome: async () => { throw new Error('Chrome not running'); },
    },
  );

  // The search itself shouldn't fail just because CDP errored — overall
  // ok stays true, the failed URL just doesn't get content enrichment.
  assert.equal(result.ok, true);
  const cfEntry = result.evidenceTrail.find(e => e.tier === 'content-fetch');
  // method records the planned tier even when individual URL fails
  assert.equal(cfEntry?.method, 'cdp-chrome');
  assert.equal(cfEntry?.extra?.contentItems, 0);
});
