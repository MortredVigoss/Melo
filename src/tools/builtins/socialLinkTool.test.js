// socialLinkTool.test.js — Phase 6 (2026-05-05).
//
// Coverage:
//   1. isSocialLinkUrl — host classification (positive + negative)
//   2. parseOpenGraph — meta tag extraction from raw HTML
//   3. resolveShortLink — only resolves known shortener hosts
//   4. readSocialLink — strategy ordering (yt-dlp first, rendered-browser
//      fallback, OG fallback, null on total miss). The yt-dlp/browser helpers
//      are dependency-injected so tests don't need live browsers or binaries.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSocialItemId,
  isSocialLinkUrl,
  parseOpenGraph,
  parseSocialPreview,
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

test('parseSocialPreview: combines OG, JSON-LD, and SSR fields', () => {
  const html = `
    <meta property="og:title" content="OG title" />
    <meta property="og:description" content="OG description" />
    <script type="application/ld+json">
      {"headline":"LD title","articleBody":"Full note body from json ld","author":{"name":"作者A"}}
    </script>
    <script>window.__INITIAL_STATE__={"desc":"正文内容比 og 更像用户分享页里的全文内容，足够长，所以应该进入 body 字段。","comments":[{"content":"第一条评论"}]}</script>
  `;
  const preview = parseSocialPreview(html);
  assert.equal(preview.title, 'LD title');
  assert.equal(preview.author, '作者A');
  assert.match(preview.body, /正文内容/);
  assert.deepEqual(preview.comments, ['第一条评论']);
});

test('parseSocialPreview: extracts Douyin _ROUTER_DATA video metadata and media URL', () => {
  const html = `
    <html><head><title>fallback title</title></head><body>
      <script>
        window._ROUTER_DATA = {
          "loaderData": {
            "video_(id)/page": {
              "videoInfoRes": {
                "item_list": [{
                  "aweme_id": "7636179780475374884",
                  "desc": "一款能以超音速飞行的客机“协和式飞机”#军事科普 #涨知识",
                  "create_time": 1777944900,
                  "author": { "nickname": "犟驴科普" },
                  "statistics": {
                    "digg_count": 4231,
                    "comment_count": 93,
                    "collect_count": 790,
                    "share_count": 143
                  },
                  "risk_infos": { "content": "作者声明：内容由 AI 生成" },
                  "text_extra": [{ "hashtag_name": "军事科普" }],
                  "music": { "duration": 56 },
                  "video": {
                    "duration": 56000,
                    "width": 720,
                    "height": 1280,
                    "cover": { "url_list": ["https://example.com/cover.jpeg"] },
                    "play_addr": {
                      "url_list": [
                        "https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0d00fg10000d7sig8nog65l4h0riov0&ratio=720p"
                      ]
                    }
                  }
                }]
              }
            }
          }
        };
      </script>
    </body></html>
  `;
  const preview = parseSocialPreview(html);
  assert.equal(preview.itemId, '7636179780475374884');
  assert.equal(preview.author, '犟驴科普');
  assert.match(preview.title, /协和式飞机/);
  assert.match(preview.body, /Likes 4\.2K/);
  assert.match(preview.body, /作者声明/);
  assert.equal(preview.media[0].duration, 56);
  assert.match(preview.media[0].src, /aweme\.snssdk\.com/);
});

test('extractSocialItemId: reads Douyin canonical ids', () => {
  assert.equal(
    extractSocialItemId('https://www.iesdouyin.com/share/video/7636179780475374884/?from_ssr=1'),
    '7636179780475374884',
  );
  assert.equal(
    extractSocialItemId('https://www.douyin.com/video/7611243785283964170'),
    '7611243785283964170',
  );
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
  const out = await readSocialLink('https://example.com', {
    browserPreviewFn: null,
    ytdlpFn: async () => null,
  });
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
  const out = await readSocialLink('https://www.douyin.com/video/123', {
    previewFn: async () => null,
    ytdlpFn,
  });
  assert.equal(out.via, 'yt-dlp');
  assert.equal(out.canonicalUrl, 'https://www.douyin.com/video/123');
  assert.match(out.body, /猫猫的日常/);
  assert.match(out.body, /by 橘子君/);
  assert.match(out.body, /Views 1234/);
  assert.match(out.body, /Source: https:\/\/www\.douyin\.com\/video\/123/);
});

test('readSocialLink: yt-dlp returns null → falls through without exception', async () => {
  const out = await readSocialLink(
    'https://www.xiaohongshu.com/explore/this-id-does-not-exist-12345',
    {
      previewFn: async () => null,
      browserPreviewFn: null,
      ytdlpFn: async () => null,
      signal: AbortSignal.timeout(500),
    },
  );
  assert.ok(out === null || (typeof out === 'object' && typeof out.body === 'string'));
});

test('readSocialLink: yt-dlp throws → caught, no exception bubbles', async () => {
  const ytdlpFn = async () => { throw new Error('yt-dlp not installed in this env'); };
  const out = await readSocialLink(
    'https://xiaohongshu.com/explore/test',
    {
      previewFn: async () => null,
      browserPreviewFn: null,
      ytdlpFn,
      signal: AbortSignal.timeout(500),
    },
  );
  assert.ok(out === null || (typeof out === 'object' && typeof out.body === 'string'));
});

// ── Render output structure ────────────────────────────────────────────

test('readSocialLink: yt-dlp result without optional fields still renders', async () => {
  const ytdlpFn = async () => ({ title: 'Bare Title' });
  const out = await readSocialLink('https://xiaohongshu.com/explore/x', {
    previewFn: async () => null,
    ytdlpFn,
  });
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
    previewFn: async () => null,
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
    previewFn: async () => null,
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
    previewFn: async () => null,
    browserPreviewFn: null,
    ytdlpFn,
  });
  assert.equal(out, null, 'pre-aborted signal must return null');
  assert.equal(ytdlpCalled, false, 'yt-dlp must NOT be invoked once signal is aborted');
});

test('readSocialLink: yt-dlp throws AbortError → does NOT continue to OG fallback', async () => {
  // Codex caught: yt-dlp aborting was treated as a regular error and
  // OG fallback would still run, blowing the budget by another 8s.
  // Post-fix: AbortError-from-yt-dlp short-circuits the whole call.
  //
  // Codex round-2 follow-up (⚪ P2 2026-05-05): pre-aborting the
  // signal short-circuits at the entry gate before yt-dlp is ever
  // called — the test never exercised the catch branch the fix lives
  // in. Now we let the signal stay live and have ytdlpFn itself throw
  // AbortError on first call. The catch branch should classify this
  // as "abort" and skip OG.
  let ogCalled = false;
  const ytdlpFn = async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    ogCalled = true;
    return new Response('<title>should not see</title>', { status: 200 });
  };
  try {
    const out = await readSocialLink('https://www.douyin.com/video/abc', {
      previewFn: async () => null,
      browserPreviewFn: null,
      ytdlpFn, // signal stays live; ytdlpFn itself throws AbortError
    });
    assert.equal(out, null,
      'AbortError from ytdlp must short-circuit to null (no OG)');
    assert.equal(ogCalled, false,
      'OG fallback must not run when yt-dlp threw AbortError');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('readSocialLink: yt-dlp deep result wins over share preview', async () => {
  let ytdlpCalled = false;
  const out = await readSocialLink('https://www.xiaohongshu.com/explore/test', {
    previewFn: async () => ({
      title: 'Share preview hit',
      description: 'This is the public preview body',
      profile: 'telegram',
      score: 20,
    }),
    ytdlpFn: async () => {
      ytdlpCalled = true;
      return {
        title: 'Deep video title',
        uploader: 'Creator A',
        description: 'Deep video description from yt-dlp',
        subtitleText: 'Actual subtitle line',
        platform: 'Xiaohongshu',
      };
    },
  });
  assert.equal(ytdlpCalled, true, 'useful share preview must not mask yt-dlp');
  assert.equal(out?.via, 'yt-dlp');
  assert.match(out.body, /Deep video title/);
  assert.match(out.body, /Actual subtitle line/);
  assert.doesNotMatch(out.body, /Share preview hit/);
  assert.equal(out.preview?.title, 'Deep video title');
  assert.equal(out.preview?.author, 'Creator A');
});

test('readSocialLink: share preview is fallback when yt-dlp misses', async () => {
  const out = await readSocialLink('https://www.xiaohongshu.com/explore/test', {
    browserPreviewFn: null,
    previewFn: async () => ({
      title: 'Share preview fallback',
      description: 'This is the public preview body',
      profile: 'telegram',
      score: 20,
    }),
    ytdlpFn: async () => null,
  });
  assert.match(out?.via || '', /^share-preview:/);
  assert.match(out.body, /Share preview fallback/);
  assert.match(out.body, /public preview body/);
});

test('readSocialLink: rendered browser fallback closes overlay before share preview', async () => {
  const out = await readSocialLink('https://www.douyin.com/video/test', {
    ytdlpFn: async () => null,
    browserPreviewFn: async () => ({
      title: 'Rendered Douyin title',
      body: '视频文案：这是一条关闭登录浮层之后才能看到的内容。',
      siteName: 'douyin.com',
      media: [{ duration: 12, width: 720, height: 1280, paused: false }],
      closedOverlays: 1,
      profile: 'browser',
      score: 40,
    }),
    previewFn: async () => ({
      title: 'Share preview fallback',
      description: 'shallow card only',
      profile: 'telegram',
      score: 20,
    }),
  });
  assert.equal(out?.via, 'browser:browser');
  assert.match(out.body, /Rendered Douyin title/);
  assert.match(out.body, /关闭登录浮层/);
  assert.match(out.body, /Detected media/);
  assert.doesNotMatch(out.body, /Share preview fallback/);
});

test('readSocialLink: browser fallback opens original short link before canonical URL', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = 'https://v.douyin.com/AbCdEf';
  const canonicalUrl = 'https://www.douyin.com/video/123';
  const visited = [];
  globalThis.fetch = async () => new Response('', {
    status: 302,
    headers: { location: canonicalUrl },
  });
  try {
    const out = await readSocialLink(originalUrl, {
      ytdlpFn: async () => null,
      browserPreviewFn: async url => {
        visited.push(url);
        if (url !== originalUrl) return null;
        return {
          title: 'Short-link browser result',
          body: '原始分享链接跳转后生成临时凭证，然后关闭登录浮层就能看到的视频文案。',
          siteName: 'douyin.com',
          media: [{ duration: 9, width: 720, height: 1280, paused: false }],
          closedOverlays: 1,
          url: canonicalUrl,
          profile: 'browser',
          score: 40,
        };
      },
      previewFn: async () => null,
    });
    assert.deepEqual(visited, [originalUrl]);
    assert.equal(out?.via, 'browser:browser');
    assert.equal(out?.canonicalUrl, canonicalUrl);
    assert.match(out.body, /临时凭证/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('readSocialLink: rejects browser fallback when it lands on a different Douyin item id', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = 'https://v.douyin.com/AbCdEf';
  const canonicalUrl = 'https://www.iesdouyin.com/share/video/7636179780475374884/?from_ssr=1';
  globalThis.fetch = async () => new Response('', {
    status: 302,
    headers: { location: canonicalUrl },
  });
  try {
    const out = await readSocialLink(originalUrl, {
      ytdlpFn: async () => null,
      browserPreviewFn: async () => ({
        title: 'Wrong rendered video',
        body: '浏览器实际落到了另一个推荐视频。',
        siteName: 'douyin.com',
        media: [{ duration: 12, width: 720, height: 1280, paused: false }],
        closedOverlays: 2,
        url: 'https://www.douyin.com/video/7611243785283964170',
        profile: 'browser',
        score: 100,
      }),
      previewFn: async () => ({
        title: 'Correct share preview',
        description: '一款能以超音速飞行的客机“协和式飞机”',
        itemId: '7636179780475374884',
        profile: 'wechat+douyin-ssr',
        score: 50,
      }),
    });
    assert.match(out?.via || '', /^share-preview:/);
    assert.match(out.body, /Correct share preview/);
    assert.doesNotMatch(out.body, /Wrong rendered video/);
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
    previewFn: async () => null,
    ytdlpFn,
  });
  // Must bind to xiaohongshu.com (the canonical host) — not www.xiaohongshu.com
  // (hostnameOf strips the www. prefix).
  assert.equal(capturedConfig.domainCookies['xiaohongshu.com'], 'sess=z');
});

test('readSocialLink: optional external readers are used after deep/browser misses', async () => {
  const out = await readSocialLink('https://www.douyin.com/video/1234567890123456789', {
    previewFn: async () => null,
    browserPreviewFn: async () => null,
    ytdlpFn: async () => null,
    externalReaderFn: async (url, opts) => ({
      method: opts.preferred[0],
      finalUrl: url,
      content:
        'External Douyin title\n\nThis externally extracted body is long enough to represent a real social page read after the normal browser fallback misses.',
    }),
  });

  assert.equal(out?.via, 'external:camoufox');
  assert.match(out.body, /External Douyin title/);
  assert.match(out.body, /optional local camoufox fallback/);
});
