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

test('readSocialLink: yt-dlp success → renders title + uploader + description', async () => {
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
  assert.match(out, /猫猫的日常/);
  assert.match(out, /by 橘子君/);
  assert.match(out, /Views 1234/);
  assert.match(out, /Source: https:\/\/www\.douyin\.com\/video\/123/);
});

test('readSocialLink: yt-dlp returns null → falls through (will hit OG path or return null)', async () => {
  // No real network — this should reach the OG step which will fail
  // (or succeed if the test happens to be online; either way no
  // exception). Either case, no throw.
  const out = await readSocialLink(
    'https://www.xiaohongshu.com/explore/this-id-does-not-exist-12345',
    { ytdlpFn: async () => null, signal: AbortSignal.timeout(500) },
  );
  // Test asserts only that the call doesn't throw and returns either
  // a string (OG hit, unlikely on a fake URL) or null.
  assert.ok(out === null || typeof out === 'string');
});

test('readSocialLink: yt-dlp throws → caught, falls through to OG (no exception bubbles)', async () => {
  const ytdlpFn = async () => { throw new Error('yt-dlp not installed in this env'); };
  // Use a hostname that won't actually resolve so the OG fetch also
  // fails fast. The only thing under test is "yt-dlp throw doesn't
  // crash readSocialLink".
  const out = await readSocialLink(
    'https://xiaohongshu.com/explore/test',
    { ytdlpFn, signal: AbortSignal.timeout(500) },
  );
  assert.ok(out === null || typeof out === 'string');
});

// ── Render output structure ────────────────────────────────────────────

test('readSocialLink: yt-dlp result without optional fields still renders', async () => {
  // Bare-minimum metadata: only title. Confirm renderer doesn't crash
  // on missing uploader / description / counts.
  const ytdlpFn = async () => ({ title: 'Bare Title' });
  const out = await readSocialLink('https://xiaohongshu.com/explore/x', { ytdlpFn });
  assert.match(out, /Bare Title/);
  assert.match(out, /Source: https:\/\/xiaohongshu\.com\/explore\/x/);
  // Should NOT contain stat / uploader markers when those fields absent.
  assert.equal(out.includes('Views '), false);
  assert.equal(out.includes('by undefined'), false);
});
