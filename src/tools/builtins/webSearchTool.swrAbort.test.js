/**
 * Stage 2c B 留账 闭环 (2026-05-18): two real-invariant tests deferred at
 * round-2 acceptance.
 *
 *   1. **Real stale SWR test** — round-3 闭环 only proved the `{items,
 *      fallbackTier}` destructure didn't crash on the SWR refresh path, but
 *      using noCache=false on a row written 0 seconds ago hits the FRESH
 *      cache path, not stale.  This test directly UPDATEs the cache row's
 *      `created_at` to land in the (TTL, MAX_STALE] window, then asserts
 *      the second call returns stale immediately AND the background
 *      refresh actually fires AND the row gets rewritten.
 *
 *   2. **Real abort-during-hang test** — the existing prod-path test in
 *      webSearchTool.cdpChrome.test.js has waitForLoadState resolve
 *      immediately, so it only proves "signal is passed in", not
 *      "abort actually closes the in-flight page".  This test makes
 *      waitForLoadState hang forever, fires abort 50ms in, and asserts
 *      webSearchTool returns within the abort window (not natural CDP
 *      timeout) and page.close() fired.
 *
 * Both close MEMORY.md `feedback_test_must_validate_real_invariant.md`'s
 * core requirement: don't use永不 resolve mock to prove只 wrapper return
 * value — exercise the path with real timing + side-effect counters.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  webSearchTool,
  _resetWebSearchCacheForTests,
  getSearchCacheDbPath,
} from './webSearchTool.js';

// MELO_HOME / MELO_CDP_ENABLED isolation — same scaffold as cdpChrome test.
let prevHome, prevCdpEnv, tmpHome;
test.beforeEach(() => {
  prevHome = process.env.MELO_HOME;
  prevCdpEnv = process.env.MELO_CDP_ENABLED;
  tmpHome = mkdtempSync(join(tmpdir(), 'melo-websearch-swr-abort-test-'));
  process.env.MELO_HOME = tmpHome;
  delete process.env.MELO_CDP_ENABLED;
  _resetWebSearchCacheForTests();
});
test.afterEach(() => {
  if (prevHome === undefined) delete process.env.MELO_HOME;
  else process.env.MELO_HOME = prevHome;
  if (prevCdpEnv === undefined) delete process.env.MELO_CDP_ENABLED;
  else process.env.MELO_CDP_ENABLED = prevCdpEnv;
  _resetWebSearchCacheForTests();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function fakeSerpProvider(urls) {
  return async () => urls.map((u, i) => ({
    title: `Result ${i + 1}`,
    url: u,
    snippet: `Snippet for ${u}`,
  }));
}

// ─── Stage 2c B 留账 #1: real stale SWR fires & writes the row ──────────────

test('real stale SWR: UPDATE created_at into stale window → run #2 returns stale immediately AND fires background refresh that rewrites the row', async () => {
  // Strategy:
  //   1. Run #1 with noCache=true to warm the cache row via the real
  //      setCachedSearch path.
  //   2. Open the underlying SQLite directly, UPDATE created_at to be
  //      slightly older than SEARCH_CACHE_TTL_MS (2h) but well within
  //      SWR_MAX_STALE_MS (24h).  This is the smallest manipulation that
  //      reliably lands in the stale window without depending on test
  //      runtime速度.
  //   3. Run #2 with noCache=false — getCachedSearch returns null (over
  //      TTL), getStaleCachedSearch returns the row, the run returns
  //      immediately and queues _refreshInBackground.
  //   4. Yield setImmediate × 3 to let the background microtask + its
  //      internal awaits drain.
  //   5. Assert the refresh actually called the fetch impls (counters),
  //      and the cache row's created_at is now recent + content_map
  //      reflects the refresh body, not the warm-cache body.

  const url = 'https://example.com/swr-real-stale-test';
  const query = 'real stale swr contract test';

  // Run #1 — warm the cache with the "old" content.
  await webSearchTool.run(
    { query, num_results: 1, noCache: true },
    {
      _searchViaPlaywright: fakeSerpProvider([url]),
      _searchViaDdg: fakeSerpProvider([]),
      _isPlaywrightCliAvailable: async () => true,
      _fetchViaJina: async () => ({
        url,
        content: 'WARM-CACHE-BODY-must-be-replaced-by-background-refresh. Padded over 100 chars so this lands in the results map for query normalization.',
        notModified: false,
      }),
    },
  );

  // Verify the row landed.
  const dbPath = getSearchCacheDbPath();
  let db = new DatabaseSync(dbPath);
  const beforeRow = db.prepare('SELECT * FROM web_search_cache WHERE query_raw = ?').get(query);
  assert.ok(beforeRow, 'run #1 must have written a cache row');
  const beforeCreatedAt = Number(beforeRow.created_at);
  const beforeContent = JSON.parse(beforeRow.content_map);
  assert.match(
    String(beforeContent[url] || ''),
    /WARM-CACHE-BODY/,
    'pre-stale: cache holds warm body',
  );

  // Age the row into the stale window: 3 hours old (TTL is 2h, MAX_STALE
  // is 24h, so 3h is squarely stale-but-recoverable).  Critically: must
  // age BOTH tables.  web_search_cache controls the SWR stale-vs-fresh
  // bucketing for the *search query*, but fetchResultContents has its
  // own URL-content cache (url_content_cache) which shortcuts both Jina
  // and PW if the URL row is still fresh.  Only aging web_search_cache
  // would let the refresh fire but skip Jina entirely (URL hit → no
  // refresh body change → counter stays 0).  We delete the url row so
  // the refresh path is forced to re-fetch via Jina.
  const STALE_AGE_MS = 3 * 60 * 60 * 1000;
  const stalenedAt = Date.now() - STALE_AGE_MS;
  db.prepare('UPDATE web_search_cache SET created_at = ? WHERE query_raw = ?')
    .run(stalenedAt, query);
  db.prepare('DELETE FROM url_content_cache WHERE url = ?').run(url);
  db.close();
  _resetWebSearchCacheForTests(); // drop module-level handle so the next read sees the UPDATE

  // Run #2 — should hit stale, return immediately, queue background refresh.
  let refreshJinaCalls = 0;
  const refreshBody = 'REFRESH-BODY-from-background-SWR. Different from warm body so we can detect via content_map. Padded over 100 chars to land in the new results map.';
  const result = await webSearchTool.run(
    { query, num_results: 1, noCache: false },
    {
      _searchViaPlaywright: fakeSerpProvider([url]),
      _searchViaDdg: fakeSerpProvider([]),
      _isPlaywrightCliAvailable: async () => true,
      _fetchViaJina: async () => {
        refreshJinaCalls += 1;
        return { url, content: refreshBody, notModified: false };
      },
    },
  );

  assert.equal(result.ok, true);
  // 真不变量 #0 (precondition for the rest): run #2 actually hit the
  // stale-SWR path.  Without this we'd be checking the wrong invariants
  // entirely (fresh / miss / etc).  Trail's `cache` entry must show
  // method=stale-swr.
  const cacheEntry = result.evidenceTrail.find(e => e.tier === 'cache');
  assert.equal(cacheEntry?.outcome, 'ok',
    `cache trail outcome must be ok; got ${JSON.stringify(cacheEntry)}`);
  assert.equal(cacheEntry?.method, 'stale-swr',
    `cache trail method must be 'stale-swr' (proves run #2 took the SWR path); got '${cacheEntry?.method}'`);

  // Drain the background microtask chain.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  // 真不变量 #1: background refresh actually called the fetch impl.
  // (The pre-fix round-3 bug was that the destructure crashed BEFORE
  // calling Jina at all on the SWR path — except this is a different
  // shape now, so what matters is the refresh path executed end-to-end.)
  assert.ok(refreshJinaCalls >= 1,
    `background refresh must call the content fetcher; got ${refreshJinaCalls} calls`);

  // 真不变量 #2: cache row was rewritten — created_at advanced + content
  // map now holds the refresh body.
  _resetWebSearchCacheForTests();
  db = new DatabaseSync(dbPath);
  const afterRow = db.prepare('SELECT * FROM web_search_cache WHERE query_raw = ?').get(query);
  assert.ok(afterRow, 'cache row must still exist after refresh');
  const afterCreatedAt = Number(afterRow.created_at);
  const afterContent = JSON.parse(afterRow.content_map);
  db.close();

  assert.ok(afterCreatedAt > beforeCreatedAt,
    `background refresh must bump created_at: was ${beforeCreatedAt}, now ${afterCreatedAt}`);
  assert.ok(afterCreatedAt > stalenedAt,
    `created_at after refresh must be more recent than the UPDATE we did: stalenedAt=${stalenedAt}, after=${afterCreatedAt}`);
  assert.match(
    String(afterContent[url] || ''),
    /REFRESH-BODY/,
    'cache content_map must hold the refreshed body, not the stale warm body',
  );
});

// ─── Stage 2c B 留账 #2: real abort-during-hang closes the in-flight page ──

test('real abort-during-hang: waitForLoadState hangs forever, abort closes the page, webSearchTool returns within abort window', async () => {
  // Strategy:
  //   1. Wire fakeBrowser whose newPage().waitForLoadState() returns a
  //      never-resolving promise (real hang, not永不-resolve mock that
  //      bypasses the wrapper).
  //   2. signal-abort 50ms after webSearchTool.run starts.
  //   3. Time the run wall-clock — must complete within < 2s (the natural
  //      "fetch hang" timeout would be much longer, so this asserts abort
  //      actually severed the wait).
  //   4. Assert page.close() fired (counter).
  //   5. The overall webSearchTool.run can still return ok:true with
  //      whatever content the SERP/Jina returned — the assertion is about
  //      the side-channel (page close), not the API return shape.

  process.env.MELO_CDP_ENABLED = '1';
  const url = 'https://example.com/hang-during-wait-for-load-state';
  const connectMod = await import('../../services/browser/connect.js');

  let pageCloseCalls = 0;
  let waitForLoadStateAbortedNaturally = false;

  const defaultContext = {
    newPage: async () => {
      const page = {
        goto: async () => {}, // succeeds immediately
        waitForLoadState: () => new Promise((resolve, reject) => {
          // 真挂 — never resolves on its own.  Either page.close() races
          // ahead and we abort via the listener, or the test times out.
          // We attach a rejection handle so the test scaffold doesn't
          // explode if page.close mutates this in-flight.
          page._rejectWait = reject;
        }),
        evaluate: async () => 'Body content the test never reaches because waitForLoadState hangs.  Padded to 100+ chars just to be on the safe side if execution surprises us.',
        close: async () => {
          pageCloseCalls += 1;
          // Mimic real playwright: closing the page rejects any pending
          // waitForLoadState with "Target closed".
          if (page._rejectWait) {
            waitForLoadStateAbortedNaturally = true;
            page._rejectWait(new Error('Target page, context or browser has been closed'));
          }
        },
      };
      return page;
    },
    close: async () => {},
  };
  const fakeBrowser = {
    contexts: () => [defaultContext],
    newContext: async () => defaultContext,
    close: async () => {},
  };
  connectMod._setEnsureChromeForTests(async () => {
    return { port: 4444, pid: 1, reused: true, profileDir: '/p', lockPath: '/l' };
  });
  connectMod._setConnectImplForTests(async () => fakeBrowser);

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);

  const start = Date.now();
  try {
    await webSearchTool.run(
      { query: 'abort during hang test', num_results: 1, noCache: true },
      {
        signal: ac.signal,
        _searchViaPlaywright: fakeSerpProvider([url]),
        _searchViaDdg: fakeSerpProvider([]),
        _isPlaywrightCliAvailable: async () => true,
        // Jina returns empty so the CDP content fallback fires →
        // it hangs in waitForLoadState until abort closes the page.
        _fetchViaJina: async () => ({ url, content: '', notModified: false }),
        // NOTE: NO _fetchViaCdpChrome — production
        // fetchViaCdpChromeForContentFetch path runs.
      },
    );
  } catch {
    // webSearchTool may surface abort as a thrown AbortError too — either
    // shape is acceptable; what we care about is timing + page.close.
  }
  const elapsed = Date.now() - start;

  // 真不变量 #1: webSearchTool returned within the abort window, NOT the
  // natural hang.  Allow 2s headroom for setImmediate / abort listener
  // event-loop scheduling.
  assert.ok(elapsed < 2000,
    `webSearchTool must return within abort window (< 2s); got ${elapsed}ms — abort did NOT sever the in-flight wait`);

  // 真不变量 #2: page.close() fired as part of the abort path.  Without
  // it, the in-flight waitForLoadState would have run to natural
  // completion (i.e. never, in this fake), leaking the handle.
  assert.ok(pageCloseCalls >= 1,
    `page.close() must fire on abort; got ${pageCloseCalls} calls (handle leak)`);

  // 真不变量 #3: the close path actually severed the hang (vs page.close
  // being called AFTER a separate natural exit).  The rejectWait flag
  // proves the close → rejection chain fired.
  assert.equal(waitForLoadStateAbortedNaturally, true,
    'page.close() must reject the pending waitForLoadState (real abort propagation)');

  connectMod._setEnsureChromeForTests(null);
  connectMod._setConnectImplForTests(null);
});
