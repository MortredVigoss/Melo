/**
 * Phase G-2b adapter regression coverage.
 *
 * normalizeToSearchTaskResult is a pure function — testable with input/output
 * only, no test seams needed (no production caller migrated yet, so the
 * tests describe the contract that callers WILL consume).
 *
 * Coverage matrix (4 RFC checkpoints):
 *   ① output channel: legacy `output` preserved + `evidence[]` populated
 *   ② error taxonomy: 8 unified codes mapped from per-tool legacy codes
 *   ③ partial-result granularity: per-item isPartial, task status derived
 *   ④ scope: 3 production tools (fetchUrlTool / socialLinkTool / webSearchTool)
 *
 * No ~/.melo write paths exercised — pure-function tests.  No isolation
 * needed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeToSearchTaskResult,
  normalizeFetchUrlResult,
  normalizeSocialLinkResult,
  normalizeWebSearchResult,
  mapErrorCode,
  deriveConfidence,
  deriveErrorFromTrail,
  ERROR_CODES,
} from './searchTask.js';

// ─── Error taxonomy mapping (checkpoint ②) ─────────────────────────────────

test('mapErrorCode: fetchUrlTool INVALID_URL → INVALID_INPUT', () => {
  assert.equal(mapErrorCode('INVALID_URL'), ERROR_CODES.INVALID_INPUT);
});

test('mapErrorCode: fetchUrlTool NO_CONTENT → EXTRACTION_FAILED', () => {
  assert.equal(mapErrorCode('NO_CONTENT'), ERROR_CODES.EXTRACTION_FAILED);
});

test('mapErrorCode: fetchUrlTool SOCIAL_LINK_BLOCKED → LOGIN_REQUIRED', () => {
  assert.equal(mapErrorCode('SOCIAL_LINK_BLOCKED'), ERROR_CODES.LOGIN_REQUIRED);
});

test('mapErrorCode: fetchUrlTool SOCIAL_LINK_FAILED → EXTRACTION_FAILED', () => {
  assert.equal(mapErrorCode('SOCIAL_LINK_FAILED'), ERROR_CODES.EXTRACTION_FAILED);
});

test('mapErrorCode: webSearchTool INVALID_QUERY → INVALID_INPUT', () => {
  assert.equal(mapErrorCode('INVALID_QUERY'), ERROR_CODES.INVALID_INPUT);
});

test('mapErrorCode: webSearchTool SEARCH_FAILED → PROVIDER_DOWN (generic)', () => {
  assert.equal(mapErrorCode('SEARCH_FAILED'), ERROR_CODES.PROVIDER_DOWN);
});

test('mapErrorCode: any code with aborted=true → ABORTED (overrides)', () => {
  assert.equal(mapErrorCode('SEARCH_FAILED', { aborted: true }), ERROR_CODES.ABORTED);
  assert.equal(mapErrorCode('NO_CONTENT', { aborted: true }), ERROR_CODES.ABORTED);
});

test('mapErrorCode: unknown code → PROVIDER_DOWN fallback', () => {
  assert.equal(mapErrorCode('TOTALLY_NEW_CODE'), ERROR_CODES.PROVIDER_DOWN);
  assert.equal(mapErrorCode(''), ERROR_CODES.PROVIDER_DOWN);
  assert.equal(mapErrorCode(null), ERROR_CODES.PROVIDER_DOWN);
});

// ─── Confidence derivation (RFC §4 Q2 — guess to refine with real data) ────

test('deriveConfidence: yt-dlp / jina / direct → high', () => {
  assert.equal(deriveConfidence('yt-dlp'), 'high');
  assert.equal(deriveConfidence('jina'), 'high');
  assert.equal(deriveConfidence('direct'), 'high');
  assert.equal(deriveConfidence('direct+cookie'), 'high');
  assert.equal(deriveConfidence('crawl4ai'), 'high');
});

test('deriveConfidence: share-preview / browser → medium', () => {
  assert.equal(deriveConfidence('share-preview:wechat'), 'medium');
  assert.equal(deriveConfidence('browser:douyin'), 'medium');
  assert.equal(deriveConfidence('playwright'), 'medium');
});

test('deriveConfidence: cache hits / SERP-only → low', () => {
  assert.equal(deriveConfidence('cache-fresh'), 'low');
  assert.equal(deriveConfidence('cache-stale-swr'), 'low');
  assert.equal(deriveConfidence('duckduckgo'), 'low');
});

test('deriveConfidence: prefix fallback for new share-preview/browser/external profiles', () => {
  assert.equal(deriveConfidence('share-preview:NEW_PROFILE'), 'medium');
  assert.equal(deriveConfidence('browser:NEW_HOST'), 'medium');
  assert.equal(deriveConfidence('external:NEW_TOOL'), 'high');
});

test('deriveConfidence: unknown method → unknown', () => {
  assert.equal(deriveConfidence(''), 'unknown');
  assert.equal(deriveConfidence(null), 'unknown');
  assert.equal(deriveConfidence('totally-new-tier'), 'unknown');
});

// ─── normalizeFetchUrlResult: success path ─────────────────────────────────

test('normalizeFetchUrlResult: fetchUrl social-link via=yt-dlp surfaces sub-tier (G-2b round-1 P1 闭环)', () => {
  // Pre-fix: adapter used meta.method='social-link' as extractionMethod,
  // losing the real sub-tier (yt-dlp).  Now meta.via takes priority for
  // social-link routed results so confidence + isPartial reflect the
  // actual extractor, matching normalizeSocialLinkResult's semantics.
  const legacy = {
    ok: true,
    output: '# Title\n\nFull article body with subtitles...',
    meta: {
      url: 'https://www.xiaohongshu.com/explore/abc',
      method: 'social-link',  // outer label
      length: 400,
      via: 'yt-dlp',           // real extractor
      canonicalUrl: 'https://www.xiaohongshu.com/explore/abc',
    },
    evidenceTrail: [
      { tier: 'cookie-resolve', outcome: 'skip', latencyMs: 0 },
      { tier: 'social-link', outcome: 'ok', latencyMs: 850, method: 'yt-dlp' },
    ],
  };
  const r = normalizeFetchUrlResult(legacy, { url: 'https://www.xiaohongshu.com/explore/abc' });
  assert.equal(r.status, 'ok', 'yt-dlp is deep → ok');
  assert.equal(r.evidence[0].sourceType, 'social-link');
  assert.equal(r.evidence[0].extractionMethod, 'yt-dlp',
    'extractionMethod must be the via sub-tier, not the outer social-link label');
  assert.equal(r.evidence[0].confidence, 'high',
    'yt-dlp → high confidence (vs unknown if we used method)');
  assert.equal(r.evidence[0].isPartial, false);
  assert.equal(r.meta.via, 'yt-dlp');
});

test('normalizeFetchUrlResult: fetchUrl social-link via=share-preview emits status=partial + isPartial=true (G-2b round-1 P1 闭环)', () => {
  // Shallow path: share-preview means we got OG card data, not deep body.
  // Must mirror normalizeSocialLinkResult's partial semantics.
  const legacy = {
    ok: true,
    output: 'Title + brief OG description from share preview',
    meta: {
      url: 'https://www.xiaohongshu.com/explore/abc',
      method: 'social-link',
      via: 'share-preview:wechat',
      canonicalUrl: 'https://www.xiaohongshu.com/explore/abc',
    },
    evidenceTrail: [
      { tier: 'social-link', outcome: 'ok', latencyMs: 200, method: 'share-preview:wechat' },
    ],
  };
  const r = normalizeFetchUrlResult(legacy);
  assert.equal(r.status, 'partial', 'share-preview is shallow → partial');
  assert.equal(r.evidence[0].extractionMethod, 'share-preview:wechat');
  assert.equal(r.evidence[0].confidence, 'medium');
  assert.equal(r.evidence[0].isPartial, true);
});

test('normalizeFetchUrlResult: fetchUrl non-social path still uses meta.method (back-compat)', () => {
  // Non-social-link routes (jina/direct/playwright) use meta.method as
  // the real extractor.  Make sure we didn't break that.
  const legacy = {
    ok: true,
    output: 'Page body',
    meta: { url: 'https://example.com/a', method: 'jina', length: 9 },
    evidenceTrail: [{ tier: 'jina', outcome: 'ok', latencyMs: 600 }],
  };
  const r = normalizeFetchUrlResult(legacy);
  assert.equal(r.status, 'ok');
  assert.equal(r.evidence[0].sourceType, 'web-page');
  assert.equal(r.evidence[0].extractionMethod, 'jina');
  assert.equal(r.evidence[0].confidence, 'high');
});


// ─── normalizeFetchUrlResult: fail paths (checkpoint ② taxonomy) ───────────

test('normalizeFetchUrlResult: INVALID_URL → status=fail, error=INVALID_INPUT', () => {
  const r = normalizeFetchUrlResult({
    ok: false,
    output: 'bad',
    error: 'INVALID_URL',
    evidenceTrail: [{ tier: 'validate', outcome: 'fail', latencyMs: 0, reason: 'invalid-url' }],
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.error, ERROR_CODES.INVALID_INPUT);
  assert.equal(r.evidence.length, 0);
});

test('normalizeFetchUrlResult: NO_CONTENT → EXTRACTION_FAILED', () => {
  const r = normalizeFetchUrlResult({
    ok: false,
    output: 'no body',
    error: 'NO_CONTENT',
    evidenceTrail: [],
  });
  assert.equal(r.error, ERROR_CODES.EXTRACTION_FAILED);
});

test('normalizeFetchUrlResult: SOCIAL_LINK_BLOCKED → LOGIN_REQUIRED', () => {
  const r = normalizeFetchUrlResult({
    ok: false,
    output: '...login wall...',
    error: 'SOCIAL_LINK_BLOCKED',
    evidenceTrail: [{ tier: 'social-link', outcome: 'fail', latencyMs: 1200, reason: 'login-wall' }],
  });
  assert.equal(r.error, ERROR_CODES.LOGIN_REQUIRED);
});

test('normalizeFetchUrlResult: abort inferred from trail (no explicit aborted flag in legacy)', () => {
  // fetchUrlTool currently has NO `aborted: true` flag — RFC §1 gap.
  // The adapter must infer from trail.
  const r = normalizeFetchUrlResult({
    ok: false,
    output: 'aborted',
    error: 'NO_CONTENT',
    evidenceTrail: [
      { tier: 'social-link', outcome: 'fail', latencyMs: 50, reason: 'aborted-mid-loop' },
    ],
  });
  assert.equal(r.error, ERROR_CODES.ABORTED, 'trail reason starting with aborted- must produce ABORTED');
  assert.equal(r.meta.aborted, true);
});

// ─── normalizeSocialLinkResult ─────────────────────────────────────────────

test('normalizeSocialLinkResult: yt-dlp deep success → status=ok, isPartial=false', () => {
  const r = normalizeSocialLinkResult({
    body: 'Full video description + subtitles...',
    via: 'yt-dlp',
    canonicalUrl: 'https://www.douyin.com/video/abc',
    preview: { title: 'Vid title', author: 'creator' },
    evidenceTrail: [{ tier: 'yt-dlp', outcome: 'ok', latencyMs: 1100 }],
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.evidence[0].isPartial, false);
  assert.equal(r.evidence[0].confidence, 'high');
  assert.equal(r.evidence[0].title, 'Vid title');
});

test('normalizeSocialLinkResult: share-preview shallow → status=partial, isPartial=true', () => {
  // RFC checkpoint ③: per-item isPartial granularity.  Social-link share
  // preview is the canonical "partial" case (got OG card, not deep body).
  const r = normalizeSocialLinkResult({
    body: 'Title + short description from OG card',
    via: 'share-preview:wechat',
    canonicalUrl: 'https://www.xiaohongshu.com/explore/abc',
    preview: { title: 'Post title', description: 'short' },
    evidenceTrail: [
      { tier: 'yt-dlp', outcome: 'fail', latencyMs: 800 },
      { tier: 'share-preview', outcome: 'ok', latencyMs: 200, method: 'wechat' },
    ],
  });
  assert.equal(r.status, 'partial');
  assert.equal(r.evidence[0].isPartial, true);
  assert.equal(r.evidence[0].confidence, 'medium');
});

test('normalizeSocialLinkResult: external-reader success → status=ok (deep enough)', () => {
  const r = normalizeSocialLinkResult({
    body: 'External reader extracted content...',
    via: 'external:crawl4ai',
    canonicalUrl: 'https://xhslink.com/a/abc',
    evidenceTrail: [{ tier: 'external-reader', outcome: 'ok', latencyMs: 5000 }],
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.evidence[0].isPartial, false);
  assert.equal(r.evidence[0].confidence, 'high');
});

test('normalizeSocialLinkResult: miss marker → status=fail, error=LOGIN_REQUIRED', () => {
  const r = normalizeSocialLinkResult({
    body: '',
    via: 'none',
    canonicalUrl: 'https://www.douyin.com/video/missing',
    evidenceTrail: [
      { tier: 'yt-dlp', outcome: 'fail', latencyMs: 500 },
      { tier: 'share-preview', outcome: 'fail', latencyMs: 200 },
      { tier: 'browser', outcome: 'fail', latencyMs: 6000 },
      { tier: 'external-reader', outcome: 'fail', latencyMs: 50 },
    ],
    missed: true,
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.error, ERROR_CODES.LOGIN_REQUIRED);
  assert.equal(r.evidence.length, 0);
  assert.equal(r.meta.timings.totalMs, 6750);
});

test('normalizeSocialLinkResult: aborted marker → status=fail, error=ABORTED, meta.aborted=true', () => {
  const r = normalizeSocialLinkResult({
    body: '',
    via: 'aborted',
    canonicalUrl: 'https://v.douyin.com/abc',
    evidenceTrail: [
      { tier: 'short-link-resolve', outcome: 'ok', latencyMs: 8 },
      { tier: 'yt-dlp', outcome: 'fail', latencyMs: 50, reason: 'aborted-mid-loop' },
      { tier: 'share-preview', outcome: 'skip', latencyMs: 0 },
      { tier: 'browser', outcome: 'skip', latencyMs: 0 },
      { tier: 'external-reader', outcome: 'skip', latencyMs: 0 },
    ],
    aborted: true,
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.error, ERROR_CODES.ABORTED);
  assert.equal(r.meta.aborted, true);
});

test('normalizeSocialLinkResult: null (non-social URL) → status=fail with adapter hint', () => {
  const r = normalizeSocialLinkResult(null, { url: 'https://example.com' });
  assert.equal(r.status, 'fail');
  assert.equal(r.output, '[adapter] not-a-social-url');
  assert.equal(r.evidence.length, 0);
});

// ─── normalizeWebSearchResult ──────────────────────────────────────────────

test('normalizeWebSearchResult: SERP results always partial in G-2b (G-2c will lift when contentItems[] exposed)', () => {
  // G-2b adapter limitation: webSearchTool inlines fetched bodies into
  // legacy.output string under "**Page content:**" — no per-url
  // contentMap exposed.  Adapter cannot truthfully claim isPartial=false
  // for any SERP item.  G-2c will change webSearchTool to emit
  // meta.contentItems[]; adapter then flips for fetched URLs.
  const legacy = {
    ok: true,
    output: '[rendered with inline bodies]',
    meta: {
      query: 'q',
      provider: 'google (playwright)',
      resultCount: 3,
      contentFetched: 2,
      results: [
        { title: 'a', url: 'https://a.example', snippet: 'sa' },
        { title: 'b', url: 'https://b.example', snippet: 'sb' },
        { title: 'c', url: 'https://c.example', snippet: 'sc' },
      ],
      timings: { totalMs: 3200, serpMs: 800, contentMs: 2400, cacheHit: false },
    },
    evidenceTrail: [
      { tier: 'cache', outcome: 'fail', latencyMs: 0 },
      { tier: 'serp', outcome: 'ok', latencyMs: 800, method: 'google (playwright)' },
      { tier: 'content-fetch', outcome: 'ok', latencyMs: 2400 },
    ],
  };
  const r = normalizeWebSearchResult(legacy);
  assert.equal(r.evidence.length, 3);
  for (const ev of r.evidence) {
    assert.equal(ev.sourceType, 'web-page');
    assert.equal(ev.isPartial, true,
      'G-2b adapter cannot lift isPartial without structured contentMap — see G-2c');
    assert.equal(ev.body, undefined, 'no body until G-2c');
  }
  assert.equal(r.status, 'partial');
  assert.equal(r.meta.via, 'google (playwright)');
  assert.equal(r.meta.timings.totalMs, 3200);
});

test('normalizeWebSearchResult: weather fast-path emits single ok evidence + extra.weatherFastPath (G-2b round-1 P0 闭环)', () => {
  // Pre-fix: weather returns ok:true but meta.results:[] → adapter
  // looked at length=0 → evidence=[] → status='fail'.  A successful
  // weather query was misclassified as failure.  Now detect by
  // provider='wttr.in' or timings.weatherFastPath=true and emit single
  // structured evidence carrying the rendered text body.
  const legacy = {
    ok: true,
    output: 'Weather data for: "Singapore" [via: wttr.in]\n\n**Location:** Singapore\n...',
    meta: {
      query: 'Singapore weather',
      provider: 'wttr.in',
      resultCount: 1,
      contentFetched: 1,
      results: [],  // ← empty array, the bug trigger
      timings: { totalMs: 1100, serpMs: 1100, contentMs: 0, cacheHit: false, weatherFastPath: true },
    },
    evidenceTrail: [
      { tier: 'weather-fast-path', outcome: 'ok', latencyMs: 1100, extra: { hit: true } },
    ],
  };
  const r = normalizeWebSearchResult(legacy, { query: 'Singapore weather' });
  assert.equal(r.status, 'ok',
    'weather fast-path must be ok, not fail (the round-1 P0 bug)');
  assert.equal(r.evidence.length, 1);
  const ev = r.evidence[0];
  assert.equal(ev.sourceType, 'web-page');
  assert.equal(ev.extractionMethod, 'wttr.in');
  assert.equal(ev.confidence, 'high');
  assert.equal(ev.isPartial, false, 'weather body is complete, not partial');
  assert.equal(ev.body, legacy.output, 'rendered weather text is the body');
  assert.equal(ev.extra?.weatherFastPath, true);
  assert.equal(r.meta.via, 'wttr.in');
});

test('normalizeWebSearchResult: weather fast-path detected by timings.weatherFastPath when provider missing', () => {
  // Defensive: detect via the timings flag too in case provider field
  // shape ever changes.
  const r = normalizeWebSearchResult({
    ok: true,
    output: 'weather body',
    meta: {
      query: 'q',
      provider: 'unknown',
      resultCount: 1,
      contentFetched: 1,
      results: [],
      timings: { totalMs: 800, weatherFastPath: true },
    },
    evidenceTrail: [{ tier: 'weather-fast-path', outcome: 'ok', latencyMs: 800 }],
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.evidence.length, 1);
  assert.equal(r.evidence[0].extra?.weatherFastPath, true);
});

test('normalizeWebSearchResult: cache fresh hit → evidence.confidence=low + meta.cache.hit=fresh', () => {
  const r = normalizeWebSearchResult({
    ok: true,
    output: '[cached]',
    meta: {
      query: 'q',
      provider: 'duckduckgo',
      resultCount: 2,
      contentFetched: 0,
      results: [{ title: 'x', url: 'https://x', snippet: '' }],
      timings: { totalMs: 5, serpMs: 0, contentMs: 0, cacheHit: true, weatherFastPath: false },
    },
    evidenceTrail: [{ tier: 'cache', outcome: 'ok', latencyMs: 5, method: 'fresh' }],
  });
  assert.equal(r.evidence[0].confidence, 'low');
  assert.equal(r.evidence[0].extractionMethod, 'cache-fresh');
  assert.equal(r.meta.cache?.hit, 'fresh');
});

test('normalizeWebSearchResult: cache stale SWR → cache-stale-swr method', () => {
  const r = normalizeWebSearchResult({
    ok: true,
    output: '[stale]',
    meta: {
      query: 'q',
      provider: 'duckduckgo',
      resultCount: 1,
      contentFetched: 0,
      results: [{ title: 'x', url: 'https://x', snippet: '' }],
      timings: { totalMs: 5, cacheHit: true, swr: true, weatherFastPath: false },
    },
    evidenceTrail: [{ tier: 'cache', outcome: 'ok', latencyMs: 5, method: 'stale-swr' }],
  });
  assert.equal(r.evidence[0].extractionMethod, 'cache-stale-swr');
  assert.equal(r.meta.cache.hit, 'stale');
});

test('normalizeWebSearchResult: aborted → status=fail, error=ABORTED, meta.aborted=true', () => {
  const r = normalizeWebSearchResult({
    ok: false,
    output: '...',
    error: 'SEARCH_FAILED',
    aborted: true,
    meta: { query: 'q', timings: { totalMs: 50, cacheHit: false } },
    evidenceTrail: [
      { tier: 'cache', outcome: 'fail', latencyMs: 0 },
      { tier: 'serp', outcome: 'fail', latencyMs: 50, reason: 'aborted-mid-loop' },
    ],
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.error, ERROR_CODES.ABORTED);
  assert.equal(r.meta.aborted, true);
});

test('normalizeWebSearchResult: legacy "SEARCH_FAILED" + trail reason=no-results → NO_RESULTS (G-2b round-2 refinement; was PROVIDER_DOWN pre-round-2)', () => {
  // Updated post round-2: see deriveErrorFromTrail above.  The trail
  // reason takes priority over the generic legacy code mapping.
  const r = normalizeWebSearchResult({
    ok: false,
    output: 'no results',
    error: 'SEARCH_FAILED',
    meta: { query: 'q', timings: { totalMs: 8000, cacheHit: false } },
    evidenceTrail: [
      { tier: 'serp', outcome: 'fail', latencyMs: 8000, reason: 'no-results' },
    ],
  });
  assert.equal(r.error, ERROR_CODES.NO_RESULTS,
    'reason=no-results refines SEARCH_FAILED → NO_RESULTS');
});

// ─── G-2b round-2: trail-reason-aware error refinement (systematic 3-tool) ─

test('deriveErrorFromTrail: webSearch serp.fail reason=no-results → NO_RESULTS (not PROVIDER_DOWN)', () => {
  // The exact bug Codex round-2 caught: 'SEARCH_FAILED' generic legacy
  // code → previously mapped to PROVIDER_DOWN, hiding the truth that
  // SERP ran successfully but found nothing.
  const r = normalizeWebSearchResult({
    ok: false,
    output: 'no results',
    error: 'SEARCH_FAILED',
    meta: { query: 'q', timings: { totalMs: 800, cacheHit: false } },
    evidenceTrail: [
      { tier: 'cache', outcome: 'fail', latencyMs: 0 },
      { tier: 'serp', outcome: 'fail', latencyMs: 800, reason: 'no-results' },
    ],
  });
  assert.equal(r.error, ERROR_CODES.NO_RESULTS,
    'serp.fail reason=no-results must map to NO_RESULTS, not generic PROVIDER_DOWN');
});

test('deriveErrorFromTrail: webSearch serp.fail reason=timeout → TIMEOUT', () => {
  const r = normalizeWebSearchResult({
    ok: false,
    output: 'timed out',
    error: 'SEARCH_FAILED',
    meta: { query: 'q', timings: { totalMs: 15000, cacheHit: false } },
    evidenceTrail: [
      { tier: 'serp', outcome: 'fail', latencyMs: 15000, reason: 'timeout' },
    ],
  });
  assert.equal(r.error, ERROR_CODES.TIMEOUT);
});

test('deriveErrorFromTrail: webSearch serp.fail reason=5xx/4xx/network → NETWORK', () => {
  for (const reason of ['5xx', '4xx', 'network']) {
    const r = normalizeWebSearchResult({
      ok: false,
      output: 'net',
      error: 'SEARCH_FAILED',
      meta: { query: 'q', timings: { totalMs: 200, cacheHit: false } },
      evidenceTrail: [
        { tier: 'serp', outcome: 'fail', latencyMs: 200, reason },
      ],
    });
    assert.equal(r.error, ERROR_CODES.NETWORK, `reason=${reason} must map to NETWORK`);
  }
});

test('deriveErrorFromTrail: webSearch with no trail-reason falls back to legacy code mapping (PROVIDER_DOWN)', () => {
  const r = normalizeWebSearchResult({
    ok: false,
    output: 'all down',
    error: 'SEARCH_FAILED',
    meta: { query: 'q', timings: { totalMs: 8000, cacheHit: false } },
    evidenceTrail: [
      { tier: 'serp', outcome: 'fail', latencyMs: 8000 }, // no reason
    ],
  });
  assert.equal(r.error, ERROR_CODES.PROVIDER_DOWN,
    'unrecognized trail-reason falls back to legacy SEARCH_FAILED → PROVIDER_DOWN');
});

test('deriveErrorFromTrail: fetchUrl outer catch dynamic err.message refined by trail (NETWORK from 5xx reason)', () => {
  // fetchUrlTool outer-catch returns `error: err.message` which is a
  // free-form string our LEGACY_CODE_MAP can't match.  Pre-round-2 we
  // would have fallen to PROVIDER_DOWN; round-2 we read the trail
  // reason (classifyFetchError wrote it) for the precise code.
  const r = normalizeFetchUrlResult({
    ok: false,
    output: 'Failed to fetch ...: 502 Bad Gateway',
    error: 'fetch failed: HTTP 502', // free-form dynamic message
    evidenceTrail: [
      { tier: 'cookie-resolve', outcome: 'skip', latencyMs: 0 },
      { tier: 'direct', outcome: 'fail', latencyMs: 1200, reason: '5xx' },
    ],
  });
  assert.equal(r.error, ERROR_CODES.NETWORK,
    'trail reason=5xx beats free-form err.message in legacy.error');
});

test('deriveErrorFromTrail: socialLink miss with multi-stage fails → causal yt-dlp wins (G-2b round-3 PHASE_PRIORITY)', () => {
  // Round-2: this test expected PROVIDER_DOWN via "last fail" algorithm
  // (external-reader.fail with reason=no-reader-fn).
  // Round-3: PHASE_PRIORITY['social-link'] = ['yt-dlp', ...] puts yt-dlp
  // first.  yt-dlp.fail(unsupported-or-no-meta) → EXTRACTION_FAILED.
  // This reflects the actual causal failure: platform doesn't support
  // yt-dlp extraction, and all subsequent fallbacks (share-preview /
  // browser / external) were just cascade failures from that root cause.
  const r = normalizeSocialLinkResult({
    body: '',
    via: 'none',
    canonicalUrl: 'https://www.douyin.com/video/x',
    evidenceTrail: [
      { tier: 'short-link-resolve', outcome: 'ok', latencyMs: 8 },
      { tier: 'yt-dlp', outcome: 'fail', latencyMs: 500, reason: 'unsupported-or-no-meta' },
      { tier: 'share-preview', outcome: 'fail', latencyMs: 200, reason: 'low-score' },
      { tier: 'browser', outcome: 'fail', latencyMs: 6000, reason: 'low-score' },
      { tier: 'external-reader', outcome: 'fail', latencyMs: 50, reason: 'no-reader-fn' },
    ],
    missed: true,
  });
  assert.equal(r.error, ERROR_CODES.EXTRACTION_FAILED,
    'PHASE_PRIORITY: yt-dlp.fail(unsupported) is causal; cascade fails do not override');
});

test('deriveErrorFromTrail: socialLink miss where last fail is login-wall → LOGIN_REQUIRED (historical default preserved)', () => {
  const r = normalizeSocialLinkResult({
    body: '',
    via: 'none',
    canonicalUrl: 'https://www.xiaohongshu.com/explore/y',
    evidenceTrail: [
      { tier: 'yt-dlp', outcome: 'fail', latencyMs: 500, reason: 'login-wall' },
      { tier: 'share-preview', outcome: 'fail', latencyMs: 200, reason: 'login-wall' },
      { tier: 'browser', outcome: 'fail', latencyMs: 6000, reason: 'login-wall' },
    ],
    missed: true,
  });
  assert.equal(r.error, ERROR_CODES.LOGIN_REQUIRED);
});

test('deriveErrorFromTrail: empty trail + no legacy code → defaultCode (LOGIN_REQUIRED for socialLink, PROVIDER_DOWN otherwise)', () => {
  // socialLink miss without trail or code preserves the historical default.
  const r = normalizeSocialLinkResult({
    body: '',
    via: 'none',
    canonicalUrl: 'https://www.douyin.com/video/z',
    evidenceTrail: [],
    missed: true,
  });
  assert.equal(r.error, ERROR_CODES.LOGIN_REQUIRED);
});

// ─── G-2b round-3: real-shape fixtures + PHASE_PRIORITY causal selection ──

test('deriveErrorFromTrail: real 5-phase webSearch trail (cache→serp→synonym-retry→skip→skip) → NO_RESULTS via causal serp.fail', () => {
  // The exact production-shape trail Codex round-3 said adapter must
  // classify correctly.  Pre-round-3 "last fail" picked synonym-retry's
  // 'all-variants-thin' (not in vocab pre-round-3) → fallback PROVIDER_DOWN.
  // Round-3 PHASE_PRIORITY for web-search puts 'serp' first, so we find
  // serp.fail(no-results) and return NO_RESULTS.
  const realTrail = [
    { tier: 'weather-fast-path', outcome: 'skip', latencyMs: 0, reason: 'no-data' },
    { tier: 'cache', outcome: 'fail', latencyMs: 5, reason: 'no-hit' },
    { tier: 'serp', outcome: 'fail', latencyMs: 1200, reason: 'no-results', method: 'google (playwright)' },
    { tier: 'synonym-retry', outcome: 'fail', latencyMs: 800, reason: 'all-variants-thin' },
    { tier: 'content-fetch', outcome: 'skip', latencyMs: 0, reason: 'no-serp-results' },
    { tier: 'semantic-rerank', outcome: 'skip', latencyMs: 0, reason: 'no-serp-results' },
  ];
  const r = normalizeWebSearchResult({
    ok: false,
    output: 'no results',
    error: 'SEARCH_FAILED',
    meta: { query: 'q', timings: { totalMs: 2005, cacheHit: false } },
    evidenceTrail: realTrail,
  });
  assert.equal(r.error, ERROR_CODES.NO_RESULTS,
    'PHASE_PRIORITY puts serp first; serp.fail(no-results) is the causal classification');
});

test('webSearch success with serp.ok + content-fetch.fail(network): SUCCESS path keeps SERP evidence (isPartial=true); does NOT route through deriveErrorFromTrail', () => {
  // Codex G-2b round-4 闭环 (2026-05-21) ⚪: previous test name claimed to
  // cover "→ NETWORK" classification but the fixture is ok:true, which
  // never calls deriveErrorFromTrail.  Renamed to reflect the real
  // invariant being tested: the SUCCESS path keeps SERP evidence even
  // when content-fetch failed.  See companion test below for the actual
  // deriveErrorFromTrail(...NETWORK) coverage on an ok:false fixture.
  const r = normalizeWebSearchResult({
    ok: true,
    output: '[partial]',
    meta: {
      query: 'q',
      provider: 'duckduckgo',
      resultCount: 3,
      contentFetched: 0,
      results: [
        { title: 'a', url: 'https://a', snippet: '' },
        { title: 'b', url: 'https://b', snippet: '' },
      ],
      timings: { totalMs: 4500, serpMs: 1000, contentMs: 3500, cacheHit: false },
    },
    evidenceTrail: [
      { tier: 'cache', outcome: 'fail', latencyMs: 5, reason: 'no-hit' },
      { tier: 'serp', outcome: 'ok', latencyMs: 1000, method: 'duckduckgo' },
      { tier: 'synonym-retry', outcome: 'skip', latencyMs: 0, reason: 'serp-strong-no-retry-needed' },
      { tier: 'content-fetch', outcome: 'fail', latencyMs: 3500, reason: 'network' },
      { tier: 'semantic-rerank', outcome: 'skip', latencyMs: 0 },
    ],
  });
  assert.equal(r.status, 'partial');
  assert.equal(r.evidence.length, 2);
  // No error code on success path:
  assert.equal(r.error, undefined,
    'success path must not surface an error code even if downstream phases failed');
});

test('deriveErrorFromTrail: directly exercises NETWORK classification (Codex ⚪ 闭环: real classifier call, not fake-via-success-fixture)', () => {
  // Codex round-4 ⚪ 闭环 (2026-05-21): the previous test claimed to
  // cover "→ NETWORK" via normalizeWebSearchResult, but the fixture
  // was ok:true → success path → deriveErrorFromTrail never invoked.
  // Fix per Codex's exact recommendation: call the classifier directly.
  // This is the canonical pattern for testing pure error-classification
  // logic — exercises the actual function under test, not a proxy.

  // Causal phase: content-fetch.fail(network) — sole failing phase, so
  // PHASE_PRIORITY['web-search'] walk picks it (serp is ok, cache is
  // ok+treated as skip-equivalent for fail attribution since not present).
  const networkOnlyTrail = [
    { tier: 'serp', outcome: 'ok', latencyMs: 1000, method: 'duckduckgo' },
    { tier: 'content-fetch', outcome: 'fail', latencyMs: 3500, reason: 'network' },
    { tier: 'semantic-rerank', outcome: 'skip', latencyMs: 0 },
  ];
  assert.equal(
    deriveErrorFromTrail(networkOnlyTrail, { source: 'web-search' }),
    ERROR_CODES.NETWORK,
    'content-fetch.fail(network) is the only failing phase → NETWORK',
  );

  // Same shape with timeout reason → TIMEOUT (proves vocab lookup works).
  const timeoutTrail = [
    { tier: 'serp', outcome: 'ok', latencyMs: 1000, method: 'duckduckgo' },
    { tier: 'content-fetch', outcome: 'fail', latencyMs: 10000, reason: 'timeout' },
  ];
  assert.equal(
    deriveErrorFromTrail(timeoutTrail, { source: 'web-search' }),
    ERROR_CODES.TIMEOUT,
    'content-fetch.fail(timeout) → TIMEOUT',
  );

  // aborted=true short-circuits regardless of trail content.
  assert.equal(
    deriveErrorFromTrail(networkOnlyTrail, { source: 'web-search', aborted: true }),
    ERROR_CODES.ABORTED,
    'aborted=true takes precedence over trail-derived classification',
  );
});

// ─── Codex G-2b round-4 闭环 (2026-05-21): api-direct success branch ────────

// Round-5 闭环 (Codex C, 2026-05-21): per-provider real-shape fixtures.
// Pre-round-5 tests used "snippet-as-body" fixtures uniformly — that's
// only Wikipedia's shape.  HN/arXiv/GitHub/SO have snippet=metadata and
// body=contentMap[url].  These tests prove the adapter honors the new
// `meta.contentItems` channel for per-URL body detection.

test('normalizeWebSearchResult: Wikipedia real shape — snippet IS the body (extract), contentItems carries same content → isPartial=false, body present', () => {
  // Wikipedia's apiDirect.js path: snippet = REST API extract (the article
  // body), AND contentMap.set(url, extract) duplicates it.  Both channels
  // agree → isPartial=false.
  const url = 'https://en.wikipedia.org/wiki/GraphQL';
  const extract = 'GraphQL is a query language and runtime for APIs that lets clients request exactly the fields they need. Created by Facebook in 2012, open-sourced 2015.';
  const r = normalizeWebSearchResult({
    ok: true,
    output: `## Wikipedia: GraphQL\n\n${extract}`,
    meta: {
      query: 'graphql',
      provider: 'wikipedia',
      resultCount: 1,
      contentFetched: 1,
      results: [{ title: 'GraphQL', url, snippet: extract }],
      contentItems: [{ url, content: extract }],
      timings: { totalMs: 220 },
    },
    evidenceTrail: [
      { tier: 'cache', outcome: 'fail', latencyMs: 2, reason: 'no-hit' },
      { tier: 'api-direct', outcome: 'ok', latencyMs: 210, method: 'wikipedia', extra: { results: 1 } },
    ],
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.evidence.length, 1);
  const ev = r.evidence[0];
  assert.equal(ev.sourceType, 'api-direct');
  assert.equal(ev.confidence, 'high');
  assert.equal(ev.isPartial, false, 'contentItems has body → isPartial=false');
  assert.equal(ev.body, extract, 'body sourced from contentItems, not snippet');
  assert.equal(ev.snippet, extract);
  assert.equal(ev.extractionMethod, 'wikipedia');
});

test('normalizeWebSearchResult: HN real shape — snippet is METADATA ("{points} · {comments} · posted {date}"), body in contentItems → snippet+body both populated, isPartial=false', () => {
  // HN's apiDirect.js literally constructs:
  //   snippet = `${points} points · ${numComments} comments · posted ${date} · → ${externalUrl}`
  //   contentMap.set(itemUrl, hit.story_text)  // body only if Ask HN / text post
  // For an Ask HN story with story_text, contentItems carries the body.
  const url = 'https://news.ycombinator.com/item?id=12345';
  const realHnSnippet = '152 points · 89 comments · posted 2026-05-20';
  const askHnBody = 'I built a rust async runtime over the weekend. Here are the lessons learned: tokio vs async-std is mostly about... [long body text]';
  const r = normalizeWebSearchResult({
    ok: true,
    output: 'HN results...',
    meta: {
      query: 'ask hn rust async',
      provider: 'hacker-news',
      resultCount: 1,
      contentFetched: 1,
      results: [{ title: 'Ask HN: My rust async runtime lessons', url, snippet: realHnSnippet }],
      contentItems: [{ url, content: askHnBody }],
      timings: { totalMs: 380 },
    },
    evidenceTrail: [
      { tier: 'api-direct', outcome: 'ok', latencyMs: 360, method: 'hacker-news', extra: { results: 1 } },
    ],
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.evidence.length, 1);
  const ev = r.evidence[0];
  assert.equal(ev.isPartial, false, 'contentItems has body → isPartial=false');
  assert.equal(ev.body, askHnBody, 'body MUST come from contentItems, NOT snippet');
  assert.equal(ev.snippet, realHnSnippet,
    'snippet preserved as metadata for display alongside body — they have different semantics');
  // The critical anti-regression: snippet (metadata) MUST NOT leak into body
  assert.notEqual(ev.body, realHnSnippet,
    'body must NEVER equal the metadata snippet (pre-round-5 bug)');
});

test('normalizeWebSearchResult: HN link-only story (no story_text) → snippet=metadata, body MISSING, isPartial=true per-item', () => {
  // Most HN stories are links to external articles — no story_text →
  // contentMap is empty for that URL → contentItems doesn't include it.
  // Adapter must honestly mark isPartial=true, body absent.
  const url = 'https://news.ycombinator.com/item?id=99999';
  const r = normalizeWebSearchResult({
    ok: true,
    output: '...',
    meta: {
      query: 'show hn',
      provider: 'hacker-news',
      resultCount: 1,
      contentFetched: 0,
      results: [{ title: 'Show HN: My SaaS', url, snippet: '50 points · 12 comments · posted 2026-05-20 · → https://mysaas.com' }],
      contentItems: [],
      timings: { totalMs: 200 },
    },
    evidenceTrail: [
      { tier: 'api-direct', outcome: 'ok', latencyMs: 180, method: 'hacker-news', extra: { results: 1 } },
    ],
  });
  // status stays 'ok' (we have evidence), per-item isPartial reflects the
  // partial body availability — per RFC §4 ③ per-item granularity.
  assert.equal(r.status, 'ok', 'status remains ok even when some bodies missing — per-item isPartial');
  const ev = r.evidence[0];
  assert.equal(ev.isPartial, true, 'no body in contentItems → isPartial=true');
  assert.equal(ev.body, undefined, 'no body field at all (not empty string) when body absent');
  assert.ok(ev.snippet.includes('points'), 'snippet metadata preserved for the consumer');
  assert.equal(ev.confidence, 'high', 'confidence stays high — we know what we have, just no full body');
});

test('normalizeWebSearchResult: GitHub real shape — snippet="★ stars · lang · updated date", body in contentItems (repo description)', () => {
  // GitHub's apiDirect.js:
  //   snippet = `★ ${stars} · ${lang} · updated ${date}`
  //   contentMap.set(url, repo.description)  // only if non-empty
  const url = 'https://github.com/tokio-rs/tokio';
  const metadataSnippet = '★ 28500 · Rust · updated 2026-05-19';
  const description = 'A runtime for writing reliable asynchronous applications with Rust. Provides I/O, networking, scheduling, timers, and more.';
  const r = normalizeWebSearchResult({
    ok: true,
    output: '...',
    meta: {
      query: 'github repo rust async runtime',
      provider: 'github',
      resultCount: 1,
      contentFetched: 1,
      results: [{ title: 'tokio-rs/tokio', url, snippet: metadataSnippet }],
      contentItems: [{ url, content: description }],
      timings: { totalMs: 450 },
    },
    evidenceTrail: [
      { tier: 'api-direct', outcome: 'ok', latencyMs: 430, method: 'github', extra: { results: 1 } },
    ],
  });
  const ev = r.evidence[0];
  assert.equal(ev.body, description);
  assert.equal(ev.snippet, metadataSnippet);
  assert.equal(ev.isPartial, false);
  assert.equal(ev.extractionMethod, 'github');
});

test('normalizeWebSearchResult: arXiv real shape — snippet="(year) · authors · arXiv:id", body=abstract in contentItems', () => {
  const url = 'https://arxiv.org/abs/1706.03762';
  const metaSnippet = '(2017) · Ashish Vaswani, Noam Shazeer, Niki Parmar et al. · arXiv:1706.03762';
  const abstract = 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks... We propose a new simple network architecture, the Transformer, based solely on attention mechanisms...';
  const r = normalizeWebSearchResult({
    ok: true,
    output: '...',
    meta: {
      query: 'attention is all you need',
      provider: 'arxiv-semantic-scholar',
      resultCount: 1,
      contentFetched: 1,
      results: [{ title: 'Attention Is All You Need', url, snippet: metaSnippet }],
      contentItems: [{ url, content: abstract }],
      timings: { totalMs: 510 },
    },
    evidenceTrail: [
      { tier: 'api-direct', outcome: 'ok', latencyMs: 490, method: 'arxiv-semantic-scholar', extra: { results: 1 } },
    ],
  });
  const ev = r.evidence[0];
  assert.equal(ev.body, abstract);
  assert.equal(ev.snippet, metaSnippet);
  assert.equal(ev.isPartial, false);
  assert.notEqual(ev.body, metaSnippet, 'arXiv body must NEVER be the metadata line');
});

test('normalizeWebSearchResult: mixed contentItems (Wikipedia full + HN link-only) → per-item isPartial differs in the same result set', () => {
  // The real value of per-item isPartial — heterogeneous results from the
  // same response.  Could happen if api-direct returns multiple items
  // with partial body availability.
  const wpUrl = 'https://en.wikipedia.org/wiki/GraphQL';
  const hnUrl = 'https://news.ycombinator.com/item?id=12345';
  const r = normalizeWebSearchResult({
    ok: true,
    output: '...',
    meta: {
      query: 'graphql',
      provider: 'wikipedia',
      resultCount: 2,
      contentFetched: 1,
      results: [
        { title: 'GraphQL', url: wpUrl, snippet: 'GraphQL is a query language...' },
        { title: 'HN discussion', url: hnUrl, snippet: '152 points · 89 comments' },
      ],
      contentItems: [
        { url: wpUrl, content: 'GraphQL is a query language and runtime for APIs...' },
        // hnUrl absent — link-only HN story, no body
      ],
      timings: { totalMs: 220 },
    },
    evidenceTrail: [
      { tier: 'api-direct', outcome: 'ok', latencyMs: 210, method: 'wikipedia', extra: { results: 2 } },
    ],
  });
  assert.equal(r.evidence[0].isPartial, false, 'Wikipedia evidence: has body');
  assert.equal(r.evidence[1].isPartial, true, 'HN evidence: no body in contentItems');
  assert.ok(r.evidence[0].body, 'Wikipedia body populated');
  assert.equal(r.evidence[1].body, undefined, 'HN body absent (per RFC §4 ③ per-item granularity)');
});

test('normalizeWebSearchResult: api-direct.skip + serp.ok → fallthrough path, SERP evidence (NOT api-direct branch)', () => {
  // Verify api-direct.skip / .fail correctly fall through to the
  // existing SERP path — they should NOT accidentally trigger the new
  // api-direct success branch.
  const r = normalizeWebSearchResult({
    ok: true,
    output: 'SERP results',
    meta: {
      query: 'general query',
      provider: 'google (playwright)',
      resultCount: 3,
      contentFetched: 0,
      results: [
        { title: 'a', url: 'https://a', snippet: '' },
        { title: 'b', url: 'https://b', snippet: '' },
        { title: 'c', url: 'https://c', snippet: '' },
      ],
      timings: { totalMs: 1200, serpMs: 1000, contentMs: 200 },
    },
    evidenceTrail: [
      { tier: 'cache', outcome: 'fail', latencyMs: 2, reason: 'no-hit' },
      { tier: 'api-direct', outcome: 'skip', latencyMs: 0, reason: 'no-provider-match' },
      { tier: 'serp', outcome: 'ok', latencyMs: 1000, method: 'google (playwright)' },
    ],
  });
  // api-direct.skip → SERP path → isPartial=true / sourceType='web-page'.
  assert.equal(r.status, 'partial', 'SERP-only path is partial (no per-url body)');
  for (const ev of r.evidence) {
    assert.equal(ev.sourceType, 'web-page',
      'api-direct.skip must not flip sourceType to api-direct');
    assert.equal(ev.isPartial, true);
  }
});

test('normalizeWebSearchResult: api-direct.fail + serp.fail(no-results) → status=fail, NO_RESULTS (api-direct does NOT shadow causal SERP fail)', () => {
  // When api-direct fails and SERP also fails, the causal failure is
  // SERP.fail (api-direct was just a try-first short-circuit).  Verify
  // PHASE_PRIORITY listing api-direct LATER than serp prevents shadowing.
  const r = normalizeWebSearchResult({
    ok: false,
    output: '',
    error: 'SEARCH_FAILED',
    meta: { query: 'q', timings: { totalMs: 5000 } },
    evidenceTrail: [
      { tier: 'cache', outcome: 'fail', latencyMs: 2, reason: 'no-hit' },
      { tier: 'api-direct', outcome: 'fail', latencyMs: 800, method: 'wikipedia', reason: 'timeout' },
      { tier: 'serp', outcome: 'fail', latencyMs: 4000, method: 'google (playwright)', reason: 'no-results' },
    ],
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.error, ERROR_CODES.NO_RESULTS,
    'serp.fail(no-results) is causal; api-direct.fail is a fallback miss, not the root cause');
});

test('deriveErrorFromTrail: real fetchUrl-via-social trail (5 sub-tiers + outer wrapper) → CAUSAL inner sub-tier wins (round-3 闭环)', () => {
  // The exact production shape fetchUrlTool emits after merging the
  // sub-trail from socialLinkTool:
  //   cookie-resolve.skip
  //   social-link.short-link-resolve.ok
  //   social-link.yt-dlp.fail(unsupported-or-no-meta)  ← CAUSAL
  //   social-link.share-preview.fail(low-score)        ← cascade
  //   social-link.browser.fail(low-score)              ← cascade
  //   social-link.external-reader.fail(no-reader-fn)   ← cascade
  //   social-link.fail(login-wall)                     ← outer wrapper
  // Pre-round-3 "last fail" picked the outer wrapper → LOGIN_REQUIRED.
  // Round-3 PHASE_PRIORITY puts inner `social-link.yt-dlp` first →
  // EXTRACTION_FAILED (unsupported-or-no-meta = platform doesn't
  // have yt-dlp extractor).
  const realTrail = [
    { tier: 'cookie-resolve', outcome: 'skip', latencyMs: 0, reason: 'no-cookie' },
    { tier: 'social-link.short-link-resolve', outcome: 'ok', latencyMs: 8 },
    { tier: 'social-link.yt-dlp', outcome: 'fail', latencyMs: 1200, reason: 'unsupported-or-no-meta' },
    { tier: 'social-link.share-preview', outcome: 'fail', latencyMs: 200, reason: 'low-score' },
    { tier: 'social-link.browser', outcome: 'fail', latencyMs: 6500, reason: 'low-score' },
    { tier: 'social-link.external-reader', outcome: 'fail', latencyMs: 50, reason: 'no-reader-fn' },
    { tier: 'social-link', outcome: 'fail', latencyMs: 8000, reason: 'login-wall' }, // outer wrapper
  ];
  const r = normalizeFetchUrlResult({
    ok: false,
    output: '...',
    error: 'SOCIAL_LINK_BLOCKED',
    evidenceTrail: realTrail,
  });
  assert.equal(r.error, ERROR_CODES.EXTRACTION_FAILED,
    'inner social-link.yt-dlp.fail wins over outer social-link.fail wrapper');
});

test('deriveErrorFromTrail: socialLink direct call (no fetchUrl wrapping) full 5-phase miss → causal inner phase wins', () => {
  // Direct readSocialLink path (no `social-link.` prefix, plain tier names).
  // PHASE_PRIORITY['social-link'] puts 'yt-dlp' first.
  const r = normalizeSocialLinkResult({
    body: '',
    via: 'none',
    canonicalUrl: 'https://www.douyin.com/video/abc',
    evidenceTrail: [
      { tier: 'short-link-resolve', outcome: 'ok', latencyMs: 8 },
      { tier: 'yt-dlp', outcome: 'fail', latencyMs: 1200, reason: 'unsupported-or-no-meta' },
      { tier: 'share-preview', outcome: 'fail', latencyMs: 200, reason: 'low-score' },
      { tier: 'browser', outcome: 'fail', latencyMs: 6500, reason: 'low-score' },
      { tier: 'external-reader', outcome: 'fail', latencyMs: 50, reason: 'no-reader-fn' },
    ],
    missed: true,
  });
  assert.equal(r.error, ERROR_CODES.EXTRACTION_FAILED,
    'yt-dlp is the depth-first causal phase for social-link');
});

test('deriveErrorFromTrail: real webSearch all-variants-thin (synonym-retry only, no serp.fail) → NO_RESULTS via new vocab', () => {
  // Edge case: serp succeeded (returned thin results), synonym-retry was
  // attempted and exhausted.  PHASE_PRIORITY['serp'] not failed →
  // moves to 'cache' (also not failed) → 'synonym-retry'.fail(all-variants-thin)
  // → NO_RESULTS via REASON_VOCABULARY (new vocab in round-3).
  const r = normalizeWebSearchResult({
    ok: false,
    output: 'thin',
    error: 'SEARCH_FAILED',
    meta: { query: 'q', timings: { totalMs: 3000, cacheHit: false } },
    evidenceTrail: [
      { tier: 'cache', outcome: 'fail', latencyMs: 5, reason: 'no-hit' },
      { tier: 'serp', outcome: 'ok', latencyMs: 1200 },
      { tier: 'synonym-retry', outcome: 'fail', latencyMs: 800, reason: 'all-variants-thin' },
      { tier: 'content-fetch', outcome: 'fail', latencyMs: 1000, reason: 'no-serp-results' },
      { tier: 'semantic-rerank', outcome: 'skip', latencyMs: 0 },
    ],
  });
  assert.equal(r.error, ERROR_CODES.NO_RESULTS,
    'all-variants-thin reason in vocab → NO_RESULTS');
});

test('deriveErrorFromTrail: socialLink no-content-or-too-short reason → EXTRACTION_FAILED (new vocab in round-3)', () => {
  const r = normalizeSocialLinkResult({
    body: '',
    via: 'none',
    canonicalUrl: 'https://www.xiaohongshu.com/explore/y',
    evidenceTrail: [
      { tier: 'yt-dlp', outcome: 'fail', latencyMs: 500, reason: 'unsupported-or-no-meta' },
      { tier: 'share-preview', outcome: 'fail', latencyMs: 200, reason: 'low-score' },
      { tier: 'browser', outcome: 'fail', latencyMs: 6000, reason: 'low-score' },
      { tier: 'external-reader', outcome: 'fail', latencyMs: 100, reason: 'no-content-or-too-short' },
    ],
    missed: true,
  });
  // PHASE_PRIORITY['social-link'] → yt-dlp first (unsupported-or-no-meta
  // = EXTRACTION_FAILED, matches the new round-3 vocab entry).
  assert.equal(r.error, ERROR_CODES.EXTRACTION_FAILED);
});

// ─── normalizeToSearchTaskResult dispatch ──────────────────────────────────

test('normalizeToSearchTaskResult: routes by source string', () => {
  // Just verify the dispatcher hits each per-source normalizer.
  const fetchResult = normalizeToSearchTaskResult(
    { ok: false, error: 'INVALID_URL', evidenceTrail: [] },
    'url-fetch',
    { url: '' },
  );
  assert.equal(fetchResult.meta.source, 'url-fetch');
  assert.equal(fetchResult.error, ERROR_CODES.INVALID_INPUT);

  const socialResult = normalizeToSearchTaskResult(null, 'social-link', { url: 'https://example.com' });
  assert.equal(socialResult.meta.source, 'social-link');

  const webResult = normalizeToSearchTaskResult(
    { ok: false, error: 'SEARCH_FAILED', meta: {}, evidenceTrail: [] },
    'web-search',
  );
  assert.equal(webResult.meta.source, 'web-search');
});

test('normalizeToSearchTaskResult: unknown source → throws', () => {
  assert.throws(
    () => normalizeToSearchTaskResult({}, 'memory-recall', {}),
    /unknown source/,
  );
});

// ─── Idempotency (G-2 RFC §3 Phase G-2a requirement) ───────────────────────

test('adapter is deterministic on identical input (no Math.random / Date.now in output that breaks idempotency for the same input)', () => {
  const legacy = {
    ok: true,
    output: 'body',
    meta: { url: 'https://x', method: 'jina' },
    evidenceTrail: [{ tier: 'jina', outcome: 'ok', latencyMs: 100 }],
  };
  const r1 = normalizeFetchUrlResult(legacy);
  const r2 = normalizeFetchUrlResult(legacy);
  // Body / structure must match; only fetchedAt may differ (which is fine
  // because callers don't rely on idempotency of fetchedAt timestamps).
  assert.equal(r1.status, r2.status);
  assert.equal(r1.evidence[0].body, r2.evidence[0].body);
  assert.equal(r1.evidence[0].extractionMethod, r2.evidence[0].extractionMethod);
  assert.equal(r1.evidence[0].confidence, r2.evidence[0].confidence);
  assert.equal(r1.output, r2.output);
});
