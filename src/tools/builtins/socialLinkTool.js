// socialLinkTool.js — Phase 6 (2026-05-05).
//
// Read pipeline for CN/short-form social platforms (Xiaohongshu, Douyin,
// xhslink, iesdouyin, v.douyin). The user pasted a link → fetch_url
// noticed it's a social-link host → routes here BEFORE attempting
// jina/direct/playwright (all of which fail on these heavy-anti-bot
// JS-shell pages).
//
// Order of attempts:
//   1. Short-link resolution: HEAD-follow xhslink.com / v.douyin.com
//      to the canonical post URL. Both shorteners 301/302 to the real
//      page; the canonical URL is what yt-dlp's extractors expect.
//   2. yt-dlp metadata: same path the chat extraction pipeline uses
//      via youtubeExtractor.fetchPlatformMetadataViaYtdlp. Pulls
//      title, uploader, description, view/like counts, subtitles
//      (when available). Honours config.domainCookies for
//      authenticated reads.
//   3. OpenGraph / meta-tag fallback: plain HTTP GET + parse
//      <meta property="og:title" />, og:description, og:image. Useful
//      for cookie-walled posts where yt-dlp returns nothing but the
//      shell still serves OG tags. NO Playwright (the existing CLI
//      fallback can't apply cookies — Phase 7 territory).
//
// What this module does NOT do:
//   • Cookie-aware Playwright session — the daemon's persistent
//     context doesn't expose a `cookies` API today. Tracked as Phase 7.
//   • Async over-budget extraction (return optimistic + post-back) —
//     the budget refactor is structural and tracked as Phase 7.
//
// Returns a string body suitable for fetch_url's contract, or null
// when every attempt failed.

import { fetchPlatformMetadataViaYtdlp } from '../../media/extractors/youtubeExtractor.js';

// Browser-shaped UA — Douyin / Xiaohongshu CDNs reject node fetch's
// default UA with 403. Used for both the short-link resolve and the
// OpenGraph fallback GET.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const OG_FETCH_TIMEOUT_MS = 8000;

/**
 * Cheap HTTP GET that returns response body (truncated). Returns null
 * on any failure. Used by the OpenGraph fallback path — a plain text
 * fetch is enough because we only parse meta tags out of the head.
 */
async function fetchHtmlBody(url, { signal, maxBytes = 200_000, timeoutMs = OG_FETCH_TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const text = await res.text();
    return typeof text === 'string' ? text.slice(0, maxBytes) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

const SHORT_LINK_HOSTS = new Set(['xhslink.com', 'v.douyin.com']);
const SOCIAL_HOSTS = new Set([
  'douyin.com', 'v.douyin.com', 'iesdouyin.com',
  'xiaohongshu.com', 'xhslink.com',
]);

function hostnameOf(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * True for any URL that should bypass jina/direct/Playwright in fetch_url
 * and instead route through this module's social-link reader.
 */
export function isSocialLinkUrl(url) {
  const host = hostnameOf(url);
  if (!host) return false;
  if (SOCIAL_HOSTS.has(host)) return true;
  // Also catch sub-hosts like m.douyin.com / www.iesdouyin.com.
  for (const known of SOCIAL_HOSTS) {
    if (host === known || host.endsWith(`.${known}`)) return true;
  }
  return false;
}

/**
 * Resolve a short link by following redirects until landing on the
 * canonical URL. Returns the resolved URL or the original if not a
 * known shortener / no redirect.
 *
 * Uses a HEAD request first; some servers reject HEAD with 405, so we
 * fall back to GET with manual redirect tracking. Cap at 5 hops to
 * avoid infinite-redirect tarpits.
 */
export async function resolveShortLink(url, { signal, timeoutMs = 5000 } = {}) {
  const host = hostnameOf(url);
  if (!SHORT_LINK_HOSTS.has(host)) return url;

  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const t = setTimeout(() => ac.abort(), timeoutMs);
    let next = null;
    try {
      const res = await fetch(current, {
        method: 'HEAD',
        redirect: 'manual',
        signal: ac.signal,
      });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        next = new URL(loc, current).toString();
      }
    } catch {
      // HEAD may be rejected by anti-bot. Fall through to the GET retry below.
    } finally {
      clearTimeout(t);
      signal?.removeEventListener?.('abort', onAbort);
    }
    if (!next) {
      // GET fallback — same redirect handling, in case HEAD was 405/blocked.
      const ac2 = new AbortController();
      const onAbort2 = () => ac2.abort();
      signal?.addEventListener?.('abort', onAbort2, { once: true });
      const t2 = setTimeout(() => ac2.abort(), timeoutMs);
      try {
        const res = await fetch(current, {
          method: 'GET',
          redirect: 'manual',
          signal: ac2.signal,
          headers: {
            // A real-browser UA is required by Douyin's CDN; default
            // node fetch UA is rejected with 403.
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          },
        });
        const loc = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && loc) {
          next = new URL(loc, current).toString();
        }
      } catch {
        next = null;
      } finally {
        clearTimeout(t2);
        signal?.removeEventListener?.('abort', onAbort2);
      }
    }
    if (!next || next === current) break;
    current = next;
    // If we've left the shortener domain, stop walking — we have the
    // canonical URL.
    const nextHost = hostnameOf(current);
    if (!SHORT_LINK_HOSTS.has(nextHost)) break;
  }
  return current;
}

/**
 * Parse a small set of OpenGraph / Twitter-Card / standard meta tags
 * out of a raw HTML body. Returns a {title, description, image, siteName}
 * dict; missing fields stay undefined. Cheap regex parser — no full
 * HTML parse, no DOM walk.
 */
export function parseOpenGraph(html) {
  if (typeof html !== 'string' || !html) return {};
  const result = {};
  const metaRe = /<meta\s+([^>]+?)\/?>/gi;
  for (const m of html.matchAll(metaRe)) {
    const attrs = m[1];
    const propMatch = attrs.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i);
    const contentMatch = attrs.match(/content\s*=\s*["']([^"']*)["']/i);
    if (!propMatch || !contentMatch) continue;
    const key = propMatch[1].toLowerCase();
    const value = contentMatch[1].trim();
    if (!value) continue;
    if ((key === 'og:title' || key === 'twitter:title' || key === 'title') && !result.title) {
      result.title = value;
    } else if ((key === 'og:description' || key === 'twitter:description' || key === 'description') && !result.description) {
      result.description = value;
    } else if ((key === 'og:image' || key === 'twitter:image') && !result.image) {
      result.image = value;
    } else if (key === 'og:site_name' && !result.siteName) {
      result.siteName = value;
    }
  }
  // Title element fallback when meta tags are missing.
  if (!result.title) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) result.title = titleMatch[1].trim();
  }
  return result;
}

/**
 * Render a yt-dlp metadata bundle as a plain-text body matching what
 * fetch_url normally returns for a successful page read. Mirrors the
 * shape extractYoutubeContent uses.
 */
function renderYtdlpBody(meta, url) {
  const stats = [];
  if (meta.viewCount != null)    stats.push(`Views ${meta.viewCount}`);
  if (meta.likeCount != null)    stats.push(`Likes ${meta.likeCount}`);
  if (meta.commentCount != null) stats.push(`Comments ${meta.commentCount}`);
  if (meta.uploadDate)           stats.push(`Posted ${meta.uploadDate}`);
  const parts = [meta.title].filter(Boolean);
  if (meta.uploader) parts.push(`by ${meta.uploader}`);
  if (meta.duration) parts.push(`Duration: ${meta.duration}`);
  if (stats.length)  parts.push(stats.join(' · '));
  if (meta.description) parts.push(meta.description);
  if (meta.subtitleText) parts.push(`\nTranscript/Subtitles:\n${meta.subtitleText}`);
  parts.push(`\nSource: ${url}`);
  return parts.filter(Boolean).join('\n\n');
}

/**
 * Render an OpenGraph fallback bundle as a plain-text body. Smaller
 * surface than yt-dlp output — title + description + source URL only.
 */
function renderOpenGraphBody(og, url) {
  const parts = [];
  if (og.title) parts.push(og.title);
  if (og.siteName && og.siteName !== og.title) parts.push(`from ${og.siteName}`);
  if (og.description) parts.push(og.description);
  parts.push(`\nSource: ${url}`);
  parts.push(
    '\n[Note: full content is behind an anti-bot wall. The host\'s OpenGraph ' +
    'preview is shown above. Add the domain cookie under Customize → Safety → ' +
    'Web-fetch cookies for the full transcript.]',
  );
  return parts.filter(Boolean).join('\n\n');
}

/**
 * Build a per-call config that merges the caller's explicit cookie
 * string into config.domainCookies, keyed under the canonical host
 * (post-short-link resolve). This honours fetch_url's "explicit cookies
 * wins, then config.domainCookies" contract — the explicit value
 * overrides whatever the global config has for that host.
 *
 * Codex follow-up (Phase 6 🔵 P0 2026-05-05): the previous version
 * silently dropped the caller's cookies parameter. fetch_url's other
 * code paths (direct / jina) honour the explicit cookies; the social
 * route now matches.
 */
function configWithExplicitCookie(config, canonicalUrl, explicitCookies) {
  if (!explicitCookies || typeof explicitCookies !== 'string') {
    return config || {};
  }
  const host = hostnameOf(canonicalUrl);
  if (!host) return config || {};
  const baseCookies = (config?.domainCookies && typeof config.domainCookies === 'object')
    ? config.domainCookies
    : {};
  return {
    ...(config || {}),
    domainCookies: { ...baseCookies, [host]: explicitCookies },
  };
}

/**
 * Top-level read: try each strategy in order and return the first
 * non-empty result.
 *
 * Return shape:
 *   { body: string, via: 'yt-dlp' | 'opengraph', canonicalUrl: string }
 *   on success; null when every strategy missed. The structured shape
 *   replaces the prior bare-string return so callers can record which
 *   sub-strategy succeeded (Phase 6 follow-up — fetch_url uses this in
 *   meta.via to distinguish a yt-dlp-rich body from an OG-only stub).
 *
 * Honours an optional `explicitCookies` string — bound to the
 * canonical host post-resolveShortLink. Any cookie set under
 * config.domainCookies for the same host is overridden for this call.
 */
export async function readSocialLink(url, {
  config = {},
  explicitCookies = '',
  signal,
  ytdlpFn = fetchPlatformMetadataViaYtdlp,
} = {}) {
  if (!isSocialLinkUrl(url)) return null;

  // Step 1 — short-link resolve.
  let canonical = url;
  try {
    canonical = await resolveShortLink(url, { signal });
  } catch {
    canonical = url;
  }

  // Build the effective config now that we know the canonical host —
  // explicit cookies bind to the resolved host, not the shortener.
  const effectiveConfig = configWithExplicitCookie(config, canonical, explicitCookies);

  // Step 2 — yt-dlp metadata. The injected ytdlpFn lets unit tests
  // exercise the rendering / fallback logic without invoking the real
  // yt-dlp binary.
  try {
    const meta = await ytdlpFn(canonical, effectiveConfig, { signal });
    if (meta && (meta.title || meta.description || meta.subtitleText)) {
      return {
        body: renderYtdlpBody(meta, canonical),
        via: 'yt-dlp',
        canonicalUrl: canonical,
      };
    }
  } catch {
    // Fall through to OG.
  }

  // Step 3 — OpenGraph / meta-tag fallback. Cheap, cookie-less, often
  // works on Xiaohongshu where yt-dlp can't strip the JS shell.
  try {
    const html = await fetchHtmlBody(canonical, { signal });
    if (html) {
      const og = parseOpenGraph(html);
      if (og.title || og.description) {
        return {
          body: renderOpenGraphBody(og, canonical),
          via: 'opengraph',
          canonicalUrl: canonical,
        };
      }
    }
  } catch {
    // Total miss.
  }
  return null;
}
