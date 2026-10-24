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
// Pure adapter for legacy tool results and persisted history. Production
// toolResultProjection normalizes results here before storing evidence trails;
// callers retain the raw output for backwards-compatible model/history reads.
// This layer does not plan searches or grant tools.
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
  // 2026-05-21 audit闭环 #4: fetchUrlTool also returns FETCH_FAILED on
  // generic transport failures (HTTP fail at outer catch + cdp-chrome
  // transport error) — pre-fix this fell through to PROVIDER_DOWN
  // ("all providers exhausted"), misleading consumers about the cause.
  // The trail-based primary classifier covers vocab'd reasons; this is
  // the fallback for when trail reason isn't recognized.  NETWORK is
  // the closest unified code (DNS/connect/5xx).
  FETCH_FAILED: ERROR_CODES.NETWORK,
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

// ─── Phase priority (G-2b round-3): source-aware causal fail selection ────
//
// Per-source ordered list — earlier phases are CAUSAL (their failure
// triggers the chain), later phases are CASCADE (they fail because the
// earlier phase already failed).  When picking the "real" fail to
// classify, prefer the highest-priority phase that actually failed.
//
// Example webSearch trail:
//   cache.fail(no-hit) → serp.fail(no-results) → synonym-retry.fail(all-variants-thin)
//                       → content-fetch.skip → semantic-rerank.skip
// Pre-round-3 "last fail" picked synonym-retry → reason 'all-variants-thin'
// → fallback PROVIDER_DOWN.  But the CAUSAL fail is serp.fail(no-results)
// → NO_RESULTS.  Phase priority list ['serp', 'cache', 'synonym-retry',
// ...] makes us search for serp.fail first.
//
// Example fetchUrl-via-social trail (after socialLink sub-trail merge):
//   cookie-resolve.skip → social-link.yt-dlp.fail(unsupported) →
//   social-link.share-preview.fail(low-score) →
//   social-link.browser.fail(low-score) →
//   social-link.external-reader.fail(no-reader-fn) →
//   social-link.fail(login-wall)  ← outer wrapper added by fetchUrlTool
// Pre-round-3 "last fail" picked the outer `social-link` wrapper, masking
// the inner `low-score` / `no-reader-fn` signals.  Phase priority puts the
// inner `social-link.*` sub-tiers ahead of the outer `social-link` so the
// classification reflects WHICH sub-strategy gave up.

const PHASE_PRIORITY = Object.freeze({
  // webSearch: serp is the causal phase; cache/synonym-retry/content-fetch
  // are around it but never override its diagnosis.
  'web-search': [
    'serp',
    'cache',
    'synonym-retry',
    'content-fetch',
    'semantic-rerank',
    'weather-fast-path',
    // G-2b round-4 闭环 (2026-05-21 Codex C #4): api-direct is the
    // try-first-then-fallback short-circuit (Wikipedia / HN / arXiv /
    // GitHub / Stack Overflow → SERP).  When api-direct.fail happens,
    // the recovery path is SERP — so SERP.fail is the CAUSAL fail.
    // Listing api-direct here (low priority) keeps it visible for
    // diagnostic / vocab parity without shadowing the real causal phase.
    'api-direct',
    'validate',
  ],
  // socialLink: depth-first — yt-dlp is the strongest signal, fall through
  // to share-preview/browser/external-reader if yt-dlp didn't carry one.
  'social-link': [
    'yt-dlp',
    'short-link-resolve',
    'share-preview',
    'browser',
    'external-reader',
  ],
  // fetchUrl: outer paths first, but the inner `social-link.<sub>` entries
  // (after sub-trail merge with `social-link.` prefix) are MORE specific
  // than the outer `social-link` summary, so they win.
  'url-fetch': [
    'validate',
    // inner social-link sub-tiers — preferred over the outer `social-link`
    // wrapper because they carry the precise extractor failure reason.
    'social-link.yt-dlp',
    'social-link.short-link-resolve',
    'social-link.share-preview',
    'social-link.browser',
    'social-link.external-reader',
    // outer wrapper / non-social paths
    'social-link',
    'direct+cookie',
    'direct',
    'jina',
    'playwright',
    'external-reader',
    'cookie-resolve',
  ],
});

// ─── trail-reason vocabulary (G-2b round-3 systematic) ─────────────────────
//
// Table-driven mapping: every reason emitted by classifyFetchError /
// classifySocialError / classifyWebSearchError + every tier-specific
// reason added by recordTrail callers.  Single source of truth; no more
// scattered `if (reason === 'x')` patches.

const REASON_VOCABULARY = Object.freeze({
  // Abort variants (also caught earlier by `aborted` opt; duplicated here
  // so trails where the caller forgot to thread the flag still classify).
  'aborted': ERROR_CODES.ABORTED,
  'aborted-mid-loop': ERROR_CODES.ABORTED,
  'aborted-by-prev-tier': ERROR_CODES.ABORTED,
  'aborted-by-prev-phase': ERROR_CODES.ABORTED,
  'aborted-at-entry': ERROR_CODES.ABORTED,
  'aborted-after-short-link': ERROR_CODES.ABORTED,
  'aborted-after-yt-dlp': ERROR_CODES.ABORTED,
  'aborted-after-share-preview': ERROR_CODES.ABORTED,
  'aborted-after-browser': ERROR_CODES.ABORTED,
  // Timeout
  'timeout': ERROR_CODES.TIMEOUT,
  'timed-out': ERROR_CODES.TIMEOUT,
  // No results (search/preview yielded nothing usable)
  'no-results': ERROR_CODES.NO_RESULTS,
  'all-variants-thin': ERROR_CODES.NO_RESULTS, // synonym-retry: retried all variants, none had enough
  'low-score': ERROR_CODES.NO_RESULTS,
  'no-match': ERROR_CODES.NO_RESULTS,
  'no-preview': ERROR_CODES.NO_RESULTS,
  'serp-strong-no-retry-needed': ERROR_CODES.NO_RESULTS,
  // Login wall / auth required
  'login-wall': ERROR_CODES.LOGIN_REQUIRED,
  'login-required': ERROR_CODES.LOGIN_REQUIRED,
  // Network
  'network': ERROR_CODES.NETWORK,
  'econnreset': ERROR_CODES.NETWORK,
  'econnrefused': ERROR_CODES.NETWORK,
  '4xx': ERROR_CODES.NETWORK,
  '5xx': ERROR_CODES.NETWORK,
  'tls': ERROR_CODES.NETWORK,
  // Extraction failures (content reachable but parser couldn't extract)
  'parse-error': ERROR_CODES.EXTRACTION_FAILED,
  'parse-empty': ERROR_CODES.EXTRACTION_FAILED,
  'no-content': ERROR_CODES.EXTRACTION_FAILED,
  'no-content-after-fallbacks': ERROR_CODES.EXTRACTION_FAILED,
  'no-content-or-too-short': ERROR_CODES.EXTRACTION_FAILED, // socialLink external-reader: returned too-short body
  'extractor-throw': ERROR_CODES.EXTRACTION_FAILED,
  'unsupported-or-no-meta': ERROR_CODES.EXTRACTION_FAILED, // socialLink yt-dlp: platform unsupported
  'no-title-or-body': ERROR_CODES.EXTRACTION_FAILED,
  // Input
  'invalid-url': ERROR_CODES.INVALID_INPUT,
  'invalid-query': ERROR_CODES.INVALID_INPUT,
  // Provider missing
  'cli-missing-or-no-content': ERROR_CODES.PROVIDER_DOWN,
  'no-reader-fn': ERROR_CODES.PROVIDER_DOWN,
  'no-browser-fn': ERROR_CODES.PROVIDER_DOWN,
  'no-preview-fn': ERROR_CODES.PROVIDER_DOWN,
  // Cache-related (rare in fail path but completeness)
  'no-hit': ERROR_CODES.NO_RESULTS,
  // No-cookie skip → not a fail reason, included for completeness
  'no-cookie': ERROR_CODES.PROVIDER_DOWN,
});

// ─── trail-reason-aware error refinement (G-2b round-3 systematic) ─────────
//
// G-2b round-3 (Codex 2026-05-11 C round-3 闭环): "last fail" algorithm
// misclassified real production trails where cascade fails (synonym-retry
// after serp.no-results, outer social-link wrapper after inner sub-tier
// fails) overwrote the causal classification.  Round-3 rewrite uses
// source-aware PHASE_PRIORITY to find the *causal* fail, not the latest.
//
// Algorithm:
//   1. aborted=true short-circuits to ABORTED.
//   2. Look up PHASE_PRIORITY[source] (ordered list of tier names).
//   3. Walk the priority list; first phase whose trail entry has
//      outcome=fail is the causal fail.
//   4. If no priority match, fall back to last fail (pre-round-3 behavior)
//      as a safety net for unknown sources / new tiers.
//   5. Look up causalFail.reason in REASON_VOCABULARY (table-driven).
//   6. If reason missing from vocab, fall through to legacy code mapping,
//      then defaultCode.

export function deriveErrorFromTrail(trail, opts = {}) {
  const {
    aborted = false,
    legacyCode = null,
    defaultCode = ERROR_CODES.PROVIDER_DOWN,
    source = null,
  } = opts;
  if (aborted) return ERROR_CODES.ABORTED;
  const trailArr = Array.isArray(trail) ? trail : [];
  // 1. Source-aware phase priority lookup.
  const priority = source ? PHASE_PRIORITY[source] : null;
  let causalFail = null;
  if (priority) {
    for (const phase of priority) {
      const hit = trailArr.find(e => e.tier === phase && e.outcome === 'fail');
      if (hit) { causalFail = hit; break; }
    }
  }
  // 2. Safety net: if no priority match (unknown source, or none of the
  //    priority phases failed but some other tier did), fall back to last
  //    fail.
  if (!causalFail) {
    causalFail = [...trailArr].reverse().find(e => e.outcome === 'fail');
  }
  // 3. Reason → unified code via table-driven vocabulary.
  const reason = causalFail?.reason;
  if (reason && Object.prototype.hasOwnProperty.call(REASON_VOCABULARY, reason)) {
    return REASON_VOCABULARY[reason];
  }
  // 4. Fall through to legacy code mapping.
  if (legacyCode) return mapErrorCode(legacyCode, { aborted });
  return defaultCode;
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
      // G-2b round-2: trail-reason-aware refinement (lessons-learned §3
      // systematic — applied to all 3 tools' fail paths in this commit).
      // For fetchUrl, outer-catch puts `err.message` into `legacy.error`,
      // a free-form string that loses precision; trail reasons (network,
      // timeout, 4xx, etc.) are the truthful classification.
      error: deriveErrorFromTrail(trail, { aborted, legacyCode: legacy.error, source: 'url-fetch' }),
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
    // G-2b round-2: trail-reason-aware error.  socialLinkTool miss isn't
    // always login wall — could be no-results (low share-preview score),
    // network failure, parse-error, etc.  The trail's last fail tier
    // tells us which; default to LOGIN_REQUIRED only when the trail
    // doesn't have a clearer signal (matches the historical default).
    return {
      status: 'fail',
      query: input.query || input.url || legacy.canonicalUrl || '',
      evidenceTrail: trail,
      evidence: [],
      meta: { source: 'social-link', via: legacy.via || 'none', timings: { totalMs: _sumLatency(trail) } },
      error: deriveErrorFromTrail(trail, { source: 'social-link', defaultCode: ERROR_CODES.LOGIN_REQUIRED }),
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
      // G-2b round-2: webSearchTool's 'SEARCH_FAILED' code conflates
      // NO_RESULTS / TIMEOUT / NETWORK / PROVIDER_DOWN — the trail's
      // serp.fail reason has the precise classification (see
      // classifyWebSearchError in webSearchTool.js).
      // G-2b round-3: source='web-search' → PHASE_PRIORITY puts serp at
      // top so we get the CAUSAL fail, not the cascade synonym-retry.
      error: deriveErrorFromTrail(trail, { aborted, legacyCode: legacy.error, source: 'web-search' }),
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

  // G-2b round-4/5 闭环 (2026-05-21 Codex C #4 / #5): api-direct success path.
  // webSearchTool short-circuits SERP when api-direct providers (Wikipedia /
  // HN / arXiv / GitHub / Stack Overflow) match.  Without this branch the
  // adapter fell through to the SERP path and incorrectly marked Wikipedia
  // entries as confidence='unknown' / isPartial=true / no body, defeating
  // the entire api-direct routing the user added 2026-05-14 a96f5e9 chain.
  //
  // Round-5 闭环 (Codex C, snippet/body distinction): the `snippet` field
  // means DIFFERENT things per provider:
  //   - Wikipedia: snippet = extract (the body itself)
  //   - HN:        snippet = "{points} · {comments} · posted {date}" (METADATA)
  //                body in apiResult.contentMap[url] = hit.story_text
  //   - arXiv:     snippet = "({year}) · {authors} · arXiv:{id}" (METADATA)
  //                body in apiResult.contentMap[url] = paper.abstract
  //   - GitHub:    snippet = "★ {stars} · {lang} · updated {date}" (METADATA)
  //                body in apiResult.contentMap[url] = repo.description
  //   - Stack Overflow: similar — snippet=metadata, body=contentMap
  // Pre-round-5 we set body=snippet uniformly → HN/GitHub appeared to have
  // "{points} · {comments}" as their answer body, total nonsense.
  //
  // Round-5 fix: consume `legacy.meta.contentItems` (added to webSearchTool's
  // api-direct.ok return path same commit) for authoritative per-URL bodies.
  // If contentItems has body for this URL → isPartial=false / body=content.
  // If no body → isPartial=true / body=undefined, snippet kept as metadata
  // for display.  task status='ok' (we have evidence rows even when bodies
  // are partial — per RFC §4 ③ "per-item isPartial" semantics).
  const apiDirectOk = trail.find(e => e?.tier === 'api-direct' && e?.outcome === 'ok');
  if (apiDirectOk) {
    const results = Array.isArray(legacy.meta?.results) ? legacy.meta.results : [];
    // method on the trail entry is the provider id ('wikipedia' / 'hacker-news' /
    // 'arxiv-semantic-scholar' / 'github' / 'stack-overflow').  Fallback to
    // meta.provider if trail entry lacks it.
    const apiProvider = apiDirectOk.method || provider;
    // Build url→body map from legacy.meta.contentItems (added round-5).
    // If absent (pre-round-5 caller / fixture), every result is partial.
    const contentItems = Array.isArray(legacy.meta?.contentItems)
      ? legacy.meta.contentItems
      : [];
    const bodyByUrl = new Map(contentItems
      .filter(c => c && typeof c.url === 'string' && typeof c.content === 'string')
      .map(c => [c.url, c.content]));
    return {
      status: results.length ? 'ok' : 'fail',
      query: input.query || legacy.meta?.query || '',
      evidenceTrail: trail,
      evidence: results.map(r => {
        const body = bodyByUrl.get(r.url);
        return {
          sourceType: 'api-direct',
          title: r.title || '',
          url: r.url || '',
          // snippet always preserved (metadata or body excerpt — caller
          // decides how to render based on isPartial).
          snippet: r.snippet || '',
          // body ONLY present when contentItems carried real content for
          // this URL.  HN/GitHub/SO with empty story_text/description leave
          // body undefined and isPartial=true.
          ...(body ? { body } : {}),
          confidence: 'high', // structured-JSON providers are always
                              // higher confidence than SERP heuristics,
                              // regardless of whether per-result body
                              // was fetched.
          extractionMethod: apiProvider,
          isPartial: !body,   // round-5: per-result honest signal —
                              // body present = full answer, absent =
                              // we have title+snippet+metadata only.
          fetchedAt: new Date().toISOString(),
        };
      }),
      meta: {
        source: 'web-search',
        via: apiProvider,
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
