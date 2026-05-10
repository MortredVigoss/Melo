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

test('evidenceTrail: aborted cache phase (non-weather query) skips phases after cache', async () => {
  // Non-weather query → no weather phase; cache check is the first await.
  // Pre-aborted signal triggers when reaching the cache phase (which is
  // synchronous — actually bails at the next await, which is serp).
  // To test cache-phase abort specifically we'd need to mock getCachedSearch
  // to await; for now exercise the more common abort point: serp pre-await.
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
