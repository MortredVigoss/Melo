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
import { isSocialLinkUrl, readSocialLink } from './socialLinkTool.js';

const JINA_READER_BASE = 'https://r.jina.ai/';
const MAX_CONTENT_LENGTH = 20_000; // chars
const FETCH_TIMEOUT_MS = 30_000;
const PLAYWRIGHT_TIMEOUT_MS = 20_000;

// Minimum character count at which we trust the extracted content is "real"
// (not a cookie wall, not an empty SPA shell). Below this we escalate to the
// next extractor.
const CONTENT_OK_THRESHOLD = 120;

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
        enum: ['auto', 'jina', 'direct', 'playwright'],
        description:
          'Extraction mode. "auto" tries Jina first, falls back to direct, then to a ' +
          'real browser (Playwright) for SPA/JS-heavy pages that return empty shells. ' +
          '"jina" forces Jina reader. "direct" forces plain fetch + Readability. ' +
          '"playwright" forces the real-browser path (slower, use only when auto fails).',
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

  async run({ url, extract_mode = 'auto', cookies }, { signal, config, _readSocialLink } = {}) {
    // Basic URL validation
    if (!url || typeof url !== 'string') {
      return { ok: false, output: 'Missing or invalid url parameter.', error: 'INVALID_URL' };
    }
    const normalized = url.trim();
    if (!/^https?:\/\//i.test(normalized)) {
      return { ok: false, output: `URL must start with http:// or https://: ${normalized}`, error: 'INVALID_URL' };
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
        if (socialResult?.body) {
          const body = socialResult.body;
          const truncated = body.length > MAX_CONTENT_LENGTH
            ? body.slice(0, MAX_CONTENT_LENGTH) + `\n\n[Content truncated at ${MAX_CONTENT_LENGTH} characters]`
            : body;
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
          };
        }
        // social-link miss — fall through to a clear actionable error
        // (NOT to jina/direct/playwright, which are guaranteed to also
        // miss and would just burn the budget).
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
        };
      } catch (err) {
        debugWarn('fetch_url', `social-link extractor threw for ${normalized}:`, err?.message || err);
        return {
          ok: false,
          output: `Social-link extractor failed: ${err?.message || err}`,
          error: 'SOCIAL_LINK_FAILED',
        };
      }
    }

    // Resolve cookies: explicit param wins, then config.domainCookies
    const cookieStr = (cookies && String(cookies).trim())
      || resolveCookiesForUrl(normalized, config);

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
      if (!(await isPlaywrightCliAvailable())) {
        return null;
      }
      const { content: pwContent } = await fetchPageViaPlaywright(normalized, {
        timeoutMs: PLAYWRIGHT_TIMEOUT_MS,
        maxChars: MAX_CONTENT_LENGTH,
      });
      return pwContent || null;
    };

    try {
      if (extract_mode === 'direct') {
        content = await fetchDirect(normalized, signal, cookieStr);
        method = cookieStr ? 'direct+cookie' : 'direct';
      } else if (extract_mode === 'jina') {
        // Jina doesn't forward our cookies — fall through to direct for authenticated URLs
        if (cookieStr) {
          content = await fetchDirect(normalized, signal, cookieStr);
          method = 'direct+cookie';
        } else {
          content = await fetchViaJina(normalized, signal);
          method = 'jina';
        }
      } else if (extract_mode === 'playwright') {
        const pwContent = await tryPlaywright();
        if (!pwContent) {
          return {
            ok: false,
            output: `Playwright extraction returned no content for "${normalized}".`,
            error: 'NO_CONTENT',
          };
        }
        content = pwContent;
        method = 'playwright';
      } else {
        // auto: cookies present → direct first; otherwise Jina first.
        // Final escalation tier: Playwright (real browser) for SPA / JS-heavy
        // pages that return empty shells via both HTTP-level fetchers.
        if (cookieStr) {
          try {
            content = await fetchDirect(normalized, signal, cookieStr);
            method = 'direct+cookie';
          } catch (err) {
            debugWarn('fetch_url', `direct+cookie failed, falling back to Jina for ${normalized}:`, err?.message || err);
            content = await fetchViaJina(normalized, signal);
            method = 'jina';
          }
        } else {
          try {
            content = await fetchViaJina(normalized, signal);
            method = 'jina';
          } catch (err) {
            debugWarn('fetch_url', `Jina failed, falling back to direct for ${normalized}:`, err?.message || err);
            try {
              content = await fetchDirect(normalized, signal, '');
              method = 'direct';
            } catch (err2) {
              debugWarn('fetch_url', `direct also failed, escalating to Playwright for ${normalized}:`, err2?.message || err2);
              content = '';
            }
          }
        }

        // 3rd-layer escalation: if neither HTTP-level extractor produced usable
        // content, try a real browser. This is slow (~5-15s) but catches sites
        // that render everything client-side.
        if (looksEmpty(content)) {
          try {
            const pwContent = await tryPlaywright();
            if (pwContent && !looksEmpty(pwContent)) {
              content = pwContent;
              method = method ? `${method}→playwright` : 'playwright';
            }
          } catch (err) {
            debugWarn('fetch_url', `Playwright escalation failed for ${normalized}:`, err?.message || err);
          }
        }
      }
    } catch (err) {
      return {
        ok: false,
        output: `Failed to fetch "${normalized}": ${err.message}`,
        error: err.message,
      };
    }

    if (!content.trim()) {
      return { ok: false, output: `No readable content found at "${normalized}".`, error: 'NO_CONTENT' };
    }

    // Truncate
    const truncated = content.length > MAX_CONTENT_LENGTH
      ? content.slice(0, MAX_CONTENT_LENGTH) + `\n\n[Content truncated at ${MAX_CONTENT_LENGTH} characters]`
      : content;

    // Append citation marker
    const output = `${truncated}\n\n[source: ${normalized}] [via: ${method}]`;

    return { ok: true, output, meta: { url: normalized, method, length: content.length } };
  },
};
