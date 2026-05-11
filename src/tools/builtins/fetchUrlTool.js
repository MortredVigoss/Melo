/**
 * fetch_url tool
 *
 * Fetches and extracts readable content from a URL.
 * Primary: Jina AI Reader (https://r.jina.ai/<url>) — handles JS-rendered pages, free, no API key.
 * Fallback: Direct fetch + @mozilla/readability for static HTML.
 *
 * Returns clean markdown/text content with source citation markers.
 */

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { debugWarn } from '../../debug.js';
import { fetchPageViaPlaywright, isPlaywrightCliAvailable } from '../../web/playwrightFetcher.js';
import { readUrlWithExternalReaders } from '../../web/externalReaders.js';
import { isSocialLinkUrl, readSocialLink } from './socialLinkTool.js';
import { wrapWithTrailLog } from '../../services/search/trailLogger.js';

const JINA_READER_BASE = 'https://r.jina.ai/';
const MAX_CONTENT_LENGTH = 20_000; // chars
const FETCH_TIMEOUT_MS = 30_000;
const PLAYWRIGHT_TIMEOUT_MS = 20_000;

// Minimum character count at which we trust the extracted content is "real"
// (not a cookie wall, not an empty SPA shell). Below this we escalate to the
// next extractor.
const CONTENT_OK_THRESHOLD = 120;

// ─── Phase G-1a (2026-05-10): evidenceTrail collection ────────────────────────
//
// Every `fetch_url` call now collects a structured trail of which fallback
// tier ran, with what outcome, in how long, and why if it failed.  See
// docs/search-system-roadmap.md §#1 for the full schema and rationale.
//
// POC scope (this commit): collect + propagate via `evidenceTrail` on the
// return object (top-level for fail paths, top-level for success paths too —
// callers ignore unknown fields, so this is back-compat).  Surfacing the
// trail in chat thread state, prompt context, and UI is later milestones
// (G-1d / G-1e / G-1f) — first we need real production data on what
// fallback chains actually look like in the wild.
//
// Tier vocabulary (lowercase, hyphen-separated): 'cookie-resolve' |
// 'social-link' | 'direct' | 'direct+cookie' | 'jina' | 'playwright' |
// 'external-reader' | 'validate'.  Outcome: 'ok' | 'fail' | 'skip'.  Reason
// codes are free-form short tokens — keep them grep-able ('login-wall',
// 'extractor-throw', 'parse-empty', 'no-content', 'timeout', '4xx', '5xx',
// 'cli-missing', 'invalid-url'), used by future analytics + UI labels.
function recordTrail(trail, tier, outcome, opts = {}) {
  if (!Array.isArray(trail)) return;
  const entry = { tier, outcome, latencyMs: Math.max(0, Number(opts.latencyMs) || 0) };
  if (opts.reason) entry.reason = opts.reason;
  if (opts.method) entry.method = opts.method;
  // Field name is `extra` (not `metadata`) to avoid colliding with the
  // top-level `meta:` legacy contract on social-link returns — a regression
  // test (fetchUrlTool.socialRoute.test.js) greps the file for stray
  // `metadata:` keys to catch ae80457's regression, and trail entries
  // would false-positive that grep otherwise.
  if (opts.extra && Object.keys(opts.extra).length) entry.extra = opts.extra;
  trail.push(entry);
}

// ─── Jina AI Reader ───────────────────────────────────────────────────────────

async function fetchViaJina(url, signal) {
  const jinaUrl = `${JINA_READER_BASE}${encodeURIComponent(url)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const combined = signal
    ? AbortSignal.any([signal, ac.signal])
    : ac.signal;

  try {
    const res = await fetch(jinaUrl, {
      signal: combined,
      headers: {
        'Accept': 'text/plain, text/markdown, */*',
        'X-Return-Format': 'markdown',
        'X-Timeout': '20',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Jina returned ${res.status}`);
    const text = await res.text();
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

// ─── Cookie resolver ──────────────────────────────────────────────────────────

/**
 * Resolve the best cookie string for a given URL from the config's domainCookies map.
 * config.domainCookies: { "y.qq.com": "uin=xxx; skey=yyy", "bilibili.com": "SESSDATA=zzz" }
 * Matches exact hostname or suffix (e.g. "qq.com" covers "y.qq.com").
 */
function resolveCookiesForUrl(url, config) {
  const domainCookies = config?.domainCookies;
  if (!domainCookies || typeof domainCookies !== 'object') return '';
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    for (const [domain, cookieStr] of Object.entries(domainCookies)) {
      const d = domain.replace(/^\./, '').replace(/^www\./, '');
      if (hostname === d || hostname.endsWith(`.${d}`)) {
        return String(cookieStr || '').trim();
      }
    }
  } catch (error) {
    debugWarn('fetch_url', `cookie resolution failed for ${url}:`, error?.message || error);
  }
  return '';
}

// ─── Direct fetch + Readability fallback ─────────────────────────────────────

async function fetchDirect(url, signal, cookieStr = '') {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const combined = signal
    ? AbortSignal.any([signal, ac.signal])
    : ac.signal;

  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; Melo/1.0)' };
  if (cookieStr) headers['Cookie'] = cookieStr;

  try {
    const res = await fetch(url, {
      signal: combined,
      headers,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      // Non-HTML: return raw text up to limit
      const text = await res.text();
      return text.trim().slice(0, MAX_CONTENT_LENGTH);
    }

    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article) throw new Error('Could not parse article content');

    const lines = [];
    if (article.title) lines.push(`# ${article.title}`);
    if (article.textContent) lines.push(article.textContent.trim());
    return lines.join('\n\n');
  } finally {
    clearTimeout(timer);
  }
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export const fetchUrlTool = {
  id: 'fetch_url',
  name: 'Fetch URL',
  description:
    'Fetch and extract readable content from any URL. Supports JavaScript-rendered pages. ' +
    'Use this to read web pages, documentation, articles, and other online resources.',
  category: 'web',
  isConcurrencySafe: true,
  requiresPermission: false,
  parametersSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The full URL to fetch (must start with http:// or https://).',
      },
      extract_mode: {
        type: 'string',
        enum: ['auto', 'jina', 'direct', 'playwright', 'crawl4ai', 'scrapling', 'camoufox'],
        description:
          'Extraction mode. "auto" tries Jina first, falls back to direct, then to a ' +
          'real browser (Playwright), then optional local readers (Crawl4AI, Scrapling, Camoufox) ' +
          'for SPA/JS-heavy pages that return empty shells. ' +
          '"jina" forces Jina reader. "direct" forces plain fetch + Readability. ' +
          '"playwright" forces the real-browser path (slower, use only when auto fails). ' +
          '"crawl4ai", "scrapling", and "camoufox" force optional local CLI readers when installed.',
        default: 'auto',
      },
      cookies: {
        type: 'string',
        description:
          'Optional Cookie header for authenticated requests (e.g. "uin=xxx; skey=yyy"). ' +
          'Domain cookies can also be configured globally in config.domainCookies.',
      },
    },
    required: ['url'],
  },
  examples: [
    { url: 'https://example.com' },
    { url: 'https://docs.python.org/3/library/json.html', extract_mode: 'jina' },
  ],

  // G-2b Phase 2 (2026-05-11 lesson #5): wrap run so every return path
  // is captured into $MELO_HOME/desktop/search-trail-log/YYYY-MM-DD.jsonl
  // when env var MELO_SEARCH_TRAIL_LOG=1.  No-op by default.  See
  // docs/search-task-rfc.md §7 for the rationale (4 Codex C-rounds on
  // adapter fixtures that turned out to be hand-written guesses; we
  // need real production shape snapshots before G-2b round-5 push).
  run: wrapWithTrailLog('url-fetch', async function run({ url, extract_mode = 'auto', cookies }, {
    signal,
    config,
    _readSocialLink,
    _readExternalUrl,
    // Phase G-1a follow-up #2 (Codex 2026-05-10): test seams for the
    // remaining three internal fetchers — without these, evidenceTrail
    // regression tests can only assert source shape, not actual runtime
    // behavior on the parse-empty / throw paths Codex flagged.
    // Production callers never set these (same convention as
    // _readSocialLink / _readExternalUrl above).
    _fetchViaJina,
    _fetchDirect,
    _tryPlaywright: _tryPlaywrightOverride,
  } = {}) {
    const trail = [];
    const tStart = Date.now();
    // Local aliases — when an override is supplied, all call sites in
    // run() route through the mock; otherwise they hit the real module-
    // scope implementation.  Keeping the variable name distinct (`call*`)
    // makes the seam explicit and avoids accidentally shadowing the
    // imported helper across the file.
    const callJina = typeof _fetchViaJina === 'function' ? _fetchViaJina : fetchViaJina;
    const callDirect = typeof _fetchDirect === 'function' ? _fetchDirect : fetchDirect;
    // Basic URL validation
    if (!url || typeof url !== 'string') {
      recordTrail(trail, 'validate', 'fail', { reason: 'invalid-url', latencyMs: 0 });
      return { ok: false, output: 'Missing or invalid url parameter.', error: 'INVALID_URL', evidenceTrail: trail };
    }
    const normalized = url.trim();
    if (!/^https?:\/\//i.test(normalized)) {
      recordTrail(trail, 'validate', 'fail', { reason: 'invalid-url', latencyMs: 0 });
      return { ok: false, output: `URL must start with http:// or https://: ${normalized}`, error: 'INVALID_URL', evidenceTrail: trail };
    }

    // Phase 6 (2026-05-05) early-route: CN/short-form social platforms
    // (Xiaohongshu, Douyin, xhslink, iesdouyin, v.douyin) bypass the
    // jina/direct/playwright chain entirely. Those endpoints serve
    // login walls, JS shells, anti-bot challenges — every hop in the
    // generic chain wastes the budget and returns shell-only HTML.
    // The dedicated socialLinkTool tries short-link resolve → yt-dlp
    // (with config.domainCookies) → rendered browser overlay-close
    // fallback → OpenGraph fallback. The user can
    // still pass extract_mode='playwright' explicitly to override
    // (escape hatch for diagnosis), but auto / direct / jina all
    // re-route here when the host matches.
    //
    // Phase 6 follow-up (Codex 🔵 P0 2026-05-05):
    //   • Honour the explicit `cookies` param — fetch_url's existing
    //     contract is "explicit cookies wins, then config.domainCookies".
    //     We now thread the explicit cookie string into a per-call config
    //     overlay so socialLinkTool's yt-dlp branch picks it up. The
    //     overlay binds to the CANONICAL host (post-short-link resolve),
    //     so a user-provided xiaohongshu.com cookie hits xhslink.com →
    //     xiaohongshu.com correctly.
    //   • Return shape: success uses `meta` (matches the legacy
    //     fetch_url contract at the bottom of run()), NOT `metadata`.
    if (isSocialLinkUrl(normalized) && extract_mode !== 'playwright') {
      const tSocial = Date.now();
      try {
        const explicitCookies = (cookies && String(cookies).trim()) || '';
        // _readSocialLink is a test seam — production callers never set
        // it. Lets unit tests inject a controlled reader so success-shape
        // assertions don't have to wrestle with the live yt-dlp binary
        // or external network. Codex Phase 6 follow-up (⚪ P2 2026-05-05).
        const reader = typeof _readSocialLink === 'function' ? _readSocialLink : readSocialLink;
        const socialResult = await reader(normalized, {
          config,
          explicitCookies,
          signal,
        });
        // Phase G-1b (2026-05-10): merge social sub-trail into our flat
        // trail with a `social-link.` tier prefix so downstream analytics
        // can distinguish where each entry originated (outer fetchUrl tier
        // vs nested socialLink sub-tier) without losing the depth info.
        // Done unconditionally — even miss/abort paths return a trail
        // worth knowing about (which sub-strategy got far enough to fail).
        if (Array.isArray(socialResult?.evidenceTrail)) {
          for (const e of socialResult.evidenceTrail) {
            trail.push({ ...e, tier: `social-link.${e.tier}` });
          }
        }
        if (socialResult?.body) {
          const body = socialResult.body;
          const truncated = body.length > MAX_CONTENT_LENGTH
            ? body.slice(0, MAX_CONTENT_LENGTH) + `\n\n[Content truncated at ${MAX_CONTENT_LENGTH} characters]`
            : body;
          recordTrail(trail, 'social-link', 'ok', {
            latencyMs: Date.now() - tSocial,
            method: socialResult.via,
            extra: { hasExplicitCookies: !!explicitCookies, canonicalUrl: socialResult.canonicalUrl },
          });
          return {
            ok: true,
            output: truncated,
            meta: {
              url: normalized,
              method: 'social-link',
              length: truncated.length,
              // socialResult.via lets the caller see which sub-strategy
              // succeeded — 'yt-dlp' / 'browser:*' / 'share-preview:*' — useful for
              // debugging extractor health without re-running.
              via: socialResult.via,
              canonicalUrl: socialResult.canonicalUrl,
            },
            evidenceTrail: trail,
          };
        }
        // social-link miss — fall through to a clear actionable error
        // (NOT to jina/direct/playwright, which are guaranteed to also
        // miss and would just burn the budget).
        recordTrail(trail, 'social-link', 'fail', {
          latencyMs: Date.now() - tSocial,
          reason: 'login-wall',
          extra: { hasExplicitCookies: !!explicitCookies },
        });
        return {
          ok: false,
          output:
            `Could not read this social-link URL: ${normalized}\n\n` +
            `The dedicated extractor (yt-dlp + browser overlay-close fallback + share preview fallback) returned no usable content. ` +
            `Common cause: the post requires a login session. Add the host's cookie ` +
            `string under Customize → Safety → Web-fetch cookies. Hosts to add for ` +
            `this URL family: xiaohongshu.com, xhslink.com, douyin.com, ` +
            `iesdouyin.com, v.douyin.com.`,
          error: 'SOCIAL_LINK_BLOCKED',
          evidenceTrail: trail,
        };
      } catch (err) {
        debugWarn('fetch_url', `social-link extractor threw for ${normalized}:`, err?.message || err);
        recordTrail(trail, 'social-link', 'fail', {
          latencyMs: Date.now() - tSocial,
          reason: 'extractor-throw',
          extra: { errMessage: String(err?.message || err).slice(0, 200) },
        });
        return {
          ok: false,
          output: `Social-link extractor failed: ${err?.message || err}`,
          error: 'SOCIAL_LINK_FAILED',
          evidenceTrail: trail,
        };
      }
    }

    // Resolve cookies: explicit param wins, then config.domainCookies
    const cookieStr = (cookies && String(cookies).trim())
      || resolveCookiesForUrl(normalized, config);
    recordTrail(trail, 'cookie-resolve', cookieStr ? 'ok' : 'skip', {
      latencyMs: 0,
      reason: cookieStr ? undefined : 'no-cookie',
      extra: { hasExplicit: !!(cookies && String(cookies).trim()) },
    });

    let content = '';
    let method = '';

    // Helper: decide whether content is "real enough" to return without
    // escalating to the next extractor. Very short payloads from an SPA shell,
    // a JS-challenge page, or a cookie/consent wall should be treated as an
    // extractor miss, not success.
    const looksEmpty = (c) => !c || c.replace(/\s+/g, '').length < CONTENT_OK_THRESHOLD;

    // Playwright fallback helper — shared-session browser, cookies NOT applied
    // (the CLI runs its own Chromium context). We only reach this when Jina and
    // direct-fetch both failed or returned shell-only HTML.
    const tryPlaywright = async () => {
      // Phase G-1a follow-up #2: test override path — when supplied, the
      // mock entirely replaces the real CLI probe + fetch (lets tests
      // force throw or short content without depending on host CLI state).
      if (typeof _tryPlaywrightOverride === 'function') {
        return _tryPlaywrightOverride();
      }
      if (!(await isPlaywrightCliAvailable())) {
        return null;
      }
      const { content: pwContent } = await fetchPageViaPlaywright(normalized, {
        timeoutMs: PLAYWRIGHT_TIMEOUT_MS,
        maxChars: MAX_CONTENT_LENGTH,
      });
      return pwContent || null;
    };

    const tryExternalReaders = async (preferred = ['crawl4ai', 'scrapling', 'camoufox']) => {
      const reader = typeof _readExternalUrl === 'function'
        ? _readExternalUrl
        : readUrlWithExternalReaders;
      return reader(normalized, {
        preferred,
        signal,
        config,
        cookies: cookieStr,
        maxChars: MAX_CONTENT_LENGTH,
        timeoutMs: PLAYWRIGHT_TIMEOUT_MS,
      });
    };

    // Phase G-1a follow-up #1 (Codex pre-pp B 2026-05-10): track which tier
    // was about to throw so the outer catch records the right tier instead
    // of `unknown`.  Each forced branch sets pendingTier + pendingTierStart
    // before the await; the outer catch reads them for the trail entry.
    let pendingTier = null;
    let pendingTierStart = 0;
    try {
      if (extract_mode === 'direct') {
        pendingTier = cookieStr ? 'direct+cookie' : 'direct';
        pendingTierStart = Date.now();
        content = await callDirect(normalized, signal, cookieStr);
        method = pendingTier;
        recordTrail(trail, method, 'ok', { latencyMs: Date.now() - pendingTierStart, extra: { extractMode: 'direct', bytes: content.length } });
        pendingTier = null;
      } else if (extract_mode === 'jina') {
        // Jina doesn't forward our cookies — fall through to direct for authenticated URLs
        if (cookieStr) {
          pendingTier = 'direct+cookie';
          pendingTierStart = Date.now();
          content = await callDirect(normalized, signal, cookieStr);
          method = 'direct+cookie';
          recordTrail(trail, 'direct+cookie', 'ok', { latencyMs: Date.now() - pendingTierStart, extra: { extractMode: 'jina-with-cookie', bytes: content.length } });
          pendingTier = null;
        } else {
          pendingTier = 'jina';
          pendingTierStart = Date.now();
          content = await callJina(normalized, signal);
          method = 'jina';
          recordTrail(trail, 'jina', 'ok', { latencyMs: Date.now() - pendingTierStart, extra: { extractMode: 'jina', bytes: content.length } });
          pendingTier = null;
        }
      } else if (extract_mode === 'playwright') {
        pendingTier = 'playwright';
        pendingTierStart = Date.now();
        const pwContent = await tryPlaywright();
        if (!pwContent) {
          recordTrail(trail, 'playwright', 'fail', { latencyMs: Date.now() - pendingTierStart, reason: 'no-content', extra: { extractMode: 'playwright' } });
          pendingTier = null;
          return {
            ok: false,
            output: `Playwright extraction returned no content for "${normalized}".`,
            error: 'NO_CONTENT',
            evidenceTrail: trail,
          };
        }
        content = pwContent;
        method = 'playwright';
        recordTrail(trail, 'playwright', 'ok', { latencyMs: Date.now() - pendingTierStart, extra: { extractMode: 'playwright', bytes: content.length } });
        pendingTier = null;
      } else if (['crawl4ai', 'scrapling', 'camoufox'].includes(extract_mode)) {
        pendingTier = 'external-reader';
        pendingTierStart = Date.now();
        const external = await tryExternalReaders([extract_mode]);
        if (!external?.content) {
          recordTrail(trail, 'external-reader', 'fail', { latencyMs: Date.now() - pendingTierStart, reason: 'cli-missing-or-no-content', method: extract_mode });
          pendingTier = null;
          return {
            ok: false,
            output: `${extract_mode} extraction returned no content for "${normalized}". Make sure the local CLI/package is installed.`,
            error: 'NO_CONTENT',
            evidenceTrail: trail,
          };
        }
        content = external.content;
        method = external.method || extract_mode;
        recordTrail(trail, 'external-reader', 'ok', { latencyMs: Date.now() - pendingTierStart, method: external.method || extract_mode, extra: { bytes: content.length } });
        pendingTier = null;
      } else {
        // auto: cookies present → direct first; otherwise Jina first.
        // Final escalation tier: Playwright (real browser) for SPA / JS-heavy
        // pages that return empty shells via both HTTP-level fetchers. If that
        // still misses, try optional local extraction CLIs (Crawl4AI,
        // Scrapling, Camoufox) without making them hard dependencies.
        // Phase G-1a follow-up #2 (Codex post-push B 2026-05-10): record
        // ok ONLY when the returned content passes the looksEmpty gate;
        // short content (parse-empty) gets recorded as fail so escalation
        // up to playwright/external is reflected in the trail as
        // "jina.fail parse-empty → playwright.ok" rather than the misleading
        // "jina.ok → playwright.ok".
        const tierOutcome = (c) => looksEmpty(c)
          ? { outcome: 'fail', reason: 'parse-empty' }
          : { outcome: 'ok' };
        if (cookieStr) {
          const tDc = Date.now();
          try {
            content = await callDirect(normalized, signal, cookieStr);
            method = 'direct+cookie';
            const r = tierOutcome(content);
            recordTrail(trail, 'direct+cookie', r.outcome, { latencyMs: Date.now() - tDc, reason: r.reason, extra: { bytes: content.length } });
          } catch (err) {
            debugWarn('fetch_url', `direct+cookie failed, falling back to Jina for ${normalized}:`, err?.message || err);
            recordTrail(trail, 'direct+cookie', 'fail', { latencyMs: Date.now() - tDc, reason: classifyFetchError(err) });
            const tJ = Date.now();
            content = await callJina(normalized, signal);
            method = 'jina';
            const r = tierOutcome(content);
            recordTrail(trail, 'jina', r.outcome, { latencyMs: Date.now() - tJ, reason: r.reason, extra: { bytes: content.length } });
          }
        } else {
          const tJ = Date.now();
          try {
            content = await callJina(normalized, signal);
            method = 'jina';
            const r = tierOutcome(content);
            recordTrail(trail, 'jina', r.outcome, { latencyMs: Date.now() - tJ, reason: r.reason, extra: { bytes: content.length } });
          } catch (err) {
            debugWarn('fetch_url', `Jina failed, falling back to direct for ${normalized}:`, err?.message || err);
            recordTrail(trail, 'jina', 'fail', { latencyMs: Date.now() - tJ, reason: classifyFetchError(err) });
            const tD = Date.now();
            try {
              content = await callDirect(normalized, signal, '');
              method = 'direct';
              const r = tierOutcome(content);
              recordTrail(trail, 'direct', r.outcome, { latencyMs: Date.now() - tD, reason: r.reason, extra: { bytes: content.length } });
            } catch (err2) {
              debugWarn('fetch_url', `direct also failed, escalating to Playwright for ${normalized}:`, err2?.message || err2);
              recordTrail(trail, 'direct', 'fail', { latencyMs: Date.now() - tD, reason: classifyFetchError(err2) });
              content = '';
            }
          }
        }

        // 3rd-layer escalation: if neither HTTP-level extractor produced usable
        // content, try a real browser. This is slow (~5-15s) but catches sites
        // that render everything client-side.
        if (looksEmpty(content)) {
          const tPw = Date.now();
          try {
            const pwContent = await tryPlaywright();
            if (pwContent && !looksEmpty(pwContent)) {
              content = pwContent;
              method = method ? `${method}→playwright` : 'playwright';
              recordTrail(trail, 'playwright', 'ok', { latencyMs: Date.now() - tPw, extra: { escalation: true, bytes: content.length } });
            } else {
              recordTrail(trail, 'playwright', 'fail', { latencyMs: Date.now() - tPw, reason: pwContent ? 'parse-empty' : 'cli-missing-or-no-content' });
            }
          } catch (err) {
            debugWarn('fetch_url', `Playwright escalation failed for ${normalized}:`, err?.message || err);
            recordTrail(trail, 'playwright', 'fail', { latencyMs: Date.now() - tPw, reason: classifyFetchError(err) });
          }
        }

        if (looksEmpty(content)) {
          const tEx = Date.now();
          try {
            const external = await tryExternalReaders();
            if (external?.content && !looksEmpty(external.content)) {
              content = external.content;
              method = method ? `${method}→${external.method}` : external.method;
              recordTrail(trail, 'external-reader', 'ok', { latencyMs: Date.now() - tEx, method: external.method, extra: { escalation: true, bytes: content.length } });
            } else {
              recordTrail(trail, 'external-reader', 'fail', { latencyMs: Date.now() - tEx, reason: 'no-content' });
            }
          } catch (err) {
            debugWarn('fetch_url', `external readers failed for ${normalized}:`, err?.message || err);
            recordTrail(trail, 'external-reader', 'fail', { latencyMs: Date.now() - tEx, reason: classifyFetchError(err) });
          }
        }
      }
    } catch (err) {
      // Phase G-1a follow-up #1: tier resolution priority — pendingTier
      // (set by forced branches just before the await that may throw),
      // then `method` (set after a forced branch successfully returned but
      // a downstream operation threw, which today shouldn't happen but
      // keep as a safety net), then 'unknown' (truly unrecoverable).
      const failTier = pendingTier || method || 'unknown';
      const failStart = pendingTier ? pendingTierStart : tStart;
      recordTrail(trail, failTier, 'fail', { latencyMs: Date.now() - failStart, reason: classifyFetchError(err) });
      return {
        ok: false,
        output: `Failed to fetch "${normalized}": ${err.message}`,
        error: err.message,
        evidenceTrail: trail,
      };
    }

    if (!content.trim()) {
      recordTrail(trail, 'validate', 'fail', { latencyMs: 0, reason: 'no-content-after-fallbacks' });
      return { ok: false, output: `No readable content found at "${normalized}".`, error: 'NO_CONTENT', evidenceTrail: trail };
    }

    // Truncate
    const truncated = content.length > MAX_CONTENT_LENGTH
      ? content.slice(0, MAX_CONTENT_LENGTH) + `\n\n[Content truncated at ${MAX_CONTENT_LENGTH} characters]`
      : content;

    // Append citation marker
    const output = `${truncated}\n\n[source: ${normalized}] [via: ${method}]`;

    return { ok: true, output, meta: { url: normalized, method, length: content.length }, evidenceTrail: trail };
  }),
};

// ─── Phase G-1a (2026-05-10): error classifier for evidenceTrail.reason ────
//
// Maps raw error messages thrown by fetchDirect / fetchViaJina /
// playwrightFetcher / externalReaders into short, grep-able reason codes.
// Keep the vocabulary small — analytics are easier with 5 buckets than
// 500 unique error.message strings.  Unknown errors fall back to 'error'
// so the trail still records "something went wrong" without losing the
// original message (the debugWarn line above keeps the verbatim text in
// stderr for debugging).
function classifyFetchError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (!msg) return 'error';
  if (msg.includes('abort')) return 'aborted';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('socket') || msg.includes('econnreset') || msg.includes('econnrefused')) return 'network';
  if (msg.includes('certificate') || msg.includes('ssl')) return 'tls';
  if (/\b4\d\d\b/.test(msg)) return '4xx';
  if (/\b5\d\d\b/.test(msg)) return '5xx';
  if (msg.includes('parse') || msg.includes('readability')) return 'parse-error';
  return 'error';
}
