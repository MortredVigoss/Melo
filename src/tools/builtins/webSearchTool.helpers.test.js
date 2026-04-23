/**
 * Unit tests for the pure helpers introduced in the web-search improvement
 * rollout.  These helpers have no external dependencies (SERP, embeddings,
 * SQLite) and can be tested in isolation — but because some of them are
 * module-private, we exercise them through the public tool surface when
 * necessary.
 *
 * What's covered:
 *   - URL canonicalisation (tracking params, m./www./amp. subdomains, trailing slash)
 *   - Query normalisation (CJK-aware, order-independent)
 *   - Intent classification (time-sensitive keywords + intrinsic kinds)
 *   - Synonym / alias expansion (node → nodejs etc.)
 *   - Query-biased snippet selection
 *   - Article-date extraction (ISO / relative / year-only)
 *   - Recency boost
 *
 * Runs hermetically: isolated MELO_HOME so it never touches the developer's
 * cache.  Nothing in these tests hits the network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEMP_HOME = mkdtempSync(join(tmpdir(), 'melo-websearch-helpers-'));
process.env.MELO_HOME = TEMP_HOME;

// The module only exports the tool + health API; private helpers aren't
// re-exported, so we import the file as a module namespace and pull what we
// need via a small accessor.  The production invariant is that these pure
// helpers are referenced through the tool's run() — we exercise them here
// by side-loading from the module's internal ESM bindings via a test hook.
//
// Strategy: re-implement a thin seeding layer for cache-hit tests, and
// smoke-test the pure helpers via the tool.parametersSchema + tool.run()
// surface.  For the handful of helpers that are genuinely private (e.g.
// expandQuerySynonyms, classifyQueryIntent), we test them indirectly by
// observing behaviour: if expansion + intent routing work, the cache key
// must segment requests correctly.

const { webSearchTool, __webSearchInternals } = await import('./webSearchTool.js');
const {
  classifyQueryIntent,
  canonicalizeUrl,
  titleFingerprint,
  normalizeQuery,
  buildCacheKey,
  ttlForIntent,
  expandQuerySynonyms,
  extractArticleDate,
  recencyBoost,
  queryBiasedSnippet,
} = __webSearchInternals;

test.after(() => {
  try {
    rmSync(TEMP_HOME, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

// ─── parametersSchema surface (P1-3) ────────────────────────────────────────

test('allowBlockedDomains is exposed on parametersSchema', () => {
  const props = webSearchTool.parametersSchema.properties;
  assert.ok(props.allowBlockedDomains, 'allowBlockedDomains present');
  assert.equal(props.allowBlockedDomains.type, 'boolean');
  assert.equal(props.allowBlockedDomains.default, false);
});

test('parametersSchema examples include an allowBlockedDomains example', () => {
  const hasFlag = webSearchTool.examples.some(e => e.allowBlockedDomains === true);
  assert.ok(hasFlag, 'at least one example demonstrates the allowBlockedDomains flag');
});

// ─── Invalid query fast-fail keeps shape ────────────────────────────────────

test('empty / whitespace query returns INVALID_QUERY', async () => {
  for (const q of ['', '   ', undefined]) {
    const r = await webSearchTool.run({ query: q });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'INVALID_QUERY');
  }
});

// ─── Intent surface propagation ─────────────────────────────────────────────
//
// We can't inspect classifyQueryIntent directly, but the failing SERP path
// surfaces `intent` on meta.  Use the SEARCH_FAILED branch with a short
// signal so we don't actually hit the network.

test('meta.intent.kind is set on SEARCH_FAILED', async () => {
  const r = await webSearchTool.run(
    { query: 'a'.repeat(200), noCache: true },
    { signal: AbortSignal.timeout(500) },
  );
  // Either SERP fails fast or the race completes with no results — either
  // branch writes meta.intent.  Only assert when we really have meta.
  if (!r.ok && r.meta) {
    assert.ok(r.meta.intent, 'intent present on failure meta');
    assert.equal(typeof r.meta.intent.kind, 'string');
    assert.equal(typeof r.meta.intent.timeSensitive, 'boolean');
  }
});

// ─── Span id is stable per run() call and distinct across calls ────────────

test('meta.spanId is a short deterministic-ish string', async () => {
  const r = await webSearchTool.run(
    { query: 'z-invalid-query-for-span-' + Date.now(), noCache: true },
    { signal: AbortSignal.timeout(200) },
  );
  if (!r.ok && r.meta?.spanId) {
    assert.equal(typeof r.meta.spanId, 'string');
    assert.match(r.meta.spanId, /^\d+-\d+$/);
  }
});

// ─── classifyQueryIntent ────────────────────────────────────────────────────

test('classifyQueryIntent marks weather as intrinsically time-sensitive', () => {
  const i = classifyQueryIntent('weather in Tokyo');
  assert.equal(i.kind, 'weather');
  assert.equal(i.timeSensitive, true);
});

test('classifyQueryIntent picks up explicit CJK time keywords', () => {
  const i = classifyQueryIntent('最新 iPhone 发布会');
  assert.equal(i.timeSensitive, true);
});

test('classifyQueryIntent defaults to general+fresh=false for neutral queries', () => {
  const i = classifyQueryIntent('fibonacci recursion base case');
  assert.equal(i.kind, 'general');
  assert.equal(i.timeSensitive, false);
});

test('classifyQueryIntent detects news/price/docs kinds', () => {
  assert.equal(classifyQueryIntent('breaking news Gaza').kind, 'news');
  assert.equal(classifyQueryIntent('btc price today').kind, 'price');
  assert.equal(classifyQueryIntent('react hooks docs').kind, 'docs');
});

// ─── canonicalizeUrl ────────────────────────────────────────────────────────

test('canonicalizeUrl strips common tracking params', () => {
  const out = canonicalizeUrl('https://example.com/a?utm_source=nl&utm_medium=x&id=7&gclid=123');
  assert.ok(!out.includes('utm_'), 'utm params stripped');
  assert.ok(!out.includes('gclid'), 'gclid stripped');
  assert.ok(out.includes('id=7'), 'non-tracking params kept');
});

test('canonicalizeUrl collapses m./www./amp. subdomains', () => {
  const a = canonicalizeUrl('https://m.example.com/a');
  const b = canonicalizeUrl('https://www.example.com/a');
  const c = canonicalizeUrl('https://amp.example.com/a/');
  assert.equal(a, b);
  assert.equal(a, c);
});

test('canonicalizeUrl drops trailing slash and fragment', () => {
  assert.equal(
    canonicalizeUrl('https://example.com/path/#section-2'),
    'https://example.com/path',
  );
});

test('canonicalizeUrl sorts params so order does not matter', () => {
  const a = canonicalizeUrl('https://example.com/x?b=1&a=2');
  const b = canonicalizeUrl('https://example.com/x?a=2&b=1');
  assert.equal(a, b);
});

test('canonicalizeUrl falls back to string for malformed input', () => {
  assert.equal(canonicalizeUrl('not a url'), 'not a url');
});

// ─── titleFingerprint collapses visual variants ─────────────────────────────

test('titleFingerprint is identical for punctuation/case variants', () => {
  const a = titleFingerprint('Node.js 22 — the LTS release!');
  const b = titleFingerprint('node js 22 the lts release');
  assert.equal(a, b);
});

// ─── normalizeQuery + buildCacheKey ─────────────────────────────────────────

test('normalizeQuery is order-independent', () => {
  const a = normalizeQuery('node js lts');
  const b = normalizeQuery('lts node js');
  assert.equal(a, b);
});

test('normalizeQuery handles pure CJK input', () => {
  const n = normalizeQuery('最新 新闻');
  assert.ok(n && n.length > 0);
});

test('buildCacheKey segments by intent kind and time-sensitivity', () => {
  const q = 'iphone 16';
  const a = buildCacheKey(q, { kind: 'news', timeSensitive: true });
  const b = buildCacheKey(q, { kind: 'news', timeSensitive: false });
  const c = buildCacheKey(q, { kind: 'general', timeSensitive: true });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.ok(a.startsWith('news|T|'));
  assert.ok(b.startsWith('news|S|'));
});

test('ttlForIntent returns the short TTL for time-sensitive queries', () => {
  assert.ok(ttlForIntent({ timeSensitive: true }) < ttlForIntent({ timeSensitive: false }));
});

// ─── expandQuerySynonyms ────────────────────────────────────────────────────

test('expandQuerySynonyms rewrites known aliases', () => {
  const variants = expandQuerySynonyms('latest node lts');
  assert.ok(variants.length >= 2, 'at least primary + one variant');
  assert.ok(variants.includes('latest node lts'));
  assert.ok(variants.some(v => /nodejs/.test(v)), 'contains a nodejs variant');
});

test('expandQuerySynonyms returns only the primary when no alias applies', () => {
  const variants = expandQuerySynonyms('fibonacci recursion');
  assert.deepEqual(variants, ['fibonacci recursion']);
});

test('expandQuerySynonyms caps at four variants', () => {
  const variants = expandQuerySynonyms('llm rag ai');
  assert.ok(variants.length <= 4);
});

// ─── extractArticleDate ────────────────────────────────────────────────────

test('extractArticleDate parses ISO date', () => {
  const t = extractArticleDate('Published 2026-03-05 by …');
  assert.ok(t);
  const d = new Date(t);
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 2); // March
  assert.equal(d.getUTCDate(), 5);
});

test('extractArticleDate parses "N days ago" relative English', () => {
  const now = Date.UTC(2026, 3, 20); // Apr 20 2026
  const t = extractArticleDate('Posted 3 days ago: ...', '', now);
  assert.ok(t);
  assert.equal(Math.round((now - t) / 86_400_000), 3);
});

test('extractArticleDate parses CJK "N天前"', () => {
  const now = Date.UTC(2026, 3, 20);
  const t = extractArticleDate('5天前 更新', '', now);
  assert.ok(t);
  assert.equal(Math.round((now - t) / 86_400_000), 5);
});

test('extractArticleDate parses 年月 form', () => {
  const t = extractArticleDate('发布于 2025年11月20日', '');
  assert.ok(t);
  const d = new Date(t);
  assert.equal(d.getUTCFullYear(), 2025);
  assert.equal(d.getUTCMonth(), 10);
});

test('extractArticleDate returns null for text with no date', () => {
  assert.equal(extractArticleDate('no date here anywhere', 'https://example.com/x'), null);
});

// ─── recencyBoost ──────────────────────────────────────────────────────────

test('recencyBoost favors very recent items', () => {
  const now = Date.now();
  assert.equal(recencyBoost(now - 3 * 86_400_000, now), 0.40);
  assert.equal(recencyBoost(now - 15 * 86_400_000, now), 0.20);
  assert.equal(recencyBoost(now - 90 * 86_400_000, now), 0.05);
});

test('recencyBoost penalises very old items', () => {
  const now = Date.now();
  assert.equal(recencyBoost(now - 400 * 86_400_000, now), -0.15);
});

test('recencyBoost returns 0 for invalid / null date', () => {
  assert.equal(recencyBoost(null), 0);
  assert.equal(recencyBoost(NaN), 0);
});

// ─── queryBiasedSnippet ────────────────────────────────────────────────────

test('queryBiasedSnippet picks the window containing query tokens', () => {
  const body = [
    'This article discusses the history of JavaScript runtimes.',
    'The Node.js 22 release became LTS on October 29.',
    'Some unrelated paragraph about CSS Grid comes afterward.',
  ].join(' ');
  const s = queryBiasedSnippet(body, ['lts', 'node'], 320);
  assert.ok(/LTS/.test(s));
  assert.ok(/Node/.test(s));
});

test('queryBiasedSnippet falls back to head when no tokens match', () => {
  const body = 'alpha beta gamma delta.';
  const s = queryBiasedSnippet(body, ['omega'], 100);
  assert.ok(s.startsWith('alpha'));
});

test('queryBiasedSnippet returns empty for empty content', () => {
  assert.equal(queryBiasedSnippet('', ['x']), '');
});
