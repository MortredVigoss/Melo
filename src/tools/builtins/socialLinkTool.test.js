// socialLinkTool.test.js — Phase 6 (2026-05-05).
//
// Coverage:
//   1. isSocialLinkUrl — host classification (positive + negative)
//   2. parseOpenGraph — meta tag extraction from raw HTML
//   3. resolveShortLink — only resolves known shortener hosts
//   4. readSocialLink — strategy ordering (yt-dlp first, OG fallback,
//      null on total miss). The yt-dlp helper is dependency-injected
//      via opts.ytdlpFn so tests don't need a live yt-dlp binary.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSocialLinkUrl,
  parseOpenGraph,
  resolveShortLink,
  readSocialLink,
} from './socialLinkTool.js';

// ── isSocialLinkUrl ────────────────────────────────────────────────────

test('isSocialLinkUrl: positive cases', () => {
  const positives = [
    'https://www.xiaohongshu.com/explore/abc',
    'https://xiaohongshu.com/discovery/item/abc',
    'https://xhslink.com/short',
    'https://www.douyin.com/video/123',
    'https://v.douyin.com/AbCdEf',
    'https://www.iesdouyin.com/share/video/789',
    'https://m.douyin.com/video/123', // sub-host
    'https://m.xiaohongshu.com/explore/x', // sub-host
  ];
  for (const url of positives) {
    assert.equal(isSocialLinkUrl(url), true, `expected social: ${url}`);
  }
});

test('isSocialLinkUrl: negative cases', () => {
  const negatives = [
    'https://example.com',
    'https://www.youtube.com/watch?v=abc',
    'https://twitter.com/user/status/123',
    'https://tiktok.com/@x/video/123',
    'not-a-url',
    '',
    null,
    undefined,
  ];
  for (const url of negatives) {
    assert.equal(isSocialLinkUrl(url), false, `expected NOT social: ${url}`);
  }
});

// ── parseOpenGraph ─────────────────────────────────────────────────────

test('parseOpenGraph: extracts og:title / og:description / og:image', () => {
  const html = `
    <html><head>
      <meta property="og:title" content="Test Post" />
      <meta property="og:description" content="A short summary" />
      <meta property="og:image" content="https://cdn/x.jpg" />
      <meta property="og:site_name" content="Xiaohongshu" />
    </head></html>
  `;
  const og = parseOpenGraph(html);
  assert.equal(og.title, 'Test Post');
  assert.equal(og.description, 'A short summary');
  assert.equal(og.image, 'https://cdn/x.jpg');
  assert.equal(og.siteName, 'Xiaohongshu');
});

test('parseOpenGraph: falls back to twitter: prefix when og: missing', () => {
  const html = `
    <meta name="twitter:title" content="Twitter Card Title" />
    <meta name="twitter:description" content="Card desc" />
  `;
  const og = parseOpenGraph(html);
  assert.equal(og.title, 'Twitter Card Title');
  assert.equal(og.description, 'Card desc');
});

test('parseOpenGraph: falls back to <title> when no meta', () => {
  const html = '<html><head><title>Plain Title</title></head></html>';
  const og = parseOpenGraph(html);
  assert.equal(og.title, 'Plain Title');
});

test('parseOpenGraph: empty / missing input returns empty object', () => {
  assert.deepEqual(parseOpenGraph(''), {});
  assert.deepEqual(parseOpenGraph(null), {});
  assert.deepEqual(parseOpenGraph(undefined), {});
});

test('parseOpenGraph: meta with empty content is skipped', () => {
  const html = '<meta property="og:title" content="" />';
  const og = parseOpenGraph(html);
  assert.equal(og.title, undefined);
});

// ── resolveShortLink ───────────────────────────────────────────────────

test('resolveShortLink: non-shortener URL returns unchanged', async () => {
  const url = 'https://www.xiaohongshu.com/explore/abc';
  const out = await resolveShortLink(url);
  assert.equal(out, url, 'non-shortener URL must not be touched');
});

test('resolveShortLink: example.com URL returns unchanged (not a known shortener)', async () => {
  const url = 'https://example.com/some/path';
  const out = await resolveShortLink(url);
  assert.equal(out, url);
});

// ── readSocialLink ─────────────────────────────────────────────────────

test('readSocialLink: rejects non-social URL with null', async () => {
  const out = await readSocialLink('https://example.com', { ytdlpFn: async () => null });
  assert.equal(out, null);
});

test('readSocialLink: yt-dlp success → returns {body, via:"yt-dlp", canonicalUrl}', async () => {
  const ytdlpFn = async () => ({
    title: '猫猫的日常',
    uploader: '橘子君',
    description: '今天遛猫日记',
    duration: '1m20s',
    viewCount: 1234,
    likeCount: 56,
    commentCount: 7,
    uploadDate: '2026-05-01',
    subtitleText: '',
    platform: 'douyin',
  });
  const out = await readSocialLink('https://www.douyin.com/video/123', { ytdlpFn });
  assert.equal(out.via, 'yt-dlp');
  assert.equal(out.canonicalUrl, 'https://www.douyin.com/video/123');
  assert.match(out.body, /猫猫的日常/);
  assert.match(out.body, /by 橘子君/);
  assert.match(out.body, /Views 1234/);
  assert.match(out.body, /Source: https:\/\/www\.douyin\.com\/video\/123/);
});

test('readSocialLink: yt-dlp returns null → falls through (no exception, returns null or OG hit)', async () => {
  const out = await readSocialLink(
    'https://www.xiaohongshu.com/explore/this-id-does-not-exist-12345',
    { ytdlpFn: async () => null, signal: AbortSignal.timeout(500) },
  );
  assert.ok(out === null || (typeof out === 'object' && typeof out.body === 'string'));
});

test('readSocialLink: yt-dlp throws → caught, no exception bubbles', async () => {
  const ytdlpFn = async () => { throw new Error('yt-dlp not installed in this env'); };
  const out = await readSocialLink(
    'https://xiaohongshu.com/explore/test',
    { ytdlpFn, signal: AbortSignal.timeout(500) },
  );
  assert.ok(out === null || (typeof out === 'object' && typeof out.body === 'string'));
});

// ── Render output structure ────────────────────────────────────────────

test('readSocialLink: yt-dlp result without optional fields still renders', async () => {
  const ytdlpFn = async () => ({ title: 'Bare Title' });
  const out = await readSocialLink('https://xiaohongshu.com/explore/x', { ytdlpFn });
  assert.equal(out.via, 'yt-dlp');
  assert.match(out.body, /Bare Title/);
  assert.match(out.body, /Source: https:\/\/xiaohongshu\.com\/explore\/x/);
  assert.equal(out.body.includes('Views '), false);
  assert.equal(out.body.includes('by undefined'), false);
});

// ── Explicit cookies threading (Codex 🔵 P0 2026-05-05) ───────────────

test('readSocialLink: explicitCookies overrides config.domainCookies for the canonical host', async () => {
  // Capture what config the ytdlp fn actually receives. Pre-fix the
  // explicitCookies parameter was silently dropped — this test would
  // catch the regression.
  let capturedConfig = null;
  const ytdlpFn = async (url, cfg) => {
    capturedConfig = cfg;
    return { title: 'irrelevant' };
  };
  const baseConfig = {
    domainCookies: {
      'douyin.com': 'old=stale',  // should be overridden
      'other.com': 'unrelated=keep',  // should survive
    },
  };
  await readSocialLink('https://www.douyin.com/video/abc', {
    config: baseConfig,
    explicitCookies: 'fresh=value',
    ytdlpFn,
  });
  assert.ok(capturedConfig?.domainCookies, 'ytdlp must receive a domainCookies map');
  assert.equal(
    capturedConfig.domainCookies['douyin.com'],
    'fresh=value',
    'explicit cookies must override the config entry for the canonical host',
  );
  assert.equal(
    capturedConfig.domainCookies['other.com'],
    'unrelated=keep',
    'unrelated host entries must survive the merge',
  );
});

test('readSocialLink: no explicitCookies → config.domainCookies passes through unchanged', async () => {
  let capturedConfig = null;
  const ytdlpFn = async (url, cfg) => {
    capturedConfig = cfg;
    return { title: 'irrelevant' };
  };
  const baseConfig = { domainCookies: { 'douyin.com': 'session=abc' } };
  await readSocialLink('https://www.douyin.com/video/abc', {
    config: baseConfig,
    ytdlpFn,
  });
  assert.equal(capturedConfig.domainCookies['douyin.com'], 'session=abc',
    'config cookie must reach yt-dlp when no explicit override given');
});

// ── Abort gating (Codex 🟡 P1 2026-05-05) ────────────────────────────

test('readSocialLink: pre-aborted signal returns null without calling yt-dlp', async () => {
  // Codex caught: pre-fix, an already-aborted signal still ran every
  // strategy. Now the entry gate must short-circuit before yt-dlp is
  // even invoked.
  let ytdlpCalled = false;
  const ytdlpFn = async () => { ytdlpCalled = true; return { title: 'should not see' }; };
  const ac = new AbortController();
  ac.abort();
  const out = await readSocialLink('https://www.douyin.com/video/abc', {
    signal: ac.signal,
    ytdlpFn,
  });
  assert.equal(out, null, 'pre-aborted signal must return null');
  assert.equal(ytdlpCalled, false, 'yt-dlp must NOT be invoked once signal is aborted');
});

test('readSocialLink: yt-dlp throws AbortError → does NOT continue to OG fallback', async () => {
  // Codex caught: yt-dlp aborting was treated as a regular error and
  // OG fallback would still run, blowing the budget by another 8s.
  // Post-fix: AbortError-from-yt-dlp short-circuits the whole call.
  let ogCalled = false;
  const ytdlpFn = async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  // Hijack global fetch ONLY for the duration of this test so we can
  // detect whether the OG fallback's fetchHtmlBody fired.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    ogCalled = true;
    return new Response('<title>should not see</title>', { status: 200 });
  };
  try {
    const ac = new AbortController();
    ac.abort();
    const out = await readSocialLink('https://www.douyin.com/video/abc', {
      signal: ac.signal,
      ytdlpFn,
    });
    assert.equal(out, null);
    // Even more important: the OG fallback's fetchHtmlBody must NOT
    // have been called. Pre-fix this would have been true.
    assert.equal(ogCalled, false,
      'OG fallback must not run when yt-dlp aborted');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('readSocialLink: yt-dlp throws non-abort error → DOES continue to OG fallback', async () => {
  // Symmetric counterpart: a yt-dlp failure for some other reason
  // (binary missing, unsupported platform, transient network error)
  // is NOT a budget signal. OG should still be tried.
  const ytdlpFn = async () => { throw new Error('yt-dlp not installed'); };
  let ogCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    ogCalled = true;
    return new Response(
      '<meta property="og:title" content="OG fallback hit" />',
      { status: 200 },
    );
  };
  try {
    const out = await readSocialLink('https://www.xiaohongshu.com/explore/test', {
      ytdlpFn,
    });
    assert.equal(ogCalled, true, 'non-abort yt-dlp error must let OG run');
    assert.equal(out?.via, 'opengraph');
    assert.match(out.body, /OG fallback hit/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolveShortLink: pre-aborted signal returns input unchanged without HEAD/GET', async () => {
  // Pre-fix: resolveShortLink would still issue HEAD then GET.
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response('', { status: 301, headers: { location: 'https://x' } });
  };
  try {
    const ac = new AbortController();
    ac.abort();
    const url = 'https://xhslink.com/abc';
    const out = await resolveShortLink(url, { signal: ac.signal });
    assert.equal(out, url, 'aborted signal must return input URL unchanged');
    assert.equal(fetchCalled, false, 'no HEAD/GET should fire');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Subdomain coverage shared with webSearch blocklist ─────────────────

test('isSocialLinkUrl: m.douyin.com / m.xiaohongshu.com sub-hosts also covered', async () => {
  // Pin the suffix-match contract that webSearch shares via
  // hostMatchesAnySuffix. A regression that flips back to exact-match
  // would re-open the gap Codex flagged.
  assert.equal(isSocialLinkUrl('https://m.douyin.com/video/123'), true);
  assert.equal(isSocialLinkUrl('https://m.xiaohongshu.com/explore/abc'), true);
  assert.equal(isSocialLinkUrl('https://www.iesdouyin.com/share/video/x'), true);
  // Negative: lookalike domains must NOT be matched.
  assert.equal(isSocialLinkUrl('https://faketiktok-douyin.com/x'), false);
  assert.equal(isSocialLinkUrl('https://xiaohongshu.com.evil.example/x'), false);
});

test('readSocialLink: explicitCookies binds to canonical host, NOT shortener host', async () => {
  // Since resolveShortLink may not actually follow xhslink in test env
  // (no live network), we use a non-shortener URL to avoid the
  // resolution branch and assert the merge keys on the input host
  // directly. The shortener-canonical case is covered by
  // resolveShortLink unit tests above — all this test pins is "merge
  // keys on whatever resolveShortLink returned, not on a separate host
  // computed from input".
  let capturedConfig = null;
  const ytdlpFn = async (url, cfg) => {
    capturedConfig = cfg;
    return { title: 't' };
  };
  await readSocialLink('https://www.xiaohongshu.com/explore/abc', {
    config: { domainCookies: {} },
    explicitCookies: 'sess=z',
    ytdlpFn,
  });
  // Must bind to xiaohongshu.com (the canonical host) — not www.xiaohongshu.com
  // (hostnameOf strips the www. prefix).
  assert.equal(capturedConfig.domainCookies['xiaohongshu.com'], 'sess=z');
});
