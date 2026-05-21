/**
 * web_search tool
 *
 * Search provider priority:
 *   1. Playwright + Google  — real browser, most stable, no API keys
 *   2. DuckDuckGo via Jina  — fallback when Playwright unavailable
 *
 * Content enrichment:
 *   Playwright CLI fetches actual page content from top results.
 *   Jina Reader as fallback.
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getMeloHome } from '../../config.js';
// CLAUDE.md §6 fix (2026-05-21 audit finding #1): AsyncLocalStorage carries
// a "captured home" context across the SWR microtask boundary so cache
// helpers resolve to the home that was active when the refresh was
// SCHEDULED, not whatever home process.env carries when the microtask
// finally executes.  Without this the historical 7d-5α-A1 4-layer bug
// pattern reopens: any future feature that flips MELO_HOME mid-runtime
// (multi-profile, worker pool, telegram polling switching chats) would
// silently write home-A's SWR refresh into home-B's search.sqlite.
// Production callers leave the context empty → resolveCacheHome() returns
// getMeloHome() exactly as before, so existing tests + behavior unchanged.
import { AsyncLocalStorage } from 'node:async_hooks';
const _homeCaptureContext = new AsyncLocalStorage();
import { debugWarn } from '../../debug.js';
import { wrapWithTrailLog } from '../../services/search/trailLogger.js';
import { tryApiDirect } from '../../services/search/apiDirect.js';

// ─── Phase G-1c (2026-05-10): evidenceTrail collection for web_search ────
//
// Same contract + vocabulary as fetchUrlTool / socialLinkTool (see
// docs/search-system-roadmap.md §#1).  webSearchTool's run() is a phase
// chain (not a fallback chain like fetchUrl, not a strategy chain like
// socialLink) — phases run in order, each independent of others, and the
// trail records what each phase did.  Phase vocabulary:
//
//   • validate           — query empty / wrong type
//   • weather-fast-path  — wttr.in shortcut (only when query matches WEATHER_KEYWORDS)
//   • cache              — fresh hit / stale (SWR) hit / miss
//   • serp               — Playwright + DDG/Jina race result
//   • synonym-retry      — additional SERP attempts when first is thin
//   • content-fetch      — Jina/Playwright bulk content read
//   • semantic-rerank    — best-effort embedding rerank
//
// The G-1b 3-layer abort contract is enforced uniformly (lessons from
// the 4-commit G-1b chain we don't want to repeat):
//   1. before await: if (signal?.aborted) → bailAbortedWebSearch
//   2. after await: if (signal?.aborted) → bailAbortedWebSearch
//   3. catch with abort: if (signal?.aborted || err.name === 'AbortError')
//      → bailAbortedWebSearch
//
// abort-mid-loop semantics: current phase records `fail aborted-mid-loop`,
// all subsequent (untried) phases record `skip aborted-by-prev-phase`.
const WS_PHASE_ORDER = ['weather-fast-path', 'cache', 'api-direct', 'serp', 'synonym-retry', 'content-fetch', 'semantic-rerank'];

function recordWebSearchTrail(trail, phase, outcome, opts = {}) {
  if (!Array.isArray(trail)) return;
  const entry = { tier: phase, outcome, latencyMs: Math.max(0, Number(opts.latencyMs) || 0) };
  if (opts.reason) entry.reason = opts.reason;
  if (opts.method) entry.method = opts.method;
  // `extra` (not `metadata`) — same convention as fetchUrlTool/socialLinkTool.
  if (opts.extra && Object.keys(opts.extra).length) entry.extra = opts.extra;
  trail.push(entry);
}

function bailAbortedWebSearch(trail, currentPhase, query, ctx = {}) {
  recordWebSearchTrail(trail, currentPhase, 'fail', { reason: 'aborted-mid-loop' });
  const idx = WS_PHASE_ORDER.indexOf(currentPhase);
  if (idx >= 0) {
    for (const p of WS_PHASE_ORDER.slice(idx + 1)) {
      recordWebSearchTrail(trail, p, 'skip', { reason: 'aborted-by-prev-phase' });
    }
  }
  // Backward compat: keep error='SEARCH_FAILED' so existing callers that
  // branch on error code (and tests that pin it) don't change behavior.
  // The new `aborted: true` flag + evidenceTrail.tier='*-mid-loop' lets
  // newer code distinguish abort from generic search failure.
  // meta.intent/spanId/timings stay present (existing tests pin them on
  // the fail path); ctx threads them in from run() so the helper stays
  // stateless.
  return {
    ok: false,
    output: `Web search aborted for "${query}".`,
    error: 'SEARCH_FAILED',
    aborted: true,
    meta: {
      query,
      timings: { totalMs: 0, serpMs: 0, contentMs: 0, cacheHit: false, weatherFastPath: false },
      ...(ctx.intent ? { intent: ctx.intent } : {}),
      ...(ctx.spanId !== undefined ? { spanId: ctx.spanId } : {}),
    },
    evidenceTrail: trail,
  };
}

// G-1c follow-up #3 (Codex C round-3 闭环 2026-05-10): unified abort race
// helper.  Wraps any in-flight promise (PW CLI probe, PW SERP, PW
// content-fetch) so a caller signal abort wins immediately instead of
// waiting for the underlying PW process to finish (5-15s typical).
//
// Real PW CLI subprocess kill is still G-5 — this helper only ensures
// the JS-side `await` returns immediately and the run() outer can bail.
// The PW child process keeps running until natural completion; the user
// just doesn't wait for it.
function abortRace(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    let listener;
    const cleanup = () => {
      if (listener) {
        try { signal.removeEventListener('abort', listener); } catch {}
        listener = null;
      }
    };
    listener = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', listener, { once: true });
    promise.then(
      v => { cleanup(); resolve(v); },
      e => { cleanup(); reject(e); },
    );
  });
}

function classifyWebSearchError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (!msg) return 'error';
  if (msg.includes('abort')) return 'aborted';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('socket') || msg.includes('econnreset') || msg.includes('econnrefused')) return 'network';
  if (msg.includes('certificate') || msg.includes('ssl')) return 'tls';
  if (/\b4\d\d\b/.test(msg)) return '4xx';
  if (/\b5\d\d\b/.test(msg)) return '5xx';
  if (msg.includes('parse') || msg.includes('json')) return 'parse-error';
  return 'error';
}
import { createPlaywrightSession, cleanPageText } from '../../web/playwrightFetcher.js';
import { withMeloChrome } from '../../services/browser/connect.js';
import { hostMatchesAnySuffix, SOCIAL_HOST_SUFFIXES } from './socialLinkTool.js';
import { tokenizeQuery, normalizeSearchValue } from '../../search/tokenizer.js';
import { getEmbedding, EMBEDDING_DIMS } from '../../memory/embeddings.js';

const JINA_READER_BASE = 'https://r.jina.ai/';
const MAX_RESULTS = 8;
const FETCH_TIMEOUT_MS = 25_000;

const CONTENT_FETCH_TIMEOUT_MS = 14_000;
const CONTENT_MAX_CHARS = 6_000;
const CONTENT_FETCH_COUNT = 4;

// Base TTLs.  Intent classifier (classifyQueryIntent) may override these per
// query — a weather/breaking-news query gets the short TTL so we don't serve
// a two-hour-old forecast.  Use ms, not seconds.
const SEARCH_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const SEARCH_CACHE_TTL_TIME_SENSITIVE_MS = 15 * 60 * 1000;
const URL_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

// P2-1 — how stale a row can be before we still return it and refresh in the
// background.  Beyond this, we fetch fresh synchronously like the old path.
const SWR_MAX_STALE_MS = 24 * 60 * 60 * 1000;

// P1-2 — synonym / alias expansion.  Every entry is a cluster of equivalents.
// tokenizeQuery splits CJK into single graphemes and English into word tokens,
// so keys here are kept in the same shape.  Retry is only triggered when the
// primary SERP yields < SYNONYM_RETRY_THRESHOLD results to keep the happy
// path a single round-trip.
const SYNONYM_RETRY_THRESHOLD = 3;
const SYNONYM_CLUSTERS = [
  ['node', 'node.js', 'nodejs'],
  ['k8s', 'kubernetes'],
  ['ts', 'typescript'],
  ['llm', 'large language model', 'foundation model', '大模型'],
  ['lts', 'long term support', '长期支持'],
  ['ai', '人工智能', 'artificial intelligence'],
  ['rag', 'retrieval augmented generation', '检索增强生成'],
  ['ml', 'machine learning', '机器学习'],
  ['api', '接口'],
  ['doc', 'docs', 'documentation', '文档'],
];

// Pre-compute a token → cluster index so expansion is O(tokens).
const _SYNONYM_INDEX = (() => {
  const map = new Map();
  SYNONYM_CLUSTERS.forEach((cluster, idx) => {
    for (const term of cluster) {
      map.set(String(term).toLowerCase(), idx);
    }
  });
  return map;
})();

// P0-3 — intent signals.  Keep the keyword sets small and obviously
// time-sensitive; a false negative here just costs us 2h of cache, a false
// positive burns extra Jina calls.  CJK and English co-exist on purpose.
const TIME_SENSITIVE_KEYWORDS = [
  // Chinese: "now / current / today / latest / just now / breaking"
  '现在', '目前', '今天', '今日', '今晚', '最新', '最近', '刚刚', '实时', '当前', '本周', '本月', '近期',
  // English
  'now', 'current', 'currently', 'today', 'tonight', 'latest', 'live', 'breaking', 'just now',
  'this week', 'this month', 'real-time', 'realtime', 'recent', 'recently',
];
const TIME_SENSITIVE_RE = new RegExp(
  '(?:' +
    TIME_SENSITIVE_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
  ')',
  'i',
);

// Heuristic intent buckets — used only for metadata and debug logging today,
// but stored on the cache row so future TTL rules can branch per-kind.
const INTENT_PATTERNS = [
  { kind: 'weather',  re: /(?:天气|气温|温度|weather|forecast|下雨|下雪|rain|snow|humid)/i },
  { kind: 'price',    re: /(?:价格|报价|多少钱|股价|price|stock|quote|exchange rate|汇率)/i },
  { kind: 'news',     re: /(?:新闻|快讯|头条|突发|news|breaking|announce)/i },
  { kind: 'schedule', re: /(?:日程|赛程|比赛时间|schedule|when is|几点开始)/i },
  { kind: 'docs',     re: /(?:文档|api|reference|docs?\b|manual|guide)/i },
];

function classifyQueryIntent(rawQuery) {
  const query = String(rawQuery || '').trim();
  const lower = query.toLowerCase();
  const timeSensitive = TIME_SENSITIVE_RE.test(lower);
  let kind = 'general';
  for (const { kind: k, re } of INTENT_PATTERNS) {
    if (re.test(lower)) { kind = k; break; }
  }
  // News, weather, and price are intrinsically time-sensitive even without
  // an explicit keyword — override.
  const intrinsicallyFresh = new Set(['weather', 'price', 'news']);
  const effectiveTimeSensitive = timeSensitive || intrinsicallyFresh.has(kind);
  return { kind, timeSensitive: effectiveTimeSensitive };
}

// ─── Debug log (P2-3) ────────────────────────────────────────────────────────
//
// Fire-and-forget append to $MELO_HOME/desktop/web-search-debug.log, rotated
// at 256 KiB.  Same shape as telegram-debug.log so a single tail pattern
// covers both.  Never throws — observability must never be on the hot path.

// G-6 #3 (audit 2026-05-11): module-load `const WEB_SEARCH_DEBUG_LOG_PATH = join(getMeloHome(),…)`
// + fire-and-forget IIFE reading the const = textbook CLAUDE.md §6 violation
// (the canonical example in §6's "background prime task in microtask"
// anti-pattern).  Fix per §6 doctrine: **capture at scheduling time**
// (function entry), not lazy-resolve globally — pass logPath into the
// IIFE via closure so it's bound to whatever home was current when the
// caller fired the log line, not whatever home is current when the
// microtask happens to run.  Per-path dir-ready map replaces the single
// `_webSearchDebugDirReady` flag so a home-flip doesn't reuse a "ready"
// signal from the previous home's directory.
const WEB_SEARCH_DEBUG_LOG_MAX_BYTES = 256 * 1024;
const _webSearchDebugDirReady = new Map(); // logPath → true once mkdir succeeded
const _backgroundRefreshInFlight = new Set();

function webSearchDebugLogPath() {
  // §6 闭环: same captured-home context as cacheDbPath() — when a SWR
  // refresh debug-logs, it writes to the captured home's log, not the
  // current home's.
  return join(_homeCaptureContext.getStore() ?? getMeloHome(), 'desktop', 'web-search-debug.log');
}

async function _ensureWebSearchDebugDir(logPath) {
  if (_webSearchDebugDirReady.get(logPath)) return;
  try {
    await mkdir(dirname(logPath), { recursive: true });
    _webSearchDebugDirReady.set(logPath, true);
  } catch {
    // Directory creation failure is non-fatal — logging just gets skipped.
  }
}

function writeWebSearchDebugLine(line) {
  // CLAUDE.md §6: capture at scheduling time, before the await boundary.
  // If MELO_HOME flips between this line and the IIFE resolving, the log
  // still goes where the caller intended (the home that was current at
  // the call site).
  const logPath = webSearchDebugLogPath();
  const stamp = new Date().toISOString();
  const payload = `[${stamp}] pid=${process.pid} ${String(line || '').trim()}\n`;
  // Fire-and-forget.  Chain the entire pipeline so one promise surfaces any
  // error via debugWarn, but the caller never waits.
  (async () => {
    try {
      await _ensureWebSearchDebugDir(logPath);
      try {
        const st = await stat(logPath).catch(() => null);
        if (st && st.size > WEB_SEARCH_DEBUG_LOG_MAX_BYTES) {
          // Simple truncate-on-overflow — better than renaming files inside
          // a tool call that should never block.
          await appendFile(logPath, '').catch(() => {});
          const { writeFile } = await import('node:fs/promises');
          await writeFile(logPath, '', 'utf8').catch(() => {});
        }
      } catch {
        // stat failures just skip the rotation attempt — append will create.
      }
      await appendFile(logPath, payload, 'utf8');
    } catch (err) {
      debugWarn('web_search.debug', 'writeWebSearchDebugLine failed', err?.message || err);
    }
  })();
}

let _webSearchSpanCounter = 0;
function nextWebSearchSpanId() {
  _webSearchSpanCounter = (_webSearchSpanCounter + 1) % 1_000_000;
  return `${process.pid}-${_webSearchSpanCounter}`;
}

// Jina early-exit tuning: return as soon as we have N successful content
// pulls OR the hard deadline trips. Most queries only need 2-3 good pages,
// and holding everyone hostage to the slowest Jina response burns p95.
const JINA_SUCCESS_THRESHOLD = 3;
const JINA_HARD_DEADLINE_MS = 7_000;

// Playwright content-fallback is strictly serial (single pw lock). Each
// hop adds ~3-6s, so we only spend the budget on the single most promising
// URL Jina couldn't parse.
const PW_FALLBACK_MAX = 1;

// Staggered SERP race: start Playwright immediately; if it hasn't come back
// within STAGGER_MS, also kick off the Jina/DDG leg. First fulfilled wins.
const SERP_STAGGER_MS = 2_000;

// web_search runs on its own named session so the SERP browser state
// (Google consent dialogs, search history, etc.) is isolated from the
// fetch_url session. `createPlaywrightSession` gives each session its
// own mutex chain and availability cache.
const pwSession = createPlaywrightSession({
  sessionName: 'melo-search',
  defaultTimeoutMs: CONTENT_FETCH_TIMEOUT_MS,
  defaultMaxChars: CONTENT_MAX_CHARS,
  debugScope: 'web_search',
});
const {
  runCli: runPlaywrightCli,
  withLock: withPwLock,
  isAvailable: isPlaywrightCliAvailable,
  navigate: pwNavigate,
} = pwSession;

// ─── Low-quality / bounce-prone domain blocklist ────────────────────────────
//
// Rationale: these domains either aggressively block bots (returning a login
// wall or CAPTCHA), produce low-quality SEO listicles, or have content that's
// intentionally gated behind auth/JS challenges that even Playwright can't
// reliably read in ≤14s. Skipping them here keeps `web_search` fast.
//
// NOTE: this blocklist applies ONLY to `web_search` (the agent actively
// searching). If the user PASTES a link to e.g. TikTok / Xiaohongshu, the
// `fetch_url` tool and the video-platform extractor (`extractYoutubeContent`)
// still handle it — those paths go through yt-dlp metadata + optional per-
// domain cookies, which is a fundamentally different code path.
const BLOCKED_CONTENT_DOMAINS = new Set([
  'pinterest.com', 'pinterest.co.uk',
  'quora.com',
  'facebook.com', 'fb.com',
  'instagram.com',
  'twitter.com', 'x.com',
  'tiktok.com',
  // CN social platforms — same anti-bot shape as TikTok above. Heavy
  // login walls, JS-only shells. web_search content fetchers waste
  // their 14s budget on these and always return empty/garbage. Phase 6
  // (this commit) routes pasted links through socialLinkTool (yt-dlp
  // + domain cookies + short-link resolve + OpenGraph fallback) — the
  // ONLY path that actually returns metadata. Search result CARDS still
  // appear (link discovery is fine); only the body fetch is skipped.
  'douyin.com', 'v.douyin.com', 'iesdouyin.com',
  'xiaohongshu.com', 'xhslink.com',
  'linkedin.com',
  'amazon.com', 'amazon.co.jp', 'amazon.co.uk',
  'ebay.com',
  'aliexpress.com',
  'yelp.com',
  'tripadvisor.com',
  'about.com',
  'ehow.com',
  'wikihow.com',
  'fandom.com',
]);

// Playwright CLI helpers now come from playwrightFetcher.js (`pwSession`
// above). Keeping the names `runPlaywrightCli` / `withPwLock` / `pwNavigate`
// / `isPlaywrightCliAvailable` in scope below for minimal-diff call sites.

// ─── Google search via Playwright ───────────────────────────────────────────

async function searchViaPlaywright(query, numResults) {
  return withPwLock(async () => {
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${Math.min(numResults + 2, 15)}&hl=zh-CN`;
    await pwNavigate(googleUrl, FETCH_TIMEOUT_MS);

    // Extract search results from Google SERP
    const extractScript = `(() => {
      const results = [];
      // Standard organic results
      document.querySelectorAll('div.g, div[data-hveid]').forEach(el => {
        const a = el.querySelector('a[href^="http"]');
        const h3 = el.querySelector('h3');
        if (!a || !h3) return;
        const url = a.href;
        if (!url || url.includes('google.com/search') || url.includes('accounts.google')) return;
        const title = h3.innerText?.trim();
        if (!title || title.length < 3) return;
        // Snippet: look for common snippet containers
        const snippetEl = el.querySelector('[data-sncf], .VwiC3b, [style*="-webkit-line-clamp"], .IsZvec');
        const snippet = (snippetEl?.innerText || '').trim().slice(0, 500);
        if (!results.some(r => r.url === url)) {
          results.push({ title, url, snippet });
        }
      });
      return JSON.stringify(results);
    })()`;

    const raw = await runPlaywrightCli(['eval', extractScript], FETCH_TIMEOUT_MS);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err1) {
      try {
        parsed = JSON.parse(JSON.parse(raw));
      } catch (err2) {
        debugWarn('web_search', `SERP extract JSON parse failed for query="${query}":`, err2?.message || err2);
        parsed = [];
      }
    }
    return Array.isArray(parsed) ? parsed.slice(0, numResults) : [];
  });
}

// ─── DuckDuckGo via Jina Reader (fallback) ──────────────────────────────────

function decodeDdgUrl(ddgRedirectUrl) {
  try {
    const match = ddgRedirectUrl.match(/[?&]uddg=([^&]+)/);
    if (!match) return ddgRedirectUrl;
    const decoded = decodeURIComponent(match[1]);
    if (decoded.startsWith('http')) return decoded;
  } catch (error) {
    debugWarn('web_search', `DDG URL decode failed for ${ddgRedirectUrl}:`, error?.message || error);
  }
  return ddgRedirectUrl;
}

async function searchViaDdg(query, numResults, signal) {
  const ddgUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const jinaUrl = `${JINA_READER_BASE}${ddgUrl}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;

  try {
    const res = await fetch(jinaUrl, {
      signal: combined,
      headers: { 'X-Return-Format': 'markdown' },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Jina/DDG returned ${res.status}`);
    const text = await res.text();
    return parseDdgMarkdown(text, numResults);
  } finally {
    clearTimeout(timer);
  }
}

function parseDdgMarkdown(text, limit) {
  const results = [];
  const blockRegex = /^\d+\.\s*\[([^\]]+)\]\((https?:\/\/[^)]+)\)\s*\n([\s\S]*?)(?=\n\d+\.\s*\[|$)/gm;
  let match;

  while ((match = blockRegex.exec(text)) !== null && results.length < limit) {
    const title = match[1].trim();
    const rawUrl = match[2].trim();
    const body = match[3].trim();

    if (title.length < 3) continue;

    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    const snippet = lines.slice(0, -1).join(' ').replace(/\[.*?\]\(.*?\)/g, '').trim().slice(0, 500);

    const url = rawUrl.includes('duckduckgo.com/l/') ? decodeDdgUrl(rawUrl) : rawUrl;
    if (!url.startsWith('http') || url.includes('duckduckgo.com')) continue;

    results.push({ title, url, snippet });
  }

  return results;
}

// ─── Web search cache (SQLite) ───────────────────────────────────────────────

// G-2 follow-up #2 (audit 2026-05-11): cacheDbPath() was previously a
// module-load-time `const join(getMeloHome(), ...)` — same CLAUDE.md §6
// violation pattern as the dreaming diary DREAMS_DIR (fixed in G-1
// 60e828d).  Per-test MELO_HOME = mkdtemp() couldn't take effect because
// the path was frozen at the first import.  Now resolved at call time
// + cache db handle closes & reopens when the resolved path changes,
// so a test (or future multi-profile runtime) that switches MELO_HOME
// gets a fresh handle pointing at the right file.
//
// Other 8 module-load-time getMeloHome() sites identified in the audit
// (see docs/search-system-roadmap.md G-6 backlog) follow the same
// pattern; they're queued for a single systematic refactor in G-6
// rather than scattered patches here.
/**
 * Resolve the home directory for cache writes.  When inside a
 * _homeCaptureContext.run(home, ...) block (currently only the SWR
 * background refresh microtask), returns the captured home.  Otherwise
 * falls back to getMeloHome() — same behavior as before for every
 * synchronous / first-await caller.
 *
 * CLAUDE.md §6 闭环 (2026-05-21 audit finding #1).
 */
function resolveCacheHome() {
  return _homeCaptureContext.getStore() ?? getMeloHome();
}

function cacheDbPath() {
  return join(resolveCacheHome(), 'desktop', 'search.sqlite');
}

let _cacheDb = null;
let _openedCachePath = null;

/** @internal test hook — close the cached handle so the next call
 *  re-opens at the current MELO_HOME path.  Tests using mkdtemp+
 *  MELO_HOME isolation should call this in beforeEach/afterEach. */
export function _resetWebSearchCacheForTests() {
  if (_cacheDb) {
    try { _cacheDb.close(); } catch {}
  }
  _cacheDb = null;
  _openedCachePath = null;
}

function getCacheDb() {
  const path = cacheDbPath();
  if (_cacheDb && _openedCachePath === path) return _cacheDb;
  // Path changed (test switched MELO_HOME) — close old handle, open new.
  if (_cacheDb) {
    try { _cacheDb.close(); } catch {}
    _cacheDb = null;
  }
  mkdirSync(dirname(path), { recursive: true });
  _cacheDb = new DatabaseSync(path);
  _openedCachePath = path;
  _cacheDb.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS web_search_cache (
      query_norm  TEXT PRIMARY KEY,
      query_raw   TEXT NOT NULL,
      provider    TEXT NOT NULL,
      results     TEXT NOT NULL,
      content_map TEXT NOT NULL DEFAULT '{}',
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS url_content_cache (
      url         TEXT PRIMARY KEY,
      content     TEXT NOT NULL,
      fetched_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_url_cache_fetched_at ON url_content_cache(fetched_at);
  `);
  // Migrations for P0-1 / P0-3 / P0-4.  ALTER TABLE ADD COLUMN is a no-op on
  // a fresh table (the CREATE above doesn't list these), so we guard with
  // try/catch and the existing "duplicate column" error just gets eaten.
  const addColumn = (table, column, ddl) => {
    try {
      _cacheDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    } catch (err) {
      const msg = String(err?.message || '');
      if (!/duplicate column/i.test(msg)) {
        debugWarn('web_search.schema', `${table}.${column} migration skipped`, msg);
      }
    }
  };
  addColumn('url_content_cache', 'etag',         'TEXT');
  addColumn('url_content_cache', 'last_modified','TEXT');
  addColumn('url_content_cache', 'content_hash', 'TEXT');
  addColumn('web_search_cache',  'intent_kind',  "TEXT NOT NULL DEFAULT 'general'");
  addColumn('web_search_cache',  'time_sensitive','INTEGER NOT NULL DEFAULT 0');
  try {
    _cacheDb.exec(
      'CREATE INDEX IF NOT EXISTS idx_url_cache_content_hash ON url_content_cache(content_hash)',
    );
  } catch (err) {
    debugWarn('web_search.schema', 'content_hash index skipped', err?.message || err);
  }
  return _cacheDb;
}

// ─── URL-level content cache (hit before Jina/PW) ───────────────────────────
// Common pattern: user searches "node 22 release", then "node 22 LTS date".
// Both queries surface overlapping URLs. Caching per-URL content (not
// per-query) lets the second search reuse what the first one fetched.

/**
 * Read a fresh (within TTL) URL cache row.  Returns the full validator
 * bundle — callers that only want the content can ignore the extras.
 */
function getCachedUrlContent(url) {
  try {
    const db = getCacheDb();
    const row = db.prepare(
      'SELECT content, etag, last_modified, content_hash, fetched_at FROM url_content_cache WHERE url = ? AND fetched_at > ?',
    ).get(url, Date.now() - URL_CACHE_TTL_MS);
    if (!row) return null;
    return {
      content: row.content,
      etag: row.etag || null,
      lastModified: row.last_modified || null,
      contentHash: row.content_hash || null,
      fetchedAt: Number(row.fetched_at),
    };
  } catch (error) {
    debugWarn('web_search', `url-cache read failed for ${url}:`, error?.message || error);
    return null;
  }
}

/**
 * Read a stale (TTL-expired) row if present.  Used by:
 *   - P0-4 conditional GET: reuse ETag / Last-Modified validators on expired rows.
 *   - P0-1 dedup: check prior content_hash to skip a duplicate from another URL.
 */
function getStaleUrlContent(url) {
  try {
    const db = getCacheDb();
    const row = db.prepare(
      'SELECT content, etag, last_modified, content_hash, fetched_at FROM url_content_cache WHERE url = ?',
    ).get(url);
    if (!row) return null;
    return {
      content: row.content,
      etag: row.etag || null,
      lastModified: row.last_modified || null,
      contentHash: row.content_hash || null,
      fetchedAt: Number(row.fetched_at),
    };
  } catch (error) {
    debugWarn('web_search', `url-cache stale read failed for ${url}:`, error?.message || error);
    return null;
  }
}

function setCachedUrlContent(url, content, { etag = null, lastModified = null, contentHash = null } = {}) {
  if (!content || content.length < 100) return;
  try {
    const db = getCacheDb();
    const hash = contentHash || sha1Short(content);
    db.prepare(`
      INSERT OR REPLACE INTO url_content_cache
        (url, content, fetched_at, etag, last_modified, content_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(url, content, Date.now(), etag, lastModified, hash);
  } catch (error) {
    debugWarn('web_search', `url-cache write failed for ${url}:`, error?.message || error);
  }
}

function touchUrlFetchTime(url) {
  try {
    const db = getCacheDb();
    db.prepare('UPDATE url_content_cache SET fetched_at = ? WHERE url = ?')
      .run(Date.now(), url);
  } catch (error) {
    debugWarn('web_search', `url-cache touch failed for ${url}:`, error?.message || error);
  }
}

// ─── URL canonicalisation (P0-1) ────────────────────────────────────────────
// Strip tracking params + normalise `m.` / `www.` / trailing-slash / fragment
// so `example.com/a?utm=x` and `m.example.com/a/` collapse to one cache key.

const _TRACKING_PARAM_RE = /^(?:utm_|gclid$|fbclid$|mc_[ce]id$|msclkid$|_ga$|ref$|ref_src$|from$|spm$)/i;

function canonicalizeUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    // Normalise host: drop leading "m." / "www." / "amp." / "mobile." subdomains.
    u.hostname = u.hostname
      .replace(/^m\./, '')
      .replace(/^www\./, '')
      .replace(/^amp\./, '')
      .replace(/^mobile\./, '')
      .toLowerCase();
    // Drop tracking params.
    const kept = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (!_TRACKING_PARAM_RE.test(k)) kept.push([k, v]);
    }
    kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    u.search = kept.length
      ? '?' + kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      : '';
    u.hash = '';
    // Trailing-slash normalisation (but keep bare-host "/").
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    return u.toString();
  } catch {
    return String(rawUrl || '');
  }
}

function sha1Short(text) {
  return createHash('sha1').update(String(text || ''), 'utf8').digest('hex').slice(0, 16);
}

function titleFingerprint(title) {
  return sha1Short(
    String(title || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim(),
  );
}

// ─── Query normalisation (P0-3) ─────────────────────────────────────────────
//
// The prior normaliser was `q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')`,
// which discards CJK order information and produces different keys for
// "Node.js LTS" vs "node js lts".  We now route through tokenizeQuery so
// that both queries collapse to the same sorted token-set key.
//
// Cache keys also embed the intent kind so a time-sensitive "weather in
// Tokyo" never shares a row with the same string asked as a cooking query.

function normalizeQuery(q) {
  const { tokens, graphemes } = tokenizeQuery(q);
  const combined = [...tokens, ...graphemes]
    .map(t => String(t).toLowerCase())
    .filter(Boolean);
  // Sort so word-order variations don't miss the cache.  For intent
  // detection we keep the raw query separately (see classifyQueryIntent).
  combined.sort();
  const deduped = [];
  let last = null;
  for (const t of combined) {
    if (t !== last) deduped.push(t);
    last = t;
  }
  const normalized = deduped.join(' ').trim();
  return normalized || normalizeSearchValue(q);
}

function buildCacheKey(query, intent) {
  const base = normalizeQuery(query);
  const kind = intent?.kind || 'general';
  const fresh = intent?.timeSensitive ? 'T' : 'S';
  return `${kind}|${fresh}|${base}`;
}

function ttlForIntent(intent) {
  if (intent?.timeSensitive) return SEARCH_CACHE_TTL_TIME_SENSITIVE_MS;
  return SEARCH_CACHE_TTL_MS;
}

/**
 * Read a fresh (within intent-TTL) row.  `intent` is computed by the caller
 * and threaded through so we don't re-run the regex here.
 */
function getCachedSearch(query, intent) {
  try {
    const db = getCacheDb();
    const key = buildCacheKey(query, intent);
    const row = db.prepare(
      'SELECT * FROM web_search_cache WHERE query_norm = ? AND created_at > ?',
    ).get(key, Date.now() - ttlForIntent(intent));
    if (!row) return null;
    return {
      provider: row.provider + ' (cached)',
      results: JSON.parse(row.results),
      contentMap: new Map(Object.entries(JSON.parse(row.content_map))),
      createdAt: Number(row.created_at),
      intentKind: row.intent_kind || intent?.kind || 'general',
      fresh: true,
    };
  } catch (error) {
    debugWarn('web_search', `cache read failed for "${query}":`, error?.message || error);
    return null;
  }
}

/**
 * P2-1 — stale-while-revalidate lookup.  Returns rows that are past the
 * fresh TTL but still within SWR_MAX_STALE_MS, so the caller can show them
 * immediately while a background refresh updates the row.
 */
function getStaleCachedSearch(query, intent) {
  try {
    const db = getCacheDb();
    const key = buildCacheKey(query, intent);
    const now = Date.now();
    const freshCutoff = now - ttlForIntent(intent);
    const staleCutoff = now - SWR_MAX_STALE_MS;
    const row = db.prepare(
      'SELECT * FROM web_search_cache WHERE query_norm = ? AND created_at <= ? AND created_at > ?',
    ).get(key, freshCutoff, staleCutoff);
    if (!row) return null;
    return {
      provider: row.provider + ' (stale)',
      results: JSON.parse(row.results),
      contentMap: new Map(Object.entries(JSON.parse(row.content_map))),
      createdAt: Number(row.created_at),
      intentKind: row.intent_kind || intent?.kind || 'general',
      fresh: false,
    };
  } catch (error) {
    debugWarn('web_search', `stale cache read failed for "${query}":`, error?.message || error);
    return null;
  }
}

function setCachedSearch(query, provider, results, contentMap, intent) {
  try {
    const db = getCacheDb();
    const contentObj = Object.fromEntries(contentMap.entries());
    const key = buildCacheKey(query, intent);
    db.prepare(`
      INSERT OR REPLACE INTO web_search_cache
        (query_norm, query_raw, provider, results, content_map, created_at, intent_kind, time_sensitive)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      key,
      query,
      provider,
      JSON.stringify(results),
      JSON.stringify(contentObj),
      Date.now(),
      intent?.kind || 'general',
      intent?.timeSensitive ? 1 : 0,
    );
  } catch (error) {
    debugWarn('web_search', `cache write failed for "${query}":`, error?.message || error);
  }
}

// ─── Smart content selection ─────────────────────────────────────────────────

// P0-2 — rough article-date extraction from SERP snippets / URLs.  Returns
// an epoch-ms timestamp or null.  Intentionally conservative — a false
// positive here tips the rank unfairly.
const _DATE_RE_ISO = /\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/;
const _DATE_RE_SLASH_US = /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\b/;
const _DATE_RE_YM = /\b(20\d{2})[-/]?(0?[1-9]|1[0-2])\b/;
const _DATE_RE_YEAR_CN = /\b(20\d{2})\s*年\s*(0?[1-9]|1[0-2])\s*月(?:\s*(0?[1-9]|[12]\d|3[01])\s*日)?/;
const _DATE_RE_YEAR_ONLY = /\b(20\d{2})\b/;
// "3 days ago" / "7 小时前" — relative references are common in SERPs.
const _DATE_RE_REL_EN = /\b(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago\b/i;
const _DATE_RE_REL_CN = /(\d+)\s*(分钟|小时|天|周|月|年)前/;

function extractArticleDate(text, url = '', nowMs = Date.now()) {
  const hay = `${text || ''} ${url || ''}`;
  let m;
  if ((m = _DATE_RE_ISO.exec(hay))) {
    const t = Date.parse(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T00:00:00Z`);
    if (Number.isFinite(t)) return t;
  }
  if ((m = _DATE_RE_SLASH_US.exec(hay))) {
    const t = Date.parse(`${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}T00:00:00Z`);
    if (Number.isFinite(t)) return t;
  }
  if ((m = _DATE_RE_YEAR_CN.exec(hay))) {
    const day = m[3] ? m[3].padStart(2, '0') : '01';
    const t = Date.parse(`${m[1]}-${m[2].padStart(2, '0')}-${day}T00:00:00Z`);
    if (Number.isFinite(t)) return t;
  }
  if ((m = _DATE_RE_REL_EN.exec(hay))) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = {
      minute: 60_000, hour: 3_600_000, day: 86_400_000,
      week:   7 * 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000,
    }[unit] || 0;
    if (ms) return nowMs - n * ms;
  }
  if ((m = _DATE_RE_REL_CN.exec(hay))) {
    const n = Number(m[1]);
    const ms = {
      '分钟': 60_000, '小时': 3_600_000, '天': 86_400_000,
      '周':  7 * 86_400_000, '月': 30 * 86_400_000, '年': 365 * 86_400_000,
    }[m[2]] || 0;
    if (ms) return nowMs - n * ms;
  }
  if ((m = _DATE_RE_YM.exec(hay))) {
    const t = Date.parse(`${m[1]}-${m[2].padStart(2, '0')}-01T00:00:00Z`);
    if (Number.isFinite(t)) return t;
  }
  if ((m = _DATE_RE_YEAR_ONLY.exec(hay))) {
    // Bare year → Jan 1 of that year.  Low-confidence signal.
    const t = Date.parse(`${m[1]}-01-01T00:00:00Z`);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * Recency boost — only applied when the query is time-sensitive.
 *   <  7 days old  → +0.40
 *   < 30 days old  → +0.20
 *   < 180 days old → +0.05
 *   >= 1 year old  → -0.15 (penalty — "latest X" should never surface a 3-year-old post)
 */
function recencyBoost(dateMs, nowMs = Date.now()) {
  if (!Number.isFinite(dateMs)) return 0;
  const ageDays = Math.max(0, (nowMs - dateMs) / 86_400_000);
  if (ageDays < 7)   return 0.40;
  if (ageDays < 30)  return 0.20;
  if (ageDays < 180) return 0.05;
  if (ageDays >= 365) return -0.15;
  return 0;
}

function scoreResultRelevance(result, queryTokens, { timeSensitive = false, nowMs = Date.now() } = {}) {
  const text = `${result.title} ${result.snippet}`.toLowerCase();
  let hits = 0;
  for (const w of queryTokens) {
    if (!w) continue;
    if (text.includes(w)) hits++;
  }
  const base = hits / Math.max(queryTokens.length, 1);
  if (!timeSensitive) return base;
  const dateMs = extractArticleDate(`${result.title} ${result.snippet}`, result.url, nowMs);
  return base + recencyBoost(dateMs, nowMs);
}

// ─── Query-biased snippet extraction (P2-2) ─────────────────────────────────
//
// Pick the best sentence-window from fetched page content, where "best" =
// the window containing the most query tokens.  CJK-aware sentence split so
// Chinese content doesn't collapse to a single 6000-char run.  Pure local
// computation — no LLM round-trip.

const _SENTENCE_SPLIT_RE = /(?<=[。！？!?\.\n])\s+|(?<=[。！？])/u;

function queryBiasedSnippet(content, queryTokens, maxChars = 320) {
  if (!content) return '';
  if (!queryTokens || !queryTokens.length) return String(content).slice(0, maxChars);
  const text = String(content);
  const sentences = text
    .split(_SENTENCE_SPLIT_RE)
    .map(s => s.trim())
    .filter(s => s && s.length >= 10);
  if (!sentences.length) return text.slice(0, maxChars);
  // Sliding window of up to 3 sentences; pick the window with the most query hits.
  let best = { start: 0, end: 0, hits: -1 };
  for (let i = 0; i < sentences.length; i++) {
    for (let j = i; j < Math.min(i + 3, sentences.length); j++) {
      const windowText = sentences.slice(i, j + 1).join(' ').toLowerCase();
      let hits = 0;
      for (const tok of queryTokens) {
        if (tok && windowText.includes(String(tok).toLowerCase())) hits++;
      }
      if (hits > best.hits && windowText.length <= maxChars * 1.4) {
        best = { start: i, end: j, hits };
      }
    }
  }
  if (best.hits <= 0) return text.slice(0, maxChars);
  const picked = sentences.slice(best.start, best.end + 1).join(' ');
  return picked.length <= maxChars ? picked : picked.slice(0, maxChars).trimEnd() + '…';
}

// ─── P1-1 semantic re-rank ──────────────────────────────────────────────────
//
// Embed the query + every result's title+snippet, compute cosine similarity
// via a vector dot product (both vectors are already L2-normalised by
// embeddings.js), and blend into the final score.  Fails open — if the
// embedding provider is unavailable, we skip re-rank and return results
// unchanged.

function cosineDot(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // L2-normalised vectors → dot == cosine similarity
}

async function semanticRerank(results, query, contentMap, { config = {}, topN = 8 } = {}) {
  if (!results || results.length < 2) return { results, applied: false, reason: 'n<2' };
  let qVec = null;
  try {
    qVec = await getEmbedding(query, config);
  } catch (err) {
    return { results, applied: false, reason: `query-embed-failed:${err?.message || err}` };
  }
  if (!qVec || qVec.length !== EMBEDDING_DIMS) {
    return { results, applied: false, reason: 'no-embedding-provider' };
  }

  // Embed a compact summary per result — title + snippet + up to 400 chars of
  // fetched content when available.  Caps at topN to bound cost.
  const embeddable = results.slice(0, topN);
  const summaries = embeddable.map(r => {
    const body = contentMap?.get(r.url) || contentMap?.get(canonicalizeUrl(r.url)) || '';
    const head = body ? String(body).slice(0, 400) : '';
    return `${r.title || ''}\n${r.snippet || ''}\n${head}`.trim();
  });

  let vectors;
  try {
    vectors = await Promise.all(summaries.map(s => getEmbedding(s, config)));
  } catch (err) {
    return { results, applied: false, reason: `doc-embed-failed:${err?.message || err}` };
  }

  const blended = embeddable.map((r, i) => {
    const v = vectors[i];
    const semantic = v && v.length === EMBEDDING_DIMS ? cosineDot(qVec, v) : 0;
    // Blend: keep the keyword/recency score computed earlier, add the
    // semantic signal with the same weight so neither collapses the other.
    const base = Number.isFinite(r._score) ? r._score : 0;
    return { ...r, _semantic: round3(semantic), _score: round3(base + semantic) };
  });

  blended.sort((a, b) => b._score - a._score);
  // Results beyond topN stayed out of re-rank; tack them on unchanged.
  const tail = results.slice(topN).map(r => ({ ...r }));
  return { results: [...blended, ...tail], applied: true, reason: 'ok' };
}

function round3(n) {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}

// ─── P1-2 synonym / alias expansion ─────────────────────────────────────────
/**
 * Return up to 3 expanded query variants to try when the primary SERP yields
 * few results.  The original query is always first.  Empty clusters and
 * tokens that have no alias just pass through.
 */
function expandQuerySynonyms(query) {
  const out = [String(query || '').trim()];
  const { tokens } = tokenizeQuery(query);
  if (!tokens.length) return out;
  const hitClusters = new Set();
  for (const t of tokens) {
    const idx = _SYNONYM_INDEX.get(String(t).toLowerCase());
    if (idx != null) hitClusters.add(idx);
  }
  if (!hitClusters.size) return out;
  for (const idx of hitClusters) {
    const cluster = SYNONYM_CLUSTERS[idx];
    for (const alt of cluster) {
      // Rebuild a candidate by swapping every hit token with `alt`.
      const rebuilt = tokens
        .map(t => (_SYNONYM_INDEX.get(String(t).toLowerCase()) === idx ? alt : t))
        .join(' ');
      if (rebuilt && !out.includes(rebuilt)) out.push(rebuilt);
      if (out.length >= 4) break;
    }
    if (out.length >= 4) break;
  }
  return out;
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (error) {
    debugWarn('web_search', `extractDomain failed for ${url}:`, error?.message || error);
    return '';
  }
}

function selectContentUrls(results, query, {
  timeSensitive = false,
  allowBlockedDomains = false,
  nowMs = Date.now(),
} = {}) {
  // P0-3 — use the CJK-aware tokenizer instead of naïve whitespace split so
  // Chinese queries actually contribute tokens.
  const { tokens, graphemes } = tokenizeQuery(query);
  const queryTokens = [...tokens, ...graphemes]
    .map(w => String(w).toLowerCase())
    .filter(w => w.length > 0);

  // P0-1 — dedup by canonical URL + title fingerprint before ranking.  This
  // collapses amp/m/www variants and mirrored posts so we don't burn Jina
  // RTTs on duplicates.
  const seenCanon = new Set();
  const seenTitle = new Set();
  const filtered = [];
  for (const r of results) {
    const url = r?.url || '';
    if (!/^https?:\/\//i.test(url)) continue;
    if (/\.(pdf|mp4|mp3|zip|docx?|xlsx?)(\?|$)/i.test(url)) continue;
    if (!allowBlockedDomains) {
      const domain = extractDomain(url);
      // Codex Phase 6 follow-up (🔵 P1 2026-05-05): the BLOCKED_CONTENT_DOMAINS
      // Set is exact-match. The social-link suffix list (xiaohongshu.com /
      // douyin.com / iesdouyin.com / xhslink.com / v.douyin.com) needs
      // sub-host coverage too — m.douyin.com / m.xiaohongshu.com are
      // mobile mirrors of the same anti-bot pages and were slipping through
      // exact-match. We share `hostMatchesAnySuffix` with socialLinkTool so
      // the early-route surface and the search blocklist stay in lockstep.
      if (BLOCKED_CONTENT_DOMAINS.has(domain)) continue;
      if (hostMatchesAnySuffix(domain, SOCIAL_HOST_SUFFIXES)) continue;
    }
    const canon = canonicalizeUrl(url);
    if (seenCanon.has(canon)) continue;
    const titleKey = titleFingerprint(r.title || '');
    if (titleKey && seenTitle.has(titleKey)) continue;
    seenCanon.add(canon);
    if (titleKey) seenTitle.add(titleKey);
    filtered.push(r);
  }

  return filtered
    .map(r => ({
      ...r,
      _score: scoreResultRelevance(r, queryTokens, { timeSensitive, nowMs }),
    }))
    .sort((a, b) => b._score - a._score)
    .slice(0, CONTENT_FETCH_COUNT)
    .map(r => r.url);
}

// ─── Content fetching ────────────────────────────────────────────────────────
// `cleanPageText` now imported from ../../web/playwrightFetcher.js.

async function fetchViaPlaywrightCli(url) {
  return withPwLock(async () => {
    try {
      await pwNavigate(url, CONTENT_FETCH_TIMEOUT_MS);
      const waitAndExtract = `(async () => {
        const get = () => (document.body?.innerText || '').trim();
        let prev = get();
        for (let i = 0; i < 6; i++) {
          await new Promise(r => setTimeout(r, 500));
          const cur = get();
          if (cur.length > 200 && cur.length === prev.length) break;
          prev = cur;
        }
        return get();
      })()`;
      const raw = await runPlaywrightCli(['eval', waitAndExtract], CONTENT_FETCH_TIMEOUT_MS);
      let text = raw;
      try {
        text = JSON.parse(raw);
      } catch (err) {
        // raw may already be a plain string — silently accept as-is
      }
      if (!text || typeof text !== 'string' || text.length < 50) {
        debugWarn('web_search', `Playwright returned empty/short content for ${url}`);
        return { url, content: null };
      }
      const clean = cleanPageText(text);
      return { url, content: clean.slice(0, CONTENT_MAX_CHARS) };
    } catch (error) {
      debugWarn('web_search', `Playwright page fetch failed for ${url}:`, error?.message || error);
      return { url, content: null };
    }
  });
}

// Stage 2c (2026-05-17): CDP-attach content fetcher.  Same shape as
// fetchViaPlaywrightCli — returns `{ url, content }` or `{ url, content:
// null }` on miss — so the Stage 3 fallback loop can swap between tiers
// without touching the surrounding orchestration.
//
// Key differences from PW CLI:
//   • Real Chrome with logged-in cookies (user's Melo Chrome profile),
//     not headless CLI Chromium → wins on auth-walled / anti-bot sites.
//   • `domcontentloaded + waitForLoadState('load', 3000) + 1.5s sleep`
//     instead of `networkidle` — same rationale as fetchUrlTool Stage 2b
//     round-3 闭环: long-polling pages (Twitter / Slack / Discord) never
//     reach networkidle, would 20s-timeout otherwise.
//   • Reuses browser.contexts()[0] (default persistent context) — must
//     NEVER call browser.newContext() (would create isolated context
//     with no login state, defeating the whole CDP-attach value).
async function fetchViaCdpChromeForContentFetch(url, signal) {
  try {
    // Codex Stage 2c round-2 闭环 (2026-05-17): thread `signal` to
    // withMeloChrome so connect-time abort bails immediately, AND register
    // an abort listener inside the callback that force-closes the page —
    // playwright-core's `page.goto({timeout})` doesn't natively accept an
    // AbortSignal, so abort during navigation has to short-circuit via
    // page.close().  Pre-fix, abort mid-goto would let the underlying
    // Chrome navigation + 1.5s sleep run to natural completion while the
    // outer abortRace already gave up.  Real signal-pass to playwright is
    // an upstream issue; this is the JS-layer minimum.
    return await withMeloChrome(async (browser) => {
      const contexts = typeof browser.contexts === 'function' ? browser.contexts() : [];
      const context = (Array.isArray(contexts) && contexts[0])
        ? contexts[0]
        : await browser.newContext(); // defensive fallback only
      const page = await context.newPage();
      // Wire abort → close page so an in-flight goto / waitForLoadState /
      // sleep returns immediately when the caller signal flips.
      let abortListener = null;
      if (signal) {
        if (signal.aborted) {
          try { await page.close(); } catch {}
          return { url, content: null };
        }
        abortListener = () => {
          page.close().catch(() => {}); // best-effort; finally also closes
        };
        signal.addEventListener('abort', abortListener, { once: true });
      }
      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: CONTENT_FETCH_TIMEOUT_MS,
        });
        try {
          await page.waitForLoadState('load', { timeout: 3000 });
        } catch { /* load may never fire on streamy pages */ }
        await new Promise(r => setTimeout(r, 1500));
        if (signal?.aborted) return { url, content: null };
        const text = await page.evaluate(() => document?.body?.innerText || '');
        const trimmed = String(text || '').trim();
        if (!trimmed || trimmed.length < 50) {
          return { url, content: null };
        }
        const clean = cleanPageText(trimmed);
        return { url, content: clean.slice(0, CONTENT_MAX_CHARS) };
      } finally {
        if (signal && abortListener) {
          try { signal.removeEventListener('abort', abortListener); } catch {}
        }
        // Close ONLY the page — leaving the persistent context alive
        // preserves the user's login state for the next content-fetch URL.
        try { await page.close(); } catch { /* best-effort */ }
      }
    }, { signal });
  } catch (err) {
    debugWarn('web_search', `cdp-chrome content fetch failed for ${url}:`, err?.message || err);
    return { url, content: null };
  }
}

/**
 * P0-4 — conditional-GET aware Jina fetch.  Pass the ETag / Last-Modified
 * we already saw for this URL (from url_content_cache) and Jina/origin may
 * reply 304, in which case we return `notModified: true` so the caller
 * reuses the stale body and bumps the cache's fetched_at.
 *
 * Returns one of:
 *   { url, content, etag, lastModified }             – fresh body fetched
 *   { url, content: null, notModified: true }        – origin says "unchanged"
 *   { url, content: null }                           – failure / empty
 */
async function fetchViaJina(url, signal, { etag = null, lastModified = null } = {}) {
  const jinaUrl = `${JINA_READER_BASE}${url}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CONTENT_FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;

  const headers = { 'X-Return-Format': 'markdown', 'X-Timeout': '12' };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  try {
    const res = await fetch(jinaUrl, { signal: combined, headers });
    clearTimeout(timer);
    if (res.status === 304) {
      return { url, content: null, notModified: true };
    }
    if (!res.ok) {
      debugWarn('web_search', `Jina returned ${res.status} for ${url}`);
      return { url, content: null };
    }
    const text = await res.text();
    const clean = cleanPageText(text);
    return {
      url,
      content: clean.slice(0, CONTENT_MAX_CHARS),
      etag: res.headers.get('etag') || null,
      lastModified: res.headers.get('last-modified') || null,
    };
  } catch (error) {
    debugWarn('web_search', `Jina fetch failed for ${url}:`, error?.message || error);
    return { url, content: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch content from URLs with three layered optimizations:
 *   1. URL-level content cache (2h TTL) — skip net calls entirely for URLs
 *      seen in a recent search.
 *   2. Jina parallel + early-exit — return once we have JINA_SUCCESS_THRESHOLD
 *      good pages OR JINA_HARD_DEADLINE_MS elapses, so the slowest URL
 *      can't hold up the whole search.
 *   3. Playwright fallback capped at PW_FALLBACK_MAX — PW is strictly
 *      serialised by the pw lock (one page at a time), so more than 1
 *      fallback URL means multi-second p95 degradation.
 */
async function fetchResultContents(urls, signal, {
  spanId = null,
  _fetchViaPlaywrightCli: _pwOverride = null,
  // G-1c follow-up #5 (Codex C round-5 闭环 2026-05-10): seam threading
  // for the content-fetch PW availability probe.  Was the 4th PW await
  // I missed in round-3/4 — Codex round-5 caught it as same-class as
  // raceSerpProviders' probe.  Lessons learned: do systematic grep for
  // ALL PW await sites the first time, not "fix the one Codex pointed at".
  _isPlaywrightCliAvailable: _pwAvailableOverride = null,
  // G-1c follow-up #5 (round-5 systematic batch): also a Jina seam, so
  // mid-await content-fetch probe abort tests can deterministically
  // construct "Jina misses → PW fallback runs" without relying on real
  // example.com network reachability.  Same pattern, same scope.
  _fetchViaJina: _jinaOverride = null,
  // Stage 2c (2026-05-17): CDP-chrome fallback seam.  Production callers
  // leave this null; tests inject deterministic content without needing
  // a real Chrome.  When MELO_CDP_ENABLED=1, Stage 3 uses CDP instead of
  // the headless PW CLI for the fallback batch (logged-in cookies +
  // anti-bot bypass).  Env off path is unchanged.
  _fetchViaCdpChrome: _cdpOverride = null,
} = {}) {
  // G-1c follow-up #2 (Codex C round-2 闭环 2026-05-10): entry abort gate.
  // Pre-fix, an aborted signal at this point still ran Jina probes + PW
  // fallback because the function trusted the caller-side check.  Now
  // we shortcut to empty so the run() outer post-await sees no work
  // happened and bails immediately.  Real PW CLI subprocess kill is G-5.
  if (signal?.aborted) return { items: [], fallbackTier: null };
  const targets = urls.filter(url => /^https?:\/\//i.test(url));
  if (!targets.length) return { items: [], fallbackTier: null };

  const results = new Map();
  // P0-1 — track every content hash we've accepted so duplicate pages
  // fetched from different URLs (mirrors, AMP, syndication) drop out.
  const seenHashes = new Set();
  const acceptBody = (url, body, meta = {}) => {
    const hash = meta.contentHash || sha1Short(body || '');
    if (!body || body.length < 100) return false;
    if (seenHashes.has(hash)) {
      if (spanId) writeWebSearchDebugLine(`[fetch] dedup-hash span=${spanId} url=${url} hash=${hash}`);
      return false;
    }
    seenHashes.add(hash);
    results.set(url, { url, content: body, ...meta, contentHash: hash });
    return true;
  };

  // Stage 1 — URL cache. A DB hit shortcuts both Jina and PW.
  const needFetch = [];
  const condGetCandidates = new Map(); // url -> { etag, lastModified }
  for (const url of targets) {
    const fresh = getCachedUrlContent(url);
    if (fresh && fresh.content) {
      // Reuse cached body but still apply the hash-dedup so two different
      // URLs with identical cached content collapse.
      if (acceptBody(url, fresh.content, {
        fromUrlCache: true,
        etag: fresh.etag,
        lastModified: fresh.lastModified,
        contentHash: fresh.contentHash,
      })) {
        continue;
      }
      // Hash-dup against an earlier URL — no need to refetch.
      continue;
    }
    // P0-4 — even for expired rows, reuse ETag / Last-Modified so Jina can
    // reply 304 and we avoid re-downloading unchanged content.
    const stale = getStaleUrlContent(url);
    if (stale && (stale.etag || stale.lastModified)) {
      condGetCandidates.set(url, { etag: stale.etag, lastModified: stale.lastModified });
    }
    needFetch.push(url);
  }
  if (!needFetch.length) return { items: [...results.values()], fallbackTier: null };

  // Stage 2 — Jina with early-exit. Implemented without polling so we
  // resolve the instant the Nth success lands.
  const failed = new Set();
  await new Promise(resolveOuter => {
    let done = false;
    let settledCount = 0;

    // 2026-05-21 audit闭环 #6: hard-deadline / early-exit must abort
    // in-flight Jina HTTP requests, not just stop updating state.  Pre-fix
    // `finish()` only flipped `done` and the per-promise `.then` checks
    // guarded against state mutation — but the underlying fetch() calls
    // kept running to natural timeout (30-60s typical), wasting bandwidth
    // + Jina server tokens on results we already discarded.
    // Solution: chain an internal AbortController to BOTH the outer signal
    // (so caller Stop still flows through) AND finish() (so deadline/quorum
    // cancels in-flight too).  Pass internalAc.signal to fetchViaJina
    // instead of the bare outer signal.
    const internalAc = new AbortController();
    if (signal) {
      if (signal.aborted) internalAc.abort();
      else {
        const fwd = () => internalAc.abort();
        signal.addEventListener('abort', fwd, { once: true });
      }
    }

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(hardDeadline);
      // Cancel any Jina fetch still in flight — the .then bodies will
      // see internalAc.signal.aborted and short-circuit, and node's
      // fetch() will reject pending HTTP with AbortError so the socket
      // is released back to the pool / closed.
      try { internalAc.abort(); } catch {}
      resolveOuter();
    };
    const hardDeadline = setTimeout(finish, JINA_HARD_DEADLINE_MS);

    for (const url of needFetch) {
      const validators = condGetCandidates.get(url) || {};
      (_jinaOverride || fetchViaJina)(url, internalAc.signal, validators)
        .then(r => {
          if (done) return;
          if (r?.notModified) {
            // Origin confirms the stale body is still valid — touch the
            // fetched_at and reuse whatever we already had.
            const stale = getStaleUrlContent(url);
            if (stale?.content) {
              acceptBody(url, stale.content, {
                fromUrlCache: true,
                notModified: true,
                etag: stale.etag,
                lastModified: stale.lastModified,
                contentHash: stale.contentHash,
              });
              touchUrlFetchTime(url);
              if (spanId) writeWebSearchDebugLine(`[fetch] 304-reuse span=${spanId} url=${url}`);
              return;
            }
            failed.add(url);
            return;
          }
          if (r?.content && r.content.length >= 100) {
            if (acceptBody(url, r.content, {
              etag: r.etag || null,
              lastModified: r.lastModified || null,
            })) {
              setCachedUrlContent(url, r.content, {
                etag: r.etag || null,
                lastModified: r.lastModified || null,
              });
            }
            // Dedup drop is intentional — not a fetch failure, and we still
            // have the canonical copy from the earlier URL, so don't mark as failed.
          } else {
            failed.add(url);
          }
        })
        .catch(() => {
          if (done) return;
          failed.add(url);
        })
        .finally(() => {
          if (done) return;
          settledCount++;
          // Count successes from the working set (needFetch), not the cache-prewarm set.
          const jinaSuccesses = needFetch.reduce((n, u) => (results.has(u) ? n + 1 : n), 0);
          if (jinaSuccesses >= JINA_SUCCESS_THRESHOLD || settledCount === needFetch.length) {
            finish();
          }
        });
    }
  });

  // Anything in needFetch that neither succeeded nor explicitly failed
  // was cut short by the early-exit deadline — treat it as Jina-missed.
  for (const url of needFetch) {
    if (!results.has(url)) failed.add(url);
  }

  // Stage 3 — real-browser fallback, capped at PW_FALLBACK_MAX.  Two tiers:
  //   • MELO_CDP_ENABLED=1 → CDP-chrome (logged-in cookies, anti-bot bypass).
  //   • env off (default)  → headless Playwright CLI (existing behavior).
  // Same loop shape; just swap the fetcher.  Trail is recorded ONE level
  // up (run() emits a single content-fetch trail entry with method).
  //
  // Codex Stage 2c round-2 闭环 (2026-05-17): fallbackTier tracks the tier
  // that ACTUALLY fired (not just the planned tier) so the run() trail
  // entry's `method` reflects reality:
  //   • null   — no fallback fired (Jina/cache covered everything, or
  //              env-off + PW unavailable, or signal pre-aborted)
  //   • 'cdp-chrome'  — at least one CDP fallback call attempted
  //   • 'playwright'  — at least one PW fallback call attempted
  let fallbackTier = null;
  if (signal?.aborted) {
    return { items: [...results.values()].filter(r => r.content), fallbackTier };
  }
  const useCdp = process.env.MELO_CDP_ENABLED === '1';
  let fallbackImpl = null;
  let plannedTier = null;
  if (useCdp) {
    // CDP path: no availability probe (the launcher fails clearly if
    // Chrome is missing, and per-URL fail naturally falls through to
    // url-cache reuse).
    fallbackImpl = _cdpOverride || fetchViaCdpChromeForContentFetch;
    plannedTier = 'cdp-chrome';
  } else {
    // PW path: existing G-1c follow-up #5 abort-raced availability probe.
    const pwAvailableImpl = _pwAvailableOverride || isPlaywrightCliAvailable;
    let pwAvailable = false;
    if (failed.size > 0 && PW_FALLBACK_MAX > 0) {
      try {
        pwAvailable = await abortRace(pwAvailableImpl(), signal);
      } catch (err) {
        if (err?.name === 'AbortError') {
          return { items: [...results.values()].filter(r => r.content), fallbackTier };
        }
        throw err;
      }
    }
    if (pwAvailable) {
      fallbackImpl = _pwOverride || fetchViaPlaywrightCli;
      plannedTier = 'playwright';
    }
  }
  if (failed.size > 0 && PW_FALLBACK_MAX > 0 && fallbackImpl) {
    const fallbackTargets = [...failed].slice(0, PW_FALLBACK_MAX);
    for (const url of fallbackTargets) {
      // Re-check at every iteration — between two fallback calls the
      // signal can flip, and the in-flight fetcher is what G-5 will kill;
      // here we only ensure no further targets get scheduled.
      if (signal?.aborted) break;
      // G-1c follow-up #3: abortRace around the in-flight fallback call
      // so signal abort during a single fetch await returns immediately.
      // Stage 2c round-2: pass signal to the impl so it can also bail
      // its own in-flight work (CDP fetcher uses signal to close the
      // page on abort; PW CLI ignores the arg — pre-existing G-5 limit).
      fallbackTier = plannedTier; // mark "fired at least once"
      let body;
      try {
        body = await abortRace(fallbackImpl(url, signal), signal);
      } catch (err) {
        if (err?.name === 'AbortError') break;
        // Propagate other errors via the same swallow path the rest of
        // the function uses — failed.add was the pre-fix behavior.
        debugWarn('web_search', `${plannedTier} fallback failed for ${url}:`, err?.message || err);
        continue;
      }
      if (body?.content && body.content.length >= 100) {
        results.set(url, body);
        setCachedUrlContent(url, body.content);
      }
    }
  }

  return { items: [...results.values()].filter(r => r.content), fallbackTier };
}

// ─── Format results ───────────────────────────────────────────────────────────

function formatResults(results, query, provider, contentMap, { queryTokens = null } = {}) {
  if (!results.length) {
    return `No results found for "${query}".`;
  }

  const lines = [
    `Web search results for: "${query}" [via: ${provider}]`,
    '',
  ];

  for (let i = 0; i < results.length; i++) {
    const { title, url, snippet } = results[i];
    lines.push(`### ${i + 1}. ${title}`);
    lines.push(`[source: ${url}]`);
    if (snippet) lines.push(snippet);

    const pageContent = contentMap?.get(url);
    if (pageContent) {
      lines.push('');
      // P2-2 — when we have fetched page content AND a query-token list,
      // surface the best sentence-window up front so the caller sees the
      // bit that actually mentions the query.  Full body still follows.
      if (queryTokens && queryTokens.length) {
        const highlight = queryBiasedSnippet(pageContent, queryTokens, 320);
        if (highlight && highlight !== pageContent.slice(0, highlight.length)) {
          lines.push('**Top match:**');
          lines.push(highlight);
          lines.push('');
        }
      }
      lines.push('**Page content:**');
      lines.push(pageContent);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ─── Weather fast-path (wttr.in) ─────────────────────────────────────────────

const WEATHER_KEYWORDS = /(?:天气|气温|温度|weather|forecast|几度|多少度|下雨|下雪|rain|snow|humid)/i;
const WEATHER_NOISE = /(?:今天|明天|后天|这周|本周|今日|明日|现在|当前|查一下|帮我查|搜一下|查查|告诉我|请问|today'?s?|tomorrow'?s?|current(?:ly)?|now|this week|what'?s?\s*the|how'?s?\s*the|check|search|tell me|please)/gi;
const WEATHER_STRIP = /(?:天气|气温|温度|weather|forecast|几度|多少度|下雨吗|下雪吗|会下雨|rain|snow|humid(?:ity)?|预报|怎么样|如何|咋样)/gi;

function extractWeatherLocation(query) {
  const stripped = query.trim()
    .replace(WEATHER_NOISE, '')
    .replace(WEATHER_STRIP, '')
    .replace(/[?？。，,!！、的\s]+/g, ' ')
    .trim();
  if (stripped && stripped.length >= 1 && stripped.length < 50) return stripped;
  return null;
}

async function fetchWeatherFastPath(query, signal) {
  const location = extractWeatherLocation(query);
  if (!location) return null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  const combined = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;

  try {
    const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
    const res = await fetch(url, { signal: combined });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();

    const cur = data?.current_condition?.[0];
    const today = data?.weather?.[0];
    if (!cur) return null;

    const lines = [
      `Weather data for: "${query}" [via: wttr.in]`,
      '',
      `**Location:** ${data?.nearest_area?.[0]?.areaName?.[0]?.value || location}`,
      `**Current temperature:** ${cur.temp_C}°C (feels like ${cur.FeelsLikeC}°C)`,
      `**Weather:** ${cur.weatherDesc?.[0]?.value || 'N/A'}`,
      `**Humidity:** ${cur.humidity}%`,
      `**Wind:** ${cur.windspeedKmph} km/h ${cur.winddir16Point || ''}`,
      `**Visibility:** ${cur.visibility} km`,
      `**UV Index:** ${cur.uvIndex}`,
    ];

    if (today) {
      lines.push('');
      lines.push(`**Today range:** ${today.mintempC}°C ~ ${today.maxtempC}°C`);
      lines.push(`**Sunrise:** ${today.astronomy?.[0]?.sunrise || 'N/A'} | **Sunset:** ${today.astronomy?.[0]?.sunset || 'N/A'}`);
      const hours = today.hourly || [];
      if (hours.length) {
        lines.push('');
        lines.push('**Hourly forecast:**');
        for (const h of hours) {
          const hr = String(parseInt(h.time, 10) / 100).padStart(2, '0') + ':00';
          lines.push(`  ${hr} — ${h.tempC}°C, ${h.weatherDesc?.[0]?.value || ''}, rain ${h.chanceofrain}%`);
        }
      }
    }

    const tomorrow = data?.weather?.[1];
    if (tomorrow) {
      lines.push('');
      lines.push(`**Tomorrow:** ${tomorrow.mintempC}°C ~ ${tomorrow.maxtempC}°C, ${tomorrow.hourly?.[4]?.weatherDesc?.[0]?.value || ''}`);
    }

    return {
      ok: true,
      output: lines.join('\n'),
      meta: { query, provider: 'wttr.in', resultCount: 1, contentFetched: 1, results: [] },
    };
  } catch (error) {
    debugWarn('web_search', `wttr.in fast-path failed for "${query}":`, error?.message || error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Staggered SERP race ─────────────────────────────────────────────────────

/**
 * Start Playwright/Google first (strongest quality), and if it hasn't
 * produced results within SERP_STAGGER_MS, also kick off the Jina/DDG leg.
 * Whichever returns a non-empty result set first wins. If both settle empty,
 * resolves with an empty-results outcome carrying the aggregated errors.
 *
 * Both legs are bounded by their own inner timeouts (FETCH_TIMEOUT_MS);
 * the race adds no new time budget — it only decides whether to parallelize.
 */
async function raceSerpProviders(query, limit, signal, deps = {}) {
  const errors = [];
  // G-1c follow-up #4 (Codex C round-4 闭环 2026-05-10): test seams.
  // Production callers leave deps empty; tests inject _searchViaPlaywright
  // / _searchViaDdg / _isPlaywrightCliAvailable so they can deterministically
  // construct paths like "SERP returns results, Jina misses, PW content
  // fallback hangs, abort mid-await".  Without seams the previous test
  // hit a different abort point (SERP race entry gate) and the
  // _fetchViaPlaywrightCli stub was never called — false-green.
  const pwSearchImpl = deps._searchViaPlaywright || searchViaPlaywright;
  const ddgImpl = deps._searchViaDdg || searchViaDdg;
  const pwAvailableImpl = deps._isPlaywrightCliAvailable || isPlaywrightCliAvailable;
  // G-1c follow-up #3 (round-3): abort gate BEFORE the CLI probe +
  // abort-race AROUND the probe.  Pre-round-3 the listener was only
  // registered AFTER the probe, so cold-start CLI detection (~8s)
  // couldn't be cancelled.
  if (signal?.aborted) {
    errors.push('aborted');
    return { results: [], provider: '', errors };
  }
  let usePw;
  try {
    usePw = await abortRace(pwAvailableImpl(), signal);
  } catch (err) {
    if (err?.name === 'AbortError') {
      errors.push('aborted');
      return { results: [], provider: '', errors };
    }
    throw err;
  }

  // Degenerate case: no Playwright → no race, just run Jina directly.
  if (!usePw) {
    try {
      const r = await ddgImpl(query, limit, signal);
      return {
        results: r,
        provider: r.length ? 'duckduckgo' : '',
        errors,
      };
    } catch (err) {
      errors.push(`DDG: ${err.message}`);
      return { results: [], provider: '', errors };
    }
  }

  return new Promise(resolve => {
    let done = false;
    let pwSettled = false;
    let jinaStarted = false;
    let jinaSettled = false;

    const finish = (results, provider) => {
      if (done) return;
      done = true;
      clearTimeout(staggerTimer);
      if (signal && abortListener) {
        try { signal.removeEventListener('abort', abortListener); } catch {}
      }
      resolve({ results, provider, errors });
    };

    // G-1c follow-up #2 (Codex C round-2 闭环 2026-05-10): caller abort
    // must terminate the race immediately — without this, signal flips
    // during PW/Jina await and the outer post-await abort gate has to
    // wait for PW to settle on its own (10+s timeout typical).  We flip
    // `done` so any late legs that resolve are ignored, and resolve the
    // race promise with a synthetic "aborted" outcome.  Real PW CLI
    // subprocess kill is still G-5 (OS-level threading); this fix is the
    // JS-layer minimum that Codex demanded as not-deferrable.
    const abortListener = signal ? () => {
      if (done) return;
      errors.push('aborted');
      finish([], '');
    } : null;
    if (signal) {
      if (signal.aborted) {
        errors.push('aborted');
        resolve({ results: [], provider: '', errors });
        return;
      }
      signal.addEventListener('abort', abortListener, { once: true });
    }

    const startJina = () => {
      if (jinaStarted || done) return;
      jinaStarted = true;
      ddgImpl(query, limit, signal).then(
        r => {
          jinaSettled = true;
          if (done) return;  // ignore late settle after abort
          if (r.length) finish(r, 'duckduckgo');
          else if (pwSettled) finish([], '');
        },
        err => {
          jinaSettled = true;
          if (done) return;
          errors.push(`DDG: ${err.message}`);
          if (pwSettled) finish([], '');
        },
      );
    };

    // PW leg — start immediately.  abortRace ensures signal flips
    // immediately reject the await even if the underlying PW process
    // keeps running until natural timeout (G-5 will kill the subprocess).
    abortRace(pwSearchImpl(query, limit), signal).then(
      r => {
        pwSettled = true;
        if (done) return;  // ignore late settle after abort
        if (r.length) finish(r, 'google (playwright)');
        else if (jinaSettled) finish([], '');
        else startJina(); // PW returned empty — bring Jina forward
      },
      err => {
        pwSettled = true;
        if (done) return;
        errors.push(`Google/PW: ${err.message}`);
        if (jinaSettled) finish([], '');
        else startJina(); // PW error — bring Jina forward
      },
    );

    // Stagger timer — if PW isn't done yet, kick off Jina in parallel
    const staggerTimer = setTimeout(startJina, SERP_STAGGER_MS);
  });
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export const webSearchTool = {
  id: 'web_search',
  name: 'Web Search',
  description:
    'Search the web for current information. Returns titles, URLs, snippets, and actual page content ' +
    'from the top results. Use this when you need up-to-date information, current events, facts, ' +
    'technical documentation, or anything not in your training data.',
  category: 'web',
  // The HTTP/Jina legs are concurrent-safe, but the Playwright SERP/session is
  // intentionally single-browser. Letting the tool runner overlap web_search
  // calls can build an unbounded Playwright queue and leave many Chrome helpers
  // around if callers keep refreshing the search view.
  isConcurrencySafe: false,
  requiresPermission: false,
  parametersSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query. Be specific and include relevant keywords.',
      },
      num_results: {
        type: 'number',
        description: `Number of results to return (1–${MAX_RESULTS}). Default: 5.`,
        default: 5,
      },
      noCache: {
        type: 'boolean',
        description:
          'When true, bypass the 2-hour SQLite cache and hit the provider fresh. ' +
          'Use only when the user explicitly asks for the latest / real-time info and a cached answer would be stale.',
        default: false,
      },
      allowBlockedDomains: {
        type: 'boolean',
        description:
          'When true, do not filter out low-signal / login-walled domains (pinterest, quora, x.com, etc.). ' +
          'Use only when the user explicitly asked about one of those sites — otherwise leave false for quality.',
        default: false,
      },
    },
    required: ['query'],
  },
  examples: [
    { query: 'latest Node.js LTS version 2026' },
    { query: 'React 19 new features', num_results: 3 },
    { query: 'best pinterest boards for UI inspiration', allowBlockedDomains: true },
  ],

  // G-2b Phase 2: same trail-log wrap as fetchUrlTool — see
  // docs/search-task-rfc.md §7 for the rationale.
  run: wrapWithTrailLog('web-search', async function run(
    { query, num_results = 5, noCache = false, allowBlockedDomains = false },
    { signal, config,
      // G-1c follow-up #4 (Codex C round-4 闭环 2026-05-10): test seams.
      // Production callers leave these empty; tests inject to construct
      // deterministic abort paths.  Same pattern as fetchUrlTool's
      // _readSocialLink / _readExternalUrl, socialLinkTool's previewFn /
      // browserPreviewFn / etc.
      _fetchViaPlaywrightCli,
      _searchViaPlaywright,
      _searchViaDdg,
      _isPlaywrightCliAvailable,
      _fetchViaJina,
      // Stage 2c (2026-05-17): content-fetch CDP fallback seam.  Same
      // shape as _fetchViaPlaywrightCli but production callers leave it
      // null and the prod fetchViaCdpChromeForContentFetch resolves the
      // import lazily.
      _fetchViaCdpChrome,
      // G-2b round-5 闭环 (2026-05-21 Codex A ⚪): api-direct DI seam so
      // tests can pin the meta.contentItems serialization shape without
      // hitting real Wikipedia / HN / arXiv / GitHub / Stack Overflow.
      // Production callers leave null → uses imported tryApiDirect.
      _tryApiDirect,
    } = {},
  ) {
    const trail = [];
    if (!query || typeof query !== 'string' || !query.trim()) {
      recordWebSearchTrail(trail, 'validate', 'fail', { reason: 'invalid-query' });
      return { ok: false, output: 'Missing or empty query.', error: 'INVALID_QUERY', evidenceTrail: trail };
    }

    const q = query.trim();
    const limit = Math.max(1, Math.min(MAX_RESULTS, Math.floor(num_results) || 5));

    // P2-3 — single span id per `run()` invocation so every debug line can
    // be grepped back to one query.  Never thrown, never awaited.
    const spanId = nextWebSearchSpanId();

    // P0-3 — classify once and thread everywhere.  Weather/price/news are
    // time-sensitive, which changes both TTL and ranking.
    const intent = classifyQueryIntent(q);

    // Shared query-token list (CJK-aware) — used by selectContentUrls AND
    // the biased-snippet formatter, so compute once.
    const { tokens: qTokens, graphemes: qGraphs } = tokenizeQuery(q);
    const queryTokens = [...qTokens, ...qGraphs]
      .map(t => String(t).toLowerCase())
      .filter(Boolean);

    writeWebSearchDebugLine(
      `[start] span=${spanId} q=${JSON.stringify(q)} ` +
      `intent=${intent.kind} ts=${intent.timeSensitive ? 1 : 0} ` +
      `limit=${limit} noCache=${noCache ? 1 : 0} allowBlocked=${allowBlockedDomains ? 1 : 0}`,
    );

    // Timing instrumentation — phases in ms, surfaced in meta.timings so
    // `melo search --json` and future dashboards can spot slow providers.
    const tStart = Date.now();
    let tAfterSerp = 0;
    let tAfterContent = 0;

    // Fast-path: weather queries via wttr.in (~1s)
    if (WEATHER_KEYWORDS.test(q)) {
      const tWeather = Date.now();
      // 3-layer abort: pre-await
      if (signal?.aborted) return bailAbortedWebSearch(trail, 'weather-fast-path', q, { intent, spanId });
      let weatherResult;
      try {
        weatherResult = await fetchWeatherFastPath(q, signal);
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') {
          return bailAbortedWebSearch(trail, 'weather-fast-path', q, { intent, spanId });
        }
        recordWebSearchTrail(trail, 'weather-fast-path', 'fail', {
          latencyMs: Date.now() - tWeather,
          reason: classifyWebSearchError(err),
        });
        weatherResult = null;
      }
      // 3-layer abort: post-await
      if (signal?.aborted) return bailAbortedWebSearch(trail, 'weather-fast-path', q, { intent, spanId });
      if (weatherResult) {
        recordWebSearchTrail(trail, 'weather-fast-path', 'ok', {
          latencyMs: Date.now() - tWeather,
          extra: { hit: true },
        });
        weatherResult.meta = {
          ...weatherResult.meta,
          timings: {
            totalMs: Date.now() - tStart,
            serpMs: Date.now() - tStart,
            contentMs: 0,
            cacheHit: false,
            weatherFastPath: true,
          },
          spanId,
          intent,
        };
        writeWebSearchDebugLine(`[end] span=${spanId} path=weather ms=${Date.now() - tStart}`);
        return { ...weatherResult, evidenceTrail: trail };
      }
      // weather miss — fall through to cache/serp.  Only record a skip
      // entry if we didn't already record a fail (caught error above).
      if (!trail.some(e => e.tier === 'weather-fast-path')) {
        recordWebSearchTrail(trail, 'weather-fast-path', 'skip', {
          latencyMs: Date.now() - tWeather,
          reason: 'no-data',
        });
      }
    }

    // ── Cache layer ────────────────────────────────────────────────────
    // Fresh hit: return immediately. Stale hit (P2-1 SWR): return the
    // stale rows now and refresh in the background, so the user never
    // pays the SERP latency on repeat queries.
    if (!noCache) {
      const tCache = Date.now();
      // G-1c follow-up #1 (Codex C 闭环 2026-05-10): cache phase entry
      // abort gate.  Pre-fix, an aborted signal would still let cache
      // fresh/stale return a successful result and queue a SWR refresh —
      // user-decided contract on 2026-05-10: Stop semantics outranks
      // cache hit.  Without this gate, a user-cancelled search shows
      // stale rows in the UI and silently spawns a background SERP task.
      if (signal?.aborted) return bailAbortedWebSearch(trail, 'cache', q, { intent, spanId });
      const fresh = getCachedSearch(q, intent);
      if (fresh) {
        // Re-check after the (synchronous) lookup — covers the race where
        // the signal flips between entry and lookup (rare but real on
        // very-tight Stop bursts).
        if (signal?.aborted) return bailAbortedWebSearch(trail, 'cache', q, { intent, spanId });
        recordWebSearchTrail(trail, 'cache', 'ok', {
          latencyMs: Date.now() - tCache,
          method: 'fresh',
          extra: { provider: fresh.provider, results: fresh.results.length },
        });
        const output = formatResults(
          fresh.results.slice(0, limit),
          q,
          fresh.provider,
          fresh.contentMap,
          { queryTokens },
        );
        writeWebSearchDebugLine(`[cache] span=${spanId} hit=fresh provider=${fresh.provider}`);
        return {
          ok: true,
          output,
          meta: {
            query: q,
            provider: fresh.provider,
            resultCount: Math.min(fresh.results.length, limit),
            contentFetched: fresh.contentMap.size,
            results: fresh.results.slice(0, limit),
            timings: {
              totalMs: Date.now() - tStart,
              serpMs: 0,
              contentMs: 0,
              cacheHit: true,
              weatherFastPath: false,
            },
            spanId,
            intent,
          },
          evidenceTrail: trail,
        };
      }

      const stale = getStaleCachedSearch(q, intent);
      if (stale) {
        // Same abort gate as fresh hit above: stale path is even worse on
        // abort because it queues a background SWR refresh that re-runs
        // SERP — exactly what Stop is supposed to prevent.
        if (signal?.aborted) return bailAbortedWebSearch(trail, 'cache', q, { intent, spanId });
        recordWebSearchTrail(trail, 'cache', 'ok', {
          latencyMs: Date.now() - tCache,
          method: 'stale-swr',
          extra: { provider: stale.provider, ageMs: Date.now() - stale.createdAt },
        });
        const output = formatResults(
          stale.results.slice(0, limit),
          q,
          stale.provider,
          stale.contentMap,
          { queryTokens },
        );
        writeWebSearchDebugLine(
          `[cache] span=${spanId} hit=stale age=${Date.now() - stale.createdAt}ms — refreshing in bg`,
        );
        // Background refresh — fire-and-forget, but deduped per cache key.
        // Search bootstrap can poll while the search page is open; without
        // this guard each poll queues another Playwright SERP task.
        // G-1c follow-up #1: don't queue SWR if signal already aborted —
        // belt-and-braces with the abort gate above (covers the case where
        // the signal flips during getStaleCachedSearch).
        const refreshKey = buildCacheKey(q, intent);
        if (signal?.aborted) {
          writeWebSearchDebugLine(`[cache] span=${spanId} hit=stale refresh=skipped-aborted`);
        } else if (!_backgroundRefreshInFlight.has(refreshKey)) {
          _backgroundRefreshInFlight.add(refreshKey);
          // Stage 2c B 留账 闭环 (2026-05-18): pass the DI seams through
          // so the background refresh path is testable (real stale-SWR
          // test in webSearchTool.swrAbort.test.js needs to assert the
          // refresh fired AND rewrote the row).  Production callers
          // leave these undefined → module-default impls win, unchanged
          // behavior.
          const refreshDeps = {
            _searchViaPlaywright, _searchViaDdg, _isPlaywrightCliAvailable,
            _fetchViaJina, _fetchViaPlaywrightCli, _fetchViaCdpChrome,
          };
          // CLAUDE.md §6 闭环 (2026-05-21 audit #1): capture home at
          // SCHEDULE time, not microtask-execution time.  AsyncLocalStorage
          // propagates the captured value across all awaits inside the
          // refresh so every cache helper (cacheDbPath / getCacheDb /
          // setCachedSearch / setCachedUrlContent / debug-log path) resolves
          // to the home that was active when the SWR was queued — even if
          // some future feature flips MELO_HOME between schedule and
          // execution.  Production single-home callers: capturedHome ===
          // current getMeloHome(), so behavior is identical to pre-fix.
          const capturedHome = getMeloHome();
          queueMicrotask(() => {
            _homeCaptureContext.run(capturedHome, () => {
              _refreshInBackground(q, limit, intent, queryTokens, allowBlockedDomains, config, refreshDeps)
                .catch(err => debugWarn('web_search', `SWR refresh failed for "${q}":`, err?.message || err))
                .finally(() => _backgroundRefreshInFlight.delete(refreshKey));
            });
          });
        } else {
          writeWebSearchDebugLine(`[cache] span=${spanId} hit=stale refresh=already-in-flight`);
        }
        return {
          ok: true,
          output,
          meta: {
            query: q,
            provider: stale.provider,
            resultCount: Math.min(stale.results.length, limit),
            contentFetched: stale.contentMap.size,
            results: stale.results.slice(0, limit),
            timings: {
              totalMs: Date.now() - tStart,
              serpMs: 0,
              contentMs: 0,
              cacheHit: true,
              swr: true,
              weatherFastPath: false,
            },
            spanId,
            intent,
          },
          evidenceTrail: trail,
        };
      }
      // cache fully missed — record skip-equivalent so the trail shows we
      // checked. (Distinct from "noCache=true" which means we never even
      // looked.)
      recordWebSearchTrail(trail, 'cache', 'fail', {
        latencyMs: Date.now() - tCache,
        reason: 'no-hit',
      });
    } else {
      recordWebSearchTrail(trail, 'cache', 'skip', { reason: 'noCache=true' });
    }

    // ── API-direct layer ──────────────────────────────────────────────
    // Before paying SERP latency, try structured-data providers (Wikipedia
    // for "what is X" / "who is X" / explicit "wiki: X" prefix; future:
    // HN / arXiv / GitHub).  Each provider has a cheap matchKind() check;
    // when no provider claims the query we record `skip no-provider-match`
    // and fall through to SERP unchanged.  When a provider succeeds, we
    // return its result formatted through the same formatResults() path
    // SERP uses, so downstream consumers (UI, evidence trail, cache miss
    // re-fill) see no shape difference.
    //
    // Why no cache write on api-direct hit: Wikipedia REST is sub-second
    // and free; caching it would create a stale-vs-fresh tier inversion
    // (cache hit returning yesterday's Wikipedia summary when the live
    // API has today's edit).  The cache layer is for SERP, which is slow
    // + expensive — api-direct doesn't share those constraints.
    //
    // No pre-await abort gate here.  tryApiDirect short-circuits on
    // no-match / time-sensitive-skip with zero network — the only network
    // it does is the actual provider.fetch() call, which has its own abort
    // handling inside fetchFromWikipedia.  An entry-level abort gate would
    // overwrite the real api-direct outcome (skip no-provider-match / skip
    // time-sensitive) with `fail aborted-mid-loop`, making trail analysis
    // unable to distinguish "abort hit while api-direct was about to skip
    // anyway" from "abort interrupted a Wikipedia fetch".  The serp phase
    // below keeps its own pre-await gate; abort during the SERP race
    // remains the canonical bail point.
    const tApi = Date.now();
    let apiResult = null;
    let apiFetchErr = null;
    try {
      const apiImpl = _tryApiDirect || tryApiDirect;
      apiResult = await apiImpl(q, intent, signal);
    } catch (err) {
      apiFetchErr = err;
    }

    // Record the api-direct trail entry FIRST, before the post-await abort
    // gate.  Synchronous gate outcomes (skip no-provider-match / skip
    // time-sensitive) must show up as their real semantics in the trail
    // even if the signal flipped during tryApiDirect's microtask — see
    // the no-pre-gate rationale above.  An abort during a real
    // provider.fetch() call surfaces as apiFetchErr, which routes to the
    // bail path below with `fail aborted-mid-loop`.
    if (apiFetchErr) {
      if (signal?.aborted || apiFetchErr?.name === 'AbortError') {
        return bailAbortedWebSearch(trail, 'api-direct', q, { intent, spanId });
      }
      recordWebSearchTrail(trail, 'api-direct', 'fail', {
        latencyMs: Date.now() - tApi,
        reason: classifyWebSearchError(apiFetchErr),
      });
    } else if (apiResult === null) {
      recordWebSearchTrail(trail, 'api-direct', 'skip', { reason: 'no-provider-match' });
    } else if (apiResult.skipped) {
      // Provider matched but elected not to fire (e.g. implicit definition
      // shape collided with intent.timeSensitive).  Record method=provider
      // so trail analysis can distinguish "no provider knows this query"
      // from "Wikipedia knows it but the gate said no".
      recordWebSearchTrail(trail, 'api-direct', 'skip', {
        latencyMs: apiResult.latencyMs,
        method: apiResult.provider,
        reason: apiResult.reason || 'gated',
      });
    } else if (apiResult.ok) {
      recordWebSearchTrail(trail, 'api-direct', 'ok', {
        latencyMs: apiResult.latencyMs,
        method: apiResult.provider,
        extra: { results: apiResult.results.length },
      });
      const output = formatResults(
        apiResult.results.slice(0, limit),
        q,
        apiResult.provider,
        apiResult.contentMap,
        { queryTokens },
      );
      writeWebSearchDebugLine(
        `[api-direct] span=${spanId} provider=${apiResult.provider} results=${apiResult.results.length} ms=${apiResult.latencyMs}`,
      );
      // G-2b round-5 闭环 (2026-05-21 Codex C #5): expose contentMap as
      // structured `meta.contentItems` so the SearchTask adapter can
      // distinguish "snippet IS body" (Wikipedia extract) from "snippet
      // is metadata, body in contentMap" (HN/arXiv/GitHub/SO).  Without
      // this the adapter has no way to set per-result isPartial honestly.
      // Only sliced to the same limit as results so the two arrays
      // align by URL.
      const slicedResults = apiResult.results.slice(0, limit);
      const contentItems = slicedResults
        .map(r => {
          const c = apiResult.contentMap?.get?.(r.url);
          return c ? { url: r.url, content: c } : null;
        })
        .filter(Boolean);
      return {
        ok: true,
        output,
        meta: {
          query: q,
          provider: apiResult.provider,
          resultCount: slicedResults.length,
          contentFetched: apiResult.contentMap.size,
          results: slicedResults,
          contentItems,
          timings: {
            totalMs: Date.now() - tStart,
            serpMs: 0,
            contentMs: 0,
            cacheHit: false,
            weatherFastPath: false,
            apiDirect: true,
          },
          spanId,
          intent,
        },
        evidenceTrail: trail,
      };
    } else {
      // Provider matched but soft-failed.  Two distinct cases:
      //   1. Aborted-during-fetch: fetchFromWikipedia catches AbortError and
      //      returns { ok:false, reason:'aborted' } instead of throwing —
      //      apiFetchErr is null so we land here, NOT in the bail branch
      //      above.  Codex G-2b round-5 B (2026-05-14) gap: without this
      //      special-case, trail would get both `api-direct.fail aborted`
      //      AND `serp.fail aborted-mid-loop` (serp's pre-await gate fires
      //      next), breaking the invariant that exactly one phase carries
      //      the abort-mid-loop fail.  api-direct WAS the active network
      //      phase when the user hit Stop, so it owns the bail.
      //   2. Real provider failure (http-5xx / no-results / parse-error):
      //      record fail + fall through to SERP so the user still gets an
      //      answer.
      if (apiResult.reason === 'aborted' && signal?.aborted) {
        return bailAbortedWebSearch(trail, 'api-direct', q, { intent, spanId });
      }
      recordWebSearchTrail(trail, 'api-direct', 'fail', {
        latencyMs: apiResult.latencyMs,
        method: apiResult.provider,
        reason: apiResult.reason || 'unknown',
      });
    }

    // Staggered SERP race: Playwright starts immediately; if it hasn't come
    // back within SERP_STAGGER_MS, also kick off the Jina/DDG leg in parallel.
    // First non-empty result wins; loser's bandwidth is the only waste.
    const tSerp = Date.now();
    // 3-layer abort: pre-await
    if (signal?.aborted) return bailAbortedWebSearch(trail, 'serp', q, { intent, spanId });
    let serpOutcome;
    try {
      serpOutcome = await raceSerpProviders(q, limit, signal, {
        _searchViaPlaywright, _searchViaDdg, _isPlaywrightCliAvailable,
      });
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') {
        return bailAbortedWebSearch(trail, 'serp', q, { intent, spanId });
      }
      recordWebSearchTrail(trail, 'serp', 'fail', {
        latencyMs: Date.now() - tSerp,
        reason: classifyWebSearchError(err),
      });
      // Skip remaining phases since serp threw.
      for (const p of ['synonym-retry', 'content-fetch', 'semantic-rerank']) {
        recordWebSearchTrail(trail, p, 'skip', { reason: 'serp-threw' });
      }
      return {
        ok: false,
        output: `Web search failed for "${q}": ${err?.message || err}`,
        error: 'SEARCH_FAILED',
        evidenceTrail: trail,
      };
    }
    // 3-layer abort: post-await
    if (signal?.aborted) return bailAbortedWebSearch(trail, 'serp', q, { intent, spanId });
    let { results, provider } = serpOutcome;
    const errors = [...serpOutcome.errors];
    recordWebSearchTrail(trail, 'serp', results.length ? 'ok' : 'fail', {
      latencyMs: Date.now() - tSerp,
      method: provider || 'none',
      reason: results.length ? undefined : 'no-results',
      extra: { resultCount: results.length, errorCount: errors.length },
    });

    // P1-2 — if the primary SERP came back thin, retry with synonym-expanded
    // variants.  Keep the first non-empty variant's results and tag the
    // provider so debug can see the retry happened.
    let synonymRetry = null;
    const tSynonym = Date.now();
    if (results.length < SYNONYM_RETRY_THRESHOLD) {
      const variants = expandQuerySynonyms(q).slice(1); // index 0 is the raw query we already tried
      let synonymTried = 0;
      for (const variant of variants) {
        // 3-layer abort: pre-await
        if (signal?.aborted) return bailAbortedWebSearch(trail, 'synonym-retry', q, { intent, spanId });
        synonymTried += 1;
        try {
          const retry = await raceSerpProviders(variant, limit, signal, {
            _searchViaPlaywright, _searchViaDdg, _isPlaywrightCliAvailable,
          });
          // 3-layer abort: post-await
          if (signal?.aborted) return bailAbortedWebSearch(trail, 'synonym-retry', q, { intent, spanId });
          if (retry.results.length >= SYNONYM_RETRY_THRESHOLD) {
            results = retry.results;
            provider = retry.provider ? `${retry.provider} (syn:${variant})` : provider;
            synonymRetry = variant;
            writeWebSearchDebugLine(
              `[syn] span=${spanId} retry=${JSON.stringify(variant)} results=${retry.results.length}`,
            );
            break;
          }
        } catch (err) {
          // 3-layer abort: catch-path
          if (signal?.aborted || err?.name === 'AbortError') {
            return bailAbortedWebSearch(trail, 'synonym-retry', q, { intent, spanId });
          }
          errors.push(`syn[${variant}]: ${err?.message || err}`);
        }
      }
      recordWebSearchTrail(trail, 'synonym-retry', synonymRetry ? 'ok' : 'fail', {
        latencyMs: Date.now() - tSynonym,
        reason: synonymRetry ? undefined : 'all-variants-thin',
        extra: { variantsTried: synonymTried, picked: synonymRetry || null },
      });
    } else {
      // serp returned strong results, no retry needed.
      recordWebSearchTrail(trail, 'synonym-retry', 'skip', { reason: 'serp-strong-no-retry-needed' });
    }

    tAfterSerp = Date.now();

    writeWebSearchDebugLine(
      `[serp] span=${spanId} provider=${provider || 'none'} ` +
      `results=${results.length} ms=${tAfterSerp - tStart}` +
      (synonymRetry ? ` syn=${JSON.stringify(synonymRetry)}` : ''),
    );

    if (!results.length) {
      // serp + synonym both empty — content-fetch + rerank are skip.
      recordWebSearchTrail(trail, 'content-fetch', 'skip', { reason: 'no-serp-results' });
      recordWebSearchTrail(trail, 'semantic-rerank', 'skip', { reason: 'no-serp-results' });
      writeWebSearchDebugLine(`[end] span=${spanId} path=fail errors=${errors.length}`);
      return {
        ok: false,
        output: `Web search failed for "${q}". Errors: ${errors.join('; ')}`,
        error: 'SEARCH_FAILED',
        meta: {
          query: q,
          timings: {
            totalMs: tAfterSerp - tStart,
            serpMs: tAfterSerp - tStart,
            contentMs: 0,
            cacheHit: false,
            weatherFastPath: false,
          },
          spanId,
          intent,
        },
        evidenceTrail: trail,
      };
    }

    // Content fetching: Jina primary (parallel), Playwright fallback (serialised)
    const smartUrls = selectContentUrls(results, q, {
      timeSensitive: intent.timeSensitive,
      allowBlockedDomains,
    });
    const tContent = Date.now();
    // 3-layer abort: pre-await
    if (signal?.aborted) return bailAbortedWebSearch(trail, 'content-fetch', q, { intent, spanId });
    let contentItems = [];
    let contentFetchFallbackTier = null;
    let contentFetchFailReason = null;
    try {
      const cfResult = await fetchResultContents(smartUrls, signal, {
        spanId,
        _fetchViaPlaywrightCli,
        _isPlaywrightCliAvailable,
        _fetchViaJina,
        _fetchViaCdpChrome,
      });
      contentItems = cfResult.items;
      contentFetchFallbackTier = cfResult.fallbackTier;
    } catch (err) {
      // catch-path abort
      if (signal?.aborted || err?.name === 'AbortError') {
        return bailAbortedWebSearch(trail, 'content-fetch', q, { intent, spanId });
      }
      debugWarn('web_search', `fetchResultContents crashed:`, err?.message || err);
      contentFetchFailReason = classifyWebSearchError(err);
      contentItems = [];
    }
    // post-await abort
    if (signal?.aborted) return bailAbortedWebSearch(trail, 'content-fetch', q, { intent, spanId });
    tAfterContent = Date.now();
    recordWebSearchTrail(trail, 'content-fetch', contentFetchFailReason ? 'fail' : 'ok', {
      latencyMs: tAfterContent - tContent,
      reason: contentFetchFailReason || undefined,
      // Stage 2c round-2 闭环 (2026-05-17): trail method reflects the tier
      // that ACTUALLY fired — null when Jina/cache covered everything (so
      // trail-log analysis can distinguish "no fallback needed" from
      // "fallback fired but failed").  Codex round-1 hardcoded by env,
      // round-2 records reality.
      method: contentFetchFallbackTier || undefined,
      extra: {
        urlsRequested: smartUrls.length,
        contentItems: contentItems.length,
      },
    });

    const contentMap = new Map(
      contentItems.map(c => [c.url, c.content]).filter(([, v]) => v),
    );

    // P1-1 — semantic re-rank using the embedding provider.  Fails open:
    // if no provider or the embed call errors, we return results unchanged.
    let rerank = { applied: false, reason: 'not-attempted' };
    const tRerank = Date.now();
    try {
      rerank = await semanticRerank(results, q, contentMap, { config, topN: 8 });
      // catch-path abort already covered below; semanticRerank doesn't take
      // a signal arg today, so post-await abort is the relevant gate here.
      if (signal?.aborted) return bailAbortedWebSearch(trail, 'semantic-rerank', q, { intent, spanId });
      if (rerank.applied) {
        results = rerank.results;
      }
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') {
        return bailAbortedWebSearch(trail, 'semantic-rerank', q, { intent, spanId });
      }
      rerank = { applied: false, reason: `threw:${err?.message || err}` };
    }
    recordWebSearchTrail(trail, 'semantic-rerank', rerank.applied ? 'ok' : 'skip', {
      latencyMs: Date.now() - tRerank,
      reason: rerank.applied ? undefined : rerank.reason,
    });

    writeWebSearchDebugLine(
      `[content] span=${spanId} fetched=${contentMap.size}/${smartUrls.length} ` +
      `ms=${tAfterContent - tAfterSerp} rerank=${rerank.applied ? 'yes' : 'no'}(${rerank.reason})`,
    );

    setCachedSearch(q, provider, results, contentMap, intent);

    const output = formatResults(results, q, provider, contentMap, { queryTokens });

    writeWebSearchDebugLine(
      `[end] span=${spanId} path=ok results=${results.length} total_ms=${tAfterContent - tStart}`,
    );

    return {
      ok: true,
      output,
      meta: {
        query: q,
        provider,
        resultCount: results.length,
        contentFetched: contentMap.size,
        results,
        timings: {
          totalMs: tAfterContent - tStart,
          serpMs: tAfterSerp - tStart,
          contentMs: tAfterContent - tAfterSerp,
          cacheHit: false,
          weatherFastPath: false,
        },
        spanId,
        intent,
        rerank: { applied: rerank.applied, reason: rerank.reason },
        synonymRetry,
      },
      evidenceTrail: trail,
    };
  }),
};

// ─── SWR background refresh (P2-1) ───────────────────────────────────────────
//
// Same core pipeline as `run()` but without the cache-read layer (we're
// only here because stale was served) and without awaiters outside the
// cache write.  If we throw, the stale row still stands — safe fallback.

async function _refreshInBackground(q, limit, intent, queryTokens, allowBlockedDomains, config, refreshDeps = {}) {
  // Stage 2c B 留账 闭环 (2026-05-18): thread the parent run()'s DI seams
  // into the background refresh too.  Pre-fix the refresh used module-
  // default impls (real Jina / DDG / Playwright net), so its end-to-end
  // contract was untestable without real network.  feedback_test_must_
  // validate_real_invariant requires we can prove "refresh fired AND
  // rewrote the cache row" with a deterministic fake — that needs DI
  // symmetry with run().  Production callers leave refreshDeps empty so
  // module-default impls win (same behavior as before).
  const {
    _searchViaPlaywright, _searchViaDdg, _isPlaywrightCliAvailable,
    _fetchViaJina, _fetchViaPlaywrightCli, _fetchViaCdpChrome,
  } = refreshDeps;
  const serp = await raceSerpProviders(q, limit, null, {
    _searchViaPlaywright, _searchViaDdg, _isPlaywrightCliAvailable,
  });
  if (!serp.results.length) return;
  const smartUrls = selectContentUrls(serp.results, q, {
    timeSensitive: intent.timeSensitive,
    allowBlockedDomains,
  });
  // Stage 2c round-3 闭环 (2026-05-17): fetchResultContents now returns
  // `{ items, fallbackTier }`, not a bare Array.  Pre-fix this destructure
  // was missing and the background refresh crashed with
  // "contentItems.map is not a function" — stale cache could never get
  // refreshed.  fallbackTier is dropped here: the SWR write goes through
  // setCachedSearch which doesn't surface trail info to the user, and
  // adding it would require widening the cache schema.
  const cfResult = await fetchResultContents(smartUrls, null, {
    _fetchViaPlaywrightCli, _isPlaywrightCliAvailable,
    _fetchViaJina, _fetchViaCdpChrome,
  }).catch(() => ({ items: [], fallbackTier: null }));
  const contentItems = cfResult.items;
  const contentMap = new Map(
    contentItems.map(c => [c.url, c.content]).filter(([, v]) => v),
  );
  let results = serp.results;
  try {
    const r = await semanticRerank(results, q, contentMap, { config, topN: 8 });
    if (r.applied) results = r.results;
  } catch {
    // rerank failure doesn't block the refresh.
  }
  setCachedSearch(q, serp.provider, results, contentMap, intent);
}

// ─── Health-check surface for `melo doctor` ─────────────────────────────────
//
// Exposes a single async probe that tells the CLI whether each leg of the
// search subsystem is usable. We keep it here (rather than in index.js) so
// all knowledge about cache paths, provider priority, and Jina base URLs
// stays co-located with the tool itself.

export function getSearchCacheDbPath() {
  return cacheDbPath();
}

/**
 * Stats about the on-disk search cache — row counts across both tables,
 * rough freshness, and overall DB size. Returned for `melo search --cache stats`.
 */
export async function getCacheStats() {
  let sizeBytes = 0;
  try {
    const st = await stat(cacheDbPath());
    sizeBytes = st.size;
  } catch {
    return {
      exists: false,
      path: cacheDbPath(),
      sizeBytes: 0,
      searchCache: { rows: 0, freshRows: 0, oldestAgeMs: null, newestAgeMs: null },
      urlCache: { rows: 0, freshRows: 0, oldestAgeMs: null, newestAgeMs: null },
      searchTtlMs: SEARCH_CACHE_TTL_MS,
      urlTtlMs: URL_CACHE_TTL_MS,
    };
  }

  const now = Date.now();
  let searchStats = { rows: 0, freshRows: 0, oldestAgeMs: null, newestAgeMs: null };
  let urlStats = { rows: 0, freshRows: 0, oldestAgeMs: null, newestAgeMs: null };

  try {
    const db = getCacheDb();
    const sRow = db.prepare(
      'SELECT COUNT(*) AS c, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM web_search_cache',
    ).get();
    const sFresh = db.prepare(
      'SELECT COUNT(*) AS c FROM web_search_cache WHERE created_at > ?',
    ).get(now - SEARCH_CACHE_TTL_MS);
    searchStats = {
      rows: Number(sRow?.c || 0),
      freshRows: Number(sFresh?.c || 0),
      oldestAgeMs: sRow?.oldest ? now - Number(sRow.oldest) : null,
      newestAgeMs: sRow?.newest ? now - Number(sRow.newest) : null,
    };

    const uRow = db.prepare(
      'SELECT COUNT(*) AS c, MIN(fetched_at) AS oldest, MAX(fetched_at) AS newest FROM url_content_cache',
    ).get();
    const uFresh = db.prepare(
      'SELECT COUNT(*) AS c FROM url_content_cache WHERE fetched_at > ?',
    ).get(now - URL_CACHE_TTL_MS);
    urlStats = {
      rows: Number(uRow?.c || 0),
      freshRows: Number(uFresh?.c || 0),
      oldestAgeMs: uRow?.oldest ? now - Number(uRow.oldest) : null,
      newestAgeMs: uRow?.newest ? now - Number(uRow.newest) : null,
    };
  } catch (error) {
    debugWarn('web_search', `cache stats failed:`, error?.message || error);
  }

  return {
    exists: true,
    path: cacheDbPath(),
    sizeBytes,
    searchCache: searchStats,
    urlCache: urlStats,
    searchTtlMs: SEARCH_CACHE_TTL_MS,
    urlTtlMs: URL_CACHE_TTL_MS,
  };
}

/**
 * Clear the search caches. `scope` may be 'all' (default), 'search', 'url',
 * or 'stale' (rows older than their TTL). Returns the deleted row count.
 */
export function clearCache(scope = 'all') {
  const validScopes = new Set(['all', 'search', 'url', 'stale']);
  if (!validScopes.has(scope)) {
    throw new Error(`Unknown cache scope: ${scope}. Expected one of: ${[...validScopes].join(', ')}`);
  }
  try {
    const db = getCacheDb();
    let deleted = 0;
    if (scope === 'all' || scope === 'search') {
      const r = db.prepare('DELETE FROM web_search_cache').run();
      deleted += Number(r.changes || 0);
    }
    if (scope === 'all' || scope === 'url') {
      const r = db.prepare('DELETE FROM url_content_cache').run();
      deleted += Number(r.changes || 0);
    }
    if (scope === 'stale') {
      const now = Date.now();
      const r1 = db.prepare('DELETE FROM web_search_cache WHERE created_at <= ?').run(now - SEARCH_CACHE_TTL_MS);
      const r2 = db.prepare('DELETE FROM url_content_cache WHERE fetched_at <= ?').run(now - URL_CACHE_TTL_MS);
      deleted = Number(r1.changes || 0) + Number(r2.changes || 0);
    }
    return { ok: true, deleted, scope };
  } catch (error) {
    return { ok: false, deleted: 0, scope, error: error?.message || String(error) };
  }
}

async function probeJinaReachability(signal) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 3500);
  const combined = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;
  try {
    // HEAD on the Jina reader landing page. Any 2xx/3xx means DNS + TLS +
    // Jina front-end are up; anything else means the fallback leg is down.
    const res = await fetch(JINA_READER_BASE, { method: 'HEAD', signal: combined });
    return { reachable: res.ok || (res.status >= 200 && res.status < 400), status: res.status };
  } catch (err) {
    return { reachable: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeCacheDb() {
  try {
    const st = await stat(cacheDbPath());
    let rowCount = 0;
    let lastQueryAgeMs = null;
    try {
      const db = getCacheDb();
      const row = db.prepare('SELECT COUNT(*) AS c, MAX(created_at) AS latest FROM web_search_cache').get();
      rowCount = Number(row?.c || 0);
      if (row?.latest) lastQueryAgeMs = Date.now() - Number(row.latest);
    } catch {
      /* ignore — existence + size still useful */
    }
    return {
      exists: true,
      path: cacheDbPath(),
      sizeBytes: st.size,
      rowCount,
      lastQueryAgeMs,
      ttlMs: SEARCH_CACHE_TTL_MS,
    };
  } catch {
    return { exists: false, path: cacheDbPath(), sizeBytes: 0, rowCount: 0, lastQueryAgeMs: null, ttlMs: SEARCH_CACHE_TTL_MS };
  }
}

/**
 * Test-only bundle — re-exported so unit tests in `webSearchTool.helpers.test.js`
 * can drive the pure helpers directly without spinning up Playwright / Jina
 * / SQLite.  Not part of the public tool surface; do not consume in
 * application code.
 */
export const __webSearchInternals = {
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
  sha1Short,
};

export async function checkSearchHealth({ signal } = {}) {
  // G-1c follow-up #5 (consistency): wrap PW probe in abortRace so health
  // check honors caller signal too (was previously bare await — discovered
  // during the systematic PW await audit triggered by Codex C round-5).
  const [playwright, jina, cacheDb] = await Promise.all([
    abortRace(isPlaywrightCliAvailable(), signal).then(
      ok => ({ available: Boolean(ok) }),
      err => ({ available: false, error: err?.message || String(err) }),
    ),
    probeJinaReachability(signal),
    probeCacheDb(),
  ]);

  const primaryOk = playwright.available;
  const fallbackOk = jina.reachable;
  const healthy = primaryOk || fallbackOk;

  return {
    healthy,
    playwright,
    jina,
    cacheDb,
    summary: healthy
      ? `search: ${primaryOk ? 'playwright ✓' : 'playwright ✗'}, ${fallbackOk ? 'jina ✓' : 'jina ✗'}, cache ${cacheDb.exists ? `${cacheDb.rowCount} rows` : 'empty'}`
      : 'search: no provider reachable (playwright ✗, jina ✗)',
  };
}
