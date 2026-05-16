/**
 * API-direct router for webSearchTool.
 *
 * The webSearchTool's default path is SERP-scrape-extract — agent picks a
 * URL from search results, we fetch + extract HTML.  That's the right call
 * for the long tail, but for many query shapes there's a structured API
 * that returns the same answer in one call, with citations, no anti-bot
 * fight, and no risk of the SERP snippet being a stale cache.
 *
 * v1 wires Wikipedia.  Adding HN / arXiv / GitHub / Stack Exchange later
 * is the same shape: a `{ name, matches, fetch }` provider plus an entry
 * in PROVIDERS.  No new test gates needed per provider — the router test
 * stays generic and each provider gets its own focused test block.
 *
 * Phase placement:
 *   weather-fast-path → cache → api-direct → serp → ...
 *
 * The cache layer sits in front of us deliberately — repeated queries
 * skip the API roundtrip just like they skip SERP.  Provider matches()
 * is a cheap heuristic (regex/intent inspection), so when no provider
 * applies we record `skip` with `no-provider-match` and fall straight
 * through to SERP without paying any latency.
 *
 * Each provider.fetch() returns one of:
 *   - `{ provider, ok: true, results, contentMap, latencyMs }` — caller
 *     formats this into the existing webSearchTool output shape and
 *     returns success.
 *   - `{ provider, ok: false, reason, latencyMs }` — soft fail, caller
 *     records the trail tier+reason and falls through to SERP.
 *   - thrown error — caller catches, records `fail`, falls through.
 *
 * Result shape matches what cache/formatResults expects:
 *   results: [{ title, url, snippet }]
 *   contentMap: Map<url, fullText>
 */

// DI seam for tests — same convention as _setWhisperCliForTests etc.
// Production uses globalThis.fetch; tests can swap in a mock that returns
// canned JSON without standing up an HTTP server.
let _fetchImpl = globalThis.fetch;

export function _setFetchForTests(fn) {
  _fetchImpl = fn || globalThis.fetch;
}

// User-Agent string — Wikipedia and many other APIs require a contact-able
// UA for anonymous traffic.  Keep generic; if any provider 403s we can
// override per-provider later.
const UA = 'Melo/0.2 (https://github.com/MortredVigoss/Melo) Node.js';

function classifyErrorReason(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (!msg) return 'error';
  if (msg.includes('abort')) return 'aborted';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('socket') || msg.includes('econnreset') || msg.includes('econnrefused')) return 'network';
  if (msg.includes('json') || msg.includes('parse')) return 'parse-error';
  return 'error';
}

function combineApiDirectSignal(externalSignal, timeoutMs) {
  // Local combine helper.  Not using src/media/common.js because that
  // module's signal helpers are media-extractor-shaped (timeoutMs is
  // mandatory there).  Here timeoutMs is per-provider, signal is optional.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
  let cleanup = () => clearTimeout(timer);
  if (externalSignal) {
    if (externalSignal.aborted) {
      ac.abort(new DOMException('Aborted', 'AbortError'));
    } else {
      const fwd = () => ac.abort(new DOMException('Aborted', 'AbortError'));
      externalSignal.addEventListener('abort', fwd, { once: true });
      cleanup = () => {
        clearTimeout(timer);
        try { externalSignal.removeEventListener('abort', fwd); } catch {}
      };
    }
  }
  return { signal: ac.signal, cleanup };
}

// ─── Wikipedia provider ──────────────────────────────────────────────────────

// Heuristics chosen to be conservative — false positives are worse than
// false negatives here because a wrong API match short-circuits SERP and
// the user sees one bad answer instead of a SERP they could have refined.
// Patterns:
//   • explicit prefix:  "wikipedia: X" / "wiki: X" / "维基百科：X"
//   • EN definition:    "what is X" / "who is X" / "define X"
//   • ZH definition:    "什么是X" / "谁是X" / "定义X" (no space required)
// EN uses `\s+\S` to require an actual term after the prefix; ZH uses
// `\s*\S` because Chinese definition queries typically have no space
// between prefix and term (`什么是光合作用` is one token-stream).
const WIKI_EXPLICIT = /^(wikipedia|wiki|维基百科|维基)\s*[:：]\s*\S/i;
const WIKI_DEFINITION_EN = /^(what\s+is|what\s+are|who\s+is|who\s+was|who\s+were|define)\s+\S/i;
const WIKI_DEFINITION_ZH = /^(什么是|谁是|定义)\s*\S/;

// Three-state match: 'explicit' (user typed `wiki:` or `维基百科：` prefix —
// always honor), 'implicit' (definition shape — gate on intent.timeSensitive
// upstream so "what is the latest Node.js version" doesn't hit a possibly
// stale Wikipedia summary), or false (no match — caller skips silently).
//
// Codex G-2b round-5 (2026-05-14): split out from isWikipediaQuery to give
// the router enough information to enforce "explicit overrides time-sensitive
// gate" — the original boolean predicate let `what is the latest X` short-
// circuit SERP unconditionally.
export function wikipediaMatchKind(query) {
  if (typeof query !== 'string') return false;
  const q = query.trim();
  if (!q) return false;
  if (WIKI_EXPLICIT.test(q)) return 'explicit';
  if (WIKI_DEFINITION_EN.test(q) || WIKI_DEFINITION_ZH.test(q)) return 'implicit';
  return false;
}

// Backwards-compat boolean predicate.  Kept for callers that only care
// "does this query route to Wikipedia at all" (status checks / debug
// logging); routing decisions inside this module use wikipediaMatchKind
// directly so they can branch on explicit vs implicit.
export function isWikipediaQuery(query) {
  return wikipediaMatchKind(query) !== false;
}

function cleanWikipediaQuery(query) {
  // Trailing `\b\s*` (vs the old `\s+`) lets us strip a prefix even when
  // the rest of the query is whitespace-only (e.g. user typed "what is "
  // and hit enter early) — clean → "", caller returns reason=empty-query
  // instead of forwarding garbage to the Wikipedia API.
  return query.trim()
    .replace(/^(wikipedia|wiki|维基百科|维基)\s*[:：]\s*/i, '')
    .replace(/^(what\s+is|what\s+are|who\s+is|who\s+was|who\s+were|define)\b\s*/i, '')
    .replace(/^(什么是|谁是|定义)\s*/, '')
    .replace(/[?？.。!！]+$/, '')
    .trim();
}

function detectWikiLang(query) {
  // CJK majority → Chinese Wikipedia; otherwise English.  Simple coverage
  // of the two languages most Melo users actually query.  Future: detect
  // ja / ko / es / fr similarly; for now zh+en covers ≥ 95% of traffic.
  return /[一-鿿]/.test(query) ? 'zh' : 'en';
}

export async function fetchFromWikipedia(query, signal) {
  const startTs = Date.now();
  const cleaned = cleanWikipediaQuery(query);
  if (!cleaned) {
    return { provider: 'wikipedia', ok: false, reason: 'empty-query', latencyMs: 0 };
  }

  const lang = detectWikiLang(cleaned);
  const { signal: reqSignal, cleanup } = combineApiDirectSignal(signal, 5000);

  try {
    // Step 1 — opensearch for the top match.  We use action=query/list=search
    // rather than the simpler `/page/summary/{term}` direct hit because the
    // summary endpoint requires an EXACT title match (or a redirect target);
    // search handles fuzzy/partial queries and returns a canonical title.
    const searchUrl = `https://${lang}.wikipedia.org/w/api.php?` +
      `action=query&format=json&list=search&srlimit=1&origin=*&srsearch=${encodeURIComponent(cleaned)}`;
    const sRes = await _fetchImpl(searchUrl, {
      signal: reqSignal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!sRes.ok) {
      return { provider: 'wikipedia', ok: false, reason: `http-${sRes.status}`, latencyMs: Date.now() - startTs };
    }
    const sData = await sRes.json();
    const top = sData?.query?.search?.[0];
    if (!top || !top.title) {
      return { provider: 'wikipedia', ok: false, reason: 'no-results', latencyMs: Date.now() - startTs };
    }

    const title = String(top.title);
    const pageSlug = encodeURIComponent(title.replace(/ /g, '_'));
    const pageUrl = `https://${lang}.wikipedia.org/wiki/${pageSlug}`;

    // Step 2 — REST summary for the extract paragraph.  Soft-degrade: if
    // this 404s or errors, we still return the search-result snippet as a
    // valid (lower-quality) answer rather than failing the whole api-direct
    // tier.  search snippet contains HTML — strip tags before returning.
    const stripHtml = s => String(s || '').replace(/<[^>]+>/g, '').trim();
    const baseSnippet = stripHtml(top.snippet);

    let extract = '';
    let finalTitle = title;
    let finalUrl = pageUrl;
    let finalSnippet = baseSnippet;
    try {
      const sumUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${pageSlug}`;
      const dRes = await _fetchImpl(sumUrl, {
        signal: reqSignal,
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (dRes.ok) {
        const dData = await dRes.json();
        extract = String(dData?.extract || '').trim();
        finalTitle = String(dData?.title || title);
        finalUrl = String(dData?.content_urls?.desktop?.page || pageUrl);
        const desc = String(dData?.description || '').trim();
        if (desc) finalSnippet = desc;
      }
    } catch (sumErr) {
      // Summary fetch failed but search succeeded — degrade gracefully.
      if (signal?.aborted) {
        return { provider: 'wikipedia', ok: false, reason: 'aborted', latencyMs: Date.now() - startTs };
      }
      // Otherwise fall through with just the search snippet.
    }

    const contentMap = new Map();
    if (extract) contentMap.set(finalUrl, extract);

    return {
      provider: 'wikipedia',
      ok: true,
      results: [{ title: finalTitle, url: finalUrl, snippet: finalSnippet }],
      contentMap,
      latencyMs: Date.now() - startTs,
    };
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') {
      return { provider: 'wikipedia', ok: false, reason: 'aborted', latencyMs: Date.now() - startTs };
    }
    return { provider: 'wikipedia', ok: false, reason: classifyErrorReason(err), latencyMs: Date.now() - startTs };
  } finally {
    cleanup();
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

const PROVIDERS = [
  { name: 'wikipedia', matchKind: wikipediaMatchKind, fetch: fetchFromWikipedia },
];

/**
 * Try each provider in declared order.  Returns:
 *   • null                                                              — no provider matched (caller skips silently)
 *   • { provider, ok: true,  results, contentMap, latencyMs }           — success (caller returns)
 *   • { provider, ok: false, reason, latencyMs }                        — provider tried + failed (caller falls through)
 *   • { provider, ok: false, skipped: true, reason, latencyMs }         — provider matched but skipped (e.g. implicit
 *                                                                        match collided with intent.timeSensitive);
 *                                                                        caller falls through to SERP without paying
 *                                                                        any API latency
 *
 * Time-sensitivity gate (Codex G-2b round-5, 2026-05-14): when the
 * provider's matchKind() is 'implicit' (definition-shape heuristic, not an
 * explicit `wiki:` prefix) AND the upstream classifier says the query is
 * time-sensitive (`latest` / `current` / `今天` / `最新` / weather/price/
 * news intent), we skip the API.  Wikipedia summaries lag live data — a
 * structured-data short-circuit for "what is the latest Node.js version"
 * would silently return a possibly-stale answer instead of letting SERP
 * find a current source.  Explicit `wiki:` prefix bypasses this gate
 * because the user has stated their preference.
 */
export async function tryApiDirect(query, intent, signal) {
  for (const provider of PROVIDERS) {
    const kind = provider.matchKind(query);
    if (!kind) continue;
    if (kind === 'implicit' && intent?.timeSensitive) {
      return {
        provider: provider.name,
        ok: false,
        skipped: true,
        reason: 'time-sensitive',
        latencyMs: 0,
      };
    }
    return provider.fetch(query, signal);
  }
  return null;
}

// Test surface — exposed only so test files can introspect the provider
// list without re-deriving it.  Do NOT consume in production code.
export const _internals = {
  PROVIDERS,
  cleanWikipediaQuery,
  detectWikiLang,
  wikipediaMatchKind,
};
