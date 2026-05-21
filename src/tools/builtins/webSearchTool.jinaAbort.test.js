/**
 * 2026-05-21 audit闭环 #6 — focused regression test for the Jina fan-out
 * internal-abort wiring (Codex Tier-2B B grade ⚪ closeout).
 *
 * The fix introduced an `internalAc` AbortController inside the Jina
 * Stage-2 fan-out so that early-exit (quorum / hard deadline / outer
 * signal abort) cancels in-flight Jina HTTP requests, not just stops
 * updating state.  This test pins the actual abort wiring:
 *
 *   - Inject _fetchViaJina that captures the signal it receives.
 *   - Trigger early finish via quorum (JINA_SUCCESS_THRESHOLD successes).
 *   - Assert remaining slow fetches' captured signals are now aborted.
 *
 * Pre-fix the signal would be the bare outer signal (unchanged on early
 * finish) — fetches would keep running.  Post-fix the signal is the
 * internal AC's, which finish() aborts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webSearchTool, _resetWebSearchCacheForTests } from './webSearchTool.js';

let prevHome, tmpHome;
test.beforeEach(() => {
  prevHome = process.env.MELO_HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'melo-jina-abort-test-'));
  process.env.MELO_HOME = tmpHome;
  _resetWebSearchCacheForTests();
});
test.afterEach(() => {
  if (prevHome === undefined) delete process.env.MELO_HOME;
  else process.env.MELO_HOME = prevHome;
  _resetWebSearchCacheForTests();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function fakeSerpProvider(urls) {
  return async () => urls.map((u, i) => ({
    title: `R${i}`,
    url: u,
    snippet: `s ${u}`,
  }));
}

test('Jina internal abort: quorum-hit (3 successes) aborts the still-pending in-flight fetches', async () => {
  // JINA_SUCCESS_THRESHOLD === 3.  selectContentUrls clips to
  // CONTENT_FETCH_COUNT (= 4) URLs before fan-out, so we use 4: 3 fast
  // + 1 slow.  First 3 resolve fast with valid content → quorum hits
  // → finish() fires → internalAc.abort() → slow-4's captured signal
  // should flip to aborted before it gets a chance to resolve.
  const urls = [
    'https://example.com/fast-1', 'https://example.com/fast-2',
    'https://example.com/fast-3', 'https://example.com/slow-4',
  ];

  // Track captured signals per URL so we can assert which got aborted.
  const capturedSignals = new Map();
  // Track resolution promises so slow URLs can be inspected post-finish.
  const slowResolvers = [];

  const fakeJina = (url, signal /*, validators */) => {
    capturedSignals.set(url, signal);
    if (url.includes('fast-')) {
      // Fast URLs resolve immediately with valid content (> 100 chars).
      return Promise.resolve({
        url,
        content: `Fast body for ${url}. Padded over the 100-char acceptance threshold so this lands in the results map and counts toward the JINA_SUCCESS_THRESHOLD quorum.`,
        notModified: false,
      });
    }
    // Slow URLs never resolve naturally — we wait for internalAc abort
    // to flip the signal, then resolve with a marker so the outer
    // Promise.all completes (otherwise the test would hang).
    return new Promise((resolve) => {
      slowResolvers.push(() => resolve({ url, content: '', notModified: false }));
      // Watch for signal abort — same shape real fetchViaJina would observe.
      if (signal && !signal.aborted) {
        signal.addEventListener('abort', () => {
          // Don't resolve immediately — let the test assert signal.aborted
          // first, then we drain.  Real fetchViaJina would reject with
          // AbortError here.  The outer Stage-2 loop only inspects state
          // in .then if !done, so either resolve or reject is fine.
        }, { once: true });
      }
    });
  };

  // Drive the actual run() so the production Stage-2 fan-out wires the
  // internal AC.  noCache=true so cache layer doesn't shortcut.
  const runPromise = webSearchTool.run(
    { query: 'jina abort quorum test', num_results: 5, noCache: true },
    {
      _searchViaPlaywright: fakeSerpProvider(urls),
      _searchViaDdg: fakeSerpProvider([]),
      _isPlaywrightCliAvailable: async () => true,
      _fetchViaJina: fakeJina,
    },
  );

  // Wait long enough for the 3 fast URLs to resolve + finish() to fire.
  // Then resolve the 2 slow URLs so the outer await doesn't hang.
  await new Promise(r => setTimeout(r, 50));

  // 真不变量: the slow URL's captured signal is aborted by now.
  const slowSignal4 = capturedSignals.get('https://example.com/slow-4');
  assert.ok(slowSignal4, 'fakeJina must have been called for slow-4');
  assert.equal(slowSignal4.aborted, true,
    'slow-4 signal must be aborted by quorum-driven finish() — pre-fix would still be false');

  // 真不变量 #2: the internal signal is DIFFERENT from any caller signal
  // (since none was passed in this test) — confirms the abort came from
  // finish(), not external.  We don't have the external signal here so
  // the simpler proof: signal exists + signal is aborted = finish() did it.
  // (If we passed an outer signal that was never aborted, we'd also see
  //  slow-* signals aborted — proving the internal AC is doing the work.)

  // Drain — let slow URLs resolve so runPromise can settle.
  slowResolvers.forEach(fn => fn());
  await runPromise; // shouldn't throw
});

test('Jina internal abort: outer signal abort still propagates to in-flight fetches (back-compat)', async () => {
  // Before the fix, passing an outer signal directly to fetchViaJina was
  // what gave callers cancellation.  Post-fix, fetchViaJina sees the
  // internal AC's signal — but the internal AC must forward outer
  // signal abort.  This test pins that back-compat: outer caller signal
  // aborts → internal AC aborts → in-flight Jina fetch signal aborted.
  const url = 'https://example.com/outer-abort-prop';
  let capturedSignal = null;
  const fakeJina = (u, signal) => {
    capturedSignal = signal;
    return new Promise(() => { /* never resolves */ });
  };
  const ac = new AbortController();

  const runPromise = webSearchTool.run(
    { query: 'outer abort prop test', num_results: 1, noCache: true },
    {
      signal: ac.signal,
      _searchViaPlaywright: fakeSerpProvider([url]),
      _searchViaDdg: fakeSerpProvider([]),
      _isPlaywrightCliAvailable: async () => true,
      _fetchViaJina: fakeJina,
    },
  );

  // Yield enough for the fetch to start.
  await new Promise(r => setTimeout(r, 20));
  assert.ok(capturedSignal, 'fakeJina must have been called and captured a signal');
  assert.equal(capturedSignal.aborted, false, 'pre-abort: captured signal not aborted');

  ac.abort();
  // Yield so the abort forwarder fires.
  await new Promise(r => setTimeout(r, 20));
  assert.equal(capturedSignal.aborted, true,
    'outer signal abort must forward through internal AC to in-flight Jina fetches');

  // Don't await runPromise — it may settle with various error shapes
  // depending on cache state.  The wiring assertion is what matters.
  try { await runPromise; } catch { /* expected variants */ }
});
