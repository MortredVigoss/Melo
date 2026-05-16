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

// ─── HN Algolia provider ─────────────────────────────────────────────────────
//
// Hacker News full-text search via the public Algolia mirror.  Anonymous
// access, no rate-limit issues at Melo scale.  All matches are 'explicit'
// — there's no "implicit" definition shape that should auto-route to HN.
// User must name the site ("hacker news" / "hn:") for us to fire.

const HN_PREFIX = /^(hn|hackernews|hacker\s+news)\s*[:：]\s*\S/i;
const HN_PHRASE = /\bhacker\s+news\b|\bhn\s+(discussion|comments|thread|story|stories)/i;

export function hnMatchKind(query) {
  if (typeof query !== 'string') return false;
  const q = query.trim();
  if (!q) return false;
  return (HN_PREFIX.test(q) || HN_PHRASE.test(q)) ? 'explicit' : false;
}

function cleanHnQuery(query) {
  return query.trim()
    .replace(/^(hn|hackernews|hacker\s+news)\s*[:：]\s*/i, '')
    .replace(/\b(hn|hacker\s+news)\s+(discussion|comments|thread|story|stories)(\s+(on|about))?\s*/gi, '')
    .replace(/\b(on|about)\s+hacker\s+news\b/gi, '')
    .replace(/\bhacker\s+news\b/gi, '')
    .replace(/[?？.。!！]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchFromHN(query, signal) {
  const startTs = Date.now();
  const cleaned = cleanHnQuery(query);
  if (!cleaned) {
    return { provider: 'hackernews', ok: false, reason: 'empty-query', latencyMs: 0 };
  }
  const { signal: reqSignal, cleanup } = combineApiDirectSignal(signal, 5000);
  try {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(cleaned)}&tags=story&hitsPerPage=3`;
    const res = await _fetchImpl(url, {
      signal: reqSignal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) {
      return { provider: 'hackernews', ok: false, reason: `http-${res.status}`, latencyMs: Date.now() - startTs };
    }
    const data = await res.json();
    const hits = Array.isArray(data?.hits) ? data.hits : [];
    if (!hits.length) {
      return { provider: 'hackernews', ok: false, reason: 'no-results', latencyMs: Date.now() - startTs };
    }
    const results = [];
    const contentMap = new Map();
    for (const hit of hits) {
      if (!hit?.objectID) continue;
      const title = String(hit.title || hit.story_title || 'HN story');
      const itemUrl = `https://news.ycombinator.com/item?id=${hit.objectID}`;
      const externalUrl = String(hit.url || '');
      const points = Number(hit.points || 0);
      const numComments = Number(hit.num_comments || 0);
      const created = hit.created_at ? String(hit.created_at).slice(0, 10) : '';
      const snippet = [
        `${points} points`,
        `${numComments} comments`,
        created ? `posted ${created}` : '',
        externalUrl ? `→ ${externalUrl}` : '',
      ].filter(Boolean).join(' · ');
      results.push({ title, url: itemUrl, snippet });
      const body = String(hit.story_text || '').replace(/<[^>]+>/g, '').trim();
      if (body) contentMap.set(itemUrl, body);
    }
    if (!results.length) {
      return { provider: 'hackernews', ok: false, reason: 'no-results', latencyMs: Date.now() - startTs };
    }
    return { provider: 'hackernews', ok: true, results, contentMap, latencyMs: Date.now() - startTs };
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') {
      return { provider: 'hackernews', ok: false, reason: 'aborted', latencyMs: Date.now() - startTs };
    }
    return { provider: 'hackernews', ok: false, reason: classifyErrorReason(err), latencyMs: Date.now() - startTs };
  } finally {
    cleanup();
  }
}

// ─── arXiv provider (via Semantic Scholar) ───────────────────────────────────
//
// arXiv's native API is Atom-XML which we'd need a parser for.  Semantic
// Scholar's free Graph API aggregates arXiv + other sources and returns
// clean JSON, no key required.  We filter results to those with an
// externalIds.ArXiv entry so this stays "arXiv-shaped" — Codex G-2b
// round-5 lesson: don't pretend to be one provider while quietly serving
// another's data.

// Codex G-2b round-6 (2026-05-16): split into explicit (user named arXiv)
// vs implicit (academic-intent phrasing but no site mention).  Implicit
// flows through the time-sensitive gate so "latest research on AI safety"
// goes to SERP, not arXiv where the data is necessarily lagged behind
// preprints / publication cycles.  Mirrors the Wikipedia matchKind shape.
const ARXIV_EXPLICIT = /^(arxiv|arXiv)\s*[:：]\s*\S|\barxiv\b/i;
const ARXIV_IMPLICIT = /\b(paper|research|论文)s?\s+(on|about|关于)\s+\S|\S\s*论文\s*$/i;

export function arxivMatchKind(query) {
  if (typeof query !== 'string') return false;
  const q = query.trim();
  if (!q) return false;
  if (ARXIV_EXPLICIT.test(q)) return 'explicit';
  if (ARXIV_IMPLICIT.test(q)) return 'implicit';
  return false;
}

function cleanArxivQuery(query) {
  return query.trim()
    .replace(/^(arxiv|arXiv)\s*[:：]\s*/i, '')
    .replace(/^\s*(papers?|research|论文)\s+(on|about|关于)\s+/i, '')
    .replace(/\s+论文\s*$/, '')
    .replace(/\barxiv\b/gi, '')
    .replace(/[?？.。!！]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchFromArxiv(query, signal) {
  const startTs = Date.now();
  const cleaned = cleanArxivQuery(query);
  if (!cleaned) {
    return { provider: 'arxiv', ok: false, reason: 'empty-query', latencyMs: 0 };
  }
  const { signal: reqSignal, cleanup } = combineApiDirectSignal(signal, 6000);
  try {
    const fields = 'title,authors,abstract,year,externalIds,url';
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(cleaned)}&limit=5&fields=${fields}`;
    const res = await _fetchImpl(url, {
      signal: reqSignal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) {
      return { provider: 'arxiv', ok: false, reason: `http-${res.status}`, latencyMs: Date.now() - startTs };
    }
    const data = await res.json();
    const all = Array.isArray(data?.data) ? data.data : [];
    // Keep only papers actually on arXiv — anything else is Semantic
    // Scholar's broader corpus and shouldn't be billed as "arXiv".
    const arxivOnly = all.filter(p => p?.externalIds?.ArXiv).slice(0, 3);
    if (!arxivOnly.length) {
      return { provider: 'arxiv', ok: false, reason: 'no-results', latencyMs: Date.now() - startTs };
    }
    const results = [];
    const contentMap = new Map();
    for (const paper of arxivOnly) {
      const arxivId = String(paper.externalIds.ArXiv);
      const paperUrl = `https://arxiv.org/abs/${arxivId}`;
      const title = String(paper.title || `arXiv:${arxivId}`).trim();
      const authorList = Array.isArray(paper.authors) ? paper.authors.slice(0, 3).map(a => a.name).filter(Boolean) : [];
      const authorTail = (Array.isArray(paper.authors) && paper.authors.length > 3) ? ' et al.' : '';
      const year = paper.year ? String(paper.year) : '';
      const snippet = [
        year ? `(${year})` : '',
        authorList.length ? authorList.join(', ') + authorTail : '',
        `arXiv:${arxivId}`,
      ].filter(Boolean).join(' · ');
      results.push({ title, url: paperUrl, snippet });
      const abstract = String(paper.abstract || '').trim();
      if (abstract) contentMap.set(paperUrl, abstract);
    }
    return { provider: 'arxiv', ok: true, results, contentMap, latencyMs: Date.now() - startTs };
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') {
      return { provider: 'arxiv', ok: false, reason: 'aborted', latencyMs: Date.now() - startTs };
    }
    return { provider: 'arxiv', ok: false, reason: classifyErrorReason(err), latencyMs: Date.now() - startTs };
  } finally {
    cleanup();
  }
}

// ─── GitHub provider ─────────────────────────────────────────────────────────
//
// Repository search.  Anonymous, 60 req/h rate limit (enough for typical
// Melo usage where this is a fallback path, not a polling target).  User
// search / code search are intentionally out of scope for v1 — same
// matchKind/fetch pattern, just deferred until shape signal warrants it.

const GH_PREFIX = /^(github|gh)\s*[:：]\s*\S/i;
const GH_PHRASE = /\bgithub\b|\bgh\s+(repo|repos|repository|repositories)\b/i;

export function githubMatchKind(query) {
  if (typeof query !== 'string') return false;
  const q = query.trim();
  if (!q) return false;
  return (GH_PREFIX.test(q) || GH_PHRASE.test(q)) ? 'explicit' : false;
}

function cleanGithubQuery(query) {
  return query.trim()
    .replace(/^(github|gh)\s*[:：]\s*/i, '')
    .replace(/^\s*github\s+(repo|repos|repository|repositories)\s+(for|of)?\s*/i, '')
    .replace(/\bgh\s+(repo|repos|repository|repositories)\b/gi, '')
    .replace(/\bon\s+github\b/gi, '')
    .replace(/\bgithub\b/gi, '')
    .replace(/[?？.。!！]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchFromGitHub(query, signal) {
  const startTs = Date.now();
  const cleaned = cleanGithubQuery(query);
  if (!cleaned) {
    return { provider: 'github', ok: false, reason: 'empty-query', latencyMs: 0 };
  }
  const { signal: reqSignal, cleanup } = combineApiDirectSignal(signal, 5000);
  try {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(cleaned)}&per_page=3&sort=best-match`;
    const res = await _fetchImpl(url, {
      signal: reqSignal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      return { provider: 'github', ok: false, reason: `http-${res.status}`, latencyMs: Date.now() - startTs };
    }
    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) {
      return { provider: 'github', ok: false, reason: 'no-results', latencyMs: Date.now() - startTs };
    }
    const results = [];
    const contentMap = new Map();
    for (const repo of items.slice(0, 3)) {
      if (!repo?.full_name) continue;
      const title = String(repo.full_name);
      const url2 = String(repo.html_url || `https://github.com/${repo.full_name}`);
      const stars = Number(repo.stargazers_count || 0);
      const lang = String(repo.language || '');
      const updated = repo.updated_at ? String(repo.updated_at).slice(0, 10) : '';
      const snippet = [
        `★ ${stars}`,
        lang || '',
        updated ? `updated ${updated}` : '',
      ].filter(Boolean).join(' · ');
      results.push({ title, url: url2, snippet });
      const desc = String(repo.description || '').trim();
      if (desc) contentMap.set(url2, desc);
    }
    if (!results.length) {
      return { provider: 'github', ok: false, reason: 'no-results', latencyMs: Date.now() - startTs };
    }
    return { provider: 'github', ok: true, results, contentMap, latencyMs: Date.now() - startTs };
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') {
      return { provider: 'github', ok: false, reason: 'aborted', latencyMs: Date.now() - startTs };
    }
    return { provider: 'github', ok: false, reason: classifyErrorReason(err), latencyMs: Date.now() - startTs };
  } finally {
    cleanup();
  }
}

// ─── Stack Overflow provider ────────────────────────────────────────────────
//
// Stack Exchange API anonymous tier (10k queries/day, far above Melo's
// needs).  Stackoverflow site only for v1; superuser/serverfault/codereview
// can be added as separate providers later if there's signal in the trail.

const SO_PREFIX = /^(stackoverflow|stack\s+overflow)\s*[:：]\s*\S/i;
const SO_PHRASE = /\bstack\s+overflow\b/i;

export function stackOverflowMatchKind(query) {
  if (typeof query !== 'string') return false;
  const q = query.trim();
  if (!q) return false;
  return (SO_PREFIX.test(q) || SO_PHRASE.test(q)) ? 'explicit' : false;
}

function cleanStackOverflowQuery(query) {
  return query.trim()
    .replace(/^(stackoverflow|stack\s+overflow)\s*[:：]\s*/i, '')
    .replace(/\bon\s+stack\s+overflow\b/gi, '')
    .replace(/\bstack\s+overflow\b/gi, '')
    .replace(/[?？.。!！]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchFromStackOverflow(query, signal) {
  const startTs = Date.now();
  const cleaned = cleanStackOverflowQuery(query);
  if (!cleaned) {
    return { provider: 'stackoverflow', ok: false, reason: 'empty-query', latencyMs: 0 };
  }
  const { signal: reqSignal, cleanup } = combineApiDirectSignal(signal, 5000);
  try {
    const url = 'https://api.stackexchange.com/2.3/search/advanced' +
      `?order=desc&sort=relevance&site=stackoverflow&pagesize=3` +
      `&q=${encodeURIComponent(cleaned)}`;
    const res = await _fetchImpl(url, {
      signal: reqSignal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) {
      return { provider: 'stackoverflow', ok: false, reason: `http-${res.status}`, latencyMs: Date.now() - startTs };
    }
    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) {
      return { provider: 'stackoverflow', ok: false, reason: 'no-results', latencyMs: Date.now() - startTs };
    }
    const results = [];
    const contentMap = new Map();
    for (const item of items.slice(0, 3)) {
      if (!item?.link) continue;
      // Stack Exchange returns title encoded as HTML entities — decode the
      // common ones so the chat UI doesn't render literal `&quot;` etc.
      const title = String(item.title || 'Stack Overflow question')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      const url2 = String(item.link);
      const score = Number(item.score || 0);
      const answerCount = Number(item.answer_count || 0);
      const isAnswered = Boolean(item.is_answered);
      const tags = Array.isArray(item.tags) ? item.tags.slice(0, 4).join(', ') : '';
      const snippet = [
        `↑ ${score}`,
        `${answerCount} answers`,
        isAnswered ? '✓ answered' : '',
        tags ? `tags: ${tags}` : '',
      ].filter(Boolean).join(' · ');
      results.push({ title, url: url2, snippet });
    }
    if (!results.length) {
      return { provider: 'stackoverflow', ok: false, reason: 'no-results', latencyMs: Date.now() - startTs };
    }
    return { provider: 'stackoverflow', ok: true, results, contentMap, latencyMs: Date.now() - startTs };
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') {
      return { provider: 'stackoverflow', ok: false, reason: 'aborted', latencyMs: Date.now() - startTs };
    }
    return { provider: 'stackoverflow', ok: false, reason: classifyErrorReason(err), latencyMs: Date.now() - startTs };
  } finally {
    cleanup();
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

const PROVIDERS = [
  // Wikipedia first — it covers the broadest implicit definition shape; the
  // others below are explicit-site-named providers so they only fire when
  // the user has clearly stated which corpus they want.  Order within the
  // explicit-named group is by expected hit volume (HN gets the most
  // organic mentions in tech queries, etc).
  { name: 'wikipedia', matchKind: wikipediaMatchKind, fetch: fetchFromWikipedia },
  { name: 'hackernews', matchKind: hnMatchKind, fetch: fetchFromHN },
  { name: 'arxiv', matchKind: arxivMatchKind, fetch: fetchFromArxiv },
  { name: 'github', matchKind: githubMatchKind, fetch: fetchFromGitHub },
  { name: 'stackoverflow', matchKind: stackOverflowMatchKind, fetch: fetchFromStackOverflow },
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
  cleanHnQuery,
  cleanArxivQuery,
  cleanGithubQuery,
  cleanStackOverflowQuery,
};
