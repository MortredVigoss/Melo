/**
 * Phase G-1c (2026-05-10): regression coverage for the evidenceTrail
 * collection added to webSearchTool.run().
 *
 * Phase chain (in WS_PHASE_ORDER): weather-fast-path → cache → serp →
 * synonym-retry → content-fetch → semantic-rerank.  The 3-layer abort
 * contract from G-1b is enforced uniformly here from day one (lessons
 * from the 4-commit G-1b chain): pre-await + post-await + catch with
 * abort all route through bailAbortedWebSearch which records current
 * phase as fail aborted-mid-loop and remaining phases as skip.
 *
 * What we pin (POC milestone scope):
 *   1. Every return path carries `evidenceTrail: []` (validate fail / cache
 *      hit / weather hit / serp ok / serp fail / abort).
 *   2. Trail entries shape: { tier, outcome, latencyMs } + optional
 *      reason / method / extra.  `extra` (not `metadata`) — same convention
 *      as fetchUrlTool / socialLinkTool to keep cross-tool grep clean.
 *   3. Cache hit short-circuits subsequent phases (no skip entries needed
 *      because they weren't part of the success path).
 *   4. Abort at each phase produces shape-stable trail with current=fail
 *      aborted-mid-loop + remaining=skip aborted-by-prev-phase.
 *
 * What we do NOT pin (later milestones G-1d/e/f): how the trail surfaces
 * in chat thread state, prompt context, or UI.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webSearchTool } from './webSearchTool.js';

const TOOL_PATH = join(dirname(fileURLToPath(import.meta.url)), 'webSearchTool.js');
const TOOL_SOURCE = readFileSync(TOOL_PATH, 'utf8');

function assertTrailShape(entry) {
  assert.equal(typeof entry.tier, 'string');
  assert.ok(['ok', 'fail', 'skip'].includes(entry.outcome), `outcome ${entry.outcome} in ok|fail|skip`);
  assert.equal(typeof entry.latencyMs, 'number');
  assert.ok(entry.latencyMs >= 0);
  if (entry.extra !== undefined) {
    assert.equal(typeof entry.extra, 'object');
    assert.notEqual(entry.extra, null);
  }
}

test('evidenceTrail: trail entry uses `extra` (not `metadata`) so cross-tool grep stays clean', () => {
  // Match real recordWebSearchTrail CALLS, not the function declaration.
  const calls = TOOL_SOURCE.matchAll(/recordWebSearchTrail\(trail,\s*['"][^'"]+['"][\s\S]*?\)\s*;/g);
  let n = 0;
  for (const m of calls) {
    n += 1;
    assert.equal(/\bmetadata:/.test(m[0]), false,
      `recordWebSearchTrail call must not use \`metadata:\`; offending: ${m[0].slice(0, 200)}`);
  }
  assert.ok(n >= 8, `expected >= 8 recordWebSearchTrail calls in source, got ${n}`);
});

test('evidenceTrail: invalid query returns trail with single validate.fail entry', async () => {
  const result = await webSearchTool.run({ query: '' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_QUERY');
  assert.ok(Array.isArray(result.evidenceTrail));
  assert.equal(result.evidenceTrail.length, 1);
  assertTrailShape(result.evidenceTrail[0]);
  assert.equal(result.evidenceTrail[0].tier, 'validate');
  assert.equal(result.evidenceTrail[0].outcome, 'fail');
  assert.equal(result.evidenceTrail[0].reason, 'invalid-query');
});

test('evidenceTrail: invalid query (whitespace only) returns trail with validate.fail', async () => {
  const result = await webSearchTool.run({ query: '   ' });
  assert.equal(result.ok, false);
  assert.equal(result.evidenceTrail[0].tier, 'validate');
  assert.equal(result.evidenceTrail[0].reason, 'invalid-query');
});

test('evidenceTrail: aborted weather-fast-path produces shape-stable trail with all 7 phases', async () => {
  // Pre-aborted signal triggers the very first phase (weather-fast-path)
  // bail.  weather query (matches WEATHER_KEYWORDS) so we enter the
  // weather block; the pre-await abort gate then fires.
  const ac = new AbortController();
  ac.abort();
  const result = await webSearchTool.run(
    { query: '今天天气怎么样', noCache: true },
    { signal: ac.signal },
  );
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  // 7 phases: current weather-fast-path = fail, the other 6 = skip.
  const tiers = result.evidenceTrail.map(e => `${e.tier}.${e.outcome}`);
  assert.ok(tiers.includes('weather-fast-path.fail'),
    `weather-fast-path must be fail; got ${tiers.join(', ')}`);
  for (const remaining of ['cache', 'api-direct', 'serp', 'synonym-retry', 'content-fetch', 'semantic-rerank']) {
    assert.ok(tiers.includes(`${remaining}.skip`),
      `${remaining} must be skip; got ${tiers.join(', ')}`);
  }
  // meta backward-compat: intent + spanId still present on aborted return
  assert.ok(result.meta?.intent);
  assert.ok(result.meta?.spanId);
});

test('evidenceTrail: time-sensitive definition query records api-direct.skip reason=time-sensitive and falls through to SERP', async () => {
  // Codex G-2b round-5 (2026-05-14) closeout: `what is the latest Node.js
  // version` matches the implicit definition shape but the time-sensitive
  // keyword (`latest`) means Wikipedia would likely return stale data.
  // The api-direct phase must skip with reason='time-sensitive' so SERP
  // gets a chance to find current info.  We use a pre-aborted signal to
  // catch the immediately-following serp phase's `fail aborted-mid-loop`
  // entry, which proves api-direct didn't short-circuit.
  const ac = new AbortController();
  ac.abort();
  const result = await webSearchTool.run(
    { query: 'what is the latest Node.js version', noCache: true },
    { signal: ac.signal },
  );
  const apiEntry = result.evidenceTrail.find(e => e.tier === 'api-direct');
  assert.equal(apiEntry?.outcome, 'skip');
  assert.equal(apiEntry?.reason, 'time-sensitive');
  assert.equal(apiEntry?.method, 'wikipedia',
    'method=wikipedia so trail analysis can distinguish "no provider knows" from "Wikipedia gated"');
  // serp phase ran next (and got aborted by the pre-aborted signal).
  const serpEntry = result.evidenceTrail.find(e => e.tier === 'serp');
  assert.equal(serpEntry?.outcome, 'fail');
  assert.equal(serpEntry?.reason, 'aborted-mid-loop');
});

test('evidenceTrail: time-sensitive Chinese definition (什么是最新...) also gates', async () => {
  const ac = new AbortController();
  ac.abort();
  const result = await webSearchTool.run(
    { query: '什么是最新的 React 框架', noCache: true },
    { signal: ac.signal },
  );
  const apiEntry = result.evidenceTrail.find(e => e.tier === 'api-direct');
  assert.equal(apiEntry?.outcome, 'skip');
  assert.equal(apiEntry?.reason, 'time-sensitive');
});

test('evidenceTrail: abort during Wikipedia fetch — api-direct owns the bail, serp gets skip aborted-by-prev-phase', async () => {
  // Codex G-2b round-5 B closeout (2026-05-14): when a signal aborts
  // mid-Wikipedia-fetch, fetchFromWikipedia catches AbortError and returns
  // `{ ok:false, reason:'aborted' }` rather than throwing.  Pre-fix that
  // got recorded as api-direct.fail aborted + serp.fail aborted-mid-loop
  // (double current-phase entry).  Now api-direct hands off via
  // bailAbortedWebSearch so it owns the bail and serp is properly downstream
  // skip.  Use `wiki:` explicit prefix to bypass time-sensitive gate (so we
  // actually reach provider.fetch) AND have the pre-aborted signal flow
  // through to fetchFromWikipedia's abort catch.
  const ac = new AbortController();
  ac.abort();
  const result = await webSearchTool.run(
    { query: 'wiki: Marie Curie', noCache: true },
    { signal: ac.signal },
  );
  const apiEntry = result.evidenceTrail.find(e => e.tier === 'api-direct');
  assert.equal(apiEntry?.outcome, 'fail');
  assert.equal(apiEntry?.reason, 'aborted-mid-loop',
    'api-direct must own the bail when abort hit during its provider.fetch');
  // Exactly one phase carries aborted-mid-loop; everything after is skip.
  for (const phase of ['serp', 'synonym-retry', 'content-fetch', 'semantic-rerank']) {
    const e = result.evidenceTrail.find(e => e.tier === phase);
    assert.equal(e?.outcome, 'skip', `${phase} must be skip, got ${e?.outcome}`);
    assert.equal(e?.reason, 'aborted-by-prev-phase',
      `${phase} must show aborted-by-prev-phase, not its own fail`);
  }
  // Sanity: no second aborted-mid-loop fail anywhere in the trail.
  const failEntries = result.evidenceTrail.filter(e => e.outcome === 'fail' && e.reason === 'aborted-mid-loop');
  assert.equal(failEntries.length, 1, `expected exactly 1 aborted-mid-loop fail, got ${failEntries.length}`);
});

test('evidenceTrail: aborted at first network phase records serp.fail; api-direct still shows its real (sync) outcome', async () => {
  // Non-weather query + noCache=true with a pre-aborted signal:
  //   • cache phase → skip noCache=true (sync, never paid network)
  //   • api-direct → no provider matched ("fixture query foo bar baz"
  //     isn't a definition shape).  api-direct has no abort gates so it
  //     reports its REAL outcome `skip no-provider-match`, not a spurious
  //     `fail aborted-mid-loop`.  This was the post-Codex-G-2b-round-5
  //     fix: gate-skip semantics must survive a pre-aborted signal so
  //     trail analysis can distinguish "abort hit while api-direct was
  //     about to skip" from "abort interrupted a Wikipedia fetch".
  //   • serp is the first phase that would pay network latency, so it's
  //     the canonical bail point — `fail aborted-mid-loop`.
  //   • synonym-retry / content-fetch / semantic-rerank → skip
  //     aborted-by-prev-phase as before.
  const ac = new AbortController();
  ac.abort();
  const result = await webSearchTool.run(
    { query: 'fixture query foo bar baz', noCache: true },
    { signal: ac.signal },
  );
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);

  const apiEntry = result.evidenceTrail.find(e => e.tier === 'api-direct');
  assert.equal(apiEntry?.outcome, 'skip',
    'api-direct must report its real sync outcome, not a spurious fail');
  assert.equal(apiEntry?.reason, 'no-provider-match');

  const serpEntry = result.evidenceTrail.find(e => e.tier === 'serp');
  assert.equal(serpEntry?.outcome, 'fail');
  assert.equal(serpEntry?.reason, 'aborted-mid-loop');

  // synonym-retry / content-fetch / semantic-rerank all skipped.
  for (const phase of ['synonym-retry', 'content-fetch', 'semantic-rerank']) {
    const e = result.evidenceTrail.find(e => e.tier === phase);
    assert.equal(e?.outcome, 'skip');
    assert.equal(e?.reason, 'aborted-by-prev-phase');
  }
});

test('evidenceTrail: aborted cache phase (real cache hit) bails to aborted instead of returning cached result', async () => {
  // G-1c follow-up #1 (Codex C 闭环 2026-05-10): pre-fix, an aborted
  // signal at cache phase entry would still let getCachedSearch return
  // a fresh row and the run would emit cache.ok + return a successful
  // search to the UI — directly contradicts user-decided contract that
  // Stop semantics outranks cache hit.  Now the entry abort gate fires
  // before the cache lookup; even if cache had a hit, we bail.
  // Real cache may be empty in test env, but the abort path doesn't
  // need a cache hit to exercise — the gate fires regardless.
  const ac = new AbortController();
  ac.abort();
  const result = await webSearchTool.run(
    { query: 'cache abort test fixture query', noCache: false },
    { signal: ac.signal },
  );
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  // cache phase must record fail aborted-mid-loop (not 'ok' even if cache had a hit).
  const cacheEntry = result.evidenceTrail.find(e => e.tier === 'cache');
  assert.equal(cacheEntry?.outcome, 'fail');
  assert.equal(cacheEntry?.reason, 'aborted-mid-loop');
  // All subsequent phases must be skip.
  for (const phase of ['serp', 'synonym-retry', 'content-fetch', 'semantic-rerank']) {
    const e = result.evidenceTrail.find(e => e.tier === phase);
    assert.equal(e?.outcome, 'skip', `${phase} must be skip after cache abort`);
    assert.equal(e?.reason, 'aborted-by-prev-phase');
  }
});

// ─── G-1c follow-up #2 (Codex C round-2 闭环 2026-05-10): mid-await abort ────
//
// Pre-aborted signal tests don't catch the real bad path: signal flips
// AFTER raceSerpProviders / fetchResultContents start their await.  Now
// the race carries an abort listener and content-fetch checks signal
// before each PW fallback target — verify the run finishes promptly
// after a delayed abort, instead of waiting for PW timeout.

test('evidenceTrail: mid-await abort during SERP race finishes promptly (no waiting for PW timeout)', async () => {
  // Fire abort 50ms after run() starts.  raceSerpProviders' abort
  // listener should resolve the race immediately with errors=['aborted'],
  // and the outer post-await gate in run() should record serp.fail
  // aborted-mid-loop.  Total run latency must be << SERP_STAGGER_MS +
  // PW timeout (which is 10+s without the listener).
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const tStart = Date.now();
  const result = await webSearchTool.run(
    { query: 'mid await abort race fixture xyz123', noCache: true },
    { signal: ac.signal },
  );
  const elapsed = Date.now() - tStart;
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  // Must finish in well under PW timeout (~10s).  Generous bound to
  // tolerate slow CI: 4 seconds is far below the 10s+ pre-fix waiting
  // pattern.
  assert.ok(elapsed < 4000,
    `run must abort promptly (mid-await abort listener), got ${elapsed}ms`);
  const serpEntry = result.evidenceTrail.find(e => e.tier === 'serp');
  assert.equal(serpEntry?.outcome, 'fail');
  // synonym/content/rerank skipped per the bailAbortedWebSearch contract.
  for (const phase of ['synonym-retry', 'content-fetch', 'semantic-rerank']) {
    const e = result.evidenceTrail.find(e => e.tier === phase);
    assert.equal(e?.outcome, 'skip', `${phase} must be skip after mid-await SERP abort`);
  }
});

// ─── G-1c follow-up #3 (Codex C round-3 闭环 2026-05-10): in-flight PW abort ────
//
// abortRace helper means a single in-flight PW await returns immediately
// when signal flips, instead of waiting for the underlying PW process to
// finish (5-15s typical).  Real subprocess kill is G-5; this verifies the
// JS-layer behavior using _fetchViaPlaywrightCli test seam.

test('evidenceTrail: mid-await abort during PW fallback returns promptly + stub IS called (G-1c round-4 Codex 闭环)', async () => {
  // G-1c round-3 had this test but used 50ms abort which fired during
  // SERP race (entry gate) BEFORE content-fetch ever started → the
  // _fetchViaPlaywrightCli stub was never called and the test passed
  // for the wrong reason (false-green).  Round-4 fix: use the new
  // _searchViaPlaywright / _searchViaDdg seams to construct a
  // deterministic path that actually reaches PW content fallback
  // before abort, then assert pwStub.calledTimes >= 1 to prove the
  // path was exercised.
  const ac = new AbortController();
  let pwStubCalls = 0;
  let pwStubAbortRaised = 0;
  const hangingPw = (url) => {
    pwStubCalls += 1;
    return new Promise(() => {
      // never resolves; abortRace will reject on signal.
    });
  };
  // Unique URLs per test run so URL cache from earlier runs doesn't
  // short-circuit Stage-1 and skip Jina+PW (made test 9 false-green
  // before — see uniqueTag pattern in test 9 above).
  const uniqueTag = `g1c-r4-pwfb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pwSerpStub = () => Promise.resolve([
    { title: 'r1', url: `https://${uniqueTag}.example.com/a`, snippet: 'foo' },
    { title: 'r2', url: `https://${uniqueTag}.example.com/b`, snippet: 'bar' },
    { title: 'r3', url: `https://${uniqueTag}.example.com/c`, snippet: 'baz' },
  ]);
  // DDG stub: empty so SERP race always picks PW.
  const ddgStub = () => Promise.resolve([]);
  // CLI probe stub: PW available so the content-fetch PW fallback path
  // is reachable.
  const cliAvailStub = () => Promise.resolve(true);

  const tStart = Date.now();
  const runP = webSearchTool.run(
    { query: `mid-await abort PW fallback ${uniqueTag}`, noCache: true },
    {
      signal: ac.signal,
      _fetchViaPlaywrightCli: hangingPw,
      _searchViaPlaywright: pwSerpStub,
      _searchViaDdg: ddgStub,
      _isPlaywrightCliAvailable: cliAvailStub,
      // Jina misses → failed.size > 0 → enter PW fallback (the path
      // under test).  Without this seam example.com would either get
      // cached body (if seen before) or rely on real network.
      _fetchViaJina: async () => ({ content: null }),
    },
  );
  // Poll until pwStubCalls > 0, then abort.  Generous 8s ceiling for
  // Jina to time out + content-fetch to enter PW fallback.
  const pollDeadline = Date.now() + 8000;
  while (pwStubCalls === 0 && Date.now() < pollDeadline) {
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(pwStubCalls >= 1,
    `PW stub must be reached before abort (proves path coverage); calledTimes=${pwStubCalls}`);
  ac.abort();
  const result = await runP;
  const elapsed = Date.now() - tStart;
  // Without abortRace the PW await would block until natural timeout
  // (5-15s+ per target × PW_FALLBACK_MAX).  abortRace must reject
  // immediately so total elapsed stays close to the abort point.
  // Generous 12s ceiling tolerates slow CI + Jina timeout (~6s).
  assert.ok(elapsed < 12000,
    `mid-await PW abort must return promptly via abortRace; got ${elapsed}ms with pwStubCalls=${pwStubCalls}`);
});

test('evidenceTrail: mid-await abort during content-fetch PW availability probe returns promptly + probe seam IS called (G-1c round-5 Codex 闭环)', async () => {
  // Pre-fix: fetchResultContents had a bare `await isPlaywrightCliAvailable()`
  // before the PW fallback loop.  Signal abort during that probe (~8s
  // cold-start) couldn't be cancelled.  Codex C round-5 caught this as
  // same-class as raceSerpProviders' probe.  Round-5 fix: probe is now
  // also abort-raced and accepts an _isPlaywrightCliAvailable seam
  // threaded from run() through fetchResultContents.
  //
  // This test drives the bad path with stubs:
  //   - SERP returns results (so we reach content-fetch)
  //   - Jina misses (so we enter PW fallback decision)
  //   - PW availability probe HANGS (so abort can race it)
  //   - signal aborts after probe seam is called
  //   - assert: probe seam was called + run returns promptly
  const ac = new AbortController();
  let probeCalls = 0;
  // Staged stub: 1st call (from raceSerpProviders) resolves true so SERP
  // race can proceed; 2nd call (from fetchResultContents) hangs so
  // content-fetch probe abort path is the one we exercise.
  const stagedProbe = () => {
    probeCalls += 1;
    if (probeCalls === 1) return Promise.resolve(true);
    return new Promise(() => {}); // hang
  };
  // Unique URLs per test run to avoid Stage-1 URL cache hits from
  // earlier tests (cache.sqlite persists in dev/CI between runs).
  const uniqueTag = `g1c-r5-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pwSerpStub = () => Promise.resolve([
    { title: 'r1', url: `https://${uniqueTag}.example.com/a`, snippet: 'foo' },
    { title: 'r2', url: `https://${uniqueTag}.example.com/b`, snippet: 'bar' },
  ]);
  const ddgStub = () => Promise.resolve([]);

  const tStart = Date.now();
  const runP = webSearchTool.run(
    { query: `mid-await content-fetch probe abort ${uniqueTag}`, noCache: true },
    {
      signal: ac.signal,
      _isPlaywrightCliAvailable: stagedProbe,
      _searchViaPlaywright: pwSerpStub,
      _searchViaDdg: ddgStub,
      // Jina misses every URL → failed.size > 0 → enter PW fallback
      // probe (the path under test).
      _fetchViaJina: async () => ({ content: null }),
    },
  );
  // Wait until probe is reached, then abort.  probe is called from BOTH
  // raceSerpProviders (early) AND fetchResultContents (later) — first
  // call is from the SERP race, second from content-fetch.  We want to
  // reach the second; poll past the first.  Generous 10s ceiling.
  const pollDeadline = Date.now() + 10000;
  while (probeCalls < 2 && Date.now() < pollDeadline) {
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(probeCalls >= 2,
    `content-fetch probe seam must be reached (after SERP race probe); calledTimes=${probeCalls}`);
  ac.abort();
  const result = await runP;
  const elapsed = Date.now() - tStart;
  // Without abortRace this would block ~8s on probe + add Jina timeout.
  // 12s ceiling tolerates Jina + slow CI but firmly catches regressions.
  assert.ok(elapsed < 12000,
    `content-fetch probe abort must return promptly via abortRace; got ${elapsed}ms with probeCalls=${probeCalls}`);
  // Result must be aborted marker (not a successful search).
  assert.equal(result.ok, false);
});

test('source-level backstop (auxiliary, not primary): abortRace helper applied to all 4 PW await sites + health probe', () => {
  // G-1c lessons-learned (round-5): source grep is AUXILIARY backstop.
  // Primary proof of behavior is the mid-await abort tests above with
  // stub.calledTimes assertions.  This test catches "future edit drops
  // abortRace verbatim" regressions; behavior tests catch "code still
  // doesn't actually abort" issues.  Both layers needed; neither alone
  // suffices.  Counts: 4 PW await sites in run-path + 1 in health probe.
  assert.match(TOOL_SOURCE, /function abortRace\(promise,\s*signal\)/);
  // Production hot-path PW awaits — all 4 must be wrapped:
  //   1. raceSerpProviders PW availability probe (pwAvailableImpl)
  //   2. raceSerpProviders PW SERP leg          (pwSearchImpl)
  //   3. fetchResultContents PW availability probe (pwAvailableImpl, round-5)
  //   4. fetchResultContents PW content fallback   (pwImpl)
  // Plus health-check (round-5 consistency): isPlaywrightCliAvailable()
  // bare in checkSearchHealth.
  const abortRaceUsages = TOOL_SOURCE.match(/abortRace\(/g) || [];
  // 1 (helper def callsite via isPlaywrightCliAvailable in health) +
  // 4 hot-path = 5+. The helper definition `function abortRace` is also
  // matched once but with `function `, so the call-site count is
  // matches MINUS 1 (definition).  We expect at LEAST 5 call sites.
  assert.ok(abortRaceUsages.length >= 5,
    `expected >= 5 abortRace usages (4 PW awaits + health probe); got ${abortRaceUsages.length}`);
  // Specific anchors that future refactors must keep:
  assert.match(TOOL_SOURCE, /abortRace\(pwAvailableImpl\(\),\s*signal\)/,
    'PW availability probe call must be wrapped');
  assert.match(TOOL_SOURCE, /abortRace\(pwSearchImpl\(/,
    'PW SERP leg call must be wrapped');
  assert.match(TOOL_SOURCE, /abortRace\(fallbackImpl\(url,\s*signal\),\s*signal\)/,
    'content-fetch fallback call must be wrapped (Stage 2c round-2 threaded signal as 2nd arg to the impl so CDP fetcher can close the page on abort)');
  assert.match(TOOL_SOURCE, /abortRace\(isPlaywrightCliAvailable\(\),\s*signal\)/,
    'health-check PW probe must be wrapped (round-5 consistency)');
});

test('evidenceTrail: source-level guard — raceSerpProviders carries an abort listener that flips done', () => {
  // Pin the abort listener wiring in source so a future "simplification"
  // that drops the listener red-flags here.
  assert.match(
    TOOL_SOURCE,
    /signal\.addEventListener\(\s*['"]abort['"]\s*,\s*abortListener[\s\S]*?{\s*once:\s*true\s*}\s*\)/,
    'raceSerpProviders must register an abort listener on the caller signal',
  );
  // And every late settle must check `done` before recording results.
  const lateSettleChecks = TOOL_SOURCE.match(/if\s*\(done\)\s*return;\s*\/\/\s*ignore late settle/g) || [];
  assert.ok(lateSettleChecks.length >= 2,
    `late-settle abort guards must be present in PW + Jina branches; got ${lateSettleChecks.length}`);
});

test('evidenceTrail: source-level guard — fetchResultContents has entry + pre-fallback abort gates', () => {
  // Stage 2c round-2: return shape changed from `[]` to
  // `{ items, fallbackTier }` so run() can record the actual tier in
  // trail.method.  Entry abort gate still required.
  assert.match(
    TOOL_SOURCE,
    /async function fetchResultContents[\s\S]*?if\s*\(signal\?\.aborted\)\s*return\s*\{\s*items:\s*\[\],\s*fallbackTier:\s*null\s*\}/,
    'fetchResultContents must check signal.aborted at the very top (returning {items:[], fallbackTier:null} per Stage 2c round-2 shape)',
  );
  // Stage 3 fallback (PW or CDP per env) must check signal before entering
  // AND inside the loop.  Loop variable renamed pwTargets → fallbackTargets
  // in Stage 2c to reflect the dual-tier nature (cdp-chrome OR playwright).
  assert.match(
    TOOL_SOURCE,
    /\/\/ Stage 3[\s\S]*?if\s*\(signal\?\.aborted\)\s*\{[\s\S]*?for\s*\(const url of fallbackTargets\)\s*\{\s*[\s\S]*?if\s*\(signal\?\.aborted\)\s*break/,
    'fetchResultContents Stage 3 must abort-gate before AND inside the fallback loop (CDP or PW)',
  );
});

test('evidenceTrail: source-level guard — cache fresh/stale return blocks must check signal.aborted before recordTrail/return', () => {
  // Pin the abort gate in source so a future edit that "simplifies away"
  // the post-lookup check (covers the rare race between entry-gate and
  // synchronous getCachedSearch) shows up red here.  Looks for the
  // distinctive bailAbortedWebSearch call inside the cache `if (fresh)`
  // and `if (stale)` branches.
  const cacheBlockMatch = TOOL_SOURCE.match(
    /if\s*\(!noCache\)\s*\{[\s\S]*?if\s*\(fresh\)\s*\{[\s\S]*?bailAbortedWebSearch[\s\S]*?if\s*\(stale\)\s*\{[\s\S]*?bailAbortedWebSearch/,
  );
  assert.ok(cacheBlockMatch,
    'cache fresh + stale branches must each contain a post-lookup bailAbortedWebSearch abort check');
});

test('evidenceTrail: aborted return preserves backward-compat meta.intent and meta.timings', async () => {
  // Existing health.test.js / helpers.test.js pin meta.intent and
  // meta.timings on the SEARCH_FAILED branch — abort must not break them.
  const ac = new AbortController();
  ac.abort();
  const result = await webSearchTool.run(
    { query: 'preserve meta on abort', noCache: true },
    { signal: ac.signal },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'SEARCH_FAILED');
  assert.ok(result.meta?.timings);
  assert.equal(result.meta.timings.cacheHit, false);
  assert.ok(result.meta?.intent);
  assert.equal(typeof result.meta.intent.kind, 'string');
});
