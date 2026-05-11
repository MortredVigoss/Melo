// SearchTask contract — Phase G-2 implementation.
//
// See docs/search-task-rfc.md for the design rationale and the 4 RFC
// checkpoints the project owner signed off on 2026-05-11:
//   ① output channel: keep legacy `output` + add structured `evidence[]`
//   ② error taxonomy: 8 codes (see ERROR_CODES below)
//   ③ partial-result granularity: per-item `isPartial`
//   ④ migration scope: 3 production tools (fetchUrlTool / socialLinkTool /
//      webSearchTool), memory-recall / file-grep deferred
//
// This module is the **G-2b adapter layer**: pure functions that take the
// legacy return shape from any of the 3 tools and emit a uniform
// `SearchTaskResult`.  No production caller is forced to migrate yet —
// chatExecutionRunner + agentMemoryContext can opt into this normalization
// at their own pace (G-2c).
//
// Design constraints (lessons-learned from G-1c 6-commit chain):
//   • Pure functions, no side effects → testable with input/output only,
//     no test seams needed.
//   • Cover all 3 tools' known shapes in one commit (systematic, not
//     "add tool when caller migrates").
//   • Error code mapping is documented + tested per shape.

// ─── Error code taxonomy ─────────────────────────────────────────────────────
//
// Maps legacy per-tool error codes into a shared 8-code vocabulary.
// `mapErrorCode(legacyCode, source)` is the single chokepoint —
// callers don't need to know which tool produced which legacy code.

export const ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',       // query empty, URL malformed
  TIMEOUT: 'TIMEOUT',                   // overall budget exceeded
  ABORTED: 'ABORTED',                   // caller signal aborted
  NO_RESULTS: 'NO_RESULTS',             // search ran, found nothing
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',     // needs cookies/login (formerly SOCIAL_LINK_BLOCKED)
  EXTRACTION_FAILED: 'EXTRACTION_FAILED', // reachable but parser failed (formerly NO_CONTENT)
  NETWORK: 'NETWORK',                   // DNS/connect/5xx
  PROVIDER_DOWN: 'PROVIDER_DOWN',       // all providers exhausted
});

const LEGACY_CODE_MAP = Object.freeze({
  // fetchUrlTool
  INVALID_URL: ERROR_CODES.INVALID_INPUT,
  NO_CONTENT: ERROR_CODES.EXTRACTION_FAILED,
  SOCIAL_LINK_BLOCKED: ERROR_CODES.LOGIN_REQUIRED,
  SOCIAL_LINK_FAILED: ERROR_CODES.EXTRACTION_FAILED,
  // webSearchTool
  INVALID_QUERY: ERROR_CODES.INVALID_INPUT,
  SEARCH_FAILED: ERROR_CODES.PROVIDER_DOWN, // generic catch-all; refined by abort flag below
  // socialLinkTool (no string error codes — uses missed/aborted flags)
});

/**
 * @param {string} legacyCode
 * @param {{aborted?: boolean, source?: string}} [ctx]
 * @returns {string} one of ERROR_CODES
 */
export function mapErrorCode(legacyCode, ctx = {}) {
  if (ctx.aborted) return ERROR_CODES.ABORTED;
  if (!legacyCode) return ERROR_CODES.PROVIDER_DOWN;
  return LEGACY_CODE_MAP[legacyCode] || ERROR_CODES.PROVIDER_DOWN;
}

// ─── Confidence derivation (from EvidenceTrail extractionMethod) ────────────
//
// Heuristic: which tier produced the result?  RFC §4 Q2 flagged this is a
// guess — to be refined when Phase 2 real-trail data tells us whether the
// resulting confidence label predicts agent "retry vs accept" behavior.

const HIGH_CONFIDENCE_METHODS = new Set([
  'yt-dlp',              // socialLink — deep video metadata + subtitles
  'jina',                // fetchUrl — Jina reader full body
  'direct',              // fetchUrl — direct HTML + Readability extracted
  'direct+cookie',       // fetchUrl — same with auth
  'crawl4ai',            // external reader full body
  'scrapling',
  'camoufox',
]);

const MEDIUM_CONFIDENCE_METHODS = new Set([
  'playwright',          // rendered browser body — anti-bot-resolved but lower-trust
  'browser:rendered',
  'browser:douyin',
  'browser:xhs',
  'share-preview:generic',
  'share-preview:wechat',
  'share-preview:wechat+douyin-ssr',
  'share-preview:xhs',
]);

const LOW_CONFIDENCE_METHODS = new Set([
  'cache-fresh',         // possibly stale by now
  'cache-stale-swr',     // explicitly stale at read time
  'duckduckgo',          // SERP only, no fetched body
  'google (playwright)', // same
]);

/**
 * @param {string} extractionMethod
 * @returns {'high'|'medium'|'low'|'unknown'}
 */
export function deriveConfidence(extractionMethod) {
  if (!extractionMethod) return 'unknown';
  // Match prefix variations (e.g. 'browser:douyin' → medium even if not exact)
  if (HIGH_CONFIDENCE_METHODS.has(extractionMethod)) return 'high';
  if (MEDIUM_CONFIDENCE_METHODS.has(extractionMethod)) return 'medium';
  if (LOW_CONFIDENCE_METHODS.has(extractionMethod)) return 'low';
  // Prefix fallback for via tags like 'share-preview:newprofile'
  if (extractionMethod.startsWith('share-preview:')) return 'medium';
  if (extractionMethod.startsWith('browser:')) return 'medium';
  if (extractionMethod.startsWith('external:')) return 'high';
  return 'unknown';
}

// ─── Normalizers (one per source tool) ───────────────────────────────────────

/**
 * Adapt fetchUrlTool legacy result → SearchTaskResult.
 *
 * Legacy shape:
 *   success: {ok:true, output, meta:{url,method,length,via,canonicalUrl}, evidenceTrail}
 *   fail:    {ok:false, output, error:'INVALID_URL'|'NO_CONTENT'|..., evidenceTrail}
 */
export function normalizeFetchUrlResult(legacy, input = {}) {
  if (!legacy || typeof legacy !== 'object') {
    return _failResult('url-fetch', input, 'invalid-legacy-shape', []);
  }
  const trail = Array.isArray(legacy.evidenceTrail) ? legacy.evidenceTrail : [];
  // Detect abort: fetchUrlTool currently has no `aborted` flag (RFC §1 gap)
  // — infer from trail.  Any tier with reason starting 'aborted-' means abort.
  const aborted = trail.some(e => typeof e.reason === 'string' && e.reason.startsWith('aborted'));
  if (!legacy.ok) {
    return {
      status: 'fail',
      query: input.query || legacy.meta?.url || '',
      evidenceTrail: trail,
      evidence: [],
      meta: {
        source: 'url-fetch',
        via: legacy.meta?.method,
        timings: { totalMs: _sumLatency(trail) },
        ...(aborted ? { aborted: true } : {}),
      },
      error: mapErrorCode(legacy.error, { aborted }),
      output: legacy.output,
    };
  }
  // Success path: 1 evidence item carrying the fetched body.
  //
  // G-2b round-1 follow-up (Codex 2026-05-11 P1): when fetchUrlTool routed
  // through the social-link path, `meta.method='social-link'` is the *outer*
  // label and `meta.via='yt-dlp' | 'share-preview:wechat' | 'browser:douyin' |
  // 'external:crawl4ai'` is the *real* extractor.  Pre-fix we used method,
  // losing the sub-tier and forcing confidence='unknown' / isPartial=false
  // even for shallow share-preview hits.  Now use via as extractionMethod
  // for social-link and mirror normalizeSocialLinkResult's isDeep semantics.
  const method = legacy.meta?.method;
  const via = legacy.meta?.via;
  const isSocialLink = method === 'social-link';
  const realMethod = isSocialLink ? (via || method) : (method || via);
  const isDeep = !isSocialLink
    || realMethod === 'yt-dlp'
    || (typeof realMethod === 'string' && realMethod.startsWith('external:'));
  const evidence = [{
    sourceType: isSocialLink ? 'social-link' : 'web-page',
    title: '', // fetchUrlTool doesn't extract title separately; body carries it
    url: legacy.meta?.canonicalUrl || legacy.meta?.url || input.url || '',
    body: legacy.output,
    confidence: deriveConfidence(realMethod),
    extractionMethod: realMethod || 'unknown',
    isPartial: !isDeep,
    fetchedAt: new Date().toISOString(),
  }];
  return {
    status: isDeep ? 'ok' : 'partial',
    query: input.query || legacy.meta?.url || '',
    evidenceTrail: trail,
    evidence,
    meta: {
      source: 'url-fetch',
      via: realMethod,
      timings: { totalMs: _sumLatency(trail) },
    },
    output: legacy.output,
  };
}

/**
 * Adapt socialLinkTool.readSocialLink legacy result → SearchTaskResult.
 *
 * Legacy shape:
 *   success: {body, via, canonicalUrl, evidenceTrail, preview?, meta?, originalUrl?}
 *   miss:    {body:'', via:'none', evidenceTrail, missed:true}
 *   abort:   {body:'', via:'aborted', evidenceTrail, aborted:true}
 *   non-social URL: null (early bail, no trail)
 */
export function normalizeSocialLinkResult(legacy, input = {}) {
  if (legacy === null || legacy === undefined) {
    // Non-social URL early bail — distinct from "miss" by tools' design.
    return _failResult('social-link', input, 'not-a-social-url', []);
  }
  if (!legacy || typeof legacy !== 'object') {
    return _failResult('social-link', input, 'invalid-legacy-shape', []);
  }
  const trail = Array.isArray(legacy.evidenceTrail) ? legacy.evidenceTrail : [];
  if (legacy.aborted) {
    return {
      status: 'fail',
      query: input.query || input.url || legacy.canonicalUrl || '',
      evidenceTrail: trail,
      evidence: [],
      meta: { source: 'social-link', via: 'aborted', timings: { totalMs: _sumLatency(trail) }, aborted: true },
      error: ERROR_CODES.ABORTED,
      output: '',
    };
  }
  if (legacy.missed || !legacy.body) {
    return {
      status: 'fail',
      query: input.query || input.url || legacy.canonicalUrl || '',
      evidenceTrail: trail,
      evidence: [],
      meta: { source: 'social-link', via: legacy.via || 'none', timings: { totalMs: _sumLatency(trail) } },
      error: ERROR_CODES.LOGIN_REQUIRED, // socialLinkTool miss is almost always login wall
      output: '',
    };
  }
  // Success — could be deep yt-dlp, share-preview, browser, or external.
  // Partial = anything that's not yt-dlp deep (RFC §4 Q3 per-item granularity).
  const via = legacy.via || 'unknown';
  const isDeep = via === 'yt-dlp' || via.startsWith('external:');
  const evidence = [{
    sourceType: 'social-link',
    title: legacy.preview?.title || '',
    url: legacy.canonicalUrl || legacy.originalUrl || input.url || '',
    body: legacy.body,
    snippet: legacy.preview?.description || '',
    confidence: deriveConfidence(via),
    extractionMethod: via,
    isPartial: !isDeep,
    fetchedAt: new Date().toISOString(),
  }];
  return {
    status: isDeep ? 'ok' : 'partial',
    query: input.query || input.url || legacy.canonicalUrl || '',
    evidenceTrail: trail,
    evidence,
    meta: {
      source: 'social-link',
      via,
      timings: { totalMs: _sumLatency(trail) },
    },
    output: legacy.body,
  };
}

/**
 * Adapt webSearchTool legacy result → SearchTaskResult.
 *
 * Legacy shape:
 *   success: {ok:true, output, meta:{query,provider,resultCount,contentFetched,results,timings,spanId,intent,rerank,synonymRetry}, evidenceTrail}
 *   fail:    {ok:false, output, error:'SEARCH_FAILED'|..., meta?, evidenceTrail, aborted?}
 */
export function normalizeWebSearchResult(legacy, input = {}) {
  if (!legacy || typeof legacy !== 'object') {
    return _failResult('web-search', input, 'invalid-legacy-shape', []);
  }
  const trail = Array.isArray(legacy.evidenceTrail) ? legacy.evidenceTrail : [];
  const aborted = !!legacy.aborted;
  if (!legacy.ok) {
    return {
      status: 'fail',
      query: input.query || legacy.meta?.query || '',
      evidenceTrail: trail,
      evidence: [],
      meta: {
        source: 'web-search',
        via: legacy.meta?.provider,
        timings: { totalMs: legacy.meta?.timings?.totalMs ?? _sumLatency(trail) },
        ...(legacy.meta?.cacheHit ? { cache: { hit: 'fresh' } } : {}),
        ...(aborted ? { aborted: true } : {}),
      },
      error: mapErrorCode(legacy.error, { aborted }),
      output: legacy.output,
    };
  }
  // G-2b round-1 follow-up #2 (Codex 2026-05-11 P0): weather fast-path
  // returns ok:true, contentFetched:1, but meta.results:[] (the fetched
  // data is embedded in `legacy.output` as a wttr.in text block, not as
  // a structured SERP-result row).  Pre-fix the adapter looked at
  // results.length=0 → evidence=[] → status='fail', misclassifying a
  // successful weather query as a failure.  Detect via the provider tag
  // 'wttr.in' or timings.weatherFastPath and emit a single web-page
  // evidence carrying the rendered text body.
  const provider = legacy.meta?.provider || 'unknown';
  const isWeatherFastPath = provider === 'wttr.in'
    || legacy.meta?.timings?.weatherFastPath === true;
  if (isWeatherFastPath) {
    const url = input.url || legacy.meta?.url || '';
    return {
      status: 'ok',
      query: input.query || legacy.meta?.query || '',
      evidenceTrail: trail,
      evidence: [{
        sourceType: 'web-page',
        title: 'Weather',
        url,
        body: legacy.output,
        confidence: 'high',
        extractionMethod: 'wttr.in',
        isPartial: false,
        fetchedAt: new Date().toISOString(),
        extra: { weatherFastPath: true },
      }],
      meta: {
        source: 'web-search',
        via: 'wttr.in',
        timings: legacy.meta?.timings || { totalMs: _sumLatency(trail) },
      },
      output: legacy.output,
    };
  }

  // Success — one evidence item per SERP result.
  //
  // G-2b round-1 follow-up #3 (Codex 2026-05-11 P0): for SERP results,
  // the legacy contract does NOT expose a structured `contentMap` even
  // when `contentFetched > 0` (fetched bodies are inlined into the
  // `output` markdown string under "**Page content:**" sections).  G-2b
  // adapter cannot reliably reconstruct per-url bodies from that string.
  // → Honest representation: mark every SERP item as isPartial=true and
  // leave body undefined.  task status='partial' (some evidence exists
  // but no parsed bodies).  G-2c will change webSearchTool to emit
  // `meta.contentItems[]` so the adapter can lift isPartial=false for
  // fetched URLs; until then, isPartial=true is the only truthful tag.
  const results = Array.isArray(legacy.meta?.results) ? legacy.meta.results : [];
  // Cache hits are valid but lower-confidence.
  const isCache = !!legacy.meta?.timings?.cacheHit;
  const evidence = results.map(r => ({
    sourceType: 'web-page',
    title: r.title || '',
    url: r.url || '',
    snippet: r.snippet || '',
    confidence: isCache ? 'low' : deriveConfidence(provider),
    extractionMethod: isCache ? (legacy.meta?.timings?.swr ? 'cache-stale-swr' : 'cache-fresh') : provider,
    isPartial: true, // SERP-only: no per-url body until G-2c
    fetchedAt: new Date().toISOString(),
  }));
  // Status: partial when SERP returned items (G-2b adapter limitation —
  // bodies are inlined in legacy.output, not structured); fail when no
  // results at all.  When G-2c webSearchTool emits structured
  // contentItems, this flips back to 'ok' for items with body.
  const status = evidence.length ? 'partial' : 'fail';
  return {
    status,
    query: input.query || legacy.meta?.query || '',
    evidenceTrail: trail,
    evidence,
    meta: {
      source: 'web-search',
      via: provider,
      timings: legacy.meta?.timings || { totalMs: _sumLatency(trail) },
      ...(isCache ? {
        cache: {
          hit: legacy.meta?.timings?.swr ? 'stale' : 'fresh',
        },
      } : {}),
    },
    output: legacy.output,
  };
}

/**
 * Dispatch table — single entry point callers use.
 *
 * @param {*} legacy        whatever the tool returned
 * @param {string} source   'url-fetch' | 'social-link' | 'web-search'
 * @param {{query?: string, url?: string}} [input]
 * @returns {SearchTaskResult}
 */
export function normalizeToSearchTaskResult(legacy, source, input = {}) {
  switch (source) {
    case 'url-fetch': return normalizeFetchUrlResult(legacy, input);
    case 'social-link': return normalizeSocialLinkResult(legacy, input);
    case 'web-search': return normalizeWebSearchResult(legacy, input);
    default:
      throw new Error(`normalizeToSearchTaskResult: unknown source "${source}" (allowed: url-fetch / social-link / web-search)`);
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function _failResult(source, input, errorReason, trail) {
  return {
    status: 'fail',
    query: input.query || input.url || '',
    evidenceTrail: trail,
    evidence: [],
    meta: { source, timings: { totalMs: 0 } },
    error: ERROR_CODES.PROVIDER_DOWN,
    output: errorReason ? `[adapter] ${errorReason}` : '',
  };
}

function _sumLatency(trail) {
  return trail.reduce((sum, e) => sum + (Number(e.latencyMs) || 0), 0);
}
