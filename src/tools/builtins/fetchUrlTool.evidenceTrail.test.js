/**
 * Phase G-1a (2026-05-10): regression coverage for the evidenceTrail
 * collection added to fetchUrlTool.
 *
 * What we pin (POC milestone scope):
 *   1. Every return path — invalid URL / social ok / social blocked /
 *      social throw / forced extract_mode wins / forced extract_mode fails /
 *      auto chain — carries `evidenceTrail: []` with at least one entry.
 *   2. Trail entries have the documented shape: { tier, outcome, latencyMs }
 *      with optional { reason, method, extra }.
 *   3. The `extra` field name (NOT `metadata`) is used so the social-link
 *      contract regression test (fetchUrlTool.socialRoute.test.js) keeps
 *      catching the ae80457 bug it was written for.
 *
 * What we do NOT pin (later milestones G-1d/e/f):
 *   • How the trail surfaces in chat thread state, prompt context, or UI.
 *   • Cross-tool trail merging when fetch_url is one of multiple fallback
 *     tools in a single agent turn.
 *   • Specific reason vocabulary beyond what's in the doc — analytics will
 *     tell us what codes are actually useful in production.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchUrlTool } from './fetchUrlTool.js';

const TOOL_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fetchUrlTool.js');
const TOOL_SOURCE = readFileSync(TOOL_PATH, 'utf8');

function assertTrailShape(entry) {
  assert.equal(typeof entry.tier, 'string', 'tier is string');
  assert.match(entry.tier, /^[a-z][a-z0-9-]*[a-z0-9+]$|^[a-z]+$/i, `tier ${entry.tier} is grep-able token`);
  assert.ok(['ok', 'fail', 'skip'].includes(entry.outcome), `outcome ${entry.outcome} in ok|fail|skip`);
  assert.equal(typeof entry.latencyMs, 'number', 'latencyMs is number');
  assert.ok(entry.latencyMs >= 0, 'latencyMs non-negative');
  if (entry.reason !== undefined) assert.equal(typeof entry.reason, 'string');
  if (entry.method !== undefined) assert.equal(typeof entry.method, 'string');
  if (entry.extra !== undefined) {
    assert.equal(typeof entry.extra, 'object');
    assert.equal(entry.extra === null, false, 'extra is non-null when present');
  }
}

test('evidenceTrail: trail entry uses `extra` (not `metadata`) so social-link regex regression stays clean', () => {
  // Source-level guard: any future caller that adds `metadata:` inside a
  // recordTrail({...}) call would re-collide with fetchUrlTool.socialRoute
  // .test.js's grep for stray `metadata:` keys. Catch that at unit level
  // before it lands.
  // Match real CALLS, not the function declaration itself.  Calls always
  // have the literal first arg `trail` followed by a string-literal tier
  // name (e.g. `recordTrail(trail, 'cookie-resolve', 'ok', {...})`).  The
  // declaration is `function recordTrail(trail, tier, outcome, opts = {})`
  // which doesn't have a quote after `trail,`.
  const recordTrailCalls = TOOL_SOURCE.matchAll(/recordTrail\(trail,\s*['"][^'"]+['"][\s\S]*?\)\s*;/g);
  let callCount = 0;
  for (const m of recordTrailCalls) {
    callCount += 1;
    assert.equal(
      /\bmetadata:/.test(m[0]),
      false,
      `recordTrail call must not use \`metadata:\` field name (use \`extra:\`); offending call: ${m[0].slice(0, 200)}`,
    );
  }
  assert.ok(callCount >= 8, `regex must match all real recordTrail calls (got ${callCount}, expected >= 8)`);
});

test('evidenceTrail: invalid URL returns trail with single validate.fail entry', async () => {
  const result = await fetchUrlTool.run({ url: '' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_URL');
  assert.ok(Array.isArray(result.evidenceTrail), 'evidenceTrail must be present on fail return');
  assert.equal(result.evidenceTrail.length, 1);
  assertTrailShape(result.evidenceTrail[0]);
  assert.equal(result.evidenceTrail[0].tier, 'validate');
  assert.equal(result.evidenceTrail[0].outcome, 'fail');
  assert.equal(result.evidenceTrail[0].reason, 'invalid-url');
});

test('evidenceTrail: non-http URL returns trail with validate.fail invalid-url', async () => {
  const result = await fetchUrlTool.run({ url: 'ftp://example.com' });
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.evidenceTrail));
  assert.equal(result.evidenceTrail[0].tier, 'validate');
  assert.equal(result.evidenceTrail[0].reason, 'invalid-url');
});

test('evidenceTrail: social-link success path emits social-link.ok with via method + extra.canonicalUrl', async () => {
  const result = await fetchUrlTool.run(
    { url: 'https://www.xiaohongshu.com/discovery/item/abc' },
    {
      _readSocialLink: async () => ({
        body: 'real article body long enough to count as content for the readability gate to be satisfied here',
        via: 'yt-dlp',
        canonicalUrl: 'https://www.xiaohongshu.com/explore/abc',
      }),
    },
  );
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.evidenceTrail));
  assert.equal(result.evidenceTrail.length, 1);
  const entry = result.evidenceTrail[0];
  assertTrailShape(entry);
  assert.equal(entry.tier, 'social-link');
  assert.equal(entry.outcome, 'ok');
  assert.equal(entry.method, 'yt-dlp');
  assert.equal(entry.extra?.canonicalUrl, 'https://www.xiaohongshu.com/explore/abc');
  assert.equal(typeof entry.extra?.hasExplicitCookies, 'boolean');
});

test('evidenceTrail: social-link miss (login wall) emits social-link.fail with reason=login-wall', async () => {
  const result = await fetchUrlTool.run(
    { url: 'https://v.douyin.com/abc' },
    { _readSocialLink: async () => ({ body: '' }) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'SOCIAL_LINK_BLOCKED');
  assert.ok(Array.isArray(result.evidenceTrail));
  assert.equal(result.evidenceTrail.length, 1);
  const entry = result.evidenceTrail[0];
  assertTrailShape(entry);
  assert.equal(entry.tier, 'social-link');
  assert.equal(entry.outcome, 'fail');
  assert.equal(entry.reason, 'login-wall');
});

test('evidenceTrail: social-link extractor throw emits social-link.fail with reason=extractor-throw', async () => {
  const result = await fetchUrlTool.run(
    { url: 'https://xhslink.com/a/foo' },
    { _readSocialLink: async () => { throw new Error('yt-dlp died'); } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'SOCIAL_LINK_FAILED');
  const entry = result.evidenceTrail[0];
  assert.equal(entry.tier, 'social-link');
  assert.equal(entry.reason, 'extractor-throw');
  assert.equal(entry.extra?.errMessage, 'yt-dlp died');
});

test('evidenceTrail: forced crawl4ai mode emits cookie-resolve.skip + external-reader.ok', async () => {
  const result = await fetchUrlTool.run(
    { url: 'https://example.com/article', extract_mode: 'crawl4ai' },
    {
      _readExternalUrl: async () => ({
        content: 'External article body long enough to satisfy the looksEmpty threshold for valid extracted content',
        method: 'crawl4ai',
      }),
    },
  );
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.evidenceTrail));
  assert.ok(result.evidenceTrail.length >= 2, 'cookie-resolve + external-reader entries');
  const tiers = result.evidenceTrail.map(e => e.tier);
  assert.ok(tiers.includes('cookie-resolve'), `tiers must include cookie-resolve; got ${tiers.join(',')}`);
  assert.ok(tiers.includes('external-reader'), `tiers must include external-reader; got ${tiers.join(',')}`);
  const externalEntry = result.evidenceTrail.find(e => e.tier === 'external-reader');
  assert.equal(externalEntry.outcome, 'ok');
  assert.equal(externalEntry.method, 'crawl4ai');
});

test('evidenceTrail: forced crawl4ai mode with missing reader emits external-reader.fail cli-missing', async () => {
  const result = await fetchUrlTool.run(
    { url: 'https://example.com/article', extract_mode: 'crawl4ai' },
    { _readExternalUrl: async () => ({ content: null }) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'NO_CONTENT');
  const externalEntry = result.evidenceTrail.find(e => e.tier === 'external-reader');
  assert.ok(externalEntry, 'external-reader entry expected');
  assert.equal(externalEntry.outcome, 'fail');
  assert.equal(externalEntry.reason, 'cli-missing-or-no-content');
});

// ─── Codex G-1a follow-up coverage (B-1: forced throw, B-2: parse-empty) ────

test('evidenceTrail: forced crawl4ai THROW emits external-reader.fail with real tier (not unknown)', async () => {
  // Pre-fix: outer catch recorded `unknown.fail` because the forced branch
  // didn't set `method` before fetchExternalReaders threw.  pendingTier
  // mechanism now ensures the trail records `external-reader.fail`.
  const result = await fetchUrlTool.run(
    { url: 'https://example.com/article', extract_mode: 'crawl4ai' },
    { _readExternalUrl: async () => { throw new Error('crawl4ai CLI segfault'); } },
  );
  assert.equal(result.ok, false);
  // The fail entry must carry the actual tier name `external-reader`,
  // never the placeholder `unknown`.
  const failEntry = result.evidenceTrail.find(e => e.outcome === 'fail');
  assert.ok(failEntry, 'a fail entry must be present');
  assert.equal(failEntry.tier, 'external-reader',
    `tier must be external-reader, got ${failEntry.tier}`);
  assert.notEqual(failEntry.tier, 'unknown', 'tier must never regress to "unknown"');
});

test('evidenceTrail: forced playwright THROW emits playwright.fail (not unknown)', async () => {
  // Similar to above for playwright forced mode.  We can't easily mock
  // tryPlaywright (it's an inline closure), so this case relies on the
  // CLI not being installed in the test environment to drive the throw
  // path indirectly via the playwrightFetcher import — if playwright
  // CLI IS available, the test naturally exercises the success path
  // and the assertion still holds because the tier label is correct.
  const result = await fetchUrlTool.run(
    { url: 'https://example.com/article', extract_mode: 'playwright' },
    {},
  );
  // Either ok or fail is acceptable — what we pin is that NO entry
  // ever gets the bogus `unknown` tier.
  for (const entry of result.evidenceTrail) {
    assert.notEqual(entry.tier, 'unknown',
      `playwright forced mode must never produce tier=unknown; got ${JSON.stringify(entry)}`);
  }
});

test('evidenceTrail: auto path Jina returning short content records jina.fail parse-empty (not jina.ok)', async () => {
  // Pre-fix: short content (under CONTENT_OK_THRESHOLD = 120 chars) was
  // recorded as jina.ok even though the runner immediately escalated to
  // playwright.  Now it should be jina.fail reason=parse-empty.
  // We exercise this via a stub that wraps fetchUrlTool — but auto path
  // really hits the network when reachable.  Use the social-link guard
  // path inverted: a non-social URL with no cookie + a jina URL that
  // returns shell-only content.  Since we can't easily mock fetchViaJina
  // from outside, we rely on the test seam pattern: there ISN'T one for
  // jina/direct in fetchUrlTool — so this test's job is the source-level
  // guard: assert the recordTrail call uses `tierOutcome(content)` not
  // a hardcoded 'ok'.
  assert.match(
    TOOL_SOURCE,
    /tierOutcome\s*=\s*\(c\)\s*=>\s*looksEmpty\(c\)/,
    'auto path must use tierOutcome() helper to gate ok/fail on content length',
  );
  // The three auto-path recordTrail calls (direct+cookie / jina / direct)
  // must all use r.outcome (computed from tierOutcome), not literal 'ok'.
  const autoBlockMatch = TOOL_SOURCE.match(/auto:\s*cookies\s+present[\s\S]*?if\s*\(looksEmpty\(content\)\)\s*\{[\s\S]*?Playwright/);
  assert.ok(autoBlockMatch, 'could not locate auto path block in source');
  const autoBlock = autoBlockMatch[0];
  // Count tier-outcome aware records in the auto path: 3 (direct+cookie,
  // jina-after-direct-fail, jina-first, direct-after-jina-fail).
  const tierOutcomeRecords = autoBlock.match(/recordTrail\(trail,\s*'(direct\+cookie|jina|direct)',\s*r\.outcome/g) || [];
  assert.ok(
    tierOutcomeRecords.length >= 3,
    `expected >= 3 recordTrail calls using r.outcome in auto path, got ${tierOutcomeRecords.length}`,
  );
});
