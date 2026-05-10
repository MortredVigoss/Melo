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

test('evidenceTrail: aborted weather-fast-path produces shape-stable trail with all 6 phases', async () => {
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
  // 6 phases: current weather-fast-path = fail, the other 5 = skip.
  const tiers = result.evidenceTrail.map(e => `${e.tier}.${e.outcome}`);
  assert.ok(tiers.includes('weather-fast-path.fail'),
    `weather-fast-path must be fail; got ${tiers.join(', ')}`);
  for (const remaining of ['cache', 'serp', 'synonym-retry', 'content-fetch', 'semantic-rerank']) {
    assert.ok(tiers.includes(`${remaining}.skip`),
      `${remaining} must be skip; got ${tiers.join(', ')}`);
  }
  // meta backward-compat: intent + spanId still present on aborted return
  assert.ok(result.meta?.intent);
  assert.ok(result.meta?.spanId);
});

test('evidenceTrail: aborted serp phase (noCache=true) records serp.fail and skips remaining phases', async () => {
  // Non-weather query + noCache=true → cache phase records skip,
  // serp phase is the next abort gate.  This test is named "serp" not
  // "cache" because noCache=true bypasses the cache lookup entirely
  // (G-1c follow-up #1 renamed: was misleadingly called "aborted cache
  // phase" before — Codex caught the false coverage).
  const ac = new AbortController();
  ac.abort();
  const result = await webSearchTool.run(
    { query: 'fixture query foo bar baz', noCache: true },
    { signal: ac.signal },
  );
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
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

test('evidenceTrail: source-level guard — fetchResultContents has entry + pre-PW-fallback abort gates', () => {
  assert.match(
    TOOL_SOURCE,
    /async function fetchResultContents[\s\S]*?if\s*\(signal\?\.aborted\)\s*return\s*\[\]/,
    'fetchResultContents must check signal.aborted at the very top',
  );
  // PW fallback block must check signal before entering AND in the loop.
  assert.match(
    TOOL_SOURCE,
    /\/\/ Stage 3[\s\S]*?if\s*\(signal\?\.aborted\)\s*\{[\s\S]*?for\s*\(const url of pwTargets\)\s*\{\s*[\s\S]*?if\s*\(signal\?\.aborted\)\s*break/,
    'fetchResultContents Stage 3 must abort-gate before AND inside the PW fallback loop',
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
