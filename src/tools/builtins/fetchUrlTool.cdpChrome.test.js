/**
 * Stage 2b: fetchUrlTool cdp-chrome tier integration tests.
 *
 * All Chrome / CDP interactions mocked via the `_tryCdpChrome` override —
 * no real Chrome spawn.  These tests pin the wiring contract:
 *
 *   1. Auto path + MELO_CDP_ENABLED=1 + HTTP fail → cdp-chrome runs as
 *      escalation tier and records ok/fail trail entry.
 *   2. Auto path + env off → cdp-chrome NOT tried (Stage 2b promise: no
 *      regression for users who don't opt in).
 *   3. Explicit extract_mode='cdp-chrome' → always runs regardless of env.
 *   4. cdp-chrome ok → escalation chain stops before playwright tier.
 *   5. cdp-chrome fail → falls through to playwright tier.
 *
 * Real-Chrome integration testing is intentionally deferred to a
 * MELO_TEST_REAL_CHROME=1-guarded test in a later stage.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchUrlTool } from './fetchUrlTool.js';

const SITE = 'https://example.com/test-cdp-chrome';
// Content samples must exceed CONTENT_OK_THRESHOLD (120 chars whitespace-
// stripped) or fetchUrlTool's looksEmpty gate will treat them as parse-
// empty and escalate to the next tier — defeating "cdp-chrome ok stops
// the chain" assertions.  Pad descriptions so the body is comfortably
// over 120 chars even after whitespace strip.
const CDP_OK_BODY = (
  'CDP-fetched page content — this is a real-browser render of the SPA shell ' +
  'with the user\'s logged-in cookies in place, including the article body, ' +
  'sidebar metadata, comment thread, and footer navigation links.  Padded to ' +
  'pass the looksEmpty gate (>120 chars whitespace-stripped) so the auto path ' +
  'sees cdp-chrome as a successful escalation and does NOT fall through to the ' +
  'playwright tier below it.'
);
const PLAYWRIGHT_OK_BODY = (
  'Playwright real-browser content fallback — same shape as the CDP body but ' +
  'returned from the headless Chromium CLI tier when cdp-chrome is unavailable ' +
  'or fails.  Padded over the 120-char threshold for the same looksEmpty reason.'
);

let prevEnv;
test.beforeEach(() => {
  prevEnv = process.env.MELO_CDP_ENABLED;
  // Default to env OFF — each test explicitly sets it to '1' when needed.
  delete process.env.MELO_CDP_ENABLED;
});
test.afterEach(() => {
  if (prevEnv === undefined) delete process.env.MELO_CDP_ENABLED;
  else process.env.MELO_CDP_ENABLED = prevEnv;
});

// Shared injection bundle — HTTP tiers (jina + direct) both return empty,
// forcing the escalation chain to reach the real-browser tiers.  Each test
// then overrides _tryCdpChrome / _tryPlaywright to assert what fires.
function emptyHttpDeps() {
  return {
    _fetchViaJina: async () => '', // empty body
    _fetchDirect: async () => '', // empty body
  };
}

// ─── Auto path: env on → cdp-chrome runs as escalation ──────────────────────

test('auto + MELO_CDP_ENABLED=1 + HTTP fail → cdp-chrome ok records escalation trail; playwright NOT tried', async () => {
  process.env.MELO_CDP_ENABLED = '1';
  let cdpCallCount = 0;
  let playwrightCallCount = 0;
  const result = await fetchUrlTool.run({ url: SITE }, {
    ...emptyHttpDeps(),
    _tryCdpChrome: async () => {
      cdpCallCount += 1;
      return CDP_OK_BODY;
    },
    _tryPlaywright: async () => {
      playwrightCallCount += 1;
      return PLAYWRIGHT_OK_BODY;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(cdpCallCount, 1, 'cdp-chrome must run when env on + HTTP fail');
  assert.equal(playwrightCallCount, 0, 'playwright must NOT run when cdp-chrome succeeds');
  const cdpEntry = result.evidenceTrail.find(e => e.tier === 'cdp-chrome');
  assert.equal(cdpEntry?.outcome, 'ok');
  assert.equal(cdpEntry?.extra?.escalation, true);
});

test('auto + MELO_CDP_ENABLED=1 + cdp-chrome fail → falls through to playwright', async () => {
  process.env.MELO_CDP_ENABLED = '1';
  let cdpCallCount = 0;
  let playwrightCallCount = 0;
  const result = await fetchUrlTool.run({ url: SITE }, {
    ...emptyHttpDeps(),
    _tryCdpChrome: async () => {
      cdpCallCount += 1;
      throw new Error('Chrome binary not found at /fake/Chrome');
    },
    _tryPlaywright: async () => {
      playwrightCallCount += 1;
      return PLAYWRIGHT_OK_BODY;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(cdpCallCount, 1);
  assert.equal(playwrightCallCount, 1, 'playwright must run as next escalation after cdp-chrome fail');
  const cdpEntry = result.evidenceTrail.find(e => e.tier === 'cdp-chrome');
  assert.equal(cdpEntry?.outcome, 'fail');
  const pwEntry = result.evidenceTrail.find(e => e.tier === 'playwright');
  assert.equal(pwEntry?.outcome, 'ok');
});

test('auto + MELO_CDP_ENABLED=1 + cdp-chrome returns empty → records parse-empty fail + falls through', async () => {
  process.env.MELO_CDP_ENABLED = '1';
  let playwrightCallCount = 0;
  const result = await fetchUrlTool.run({ url: SITE }, {
    ...emptyHttpDeps(),
    _tryCdpChrome: async () => '', // empty body, treated like parse-empty per the existing looksEmpty gate
    _tryPlaywright: async () => {
      playwrightCallCount += 1;
      return PLAYWRIGHT_OK_BODY;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(playwrightCallCount, 1);
  const cdpEntry = result.evidenceTrail.find(e => e.tier === 'cdp-chrome');
  assert.equal(cdpEntry?.outcome, 'fail');
  assert.match(cdpEntry?.reason || '', /no-content|parse-empty/);
});

// ─── Auto path: env off → cdp-chrome must NOT run ───────────────────────────

test('auto + env OFF → cdp-chrome skipped entirely (pre-Stage-2b behavior preserved)', async () => {
  // env intentionally NOT set
  let cdpCallCount = 0;
  let playwrightCallCount = 0;
  await fetchUrlTool.run({ url: SITE }, {
    ...emptyHttpDeps(),
    _tryCdpChrome: async () => {
      cdpCallCount += 1;
      return 'should not run';
    },
    _tryPlaywright: async () => {
      playwrightCallCount += 1;
      return PLAYWRIGHT_OK_BODY;
    },
  });
  assert.equal(cdpCallCount, 0, 'cdp-chrome must NOT be called when MELO_CDP_ENABLED is not 1');
  assert.equal(playwrightCallCount, 1, 'playwright escalation runs as the only real-browser tier when env off');
});

test('auto + env="0" → cdp-chrome skipped (strict "===1" check, not truthy)', async () => {
  process.env.MELO_CDP_ENABLED = '0';
  let cdpCallCount = 0;
  await fetchUrlTool.run({ url: SITE }, {
    ...emptyHttpDeps(),
    _tryCdpChrome: async () => { cdpCallCount += 1; return 'x'; },
    _tryPlaywright: async () => PLAYWRIGHT_OK_BODY,
  });
  assert.equal(cdpCallCount, 0, 'only "===1" enables; other truthy strings stay disabled');
});

// ─── Explicit extract_mode='cdp-chrome' ────────────────────────────────────

test('explicit extract_mode="cdp-chrome" + env OFF → still runs (user override)', async () => {
  // env intentionally not set — explicit mode should bypass the gate.
  let cdpCallCount = 0;
  let jinaCallCount = 0;
  const result = await fetchUrlTool.run({ url: SITE, extract_mode: 'cdp-chrome' }, {
    _fetchViaJina: async () => { jinaCallCount += 1; return 'should not run'; },
    _fetchDirect: async () => 'should not run',
    _tryCdpChrome: async () => {
      cdpCallCount += 1;
      return CDP_OK_BODY;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(cdpCallCount, 1);
  assert.equal(jinaCallCount, 0, 'explicit cdp-chrome must NOT also run jina');
  const cdpEntry = result.evidenceTrail.find(e => e.tier === 'cdp-chrome');
  assert.equal(cdpEntry?.outcome, 'ok');
  assert.equal(cdpEntry?.extra?.extractMode, 'cdp-chrome');
});

test('explicit extract_mode="cdp-chrome" + tryCdpChrome throws → ok:false FETCH_FAILED + trail records fail', async () => {
  const result = await fetchUrlTool.run({ url: SITE, extract_mode: 'cdp-chrome' }, {
    _tryCdpChrome: async () => {
      throw new Error('CDP port did not respond');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'FETCH_FAILED');
  const cdpEntry = result.evidenceTrail.find(e => e.tier === 'cdp-chrome');
  assert.equal(cdpEntry?.outcome, 'fail');
});

test('explicit extract_mode="cdp-chrome" + returns empty → ok:false NO_CONTENT', async () => {
  const result = await fetchUrlTool.run({ url: SITE, extract_mode: 'cdp-chrome' }, {
    _tryCdpChrome: async () => null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'NO_CONTENT');
  const cdpEntry = result.evidenceTrail.find(e => e.tier === 'cdp-chrome');
  assert.equal(cdpEntry?.outcome, 'fail');
  assert.equal(cdpEntry?.reason, 'no-content');
});

// ─── Schema: 'cdp-chrome' is in the enum ────────────────────────────────────

test('parametersSchema enum contains "cdp-chrome"', () => {
  const enums = fetchUrlTool.parametersSchema?.properties?.extract_mode?.enum;
  assert.ok(Array.isArray(enums));
  assert.ok(enums.includes('cdp-chrome'), `enum must include cdp-chrome; got ${enums.join(', ')}`);
});

// ─── Stage 2b round-2 闭环: fake-Browser test for context selection ───────

test('tryCdpChrome reuses browser.contexts()[0] (default persistent) — does NOT call newContext', async () => {
  // Codex round-2 闭环 (2026-05-16): the explicit-override tests above all
  // bypass the real tryCdpChrome → withMeloChrome → browser interaction,
  // so they couldn't catch the login-state-destroying newContext() bug
  // round-1 shipped with.  This test injects a fake Browser via the
  // connect.js DI seam so the REAL tryCdpChrome runs and we can verify
  // which Browser methods get called.
  const connectMod = await import('../../services/browser/connect.js');

  let newContextCallCount = 0;
  let contextCloseCallCount = 0;
  let pageCloseCallCount = 0;
  let gotoCallCount = 0;

  const defaultContext = {
    newPage: async () => ({
      goto: async () => { gotoCallCount += 1; },
      evaluate: async () => 'Fake Browser page text returned from default persistent context; pretend this is the logged-in user\'s Twitter feed body or similar auth-walled content.  Padded so looksEmpty does not fire and the auto path treats this as a successful CDP fetch.',
      close: async () => { pageCloseCallCount += 1; },
    }),
    close: async () => { contextCloseCallCount += 1; },
  };
  const fakeBrowser = {
    contexts: () => [defaultContext],
    newContext: async () => { newContextCallCount += 1; return defaultContext; },
    close: async () => {}, // CDP detach (withMeloChrome will call this)
  };

  connectMod._setEnsureChromeForTests(async () => ({
    port: 7777, pid: 1, reused: true, profileDir: '/p', lockPath: '/l',
  }));
  connectMod._setConnectImplForTests(async () => fakeBrowser);

  try {
    process.env.MELO_CDP_ENABLED = '1';
    const result = await fetchUrlTool.run({ url: SITE }, {
      _fetchViaJina: async () => '', // HTTP fails, escalates to cdp-chrome
      _fetchDirect: async () => '',
      _tryPlaywright: async () => PLAYWRIGHT_OK_BODY, // would fall through if cdp fails
    });

    assert.equal(result.ok, true);
    assert.equal(gotoCallCount, 1, 'tryCdpChrome must call page.goto exactly once');
    assert.equal(newContextCallCount, 0,
      'newContext() must NEVER be called — that would destroy login state');
    assert.equal(contextCloseCallCount, 0,
      'context.close() must NEVER be called — keeps user logged-in across fetches');
    assert.equal(pageCloseCallCount, 1,
      'page.close() must be called exactly once — cleans up the new tab but keeps context alive');

    const cdpEntry = result.evidenceTrail.find(e => e.tier === 'cdp-chrome');
    assert.equal(cdpEntry?.outcome, 'ok');
  } finally {
    connectMod._setEnsureChromeForTests(null);
    connectMod._setConnectImplForTests(null);
  }
});

test('explicit extract_mode="cdp-chrome" on social URL bypasses social-link extractor (Codex round-3 闭环)', async () => {
  // Round-3: the social-link early-routing short-circuit only let
  // `extract_mode='playwright'` through as an escape hatch, so explicit
  // `cdp-chrome` on a twitter/reddit URL got rerouted to the social-link
  // extractor instead — breaking the schema's "explicit modes force their
  // tier" contract.  This test pins the fix: cdp-chrome explicit on a
  // social URL must call _tryCdpChrome.
  const twitterUrl = 'https://twitter.com/anthropic/status/1234567890';
  let cdpCallCount = 0;
  let socialLinkCallCount = 0;
  const result = await fetchUrlTool.run({ url: twitterUrl, extract_mode: 'cdp-chrome' }, {
    _tryCdpChrome: async () => {
      cdpCallCount += 1;
      return CDP_OK_BODY;
    },
    _readSocialLink: async () => {
      socialLinkCallCount += 1;
      return { ok: true, output: 'social-link extractor result (should NOT run)', evidenceTrail: [] };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(cdpCallCount, 1, 'explicit cdp-chrome on social URL must invoke CDP, not social-link');
  assert.equal(socialLinkCallCount, 0, 'social-link extractor must NOT run when user explicitly chose cdp-chrome');
  const cdpEntry = result.evidenceTrail.find(e => e.tier === 'cdp-chrome');
  assert.equal(cdpEntry?.outcome, 'ok');
});

test('tryCdpChrome uses domcontentloaded — pages that never reach networkidle still extract (Codex round-3 闭环)', async () => {
  // Round-3: pre-fix `waitUntil: 'networkidle'` would 20s-timeout on long-
  // polling sites (Twitter / Discord / Slack embeds / anything with
  // open WebSockets or SSE).  This test wires a fake page whose goto
  // resolves with `domcontentloaded` but a hypothetical `networkidle`
  // wait would never resolve — the previous implementation would
  // FETCH_FAILED on it; the fix uses domcontentloaded + a short
  // stability wait so it succeeds.
  const connectMod = await import('../../services/browser/connect.js');

  let gotoWaitUntil = null;
  const longPollingPage = {
    goto: async (_url, opts) => {
      gotoWaitUntil = opts?.waitUntil;
      // Resolve immediately — DOM is ready, but a real networkidle wait
      // would still be open (long-polling).  In the test we just resolve;
      // the assertion is that the code passed 'domcontentloaded', not
      // 'networkidle'.
    },
    waitForLoadState: async () => {
      // Simulate the `load` state firing — short-circuit the 3s timeout.
    },
    evaluate: async () => 'Long-polling site page body — Twitter-like SPA with WebSockets streaming in the background that would never reach networkidle, but DOM content is already rendered and innerText is available.',
    close: async () => {},
  };
  const defaultContext = {
    newPage: async () => longPollingPage,
    close: async () => {},
  };
  const fakeBrowser = {
    contexts: () => [defaultContext],
    newContext: async () => defaultContext,
    close: async () => {},
  };

  connectMod._setEnsureChromeForTests(async () => ({
    port: 7779, pid: 1, reused: true, profileDir: '/p', lockPath: '/l',
  }));
  connectMod._setConnectImplForTests(async () => fakeBrowser);

  try {
    const result = await fetchUrlTool.run({ url: 'https://twitter.com/x/status/1', extract_mode: 'cdp-chrome' }, {});
    assert.equal(result.ok, true, 'long-polling page must succeed (pre-fix would 20s-timeout)');
    assert.equal(gotoWaitUntil, 'domcontentloaded',
      `goto must use domcontentloaded, not networkidle; got: ${gotoWaitUntil}`);
  } finally {
    connectMod._setEnsureChromeForTests(null);
    connectMod._setConnectImplForTests(null);
  }
});

test('tryCdpChrome: defensive fallback — contexts() returns [] → newContext() (shouldn\'t happen with CDP attach but won\'t crash)', async () => {
  const connectMod = await import('../../services/browser/connect.js');

  let newContextCallCount = 0;
  const fallbackContext = {
    newPage: async () => ({
      goto: async () => {},
      evaluate: async () => 'Fallback context page body — wide enough to pass the looksEmpty 120-char threshold so the test treats this fetch as a successful escalation outcome even on the defensive newContext() path.',
      close: async () => {},
    }),
    close: async () => {},
  };
  const fakeBrowser = {
    contexts: () => [], // empty — exercise the fallback
    newContext: async () => { newContextCallCount += 1; return fallbackContext; },
    close: async () => {},
  };

  connectMod._setEnsureChromeForTests(async () => ({
    port: 7778, pid: 1, reused: true, profileDir: '/p', lockPath: '/l',
  }));
  connectMod._setConnectImplForTests(async () => fakeBrowser);

  try {
    process.env.MELO_CDP_ENABLED = '1';
    const result = await fetchUrlTool.run({ url: SITE }, {
      _fetchViaJina: async () => '',
      _fetchDirect: async () => '',
      _tryPlaywright: async () => PLAYWRIGHT_OK_BODY,
    });

    assert.equal(result.ok, true);
    assert.equal(newContextCallCount, 1,
      'empty contexts() array exercises the defensive fallback');
  } finally {
    connectMod._setEnsureChromeForTests(null);
    connectMod._setConnectImplForTests(null);
  }
});
