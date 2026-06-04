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
import { readSocialLink } from './socialLinkReader.js';

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

// ─── G-1b follow-up #1 (Codex C 闭环 2026-05-10): mid-loop abort coverage ────
//
// Pre-fix, the share-preview / browser / external-reader multi-candidate
// loops did `if (signal?.aborted) return null;` which broke the G-1b
// contract (every social-link return carries an evidenceTrail).  Now they
// route through bailAbortedSocial() which records the current tier as
// fail reason=aborted-mid-loop AND the remaining tiers as skip
// reason=aborted-by-prev-tier — trail is always shape-stable.
//
// Test pattern: stub globalThis.fetch so resolveShortLink returns a
// canonical URL different from the input, giving uniqueStrategyUrls 2
// candidates and forcing the for-loop to enter at least once.  Then the
// mocked sub-fn aborts the signal after its first call so the next
// iteration's top-of-loop check fires bailAbortedSocial().

async function withShortLinkResolveTo(canonicalUrl, body) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', {
    status: 302,
    headers: { location: canonicalUrl },
  });
  try { return await body(); } finally { globalThis.fetch = originalFetch; }
}

test('readSocialLink: mid-loop abort in share-preview returns marker with full trail (current=fail, browser+external=skip)', async () => {
  const ac = new AbortController();
  const out = await withShortLinkResolveTo(
    'https://www.xiaohongshu.com/explore/abc',
    () => readSocialLink('https://xhslink.com/abc', {
      signal: ac.signal,
      ytdlpFn: async () => null,
      previewFn: async () => { ac.abort(); return null; },  // abort then return null → loop continues, top check fires
      browserPreviewFn: async () => ({ title: 'must not see' }),  // would otherwise be tried
      externalReaderFn: async () => ({ content: 'must not see' }),
    }),
  );
  assert.equal(out.aborted, true);
  assert.equal(out.via, 'aborted');
  const tiers = out.evidenceTrail.map(e => `${e.tier}.${e.outcome}`);
  // share-preview ran (and was aborted mid-loop), browser + external never started.
  assert.ok(tiers.includes('share-preview.fail'),
    `share-preview must record fail; got ${tiers.join(', ')}`);
  assert.ok(tiers.includes('browser.skip'),
    `browser must record skip when aborted before reaching it; got ${tiers.join(', ')}`);
  assert.ok(tiers.includes('external-reader.skip'),
    `external-reader must record skip when aborted before reaching it; got ${tiers.join(', ')}`);
  const shareEntry = out.evidenceTrail.find(e => e.tier === 'share-preview' && e.outcome === 'fail');
  assert.equal(shareEntry.reason, 'aborted-mid-loop');
});

test('readSocialLink: mid-loop abort in browser returns marker, external=skip', async () => {
  const ac = new AbortController();
  const out = await withShortLinkResolveTo(
    'https://www.xiaohongshu.com/explore/abc',
    () => readSocialLink('https://xhslink.com/abc', {
      signal: ac.signal,
      ytdlpFn: async () => null,
      previewFn: async () => null,
      browserPreviewFn: async () => { ac.abort(); return null; },
      externalReaderFn: async () => ({ content: 'must not see' }),
    }),
  );
  assert.equal(out.aborted, true);
  const browserEntry = out.evidenceTrail.find(e => e.tier === 'browser' && e.outcome === 'fail');
  assert.ok(browserEntry, 'browser must be recorded as fail');
  assert.equal(browserEntry.reason, 'aborted-mid-loop');
  const externalEntry = out.evidenceTrail.find(e => e.tier === 'external-reader' && e.outcome === 'skip');
  assert.ok(externalEntry, 'external-reader must be skip');
  assert.equal(externalEntry.reason, 'aborted-by-prev-tier');
});

test('readSocialLink: mid-loop abort in external-reader returns marker (no remaining tiers to skip)', async () => {
  const ac = new AbortController();
  const out = await withShortLinkResolveTo(
    'https://www.xiaohongshu.com/explore/abc',
    () => readSocialLink('https://xhslink.com/abc', {
      signal: ac.signal,
      ytdlpFn: async () => null,
      previewFn: async () => null,
      browserPreviewFn: async () => null,
      externalReaderFn: async () => { ac.abort(); return null; },
    }),
  );
  assert.equal(out.aborted, true);
  const externalEntry = out.evidenceTrail.find(e => e.tier === 'external-reader' && e.outcome === 'fail');
  assert.ok(externalEntry, 'external-reader must be recorded as fail');
  assert.equal(externalEntry.reason, 'aborted-mid-loop');
  // No tiers AFTER external-reader, so no extra skip entries past it.
  const externalIndex = out.evidenceTrail.findIndex(e => e === externalEntry);
  assert.equal(externalIndex, out.evidenceTrail.length - 1,
    'external-reader.fail must be the last trail entry (nothing to skip after)');
});

// ─── G-1b follow-up #2 (Codex C 闭环 round-2 2026-05-10) ─────────────────
//
// Single-candidate (direct URL where url === canonical) await-after abort
// case.  Loop entry check passes, the awaited sub-fn returns null (or a
// score-too-low preview) AFTER the signal fires inside the await.  Without
// the post-await abort check, the loop exits normally and the outer
// "no-match" recorder fires — breaking the 5-row schema.  Now the post-
// await check routes through bailAbortedSocial like a true mid-loop abort.

test('readSocialLink: direct URL share-preview await-after abort still records share-preview.fail aborted-mid-loop + skip remaining', async () => {
  // Direct host (xiaohongshu.com is NOT in SHORT_LINK_HOSTS), so
  // resolveShortLink returns the input unchanged → uniqueStrategyUrls
  // produces a single candidate.  previewFn aborts mid-await and returns
  // null; pre-fix this exited the loop normally and recorded
  // share-preview.fail no-match.  Post-fix the post-await abort check
  // catches it and bails to mid-loop semantics.
  const ac = new AbortController();
  const out = await readSocialLink('https://www.xiaohongshu.com/explore/abc', {
    signal: ac.signal,
    ytdlpFn: async () => null,
    previewFn: async () => { ac.abort(); return null; },
    browserPreviewFn: async () => ({ title: 'must not see', score: 100 }),
    externalReaderFn: async () => ({ content: 'must not see' }),
  });
  assert.equal(out.aborted, true);
  const shareEntry = out.evidenceTrail.find(e => e.tier === 'share-preview');
  assert.ok(shareEntry, 'share-preview entry expected');
  assert.equal(shareEntry.outcome, 'fail');
  assert.equal(shareEntry.reason, 'aborted-mid-loop',
    `single-candidate await-after abort must classify as aborted-mid-loop, not no-match; got ${shareEntry.reason}`);
  // 5-row schema must be intact: browser + external-reader skip.
  assert.ok(out.evidenceTrail.find(e => e.tier === 'browser' && e.outcome === 'skip'));
  assert.ok(out.evidenceTrail.find(e => e.tier === 'external-reader' && e.outcome === 'skip'));
});

test('readSocialLink: direct URL browser await-after abort still records browser.fail + external-reader.skip', async () => {
  const ac = new AbortController();
  const out = await readSocialLink('https://www.douyin.com/video/abc', {
    signal: ac.signal,
    ytdlpFn: async () => null,
    previewFn: async () => null,
    browserPreviewFn: async () => { ac.abort(); return null; },
    externalReaderFn: async () => ({ content: 'must not see' }),
  });
  assert.equal(out.aborted, true);
  const browserEntry = out.evidenceTrail.find(e => e.tier === 'browser');
  assert.equal(browserEntry?.outcome, 'fail');
  assert.equal(browserEntry?.reason, 'aborted-mid-loop');
  assert.ok(out.evidenceTrail.find(e => e.tier === 'external-reader' && e.outcome === 'skip'));
});

test('readSocialLink: direct URL external-reader await-after abort still records external-reader.fail (no remaining tiers)', async () => {
  const ac = new AbortController();
  const out = await readSocialLink('https://www.xiaohongshu.com/discovery/item/zzz', {
    signal: ac.signal,
    ytdlpFn: async () => null,
    previewFn: async () => null,
    browserPreviewFn: async () => null,
    externalReaderFn: async () => { ac.abort(); return null; },
  });
  assert.equal(out.aborted, true);
  const externalEntry = out.evidenceTrail.find(e => e.tier === 'external-reader');
  assert.equal(externalEntry?.outcome, 'fail');
  assert.equal(externalEntry?.reason, 'aborted-mid-loop');
  // external-reader is the last tier — nothing to skip after.
});

// ─── G-1b follow-up #3 (Codex C round-3 闭环 2026-05-10) ─────────────────
//
// Catch-path abort: when the awaited sub-fn rejects with AbortError (or
// the signal flips during the await and the sub-fn throws for unrelated
// reasons), the catch block must route through bailAbortedSocial too —
// not classifySocialError.  Otherwise the trail records reason='aborted'
// (generic) instead of 'aborted-mid-loop' AND remaining tiers don't get
// skip entries → 5-row schema breaks the same way as the resolve-null
// path before round-2.

function makeAbortRejector(ac) {
  return async () => {
    ac.abort();
    const err = new Error('aborted via reject');
    err.name = 'AbortError';
    throw err;
  };
}

test('readSocialLink: share-preview catch-path abort (sub-fn throws AbortError) records aborted-mid-loop + 5-row schema', async () => {
  const ac = new AbortController();
  const out = await readSocialLink('https://www.xiaohongshu.com/explore/abc', {
    signal: ac.signal,
    ytdlpFn: async () => null,
    previewFn: makeAbortRejector(ac),
    browserPreviewFn: async () => ({ title: 'must not see', score: 100 }),
    externalReaderFn: async () => ({ content: 'must not see' }),
  });
  assert.equal(out.aborted, true);
  const shareEntry = out.evidenceTrail.find(e => e.tier === 'share-preview');
  assert.equal(shareEntry?.outcome, 'fail');
  assert.equal(shareEntry?.reason, 'aborted-mid-loop',
    `catch-path abort must classify as aborted-mid-loop (not generic 'aborted'); got ${shareEntry?.reason}`);
  assert.ok(out.evidenceTrail.find(e => e.tier === 'browser' && e.outcome === 'skip'),
    'browser must still get skip entry on catch-path abort');
  assert.ok(out.evidenceTrail.find(e => e.tier === 'external-reader' && e.outcome === 'skip'),
    'external-reader must still get skip entry on catch-path abort');
});

test('readSocialLink: browser catch-path abort records aborted-mid-loop + external-reader.skip', async () => {
  const ac = new AbortController();
  const out = await readSocialLink('https://www.douyin.com/video/abc', {
    signal: ac.signal,
    ytdlpFn: async () => null,
    previewFn: async () => null,
    browserPreviewFn: makeAbortRejector(ac),
    externalReaderFn: async () => ({ content: 'must not see' }),
  });
  assert.equal(out.aborted, true);
  const browserEntry = out.evidenceTrail.find(e => e.tier === 'browser');
  assert.equal(browserEntry?.outcome, 'fail');
  assert.equal(browserEntry?.reason, 'aborted-mid-loop');
  assert.ok(out.evidenceTrail.find(e => e.tier === 'external-reader' && e.outcome === 'skip'));
});

test('readSocialLink: external-reader catch-path abort records aborted-mid-loop (no remaining tiers)', async () => {
  const ac = new AbortController();
  const out = await readSocialLink('https://www.xiaohongshu.com/discovery/item/zzz', {
    signal: ac.signal,
    ytdlpFn: async () => null,
    previewFn: async () => null,
    browserPreviewFn: async () => null,
    externalReaderFn: makeAbortRejector(ac),
  });
  assert.equal(out.aborted, true);
  const externalEntry = out.evidenceTrail.find(e => e.tier === 'external-reader');
  assert.equal(externalEntry?.outcome, 'fail');
  assert.equal(externalEntry?.reason, 'aborted-mid-loop');
});

test('readSocialLink: trail entry uses `extra` (not `metadata`) so cross-tool grep stays clean', async () => {
  // Source-level guard mirroring the fetchUrlTool one — trail entries must
  // never use `metadata:` field name to avoid colliding with the legacy
  // `meta:` contract on social-link returns elsewhere in the codebase.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const TOOL_SOURCE = readFileSync(join(here, 'socialLinkReader.js'), 'utf8');
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
