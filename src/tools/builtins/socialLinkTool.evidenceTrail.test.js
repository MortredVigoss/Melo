/**
 * Phase G-1b (2026-05-10): regression coverage for the evidenceTrail
 * collection added to readSocialLink.
 *
 * Five sub-tiers we expect entries for (in order):
 *   short-link-resolve → yt-dlp → share-preview → browser → external-reader
 *
 * What we pin:
 *   1. Each sub-strategy emits exactly one trail entry per call (ok / fail
 *      / skip). The skip outcome maps to abort gates between strategies
 *      so callers can tell "we never tried X" from "X failed".
 *   2. Every return path (success / null-replacement / abort) carries
 *      `evidenceTrail: []` plus at least one entry — never absent.
 *   3. Reason vocabulary aligns with fetchUrlTool's classifier (aborted /
 *      timeout / network / 4xx / 5xx / parse-error / error / no-content /
 *      no-preview / low-score / no-title-or-body / unsupported-or-no-meta).
 *   4. Backward-compat: callers that key off `result?.body` still see
 *      falsy on miss/abort paths (body remains '' or 'aborted' via marker).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readSocialLink } from './socialLinkTool.js';

function assertTrailEntryShape(entry) {
  assert.equal(typeof entry.tier, 'string');
  assert.ok(['ok', 'fail', 'skip'].includes(entry.outcome), `outcome ${entry.outcome} in ok|fail|skip`);
  assert.equal(typeof entry.latencyMs, 'number');
  assert.ok(entry.latencyMs >= 0);
}

test('readSocialLink: non-social URL returns null without trail (early bail by isSocialLinkUrl gate)', async () => {
  const result = await readSocialLink('https://example.com/article', {});
  assert.equal(result, null,
    'non-social hosts must short-circuit before trail collection — backward compat');
});

test('readSocialLink: yt-dlp success path emits short-link-resolve.ok + yt-dlp.ok and no later sub-tiers', async () => {
  const result = await readSocialLink('https://www.xiaohongshu.com/discovery/item/abc', {
    ytdlpFn: async () => ({ title: 'Hello', description: 'world', subtitleText: '' }),
    previewFn: async () => null,  // would fall through if reached
    browserPreviewFn: async () => null,
    externalReaderFn: async () => null,
  });
  assert.ok(result, 'success result must be returned');
  assert.equal(result.via, 'yt-dlp');
  assert.ok(Array.isArray(result.evidenceTrail));
  assert.equal(result.evidenceTrail.length, 2,
    'success at yt-dlp emits exactly 2 entries (short-link-resolve + yt-dlp)');
  for (const e of result.evidenceTrail) assertTrailEntryShape(e);
  assert.equal(result.evidenceTrail[0].tier, 'short-link-resolve');
  assert.equal(result.evidenceTrail[0].outcome, 'ok');
  assert.equal(result.evidenceTrail[1].tier, 'yt-dlp');
  assert.equal(result.evidenceTrail[1].outcome, 'ok');
  assert.equal(result.evidenceTrail[1].extra?.hasTitle, true);
});

test('readSocialLink: yt-dlp throws → share-preview deep success path emits 3 entries (short-link, yt-dlp.fail, share-preview.ok)', async () => {
  const result = await readSocialLink('https://www.xiaohongshu.com/discovery/item/xyz', {
    ytdlpFn: async () => { throw new Error('yt-dlp not installed'); },
    previewFn: async (url) => ({
      // Score >= DEEP_SOCIAL_PREVIEW_SCORE (40 by default — see socialLinkTool source)
      // requires multiple fields. Build a maximal preview to pass the gate.
      title: 'Real article title that scores high',
      description: 'A long description that adds to the score significantly here today',
      siteName: 'xiaohongshu',
      url,
      image: 'https://example.com/img.jpg',
      author: 'someone',
      itemId: 'item-xyz',
      profile: 'xhs',
      body: 'A long body of content easily exceeding the share-preview score threshold for deep success in this regression test',
      media: [{ type: 'image', url: 'https://example.com/img.jpg' }],
    }),
    browserPreviewFn: async () => null,
    externalReaderFn: async () => null,
  });
  assert.ok(result);
  assert.match(result.via || '', /^share-preview:/);
  assert.ok(Array.isArray(result.evidenceTrail));
  const tiers = result.evidenceTrail.map(e => e.tier);
  assert.deepEqual(
    tiers,
    ['short-link-resolve', 'yt-dlp', 'share-preview'],
    `expected ordered sub-tiers; got ${tiers.join(', ')}`,
  );
  const ytdlpEntry = result.evidenceTrail.find(e => e.tier === 'yt-dlp');
  assert.equal(ytdlpEntry.outcome, 'fail');
  assert.ok(['error', 'aborted', 'timeout', 'network', 'parse-error'].includes(ytdlpEntry.reason),
    `yt-dlp.fail reason must be a known classification; got ${ytdlpEntry.reason}`);
  const shareEntry = result.evidenceTrail.find(e => e.tier === 'share-preview');
  assert.equal(shareEntry.outcome, 'ok');
  assert.equal(shareEntry.extra?.deep, true);
});

test('readSocialLink: full miss (every strategy returns null) emits 5-entry trail and a body=\'\' marker for backward compat', async () => {
  const result = await readSocialLink('https://www.douyin.com/video/missing', {
    ytdlpFn: async () => null,
    previewFn: async () => null,
    browserPreviewFn: async () => null,
    externalReaderFn: async () => null,
  });
  assert.ok(result, 'miss path now returns marker object instead of bare null (G-1b contract change)');
  assert.equal(result.body, '', 'body remains empty so backward-compat callers `if (result?.body)` still treat as miss');
  assert.equal(result.missed, true);
  assert.ok(Array.isArray(result.evidenceTrail));
  const tiers = result.evidenceTrail.map(e => e.tier);
  assert.deepEqual(
    tiers,
    ['short-link-resolve', 'yt-dlp', 'share-preview', 'browser', 'external-reader'],
    `full miss must record all 5 sub-tiers in order; got ${tiers.join(', ')}`,
  );
  // First entry (short-link-resolve) is ok or fail depending on host; last 4 must be fail.
  for (const tier of ['yt-dlp', 'share-preview', 'browser', 'external-reader']) {
    const entry = result.evidenceTrail.find(e => e.tier === tier);
    assert.equal(entry.outcome, 'fail', `${tier} must be fail when nothing returns content`);
    assert.ok(typeof entry.reason === 'string' && entry.reason.length > 0,
      `${tier}.fail must carry a non-empty reason`);
  }
});

test('readSocialLink: abort signal at entry returns aborted marker with single skip entry', async () => {
  const ac = new AbortController();
  ac.abort();
  const result = await readSocialLink('https://www.xiaohongshu.com/discovery/item/abc', {
    signal: ac.signal,
    ytdlpFn: async () => ({ title: 'never reached' }),
  });
  assert.ok(result);
  assert.equal(result.aborted, true);
  assert.equal(result.via, 'aborted');
  assert.equal(result.body, '');
  assert.ok(Array.isArray(result.evidenceTrail));
  assert.equal(result.evidenceTrail.length, 1);
  const entry = result.evidenceTrail[0];
  assert.equal(entry.tier, 'short-link-resolve');
  assert.equal(entry.outcome, 'skip');
  assert.equal(entry.reason, 'aborted-at-entry');
});

test('readSocialLink: trail entry uses `extra` (not `metadata`) so cross-tool grep stays clean', async () => {
  // Source-level guard mirroring the fetchUrlTool one — trail entries must
  // never use `metadata:` field name to avoid colliding with the legacy
  // `meta:` contract on social-link returns elsewhere in the codebase.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const TOOL_SOURCE = readFileSync(join(here, 'socialLinkTool.js'), 'utf8');
  // Match real recordSocialTrail CALLS, not the function declaration
  // (which has no string-literal first arg after `trail,`).
  const calls = TOOL_SOURCE.matchAll(/recordSocialTrail\(trail,\s*['"][^'"]+['"][\s\S]*?\)\s*;/g);
  let n = 0;
  for (const m of calls) {
    n += 1;
    assert.equal(/\bmetadata:/.test(m[0]), false,
      `recordSocialTrail call must not use \`metadata:\`; offending: ${m[0].slice(0, 200)}`);
  }
  assert.ok(n >= 10, `expected >= 10 recordSocialTrail calls in source, got ${n}`);
});
