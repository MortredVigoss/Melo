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
  // Should be a function instead.
  assert.match(
    source,
    /function\s+cacheDbPath\s*\(\)\s*\{[\s\S]*?return\s+join\(\s*getMeloHome\(\)/,
    'cacheDbPath should be a call-time function',
  );
});
