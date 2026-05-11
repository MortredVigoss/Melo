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

test('normalizeWebSearchResult: SEARCH_FAILED without abort → PROVIDER_DOWN', () => {
  const r = normalizeWebSearchResult({
    ok: false,
    output: 'all providers failed',
    error: 'SEARCH_FAILED',
    meta: { query: 'q', timings: { totalMs: 8000, cacheHit: false } },
    evidenceTrail: [
      { tier: 'serp', outcome: 'fail', latencyMs: 8000, reason: 'no-results' },
    ],
  });
  assert.equal(r.error, ERROR_CODES.PROVIDER_DOWN);
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
