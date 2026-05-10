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
//   3. Browser-rendered fallback: real Playwright page, close login /
//      app-prompt overlays, then extract visible text and video element
//      metadata. This catches Douyin/XHS pages where content is present
//      after clicking the modal X.
//   4. Optional external readers: Camoufox / Crawl4AI / Scrapling if
//      installed locally. These are not hard dependencies.
//   5. Share-preview unfurl fallback: fetch the page with chat-app /
//      crawler / mobile WebView user agents, then parse OpenGraph,
//      Twitter Card, JSON-LD, and common SSR JSON string fields. This
//      mirrors the "I pasted it into Telegram/WeChat and got a useful
//      preview" path, but it must NOT mask deeper results.
//
// What this module does NOT do:
//   • Cookie-aware Playwright session — the daemon's persistent
//     context doesn't expose a `cookies` API today. Cookies still go
//     to yt-dlp through config.domainCookies / explicitCookies.
//   • Async over-budget extraction (return optimistic + post-back) —
//     the budget refactor is structural and tracked as Phase 7.
//
// Returns a string body suitable for fetch_url's contract, or null
// when every attempt failed.

import { fetchPlatformMetadataViaYtdlp } from '../../media/extractors/youtubeExtractor.js';
import { readUrlWithExternalReaders } from '../../web/externalReaders.js';

// ─── Phase G-1b (2026-05-10): evidenceTrail collection for social-link ────
//
// Mirrors the recordTrail/EvidenceTrailEntry contract from fetchUrlTool
// (see docs/search-system-roadmap.md §#1).  readSocialLink() now returns
// `{ ..., evidenceTrail: [{tier, outcome, latencyMs, reason?, method?, extra?}] }`
// even on success/null paths.  fetchUrlTool merges these sub-entries into
// its own trail with a `social-link.` prefix on the tier name to keep the
// flat trail shape from G-1a while still distinguishing where each entry
// originated from.
//
// Sub-tiers we record:
//   • short-link-resolve (xhslink/v.douyin → canonical URL HEAD-follow)
//   • yt-dlp             (deep metadata via youtubeExtractor)
//   • share-preview      (OG/JSON-LD/SSR cards)
//   • browser            (Playwright headless + overlay-close)
//   • external-reader    (camoufox/crawl4ai/scrapling)
// Outcome 'skip' covers the `if (signal?.aborted) return` early-bail
// branches so consumers can tell "we didn't try X" from "X failed".
// Phase G-1b follow-up #1 (Codex C 闭环 2026-05-10): mid-loop abort
// helper.  Multi-candidate loops in share-preview/browser/external-reader
// previously did a bare `if (signal?.aborted) return null;` which broke
// the G-1b contract that every social-link return carries an
// evidenceTrail.  This helper records the current tier as fail
// reason=aborted-mid-loop AND the remaining (untried) tiers as skip
// reason=aborted-by-prev-tier, so the trail is always shape-stable
// (5 entries when we reach this layer or later) and analytics scripts
// can tell "we got to share-preview and were killed" from "we never
// tried browser".  User-decided contract on 2026-05-10:
//   • current tier → fail (it WAS running when abort hit)
//   • untried tiers → skip (we never started them)
//   • aborted marker { body:'', via:'aborted', evidenceTrail, aborted:true }
function bailAbortedSocial(trail, currentTier, remainingTiers, canonical) {
  recordSocialTrail(trail, currentTier, 'fail', { reason: 'aborted-mid-loop' });
  for (const t of (remainingTiers || [])) {
    recordSocialTrail(trail, t, 'skip', { reason: 'aborted-by-prev-tier' });
  }
  return { body: '', via: 'aborted', canonicalUrl: canonical, evidenceTrail: trail, aborted: true };
}

function recordSocialTrail(trail, tier, outcome, opts = {}) {
  if (!Array.isArray(trail)) return;
  const entry = { tier, outcome, latencyMs: Math.max(0, Number(opts.latencyMs) || 0) };
  if (opts.reason) entry.reason = opts.reason;
  if (opts.method) entry.method = opts.method;
  // `extra` (not `metadata`) — same convention as fetchUrlTool to avoid
  // grep collision with the legacy social-link `meta:` return field.
  if (opts.extra && Object.keys(opts.extra).length) entry.extra = opts.extra;
  trail.push(entry);
}

// Browser-shaped UA — Douyin / Xiaohongshu CDNs reject node fetch's
// default UA with 403. Used for both the short-link resolve and the
// share-preview fallback GET.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MOBILE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const UNFURL_FETCH_TIMEOUT_MS = 4500;
const UNFURL_FETCH_MAX_BYTES = 300_000;
const BROWSER_FETCH_TIMEOUT_MS = 12_000;
const BROWSER_FETCH_MAX_TEXT = 12_000;
const DEEP_SOCIAL_PREVIEW_SCORE = 38;

const UNFURL_PROFILES = Object.freeze([
  {
    name: 'telegram',
    headers: {
      'User-Agent': 'TelegramBot (like TwitterBot)',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    },
  },
  {
    name: 'wechat',
    headers: {
      'User-Agent': `${MOBILE_SAFARI_UA} MicroMessenger/8.0.47`,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    },
  },
  {
    name: 'mobile',
    headers: {
      'User-Agent': MOBILE_SAFARI_UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    },
  },
  {
    name: 'twitterbot',
    headers: {
      'User-Agent': 'Twitterbot/1.0',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    },
  },
]);

/**
 * Cheap HTTP GET that returns response body (truncated). Returns null
 * on any failure. Used by the share-preview fallback path — a plain text
 * fetch is enough because we only parse meta tags out of the head.
 */
async function fetchHtmlBody(
  url,
  {
    signal,
    maxBytes = UNFURL_FETCH_MAX_BYTES,
    timeoutMs = UNFURL_FETCH_TIMEOUT_MS,
    headers = {},
  } = {},
) {
  if (signal?.aborted) return null;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        ...headers,
      },
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

/**
 * Canonical list of social-platform host suffixes the early-route
 * covers. Exported so `web_search`'s content-fetch blocklist can use
 * the SAME matcher — Codex review (Phase 6 🔵 P1 2026-05-05) caught
 * that web_search was using exact-match against `'douyin.com'` while
 * isSocialLinkUrl was suffix-matching `m.douyin.com` / `m.xiaohongshu.com`,
 * leaving search hitting mobile sub-hosts that fetch_url already routes
 * around. Sharing the matcher closes the gap.
 */
export const SOCIAL_HOST_SUFFIXES = Object.freeze([
  'douyin.com', 'v.douyin.com', 'iesdouyin.com',
  'xiaohongshu.com', 'xhslink.com',
]);

export function hostnameOf(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Returns true when `host` is any of `suffixes` or a sub-host of one.
 * Exported so callers (web_search blocklist) get the same matching
 * semantics. Empty / missing host returns false; never throws.
 */
export function hostMatchesAnySuffix(host, suffixes) {
  if (!host || typeof host !== 'string') return false;
  for (const suffix of suffixes) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

/**
 * True for any URL that should bypass jina/direct/Playwright in fetch_url
 * and instead route through this module's social-link reader.
 */
export function isSocialLinkUrl(url) {
  return hostMatchesAnySuffix(hostnameOf(url), SOCIAL_HOST_SUFFIXES);
}

/**
 * Resolve a short link by following redirects until landing on the
 * canonical URL. Returns the resolved URL or the original if not a
 * known shortener / no redirect.
 *
 * Uses a HEAD request first; some servers reject HEAD with 405, so we
 * fall back to GET with manual redirect tracking. Cap at 5 hops to
 * avoid infinite-redirect tarpits.
 *
 * Codex Phase 6 follow-up (🟡 P1 2026-05-05): bail immediately when
 * signal is already aborted — otherwise we'd start the HEAD/GET
 * round-trips for a request the host has already given up on (the
 * outer 14s budget is already spent). The same gate runs at every
 * stage of readSocialLink below.
 */
export async function resolveShortLink(url, { signal, timeoutMs = 5000 } = {}) {
  if (signal?.aborted) return url;
  const host = hostnameOf(url);
  if (!SHORT_LINK_HOSTS.has(host)) return url;

  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    if (signal?.aborted) break; // re-check between hops
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

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, raw) => {
      const code = Number.parseInt(raw, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(value = '') {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ' '));
}

function parseHtmlAttrs(attrs = '') {
  const result = {};
  const attrRe = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of attrs.matchAll(attrRe)) {
    result[String(match[1] || '').toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? '');
  }
  return result;
}

function assignIfUseful(target, key, value, maxChars = 5000) {
  const text = decodeHtmlEntities(value || '').slice(0, maxChars).trim();
  if (!text || target[key]) return;
  target[key] = text;
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
    const attrs = parseHtmlAttrs(m[1]);
    const key = String(attrs.property || attrs.name || '').toLowerCase();
    const value = attrs.content || '';
    if (!key || !value) continue;
    if (key === 'og:title' || key === 'twitter:title' || key === 'title') {
      assignIfUseful(result, 'title', value, 300);
    } else if (key === 'og:description' || key === 'twitter:description' || key === 'description') {
      assignIfUseful(result, 'description', value, 5000);
    } else if (key === 'og:image' || key === 'twitter:image') {
      assignIfUseful(result, 'image', value, 1000);
    } else if (key === 'og:site_name') {
      assignIfUseful(result, 'siteName', value, 300);
    }
  }
  // Title element fallback when meta tags are missing.
  if (!result.title) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) assignIfUseful(result, 'title', titleMatch[1], 300);
  }
  return result;
}

function parseJsonMaybe(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function walkJson(value, visitor, depth = 0) {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visitor, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  visitor(value);
  for (const child of Object.values(value)) walkJson(child, visitor, depth + 1);
}

function extractJsonLdPreview(html) {
  const preview = {};
  const scriptRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptRe)) {
    const parsed = parseJsonMaybe(stripTags(match[1]));
    if (!parsed) continue;
    walkJson(parsed, node => {
      assignIfUseful(preview, 'title', node.headline || node.name, 300);
      assignIfUseful(preview, 'description', node.description, 5000);
      assignIfUseful(preview, 'body', node.articleBody || node.text, 8000);
      const author = Array.isArray(node.author) ? node.author[0] : node.author;
      if (author && typeof author === 'object') assignIfUseful(preview, 'author', author.name, 300);
      if (typeof author === 'string') assignIfUseful(preview, 'author', author, 300);
      const image = Array.isArray(node.image) ? node.image[0] : node.image;
      if (typeof image === 'string') assignIfUseful(preview, 'image', image, 1000);
      if (image && typeof image === 'object') assignIfUseful(preview, 'image', image.url, 1000);
    });
  }
  return preview;
}

function decodeJsonStringLiteral(value = '') {
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
  } catch {
    return value
      .replace(/\\n/g, '\n')
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  }
}

function looksLikeBoilerplate(text = '') {
  const normalized = String(text || '').trim();
  if (normalized.length < 2) return true;
  if (/^https?:\/\//i.test(normalized)) return true;
  if (/^(小红书|抖音|TikTok|RedNote|Xiaohongshu|Douyin)\s*[-_|]?\s*$/i.test(normalized)) return true;
  if (/^(打开看看|复制链接|阅读全文|立即打开|登录后查看更多|请升级|安全验证)$/i.test(normalized)) return true;
  return false;
}

function extractSsrPreview(html) {
  const preview = { comments: [] };
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(text => /(?:title|desc|description|content|nickname|comment|note)/i.test(text))
    .join('\n')
    .slice(0, 900_000);

  const seen = new Set();
  const pairRe =
    /["']([a-zA-Z0-9_:-]*(?:title|desc|description|content|note|nickname|author|user|comment|text)[a-zA-Z0-9_:-]*)["']\s*:\s*["']((?:\\.|[^"'\\]){2,5000})["']/gi;

  for (const match of scripts.matchAll(pairRe)) {
    const key = String(match[1] || '').toLowerCase();
    const raw = decodeJsonStringLiteral(match[2] || '');
    const value = stripTags(raw);
    if (looksLikeBoilerplate(value) || seen.has(value)) continue;
    seen.add(value);

    if (/nickname|author|user/.test(key)) {
      assignIfUseful(preview, 'author', value, 300);
    } else if (/comment/.test(key) || (/content|text/.test(key) && preview.body && value.length < 140)) {
      if (value.length >= 3 && preview.comments.length < 3) preview.comments.push(value.slice(0, 500));
    } else if (/title/.test(key)) {
      assignIfUseful(preview, 'title', value, 300);
    } else if (/desc|description|content|note|text/.test(key)) {
      if (!preview.body && value.length > 30) {
        assignIfUseful(preview, 'body', value, 8000);
      } else {
        assignIfUseful(preview, 'description', value, 5000);
      }
    }
  }
  return preview;
}

function extractBalancedJsonObject(text = '', startIndex = -1) {
  if (startIndex < 0 || text[startIndex] !== '{') return '';
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return '';
}

function parseAssignedJsonObject(script = '', assignmentName = '') {
  const index = script.indexOf(assignmentName);
  if (index < 0) return null;
  const equalsIndex = script.indexOf('=', index + assignmentName.length);
  if (equalsIndex < 0) return null;
  const braceIndex = script.indexOf('{', equalsIndex);
  const raw = extractBalancedJsonObject(script, braceIndex);
  return raw ? parseJsonMaybe(raw) : null;
}

function firstUsefulString(...values) {
  for (const value of values.flat(Infinity)) {
    const text = stripTags(value || '');
    if (text && !looksLikeBoilerplate(text)) return text;
  }
  return '';
}

function firstArrayString(value) {
  if (Array.isArray(value)) return firstUsefulString(value);
  return firstUsefulString(value);
}

function firstUrlString(...values) {
  for (const value of values.flat(Infinity)) {
    const text = decodeHtmlEntities(value || '').trim();
    if (/^(https?:\/\/|data:)/i.test(text)) return text;
  }
  return '';
}

function compactCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function durationSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1000 ? Math.round(n / 1000) : Math.round(n);
}

export function extractSocialItemId(url = '') {
  const text = String(url || '');
  const patterns = [
    /\/share\/video\/([\w-]{3,})/i,
    /\/video\/([\w-]{3,})/i,
    /[?&](?:modal_id|aweme_id)=([\w-]{3,})/i,
    /\/(?:explore|discovery\/item)\/([\w-]{6,})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

function findDouyinItem(data) {
  let best = null;
  walkJson(data, node => {
    if (best) return;
    if (Array.isArray(node.item_list)) {
      best = node.item_list.find(item => item && typeof item === 'object' && (item.aweme_id || item.desc));
      if (best) return;
    }
    if ((node.aweme_id || node.awemeId) && (node.desc || node.video || node.author)) {
      best = node;
    }
  });
  return best;
}

function buildDouyinItemPreview(item = {}) {
  if (!item || typeof item !== 'object') return {};
  const video = item.video && typeof item.video === 'object' ? item.video : {};
  const author = item.author && typeof item.author === 'object' ? item.author : {};
  const stats = item.statistics && typeof item.statistics === 'object' ? item.statistics : {};
  const desc = firstUsefulString(item.desc, item.share_info?.share_desc);
  const authorName = firstUsefulString(author.nickname, author.unique_id, author.short_id);
  const cover = firstUrlString(
    video.cover?.url_list,
    video.origin_cover?.url_list,
    video.dynamic_cover?.url_list,
    item.share_info?.share_qrcode_url?.url_list,
  );
  const playUrl = firstUrlString(video.play_addr?.url_list, video.download_addr?.url_list);
  const duration = durationSeconds(video.duration || item.music?.duration);
  const tags = Array.isArray(item.text_extra)
    ? item.text_extra
        .map(extra => firstUsefulString(extra?.hashtag_name, extra?.hashtagName))
        .filter(Boolean)
        .slice(0, 8)
    : [];
  const statLine = [
    stats.play_count != null ? `Views ${compactCount(stats.play_count)}` : '',
    stats.digg_count != null ? `Likes ${compactCount(stats.digg_count)}` : '',
    stats.comment_count != null ? `Comments ${compactCount(stats.comment_count)}` : '',
    stats.collect_count != null ? `Collects ${compactCount(stats.collect_count)}` : '',
    stats.share_count != null ? `Shares ${compactCount(stats.share_count)}` : '',
  ].filter(Boolean).join(' · ');
  const notice = firstUsefulString(item.risk_infos?.content, item.risk_infos?.warn_content);
  const createdAt = Number.isFinite(Number(item.create_time))
    ? new Date(Number(item.create_time) * 1000).toISOString().slice(0, 10)
    : '';
  const body = [
    desc,
    tags.length ? `Tags: ${tags.map(tag => `#${tag}`).join(' ')}` : '',
    statLine,
    createdAt ? `Posted ${createdAt}` : '',
    notice ? `Notice: ${notice}` : '',
  ].filter(Boolean).join('\n');

  const media = playUrl
    ? [{
        src: playUrl,
        poster: cover,
        duration,
        width: Number(video.width || 0) || 0,
        height: Number(video.height || 0) || 0,
      }]
    : [];

  return {
    title: desc.slice(0, 300),
    description: desc,
    body,
    author: authorName,
    image: cover,
    siteName: 'Douyin',
    itemId: String(item.aweme_id || item.awemeId || '').trim(),
    media,
    profile: 'douyin-ssr',
    comments: notice ? [notice] : [],
    stats,
  };
}

function extractDouyinRouterDataPreview(html) {
  if (typeof html !== 'string' || !/douyin|aweme|_ROUTER_DATA|videoInfoRes/i.test(html)) {
    return {};
  }
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  for (const script of scripts) {
    const parsed =
      parseAssignedJsonObject(script, 'window._ROUTER_DATA') ||
      parseAssignedJsonObject(script, 'window._SSR_DATA') ||
      parseAssignedJsonObject(script, 'window.__INITIAL_STATE__');
    if (!parsed) continue;
    const item = findDouyinItem(parsed);
    const preview = buildDouyinItemPreview(item);
    if (preview.title || preview.body || preview.media?.length) return preview;
  }
  return {};
}

export function parseSocialPreview(html) {
  const og = parseOpenGraph(html);
  const jsonLd = extractJsonLdPreview(html);
  const ssr = extractSsrPreview(html);
  const platform = extractDouyinRouterDataPreview(html);
  return {
    ...og,
    ...jsonLd,
    ...ssr,
    ...platform,
    title: platform.title || ssr.title || jsonLd.title || og.title || '',
    description: platform.description || ssr.description || jsonLd.description || og.description || '',
    body: platform.body || ssr.body || jsonLd.body || '',
    author: platform.author || ssr.author || jsonLd.author || '',
    image: platform.image || ssr.image || jsonLd.image || og.image || '',
    siteName: platform.siteName || og.siteName || '',
    comments: [
      ...(Array.isArray(platform.comments) ? platform.comments : []),
      ...(Array.isArray(ssr.comments) ? ssr.comments : []),
    ].filter((value, index, list) => value && list.indexOf(value) === index).slice(0, 4),
    media: Array.isArray(platform.media) ? platform.media : [],
    itemId: platform.itemId || '',
    profile: platform.profile || '',
  };
}

function scorePreview(preview = {}) {
  let score = 0;
  if (preview.title && !looksLikeBoilerplate(preview.title)) score += 10;
  if (preview.description && !looksLikeBoilerplate(preview.description)) score += Math.min(30, preview.description.length / 20);
  if (preview.body && !looksLikeBoilerplate(preview.body)) score += Math.min(60, preview.body.length / 30);
  if (preview.author) score += 8;
  if (preview.image) score += 4;
  if (Array.isArray(preview.comments) && preview.comments.length) score += 6;
  if (preview.itemId) score += 10;
  if (Array.isArray(preview.media) && preview.media.length) score += 12;
  return score;
}

async function fetchSocialPreview(url, { signal } = {}) {
  if (signal?.aborted) return null;
  const attempts = await Promise.all(
    UNFURL_PROFILES.map(async profile => {
      const html = await fetchHtmlBody(url, {
        signal,
        headers: profile.headers,
        timeoutMs: UNFURL_FETCH_TIMEOUT_MS,
      });
      if (!html) return null;
      const preview = parseSocialPreview(html);
      const score = scorePreview(preview);
      if (score < 10) return null;
      return {
        ...preview,
        profile: preview.profile ? `${profile.name}+${preview.profile}` : profile.name,
        score,
      };
    }),
  ).catch(() => []);
  const best = attempts.filter(Boolean).sort((a, b) => b.score - a.score)[0];
  return best || null;
}

function socialPreviewMatchesExpected(preview = {}, expectedUrl = '') {
  const expectedId = extractSocialItemId(expectedUrl);
  if (!expectedId) return true;
  const previewIds = [
    preview.itemId,
    extractSocialItemId(preview.url || ''),
  ].filter(Boolean);
  if (!previewIds.length) return true;
  return previewIds.some(id => id === expectedId);
}

function cleanBrowserExtractedText(text = '') {
  const seen = new Set();
  return String(text || '')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => {
      if (!line || line.length < 2) return false;
      if (seen.has(line)) return false;
      seen.add(line);
      if (/^(登录|注册|扫码登录|密码登录|验证码登录|手机号登录|打开 App|打开APP|立即打开|阅读全文|同意|取消)$/i.test(line)) {
        return false;
      }
      if (/^(抖音|小红书|TikTok|RedNote|Xiaohongshu|Douyin)$/i.test(line)) {
        return false;
      }
      return true;
    })
    .join('\n')
    .trim();
}

function scoreBrowserPreview(preview = {}) {
  let score = scorePreview(preview);
  if (preview.body && cleanBrowserExtractedText(preview.body).length > 80) score += 20;
  if (Array.isArray(preview.media) && preview.media.length) score += 8;
  if (preview.closedOverlays) score += 4;
  return score;
}

function browserPreviewFromPayload(payload = {}) {
  const body = cleanBrowserExtractedText(payload.body || '').slice(0, BROWSER_FETCH_MAX_TEXT);
  const media = Array.isArray(payload.media)
    ? payload.media
        .filter(item => item && typeof item === 'object')
        .slice(0, 4)
    : [];
  const preview = {
    title: cleanBrowserExtractedText(payload.title || payload.metaTitle || '').slice(0, 300),
    description: cleanBrowserExtractedText(payload.description || '').slice(0, 1000),
    body,
    author: cleanBrowserExtractedText(payload.author || '').slice(0, 300),
    siteName: cleanBrowserExtractedText(payload.siteName || '').slice(0, 300),
    image: String(payload.image || '').trim().slice(0, 1000),
    comments: Array.isArray(payload.comments) ? payload.comments.slice(0, 3) : [],
    media,
    closedOverlays: Number(payload.closedOverlays || 0),
    url: String(payload.url || '').trim().slice(0, 1000),
    itemId: extractSocialItemId(payload.url || ''),
    profile: 'browser',
  };
  preview.score = scoreBrowserPreview(preview);
  return preview.score >= 18 ? preview : null;
}

function uniqueStrategyUrls(...urls) {
  const seen = new Set();
  const result = [];
  for (const url of urls) {
    const text = String(url || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

async function parsePlaywrightRawJson(raw) {
  let value = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    // Accept raw strings from older CLI versions below.
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return { body: value };
    }
  }
  return value && typeof value === 'object' ? value : null;
}

/**
 * Real-browser social fallback. Some Douyin / Xiaohongshu pages serve
 * a login/app-prompt modal above otherwise readable content. This helper
 * opens the page, clicks only close/later-style controls, waits for the
 * page to settle, then extracts visible text and video metadata.
 */
async function fetchSocialBrowserPreview(url, { signal } = {}) {
  if (signal?.aborted) return null;
  let playwright;
  try {
    playwright = await import('../../web/playwrightFetcher.js');
  } catch {
    return null;
  }

  try {
    if (signal?.aborted || !(await playwright.isPlaywrightCliAvailable())) return null;
    return await playwright.withPwLock(async () => {
      if (signal?.aborted) return null;
      await playwright.pwNavigate(url, BROWSER_FETCH_TIMEOUT_MS);
      if (signal?.aborted) return null;

      const script = `(async () => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const visible = el => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 &&
            style.display !== 'none' && style.visibility !== 'hidden' &&
            Number(style.opacity || 1) > 0.05;
        };
        const textOf = el => [
          el.innerText || '',
          el.textContent || '',
          el.getAttribute?.('aria-label') || '',
          el.getAttribute?.('title') || '',
          el.getAttribute?.('class') || '',
        ].filter(Boolean).join(' ').trim();
        const closePattern = /(关闭|关闭登录|暂不登录|稍后|稍后再说|取消|不登录|跳过|close|dismiss|later|not now|skip|×|✕|x)/i;
        const clickCloseControls = () => {
          const candidates = new Set();
          for (const selector of [
            '[aria-label*="关闭"]',
            '[aria-label*="close" i]',
            '[title*="关闭"]',
            '[title*="close" i]',
            '[class*="close" i]',
            '[class*="modal" i] button',
            '[class*="login" i] button',
            '[role="button"]',
            'button',
            'svg',
          ]) {
            try {
              document.querySelectorAll(selector).forEach(el => candidates.add(el));
            } catch {}
          }
          let clicked = 0;
          for (const el of candidates) {
            if (!visible(el)) continue;
            const label = textOf(el);
            const rect = el.getBoundingClientRect();
            const looksLikeCornerX =
              rect.width <= 80 && rect.height <= 80 &&
              (label === '×' || label === 'x' || label === 'X' || /close|关闭/i.test(label)) &&
              (rect.right > window.innerWidth * 0.45 || rect.top < window.innerHeight * 0.45);
            if (!closePattern.test(label) && !looksLikeCornerX) continue;
            try {
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              clicked += 1;
            } catch {}
          }
          return clicked;
        };

        let closedOverlays = 0;
        await sleep(800);
        for (let i = 0; i < 4; i += 1) {
          closedOverlays += clickCloseControls();
          await sleep(550);
        }

        for (const video of Array.from(document.querySelectorAll('video')).slice(0, 3)) {
          try {
            video.muted = true;
            video.play?.().catch?.(() => {});
          } catch {}
        }
        await sleep(1600);

        const meta = name => document.querySelector(\`meta[property="\${name}"],meta[name="\${name}"]\`)?.content || '';
        const text = (document.body?.innerText || '').trim();
        const media = Array.from(document.querySelectorAll('video')).slice(0, 4).map(video => ({
          src: video.currentSrc || video.src || '',
          poster: video.poster || '',
          duration: Number.isFinite(video.duration) ? Math.round(video.duration) : null,
          paused: Boolean(video.paused),
          width: video.videoWidth || video.clientWidth || 0,
          height: video.videoHeight || video.clientHeight || 0,
        })).filter(item => item.src || item.poster || item.duration);

        return JSON.stringify({
          title: document.title || meta('og:title') || meta('twitter:title') || '',
          metaTitle: meta('og:title') || meta('twitter:title') || '',
          description: meta('og:description') || meta('twitter:description') || meta('description') || '',
          author: meta('author') || '',
          siteName: meta('og:site_name') || location.hostname,
          image: meta('og:image') || meta('twitter:image') || '',
          body: text,
          media,
          closedOverlays,
          url: location.href,
        });
      })()`;

      const raw = await playwright.runPlaywrightCli(['eval', script], BROWSER_FETCH_TIMEOUT_MS);
      const payload = await parsePlaywrightRawJson(raw);
      return browserPreviewFromPayload(payload);
    });
  } catch {
    return null;
  }
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

function previewFromYtdlpMeta(meta = {}) {
  return {
    title: meta.title || '',
    description: meta.description || meta.subtitleText || '',
    body: [meta.description, meta.subtitleText ? `Transcript/Subtitles:\n${meta.subtitleText}` : '']
      .filter(Boolean)
      .join('\n\n'),
    author: meta.uploader || '',
    siteName: meta.platform || '',
    image: '',
    comments: [],
    profile: 'yt-dlp',
    score: 100,
  };
}

function renderMediaLines(media = []) {
  if (!Array.isArray(media) || !media.length) return [];
  return media
    .map((item, index) => {
      const details = [
        item.duration ? `duration ${item.duration}s` : '',
        item.width && item.height ? `${item.width}x${item.height}` : '',
        item.paused === false ? 'playing' : '',
        item.src ? `src ${String(item.src).slice(0, 180)}` : '',
        item.poster ? `poster ${String(item.poster).slice(0, 180)}` : '',
      ].filter(Boolean).join(' · ');
      return details ? `- Video ${index + 1}: ${details}` : '';
    })
    .filter(Boolean);
}

/**
 * Render the same kind of share preview Telegram / WeChat would surface:
 * title, author/site, description/body, cover image, and a few visible
 * comment snippets when the SSR payload exposes them.
 */
function renderSocialPreviewBody(preview, url) {
  const parts = [];
  if (preview.title) parts.push(preview.title);
  const byline = [
    preview.author ? `by ${preview.author}` : '',
    preview.siteName ? `from ${preview.siteName}` : '',
    preview.profile ? `via ${preview.profile} preview` : '',
  ].filter(Boolean).join(' · ');
  if (byline) parts.push(byline);
  if (preview.description) parts.push(preview.description);
  if (preview.body && preview.body !== preview.description) parts.push(preview.body);
  if (Array.isArray(preview.comments) && preview.comments.length) {
    parts.push(`Visible comments:\n${preview.comments.map(comment => `- ${comment}`).join('\n')}`);
  }
  const mediaLines = renderMediaLines(preview.media);
  if (mediaLines.length) parts.push(`Detected media:\n${mediaLines.join('\n')}`);
  if (preview.image) parts.push(`Preview image: ${preview.image}`);
  parts.push(`\nSource: ${url}`);
  parts.push(
    '\n[Note: this is the public share preview/unfurl content, similar to what ' +
    'Telegram/WeChat can preview without logging in. Full comments or gated ' +
    'sections may still be omitted.]',
  );
  return parts.filter(Boolean).join('\n\n');
}

function renderBrowserPreviewBody(preview, url) {
  const parts = [];
  if (preview.title) parts.push(preview.title);
  const byline = [
    preview.author ? `by ${preview.author}` : '',
    preview.siteName ? `from ${preview.siteName}` : '',
    'via rendered browser after closing visible login/app overlays',
  ].filter(Boolean).join(' · ');
  if (byline) parts.push(byline);
  if (preview.description) parts.push(preview.description);
  if (preview.body && preview.body !== preview.description) parts.push(preview.body);
  if (Array.isArray(preview.media) && preview.media.length) {
    const mediaLines = renderMediaLines(preview.media);
    if (mediaLines.length) parts.push(`Detected media:\n${mediaLines.join('\n')}`);
  }
  if (preview.image) parts.push(`Preview image: ${preview.image}`);
  parts.push(`\nSource: ${url}`);
  parts.push(
    '\n[Note: this was read from a real browser after closing visible login/app ' +
    'overlays. If the platform still gates full captions, comments, or audio, ' +
    'those parts may be incomplete.]',
  );
  return parts.filter(Boolean).join('\n\n');
}

function renderExternalReaderBody(result, url) {
  const method = result?.method || 'external-reader';
  const content = String(result?.content || '').trim();
  if (!content) return '';
  return [
    content,
    `\nSource: ${result?.finalUrl || url}`,
    `\n[Note: this was read through the optional local ${method} fallback. Social-platform captions, comments, or audio may still be incomplete if the page requires a logged-in session.]`,
  ].filter(Boolean).join('\n\n');
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
 *   { body: string, via: 'yt-dlp' | 'share-preview:*', canonicalUrl: string }
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
  previewFn = fetchSocialPreview,
  browserPreviewFn = fetchSocialBrowserPreview,
  externalReaderFn = readUrlWithExternalReaders,
  ytdlpFn = fetchPlatformMetadataViaYtdlp,
} = {}) {
  const trail = [];
  if (!isSocialLinkUrl(url)) return null;
  // Codex Phase 6 follow-up (🟡 P1 2026-05-05): abort gate at entry +
  // before each strategy. abort is "host gave up, stop now"; we must
  // not waste more budget on yt-dlp / OG fetch.
  if (signal?.aborted) {
    recordSocialTrail(trail, 'short-link-resolve', 'skip', { reason: 'aborted-at-entry' });
    return { body: '', via: 'aborted', canonicalUrl: url, evidenceTrail: trail, aborted: true };
  }

  // Step 1 — short-link resolve.
  let canonical = url;
  const tShort = Date.now();
  try {
    canonical = await resolveShortLink(url, { signal });
    recordSocialTrail(trail, 'short-link-resolve', 'ok', {
      latencyMs: Date.now() - tShort,
      extra: { resolved: canonical !== url, canonical },
    });
  } catch (err) {
    canonical = url;
    recordSocialTrail(trail, 'short-link-resolve', 'fail', {
      latencyMs: Date.now() - tShort,
      reason: classifySocialError(err),
      extra: { fallbackToOriginal: true },
    });
  }
  if (signal?.aborted) {
    recordSocialTrail(trail, 'yt-dlp', 'skip', { reason: 'aborted-after-short-link' });
    return { body: '', via: 'aborted', canonicalUrl: canonical, evidenceTrail: trail, aborted: true };
  }

  // Build the effective config now that we know the canonical host —
  // explicit cookies bind to the resolved host, not the shortener.
  const effectiveConfig = configWithExplicitCookie(config, canonical, explicitCookies);

  // Step 2 — deep yt-dlp metadata. This must run BEFORE share-preview:
  // a social preview may contain only a title/thumbnail, and returning it
  // early makes Melo "guess" a Douyin/Xiaohongshu video instead of reading
  // the real metadata/subtitles when yt-dlp can access them.
  let ytdlpAborted = false;
  const tYtdlp = Date.now();
  try {
    const meta = await ytdlpFn(canonical, effectiveConfig, { signal });
    if (meta && (meta.title || meta.description || meta.subtitleText)) {
      recordSocialTrail(trail, 'yt-dlp', 'ok', {
        latencyMs: Date.now() - tYtdlp,
        extra: { hasTitle: !!meta.title, hasDescription: !!meta.description, hasSubtitles: !!meta.subtitleText },
      });
      return {
        body: renderYtdlpBody(meta, canonical),
        via: 'yt-dlp',
        canonicalUrl: canonical,
        preview: previewFromYtdlpMeta(meta),
        meta,
        evidenceTrail: trail,
      };
    }
    recordSocialTrail(trail, 'yt-dlp', 'fail', {
      latencyMs: Date.now() - tYtdlp,
      reason: meta ? 'no-title-or-body' : 'unsupported-or-no-meta',
    });
  } catch (err) {
    // If yt-dlp failed BECAUSE the signal aborted, preview fallback is also pointless —
    // bail. Other error reasons (yt-dlp not installed / unsupported
    // platform / network blip) → fall through to preview; preview is independent
    // of yt-dlp's transport and may still succeed.
    ytdlpAborted = signal?.aborted || err?.name === 'AbortError';
    recordSocialTrail(trail, 'yt-dlp', 'fail', {
      latencyMs: Date.now() - tYtdlp,
      reason: ytdlpAborted ? 'aborted' : classifySocialError(err),
    });
  }
  if (signal?.aborted || ytdlpAborted) {
    recordSocialTrail(trail, 'share-preview', 'skip', { reason: 'aborted-after-yt-dlp' });
    return { body: '', via: 'aborted', canonicalUrl: canonical, evidenceTrail: trail, aborted: true };
  }

  // Step 3 — chat-app style share preview / SSR fallback. This is the
  // path users observe when Telegram / WeChat can show a Xiaohongshu /
  // Douyin card without a logged-in browser. Now that Douyin SSR parsing
  // extracts item ids + media URLs, a high-score preview is often more
  // reliable and much faster than a real browser (which may land on a
  // recommended video after redirect).
  let shallowPreviewResult = null;
  const tShare = Date.now();
  let sharePreviewBestScore = 0;
  let sharePreviewMissReason = null;
  try {
    if (typeof previewFn === 'function') {
      for (const candidateUrl of uniqueStrategyUrls(url, canonical)) {
        if (signal?.aborted) return bailAbortedSocial(trail, 'share-preview', ['browser', 'external-reader'], canonical);
        const preview = await previewFn(candidateUrl, { signal, canonicalUrl: canonical });
        // G-1b follow-up #2 (Codex C 闭环 2026-05-10): also check abort
        // AFTER each await — single-candidate loops (url === canonical)
        // would otherwise complete normally and the signal abort that
        // happened mid-await would be silently swallowed by the outer
        // "no-match" record path, breaking the 5-row schema contract.
        if (signal?.aborted) return bailAbortedSocial(trail, 'share-preview', ['browser', 'external-reader'], canonical);
        const score = preview ? scorePreview(preview) : 0;
        sharePreviewBestScore = Math.max(sharePreviewBestScore, score);
        if (
          preview &&
          score >= 10 &&
          socialPreviewMatchesExpected(preview, canonical)
        ) {
          const result = {
            body: renderSocialPreviewBody(preview, candidateUrl),
            via: `share-preview:${preview.profile || 'generic'}`,
            canonicalUrl: candidateUrl,
            originalUrl: url,
            preview,
          };
          if (score >= DEEP_SOCIAL_PREVIEW_SCORE) {
            recordSocialTrail(trail, 'share-preview', 'ok', {
              latencyMs: Date.now() - tShare,
              method: preview.profile || 'generic',
              extra: { score, deep: true },
            });
            return { ...result, evidenceTrail: trail };
          }
          shallowPreviewResult = shallowPreviewResult || result;
        }
      }
      // Loop completed without returning a deep preview.
      if (!shallowPreviewResult) {
        sharePreviewMissReason = sharePreviewBestScore === 0 ? 'no-preview' : 'low-score';
      }
    } else {
      sharePreviewMissReason = 'no-preview-fn';
    }
  } catch (err) {
    // Preview miss — continue to browser fallback.
    sharePreviewMissReason = classifySocialError(err);
  }
  // Record a single share-preview entry for this strategy block (deep
  // success path returns above; this path covers shallow + complete miss).
  if (shallowPreviewResult) {
    recordSocialTrail(trail, 'share-preview', 'ok', {
      latencyMs: Date.now() - tShare,
      method: shallowPreviewResult.via.replace(/^share-preview:/, ''),
      extra: { score: sharePreviewBestScore, deep: false, kept: 'shallow-pending-deeper' },
    });
  } else {
    recordSocialTrail(trail, 'share-preview', 'fail', {
      latencyMs: Date.now() - tShare,
      reason: sharePreviewMissReason || 'no-match',
      extra: { bestScore: sharePreviewBestScore },
    });
  }
  if (signal?.aborted) {
    recordSocialTrail(trail, 'browser', 'skip', { reason: 'aborted-after-share-preview' });
    return { body: '', via: 'aborted', canonicalUrl: canonical, evidenceTrail: trail, aborted: true };
  }

  // Step 4 — rendered browser fallback. Some Douyin/XHS pages look
  // blocked only because a top-level login modal covers the page; after
  // clicking the modal X, the visible caption/text/video element is usable.
  //
  // Important: try the ORIGINAL pasted URL before the canonical URL.
  // Douyin short/share links can mint temporary visitor credentials during
  // their browser redirect chain. If we resolve the short link with Node
  // fetch first and then open only the final canonical URL, the page may
  // complain that the redirected request lacks a temporary credential even
  // though the same link works in a normal browser.
  const tBrowser = Date.now();
  let browserBestScore = 0;
  let browserMissReason = null;
  try {
    if (typeof browserPreviewFn === 'function') {
      for (const candidateUrl of uniqueStrategyUrls(url, canonical)) {
        if (signal?.aborted) return bailAbortedSocial(trail, 'browser', ['external-reader'], canonical);
        const browserPreview = await browserPreviewFn(candidateUrl, { signal, canonicalUrl: canonical });
        // G-1b follow-up #2: post-await abort check (see share-preview block).
        if (signal?.aborted) return bailAbortedSocial(trail, 'browser', ['external-reader'], canonical);
        const bScore = browserPreview ? scoreBrowserPreview(browserPreview) : 0;
        browserBestScore = Math.max(browserBestScore, bScore);
        if (
          browserPreview &&
          bScore >= 18 &&
          socialPreviewMatchesExpected(browserPreview, canonical)
        ) {
          const sourceUrl = browserPreview.url || candidateUrl;
          recordSocialTrail(trail, 'browser', 'ok', {
            latencyMs: Date.now() - tBrowser,
            method: browserPreview.profile || 'rendered',
            extra: { score: bScore },
          });
          return {
            body: renderBrowserPreviewBody(browserPreview, sourceUrl),
            via: `browser:${browserPreview.profile || 'rendered'}`,
            canonicalUrl: sourceUrl,
            originalUrl: url,
            preview: browserPreview,
            evidenceTrail: trail,
          };
        }
      }
      // Loop done without returning — record fail with best-score context.
      browserMissReason = browserBestScore === 0 ? 'no-preview' : 'low-score';
    } else {
      browserMissReason = 'no-browser-fn';
    }
  } catch (err) {
    // Browser miss — continue to cheap unfurl fallback.
    browserMissReason = classifySocialError(err);
  }
  recordSocialTrail(trail, 'browser', 'fail', {
    latencyMs: Date.now() - tBrowser,
    reason: browserMissReason || 'no-match',
    extra: { bestScore: browserBestScore },
  });
  if (signal?.aborted) {
    recordSocialTrail(trail, 'external-reader', 'skip', { reason: 'aborted-after-browser' });
    return { body: '', via: 'aborted', canonicalUrl: canonical, evidenceTrail: trail, aborted: true };
  }

  // Step 4b — optional local extraction CLIs. This keeps the old
  // Playwright path as the first browser fallback while letting users who
  // install Camoufox / Crawl4AI / Scrapling get deeper reads on difficult
  // social pages without paying for a hosted scraping API.
  const tExternal = Date.now();
  let externalMissReason = null;
  try {
    if (typeof externalReaderFn === 'function') {
      for (const candidateUrl of uniqueStrategyUrls(url, canonical)) {
        if (signal?.aborted) return bailAbortedSocial(trail, 'external-reader', [], canonical);
        const external = await externalReaderFn(candidateUrl, {
          preferred: ['camoufox', 'crawl4ai', 'scrapling'],
          signal,
          config: effectiveConfig,
          maxChars: BROWSER_FETCH_MAX_TEXT,
          timeoutMs: BROWSER_FETCH_TIMEOUT_MS,
        });
        // G-1b follow-up #2: post-await abort check (see share-preview block).
        if (signal?.aborted) return bailAbortedSocial(trail, 'external-reader', [], canonical);
        if (external?.content && cleanBrowserExtractedText(external.content).length > 120) {
          const body = renderExternalReaderBody(external, external.finalUrl || candidateUrl);
          recordSocialTrail(trail, 'external-reader', 'ok', {
            latencyMs: Date.now() - tExternal,
            method: external.method || 'reader',
            extra: { bytes: external.content.length },
          });
          return {
            body,
            via: `external:${external.method || 'reader'}`,
            canonicalUrl: external.finalUrl || candidateUrl,
            originalUrl: url,
            preview: {
              title: cleanBrowserExtractedText(external.content).split('\n')[0]?.slice(0, 300) || '',
              body: external.content,
              profile: external.method || 'external-reader',
            },
            evidenceTrail: trail,
          };
        }
      }
      externalMissReason = 'no-content-or-too-short';
    } else {
      externalMissReason = 'no-reader-fn';
    }
  } catch (err) {
    // External reader miss — keep the existing shallow preview fallback.
    externalMissReason = classifySocialError(err);
  }
  recordSocialTrail(trail, 'external-reader', 'fail', {
    latencyMs: Date.now() - tExternal,
    reason: externalMissReason || 'no-match',
  });
  if (signal?.aborted) {
    return { body: '', via: 'aborted', canonicalUrl: canonical, evidenceTrail: trail, aborted: true };
  }

  if (shallowPreviewResult) {
    // Shallow preview was already recorded as ok above; return it as the
    // final result with the full trail attached.
    return { ...shallowPreviewResult, evidenceTrail: trail };
  }

  return { body: '', via: 'none', canonicalUrl: canonical, evidenceTrail: trail, missed: true };
}

// ─── Phase G-1b error classifier (mirrors fetchUrlTool's) ─────────────────
//
// Same vocabulary as fetchUrlTool.classifyFetchError so cross-tool trail
// analysis works without translating reason codes.  Kept as a separate
// function (rather than imported) to avoid creating a circular dep
// (fetchUrlTool imports socialLinkTool, not the other way around).
function classifySocialError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (!msg) return 'error';
  if (msg.includes('abort')) return 'aborted';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('socket') || msg.includes('econnreset') || msg.includes('econnrefused')) return 'network';
  if (msg.includes('certificate') || msg.includes('ssl')) return 'tls';
  if (/\b4\d\d\b/.test(msg)) return '4xx';
  if (/\b5\d\d\b/.test(msg)) return '5xx';
  if (msg.includes('parse')) return 'parse-error';
  return 'error';
}
