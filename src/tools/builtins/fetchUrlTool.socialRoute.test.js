// fetchUrlTool.socialRoute.test.js — Phase 6 (2026-05-05).
//
// Pin the early-route contract:
//   • Social-link hosts (xhs / douyin / xhslink / iesdouyin / v.douyin)
//     bypass jina/direct/playwright entirely. The user's diagnosis
//     identified those generic fetchers as guaranteed-failures on these
//     anti-bot pages — wasting the budget instead of failing fast.
//   • extract_mode='playwright' is the explicit override (escape hatch
//     for diagnosis); auto / direct / jina all early-route.
//   • A social-link miss returns SOCIAL_LINK_BLOCKED with an actionable
//     hint pointing the user at the cookies UI — NOT a falls-through to
//     jina/direct/playwright that would silently waste the next 14s.
//
// We don't (and can't) actually run yt-dlp / hit live network here.
// Instead we exercise the routing logic and the error-shape contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchUrlTool } from './fetchUrlTool.js';
import { isSocialLinkUrl } from './socialLinkTool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_SOURCE = readFileSync(join(__dirname, 'fetchUrlTool.js'), 'utf8');

// Static-source contract pins — cheap insurance that a future refactor
// doesn't accidentally drop the early-route branch or stop forwarding
// extract_mode='playwright' as the override.

test('fetchUrlTool source imports the social-link router', () => {
  assert.match(TOOL_SOURCE, /import\s+\{\s*isSocialLinkUrl,\s*readSocialLink\s*\}\s+from\s+'\.\/socialLinkTool\.js'/);
});

test('fetchUrlTool source has the early-route conditional with playwright escape hatch', () => {
  // Pin the exact gate so a refactor that flips the comparison or
  // drops the override-mode check shows up red.
  assert.match(
    TOOL_SOURCE,
    /isSocialLinkUrl\(normalized\)\s*&&\s*extract_mode\s*!==\s*['"]playwright['"]/,
  );
});

test('fetchUrlTool source returns SOCIAL_LINK_BLOCKED on miss (not falls through)', () => {
  assert.match(TOOL_SOURCE, /error:\s*['"]SOCIAL_LINK_BLOCKED['"]/);
  // Pin the actionable hint copy — Customize → Safety path the user
  // needs to click. If the UI section ever moves we want the test to
  // fail so docs stay aligned.
  assert.match(TOOL_SOURCE, /Customize → Safety → Web-fetch cookies/);
});

// End-to-end (with mocked extractor): a non-social URL must NOT hit
// the early-route at all. Run with extract_mode='direct' and a
// bogus URL — the social-link branch would short-circuit BEFORE
// fetch was reached, so a 404 / DNS error means we did NOT take the
// social-link route. The signal AbortSignal.timeout makes this
// finish in well under a second.

test('non-social URL passes through early-route (does NOT short-circuit to SOCIAL_LINK_BLOCKED)', async () => {
  const result = await fetchUrlTool.run(
    { url: 'https://this-host-does-not-exist-test.invalid', extract_mode: 'direct' },
    { signal: AbortSignal.timeout(500), config: {} },
  );
  // Whatever happens (network error, timeout) the error code MUST NOT
  // be SOCIAL_LINK_BLOCKED — that would mean the early-route fired
  // for a non-social URL.
  if (!result.ok) {
    assert.notEqual(result.error, 'SOCIAL_LINK_BLOCKED');
    assert.notEqual(result.error, 'SOCIAL_LINK_FAILED');
  }
});

test('isSocialLinkUrl: webSearchTool blocklist must include every host the early-route covers', () => {
  // Cross-system contract: if a host is recognised by isSocialLinkUrl,
  // web_search MUST also block it from content-fetch. Otherwise
  // web_search wastes its budget on a host fetch_url already routes
  // around. Pin the alignment by reading both sides from source.
  const webSearchSource = readFileSync(
    join(__dirname, 'webSearchTool.js'),
    'utf8',
  );
  const SOCIAL_HOSTS = [
    'douyin.com', 'v.douyin.com', 'iesdouyin.com',
    'xiaohongshu.com', 'xhslink.com',
  ];
  for (const host of SOCIAL_HOSTS) {
    // Both sides should reference the bare host string.
    assert.ok(isSocialLinkUrl(`https://${host}/anything`),
      `socialLinkTool must recognise ${host}`);
    assert.match(
      webSearchSource,
      new RegExp(`['"]${host.replace(/\./g, '\\.')}['"]`),
      `webSearchTool blocklist must include ${host}`,
    );
  }
});
