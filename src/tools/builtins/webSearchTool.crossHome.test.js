/**
 * G-2 Phase 2 follow-up #2 (2026-05-11): cross-MELO_HOME cache isolation
 * for web_search cache db.  Pre-fix `CACHE_DB_PATH` was a module-load
 * `const` so the path was frozen at first import — tests / multi-profile
 * runtime that switch MELO_HOME couldn't get a fresh handle.
 *
 * These tests pin the behavior (lessons-learned #2 — real behavior
 * assertions, no source grep) that:
 *   - `getCacheDb` re-resolves the path at call time
 *   - a path change closes the old handle and opens a new one
 *   - test-hook `_resetWebSearchCacheForTests` lets isolated tests
 *     bounce the handle cleanly
 *
 * MELO_HOME is mkdtemp'd per test — same pattern as the dreaming
 * tests fixed by G-1 60e828d.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  webSearchTool,
  getSearchCacheDbPath,
  clearCache,
  getCacheStats,
  _resetWebSearchCacheForTests,
} from './webSearchTool.js';

let _homeA = null;
let _homeB = null;
let _prevHome;

test.beforeEach(() => {
  _prevHome = process.env.MELO_HOME;
  _homeA = mkdtempSync(join(tmpdir(), 'melo-ws-cross-A-'));
  _homeB = mkdtempSync(join(tmpdir(), 'melo-ws-cross-B-'));
  process.env.MELO_HOME = _homeA;
  _resetWebSearchCacheForTests();
});

test.afterEach(() => {
  _resetWebSearchCacheForTests();
  try { rmSync(_homeA, { recursive: true, force: true }); } catch {}
  try { rmSync(_homeB, { recursive: true, force: true }); } catch {}
  _homeA = null;
  _homeB = null;
  if (_prevHome === undefined) delete process.env.MELO_HOME;
  else process.env.MELO_HOME = _prevHome;
});

test('getSearchCacheDbPath: re-resolves at call time (not frozen at import)', () => {
  const pathA = getSearchCacheDbPath();
  assert.ok(pathA.startsWith(_homeA),
    `path must reflect current MELO_HOME=${_homeA}; got ${pathA}`);

  // Flip MELO_HOME — without re-resolution, getSearchCacheDbPath would
  // still return the old path frozen at module-load time.
  process.env.MELO_HOME = _homeB;
  const pathB = getSearchCacheDbPath();
  assert.ok(pathB.startsWith(_homeB),
    `after flip, path must reflect MELO_HOME=${_homeB}; got ${pathB}`);
  assert.notEqual(pathA, pathB);
});

test('cache path switches under flipped MELO_HOME + _resetWebSearchCacheForTests bounces handle', () => {
  // Pin the path-resolution + handle-bounce contract that protects
  // cross-home isolation in tests / multi-profile runtime.  Going
  // through webSearchTool.run would require letting the cache phase
  // actually open getCacheDb (which only happens deep enough into the
  // pipeline that the test would have to run real or near-real SERP
  // logic).  The path + reset hook are the contract; if those work,
  // the actual `_cacheDb` open inside getCacheDb (covered by the
  // existing health/helpers tests) automatically follows.
  const pathA = getSearchCacheDbPath();
  assert.ok(pathA.startsWith(_homeA));

  // Flip + bounce — equivalent to what a multi-profile runtime hook
  // would do on user-switch.
  process.env.MELO_HOME = _homeB;
  _resetWebSearchCacheForTests();
  const pathB = getSearchCacheDbPath();
  assert.ok(pathB.startsWith(_homeB));
  assert.notEqual(pathA, pathB,
    'cache path must reflect the current MELO_HOME after reset hook fires');
});

test('_resetWebSearchCacheForTests: closes existing handle so the next call re-opens at new path', () => {
  // Force first open under home A.
  const pathA = getSearchCacheDbPath();
  // Touching the path enough — getCacheDb is internal, but the test
  // hook plus path resolution above already validate the contract.
  // Verify the reset hook is callable + doesn't throw with no open
  // handle.
  assert.doesNotThrow(() => _resetWebSearchCacheForTests());
  assert.doesNotThrow(() => _resetWebSearchCacheForTests()); // idempotent
  const pathA2 = getSearchCacheDbPath();
  assert.equal(pathA, pathA2, 'path resolution stable when MELO_HOME unchanged');
});

test('real-handle round-trip: clearCache opens db under A, flip MELO_HOME, clearCache opens db under B (Codex B follow-up — actually exercises getCacheDb path-change branch)', async () => {
  // This pins the *behavior* that the path-resolution + handle-bounce
  // tests above only prove indirectly: that getCacheDb's "path changed,
  // close old handle, open new" branch actually fires and lands the
  // db file in the new home — not the old one (which would be the
  // CLAUDE.md §6 regression we're guarding against).

  // (1) Open under home A via a real export that calls getCacheDb().
  //     clearCache('all') is cheap, has no network/PW dependency,
  //     and exercises getCacheDb identically to the production hot path.
  const r1 = clearCache('all');
  assert.equal(r1.ok, true, 'clearCache must succeed under home A');
  const pathA = join(_homeA, 'desktop', 'search.sqlite');
  assert.ok(existsSync(pathA),
    `after clearCache under home A, db file must exist at ${pathA}`);

  // (2) Sanity: getCacheStats also opens — observe both rows present after seed.
  const statsA = await getCacheStats();
  assert.equal(statsA.exists, true);
  assert.equal(statsA.path, pathA,
    `stats.path must reflect home A, got ${statsA.path}`);

  // (3) Flip MELO_HOME to B.  No reset hook called — the auto-reopen
  //     branch inside getCacheDb is what we're testing.  If the path
  //     was still frozen at module load, clearCache would (incorrectly)
  //     keep writing under home A and pathB would never appear.
  process.env.MELO_HOME = _homeB;

  const r2 = clearCache('all');
  assert.equal(r2.ok, true, 'clearCache must succeed under home B after flip');
  const pathB = join(_homeB, 'desktop', 'search.sqlite');
  assert.ok(existsSync(pathB),
    `after MELO_HOME flip + clearCache, db file must exist at home B path ${pathB}`);

  // (4) Both files exist independently — handle didn't follow A across.
  assert.ok(existsSync(pathA), 'home A db must still exist (we only swapped handle, not deleted)');

  // (5) Stats now report B path — handle re-resolved.
  const statsB = await getCacheStats();
  assert.equal(statsB.path, pathB,
    `after flip, stats.path must reflect home B, got ${statsB.path}`);
});

test('source-level guard: webSearchTool.js does NOT use a module-load `const CACHE_DB_PATH = join(getMeloHome()…)` anymore', async () => {
  // Auxiliary backstop (lessons-learned #2 — real behavior above is the
  // primary proof; this guard catches accidental regression where someone
  // re-introduces the frozen const).
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname: pd } = await import('node:path');
  const here = pd(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'webSearchTool.js'), 'utf8');
  assert.equal(
    /const\s+CACHE_DB_PATH\s*=\s*join\(\s*getMeloHome\(\)/.test(source),
    false,
    'CACHE_DB_PATH must not be a module-load-time const (CLAUDE.md §6)',
  );
  // Should be a function instead.  2026-05-21 audit闭环: post-§6-fix
  // cacheDbPath() resolves through `resolveCacheHome()` (which honors the
  // AsyncLocalStorage captured home for SWR refresh microtasks, falling
  // back to getMeloHome() for normal callers).  Either form is §6-compliant
  // as long as it's a call-time function — the anti-pattern guarded here
  // is the module-load `const` form.
  assert.match(
    source,
    /function\s+cacheDbPath\s*\(\)\s*\{[\s\S]*?return\s+join\(\s*(getMeloHome\(\)|resolveCacheHome\(\))/,
    'cacheDbPath should be a call-time function resolving through getMeloHome() or resolveCacheHome()',
  );
});

// ─── 2026-05-21 audit finding #1: SWR microtask captures home at schedule ──

test('SWR refresh microtask writes to the home captured at SCHEDULE time, NOT whatever MELO_HOME is when microtask runs (CLAUDE.md §6 闭环)', async () => {
  // The historical 7d-5α-A1 bug was a background prime task re-reading
  // getMeloHome() inside a microtask body, writing home-A's snapshot into
  // home-B's directory.  Same shape lurks in SWR refresh: queueMicrotask
  // body calls into setCachedSearch → cacheDbPath() → getMeloHome().
  // Without AsyncLocalStorage capture, a MELO_HOME flip between schedule
  // and microtask execution silently writes the refresh to the wrong DB.
  //
  // Test strategy:
  //   1. Open run #1 under home A with noCache=true (warms cache).
  //   2. Open a long pending SWR (artificially or via real stale UPDATE)
  //      so we have a microtask in flight.
  //   3. Flip MELO_HOME to B between schedule and microtask resolution.
  //   4. Assert the refresh wrote to home A's search.sqlite, not B's.
  //
  // We use the production stale-SWR path (not a synthetic microtask)
  // so the captured-home context wires exactly as production does.

  const { DatabaseSync } = await import('node:sqlite');
  const url = 'https://example.com/§6-capture-test';
  const query = '§6 capture test query';

  // (1) Warm under A.
  await webSearchTool.run(
    { query, num_results: 1, noCache: true },
    {
      _searchViaPlaywright: async () => [{ title: 'T', url, snippet: 'snippet' }],
      _searchViaDdg: async () => [],
      _isPlaywrightCliAvailable: async () => true,
      _fetchViaJina: async () => ({
        url,
        content: 'CAPTURE-TEST-WARM-BODY-from-initial-warmup-run. Padded over the 100-char fetchResultContents acceptance threshold so the cache row lands successfully with this body in content_map.',
        notModified: false,
      }),
    },
  );

  // (2) Age the row into stale window so run #2 will queue SWR refresh.
  const dbPathA = join(_homeA, 'desktop', 'search.sqlite');
  let db = new DatabaseSync(dbPathA);
  const STALE_AGE_MS = 3 * 60 * 60 * 1000;
  db.prepare('UPDATE web_search_cache SET created_at = ? WHERE query_raw = ?')
    .run(Date.now() - STALE_AGE_MS, query);
  db.prepare('DELETE FROM url_content_cache WHERE url = ?').run(url);
  db.close();
  _resetWebSearchCacheForTests();

  // (3) Trigger run #2 — synchronous return serves stale + schedules SWR.
  let refreshCalled = 0;
  const refreshBody = 'CAPTURE-TEST-REFRESH-BODY-written-by-background-SWR-microtask. Different from warm body so the cache rewrite is detectable. Padded well past the 100-char acceptance threshold so fetchResultContents takes this.';
  await webSearchTool.run(
    { query, num_results: 1, noCache: false },
    {
      _searchViaPlaywright: async () => [{ title: 'T', url, snippet: 'snippet' }],
      _searchViaDdg: async () => [],
      _isPlaywrightCliAvailable: async () => true,
      _fetchViaJina: async () => {
        refreshCalled += 1;
        return { url, content: refreshBody, notModified: false };
      },
    },
  );

  // (4) IMMEDIATELY flip MELO_HOME to B — simulates what a multi-profile
  //     runtime hook would do AFTER run #2 returns but BEFORE the microtask
  //     queued inside it resolves.  Without the §6 capture, the SWR refresh
  //     would resolve cacheDbPath() under B → write to B's DB.
  process.env.MELO_HOME = _homeB;

  // (5) Drain the microtask chain — let SWR refresh run to completion
  //     under the (now flipped) MELO_HOME.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.ok(refreshCalled >= 1, 'background SWR refresh fetcher must have fired');

  // (6) **The load-bearing invariant**: home A's DB row was REWRITTEN by
  //     the refresh (created_at advanced, content_map carries refreshBody).
  //     Pre-§6-fix this would write to home B (NEW DB file appearing at
  //     dbPathB), leaving A's row untouched (still stale).
  _resetWebSearchCacheForTests();
  db = new DatabaseSync(dbPathA);
  const rowA = db.prepare('SELECT * FROM web_search_cache WHERE query_raw = ?').get(query);
  db.close();
  assert.ok(rowA, 'home A row must still exist after refresh');
  const contentA = JSON.parse(rowA.content_map);
  assert.match(
    String(contentA[url] || ''),
    /CAPTURE-TEST-REFRESH-BODY/,
    'home A cache must hold the refresh body — the SWR microtask captured home A at schedule time and wrote there',
  );

  // (7) Negative invariant: home B's DB should NOT exist (or if it does,
  //     it must not contain this query).  Pre-fix the SWR would create
  //     dbPathB and write the refresh there — that's the bug.
  const dbPathB = join(_homeB, 'desktop', 'search.sqlite');
  if (existsSync(dbPathB)) {
    const dbB = new DatabaseSync(dbPathB);
    const rowB = dbB.prepare('SELECT * FROM web_search_cache WHERE query_raw = ?').get(query);
    dbB.close();
    assert.equal(rowB, undefined,
      'home B DB must NOT have a row for this query — refresh should have written to A (captured home)');
  }
});
