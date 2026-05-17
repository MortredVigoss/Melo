/**
 * Stage 3a: pageRegistry unit tests.
 *
 * Connection / CDP / playwright-core all DI'd via _setConnectImplForTests
 * so tests run without real Chrome.  Coverage:
 *   • MELO_CDP_ENABLED=1 gate (env off → openPage throws clearly)
 *   • URL validation (non-http rejected)
 *   • Happy path: open → register → getPage / peekPageInfo / pageCount
 *     return consistent state
 *   • contexts()[0] reuse semantic (NOT newContext) — same as Stage 2b/2c
 *   • Close path: page + browser handle both closed, entry dropped
 *   • Idempotent close — closing unknown / already-closed → false
 *   • getPage bumps lastUsedAt; peekPageInfo does not
 *   • cleanupIdlePages closes only stale entries
 *   • closeAllPages clears registry, swallows individual errors
 *   • goto failure → page + browser both cleaned up, no leak
 *   • signal aborted between connect and goto → cleanup + AbortError
 */

import test from 'node:test';
import assert from 'node:assert/strict';

test.afterEach(async () => {
  const mod = await import('./pageRegistry.js');
  mod._setConnectImplForTests(null);
  mod._resetPagesForTests();
});

let prevCdpEnv;
test.beforeEach(() => {
  prevCdpEnv = process.env.MELO_CDP_ENABLED;
  // Default env ON for all tests — opt out explicitly when testing the gate.
  process.env.MELO_CDP_ENABLED = '1';
});
test.afterEach(() => {
  if (prevCdpEnv === undefined) delete process.env.MELO_CDP_ENABLED;
  else process.env.MELO_CDP_ENABLED = prevCdpEnv;
});

function makeFakePage({ gotoThrows = null, currentUrl = null } = {}) {
  let closeCallCount = 0;
  let gotoCallCount = 0;
  const page = {
    goto: async (url) => {
      gotoCallCount += 1;
      if (gotoThrows) throw gotoThrows;
    },
    waitForLoadState: async () => {},
    close: async () => { closeCallCount += 1; },
    get gotoCallCount() { return gotoCallCount; },
    get closeCallCount() { return closeCallCount; },
  };
  return page;
}

function makeFakeBrowser(pages, { newContextCalls = { count: 0 } } = {}) {
  let browserCloseCallCount = 0;
  const context = {
    newPage: async () => pages.shift() || makeFakePage(),
    close: async () => {},
  };
  const browser = {
    contexts: () => [context],
    newContext: async () => { newContextCalls.count += 1; return context; },
    close: async () => { browserCloseCallCount += 1; },
    get closeCallCount() { return browserCloseCallCount; },
  };
  return { browser, context, _newContextCalls: newContextCalls };
}

// ─── env gate ────────────────────────────────────────────────────────────────

test('openPage: env OFF → throws "MELO_CDP_ENABLED=1 required"', async () => {
  delete process.env.MELO_CDP_ENABLED;
  const { openPage } = await import('./pageRegistry.js');
  await assert.rejects(() => openPage('https://example.com/x'), /MELO_CDP_ENABLED=1/);
});

test('openPage: env="0" → throws (strict === "1" check)', async () => {
  process.env.MELO_CDP_ENABLED = '0';
  const { openPage } = await import('./pageRegistry.js');
  await assert.rejects(() => openPage('https://example.com/x'), /MELO_CDP_ENABLED=1/);
});

// ─── URL validation ────────────────────────────────────────────────────────

test('openPage: rejects non-http(s) URLs with clear error', async () => {
  const { openPage } = await import('./pageRegistry.js');
  await assert.rejects(() => openPage('file:///tmp/x.html'), /must be http\(s\)/);
  await assert.rejects(() => openPage(''), /must be http\(s\)/);
  await assert.rejects(() => openPage(null), /must be http\(s\)/);
});

// ─── Happy path ────────────────────────────────────────────────────────────

test('openPage: registers + returns {pageId, currentUrl}', async () => {
  const mod = await import('./pageRegistry.js');
  const fakePage = makeFakePage();
  const { browser } = makeFakeBrowser([fakePage]);
  mod._setConnectImplForTests(async () => ({
    browser, port: 5000, reused: false, profileDir: '/p', lockPath: '/l',
  }));

  const result = await mod.openPage('https://example.com/x');
  assert.ok(result.pageId, 'pageId must be returned');
  assert.match(result.pageId, /^pg-[a-f0-9]{8}$/, 'pageId shape: pg-<8 hex>');
  assert.equal(result.currentUrl, 'https://example.com/x');
  assert.equal(mod.pageCount(), 1, 'registry must have 1 entry after openPage');

  // page.goto was called once with the URL
  assert.equal(fakePage.gotoCallCount, 1);
});

test('openPage: reuses contexts()[0] (never calls newContext when contexts exist)', async () => {
  const mod = await import('./pageRegistry.js');
  const fakePage = makeFakePage();
  const newContextCalls = { count: 0 };
  const { browser } = makeFakeBrowser([fakePage], { newContextCalls });
  mod._setConnectImplForTests(async () => ({
    browser, port: 5000, reused: false, profileDir: '/p', lockPath: '/l',
  }));

  await mod.openPage('https://example.com/x');
  assert.equal(newContextCalls.count, 0,
    'newContext() must NEVER be called when contexts()[0] is present (login state preservation contract)');
});

test('openPage: empty contexts() → fallback newContext (defensive only)', async () => {
  const mod = await import('./pageRegistry.js');
  const fakePage = makeFakePage();
  const newContextCalls = { count: 0 };
  const fakeBrowser = {
    contexts: () => [], // empty — exercises the defensive fallback
    newContext: async () => {
      newContextCalls.count += 1;
      return { newPage: async () => fakePage, close: async () => {} };
    },
    close: async () => {},
  };
  mod._setConnectImplForTests(async () => ({
    browser: fakeBrowser, port: 5000, reused: false, profileDir: '/p', lockPath: '/l',
  }));

  await mod.openPage('https://example.com/x');
  assert.equal(newContextCalls.count, 1, 'empty contexts triggers defensive newContext');
});

test('openPage: stores page.url() (landed URL) — handles redirects correctly (Codex Stage 3b round-2 闭环)', async () => {
  // Pre-fix, openPage stored the input URL verbatim; after a redirect
  // (30x, login, consent flow), registry.currentUrl would mislead the
  // model into thinking the page is somewhere it isn't.  Fix uses
  // page.url() after navigation lands.
  const mod = await import('./pageRegistry.js');
  const fakePage = makeFakePage();
  // Override url() to return the redirected location
  fakePage.url = () => 'https://example.com/login?from=%2Fdashboard';
  const { browser } = makeFakeBrowser([fakePage]);
  mod._setConnectImplForTests(async () => ({
    browser, port: 5000, reused: false, profileDir: '/p', lockPath: '/l',
  }));

  // Input URL is /dashboard but the (fake) page redirects to /login.
  const result = await mod.openPage('https://example.com/dashboard');
  assert.equal(result.currentUrl, 'https://example.com/login?from=%2Fdashboard',
    'currentUrl must reflect the landed URL after redirect, not the input URL');
  // Registry entry must also reflect the landed URL
  const info = mod.peekPageInfo(result.pageId);
  assert.equal(info.currentUrl, 'https://example.com/login?from=%2Fdashboard');
});

test('openPage: falls back to input URL when page.url() returns empty', async () => {
  // Defensive — fake pages / first-load races may return empty url()
  const mod = await import('./pageRegistry.js');
  const fakePage = makeFakePage();
  fakePage.url = () => '';
  const { browser } = makeFakeBrowser([fakePage]);
  mod._setConnectImplForTests(async () => ({
    browser, port: 5000, reused: false, profileDir: '/p', lockPath: '/l',
  }));

  const result = await mod.openPage('https://example.com/some-page');
  assert.equal(result.currentUrl, 'https://example.com/some-page');
});

// ─── getPage / peekPageInfo ────────────────────────────────────────────────

test('getPage: returns playwright page; bumps lastUsedAt', async () => {
  const mod = await import('./pageRegistry.js');
  const fakePage = makeFakePage();
  const { browser } = makeFakeBrowser([fakePage]);
  mod._setConnectImplForTests(async () => ({
    browser, port: 5000, reused: false, profileDir: '/p', lockPath: '/l',
  }));

  const { pageId } = await mod.openPage('https://example.com/x');
  const initial = mod.peekPageInfo(pageId);
  // Sleep 5ms so the lastUsedAt bump after getPage is observable
  await new Promise(r => setTimeout(r, 5));
  const page = mod.getPage(pageId);
  assert.equal(page, fakePage, 'getPage returns the registered playwright page');
  const after = mod.peekPageInfo(pageId);
  assert.ok(after.lastUsedAt > initial.lastUsedAt,
    'getPage must bump lastUsedAt for idle-sweep correctness');
});

test('getPage: unknown pageId throws clearly', async () => {
  const { getPage } = await import('./pageRegistry.js');
  assert.throws(() => getPage('pg-deadbeef'), /Unknown pageId/);
  assert.throws(() => getPage(null), /Unknown pageId/);
});

test('peekPageInfo: returns null for unknown pageId; does NOT bump lastUsedAt', async () => {
  const mod = await import('./pageRegistry.js');
  const fakePage = makeFakePage();
  const { browser } = makeFakeBrowser([fakePage]);
  mod._setConnectImplForTests(async () => ({
    browser, port: 5000, reused: false, profileDir: '/p', lockPath: '/l',
  }));
  const { pageId } = await mod.openPage('https://example.com/x');

  assert.equal(mod.peekPageInfo('pg-unknown'), null);

  const before = mod.peekPageInfo(pageId);
  await new Promise(r => setTimeout(r, 5));
  const after1 = mod.peekPageInfo(pageId);
  await new Promise(r => setTimeout(r, 5));
  const after2 = mod.peekPageInfo(pageId);
  assert.equal(before.lastUsedAt, after1.lastUsedAt,
    'peekPageInfo must NOT bump lastUsedAt');
  assert.equal(after1.lastUsedAt, after2.lastUsedAt);
});

// ─── closePage ─────────────────────────────────────────────────────────────

test('closePage: closes page + browser; drops registry entry; returns true', async () => {
  const mod = await import('./pageRegistry.js');
  const fakePage = makeFakePage();
  const { browser } = makeFakeBrowser([fakePage]);
  mod._setConnectImplForTests(async () => ({
    browser, port: 5000, reused: false, profileDir: '/p', lockPath: '/l',
  }));
  const { pageId } = await mod.openPage('https://example.com/x');

  const ok = await mod.closePage(pageId);
  assert.equal(ok, true);
  assert.equal(fakePage.closeCallCount, 1, 'page handle must be closed');
  assert.equal(browser.closeCallCount, 1, 'browser handle must be closed');
  assert.equal(mod.pageCount(), 0);
  assert.equal(mod.peekPageInfo(pageId), null, 'registry entry must be dropped');
});

test('closePage: unknown pageId returns false (idempotent)', async () => {
  const { closePage } = await import('./pageRegistry.js');
  assert.equal(await closePage('pg-never-opened'), false);
  // Calling twice is also fine
  assert.equal(await closePage('pg-never-opened'), false);
});

test('closePage: double close is safe — first true, second false', async () => {
  const mod = await import('./pageRegistry.js');
  const fakePage = makeFakePage();
  const { browser } = makeFakeBrowser([fakePage]);
  mod._setConnectImplForTests(async () => ({
    browser, port: 5000, reused: false, profileDir: '/p', lockPath: '/l',
  }));
  const { pageId } = await mod.openPage('https://example.com/x');
  assert.equal(await mod.closePage(pageId), true);
  assert.equal(await mod.closePage(pageId), false, 'second close is no-op');
});

// ─── closeAllPages ─────────────────────────────────────────────────────────

test('closeAllPages: closes every registered page, swallows individual errors', async () => {
  const mod = await import('./pageRegistry.js');
  const goodPage = makeFakePage();
  const goodBrowser = makeFakeBrowser([goodPage]).browser;
  const badPage = {
    goto: async () => {},
    waitForLoadState: async () => {},
    close: async () => { throw new Error('page close failed'); },
  };
  const badBrowser = {
    contexts: () => [{ newPage: async () => badPage, close: async () => {} }],
    newContext: async () => {},
    close: async () => {},
  };
  // First openPage: good, second openPage: bad close — closeAllPages
  // must close BOTH despite the bad one throwing.
  let callIdx = 0;
  mod._setConnectImplForTests(async () => {
    const browser = callIdx === 0 ? goodBrowser : badBrowser;
    callIdx += 1;
    return { browser, port: 5000, reused: false, profileDir: '/p', lockPath: '/l' };
  });
  await mod.openPage('https://example.com/a');
  await mod.openPage('https://example.com/b');
  assert.equal(mod.pageCount(), 2);

  await mod.closeAllPages();
  assert.equal(mod.pageCount(), 0, 'all entries cleared even when one close throws');
});

// ─── cleanupIdlePages ──────────────────────────────────────────────────────

test('cleanupIdlePages: closes only entries idle longer than maxIdleMs', async () => {
  const mod = await import('./pageRegistry.js');
  const recentPage = makeFakePage();
  const stalePage = makeFakePage();
  let callIdx = 0;
  mod._setConnectImplForTests(async () => {
    const page = callIdx === 0 ? recentPage : stalePage;
    callIdx += 1;
    const { browser } = makeFakeBrowser([page]);
    return { browser, port: 5000, reused: false, profileDir: '/p', lockPath: '/l' };
  });
  const { pageId: recent } = await mod.openPage('https://example.com/recent');
  const { pageId: stale } = await mod.openPage('https://example.com/stale');

  // Forcibly age the stale entry by reading-then-overwriting lastUsedAt
  // via the public surface: we can't reach into the Map directly, so we
  // use a long maxIdleMs and a short sleep to push BOTH entries past the
  // cutoff, then "touch" recent via getPage to reset its lastUsedAt.
  await new Promise(r => setTimeout(r, 20));
  mod.getPage(recent); // bumps recent's lastUsedAt to "now"

  const closed = await mod.cleanupIdlePages(10);
  assert.deepEqual(closed, [stale], 'only the stale entry was closed');
  assert.equal(mod.pageCount(), 1);
  assert.equal(mod.peekPageInfo(recent)?.pageId, recent);
  assert.equal(mod.peekPageInfo(stale), null);
});

test('cleanupIdlePages: invalid maxIdleMs returns empty array (no-op)', async () => {
  const { cleanupIdlePages } = await import('./pageRegistry.js');
  assert.deepEqual(await cleanupIdlePages(0), []);
  assert.deepEqual(await cleanupIdlePages(-1), []);
  assert.deepEqual(await cleanupIdlePages(NaN), []);
  assert.deepEqual(await cleanupIdlePages(Infinity), []);
});

// ─── Error paths ───────────────────────────────────────────────────────────

test('openPage: goto throws → page + browser cleaned up, registry empty', async () => {
  const mod = await import('./pageRegistry.js');
  const fakePage = makeFakePage({ gotoThrows: new Error('net::ERR_TIMED_OUT') });
  const { browser } = makeFakeBrowser([fakePage]);
  mod._setConnectImplForTests(async () => ({
    browser, port: 5000, reused: false, profileDir: '/p', lockPath: '/l',
  }));

  await assert.rejects(() => mod.openPage('https://example.com/timeout'), /TIMED_OUT/);
  assert.equal(fakePage.closeCallCount, 1, 'page must be closed on goto error');
  assert.equal(browser.closeCallCount, 1, 'browser must be closed on goto error');
  assert.equal(mod.pageCount(), 0, 'registry must NOT have a leaked entry');
});

test('openPage: signal aborted DURING goto → page+browser closed, registry empty, AbortError (Codex round-2 闭环)', async () => {
  // Codex round-2: pre-fix, openPage only checked signal BEFORE goto.
  // page.goto() doesn't listen to AbortSignal, so a Stop fired during
  // navigation let goto run to natural completion, page got registered,
  // and the abort was silently ignored.  The fix attaches a listener
  // that closes the page on signal flip + re-checks abort after each
  // await; this test pins all three behaviors (no registration, both
  // handles closed, AbortError thrown).
  const mod = await import('./pageRegistry.js');

  const ac = new AbortController();
  let pageCloseCallCount = 0;
  let gotoSettled = false;
  // The page's goto resolves only when its close() is called — simulating
  // playwright's "in-flight goto interrupted by page.close()" behavior.
  const fakePage = {
    goto: async () => {
      // Hangs until close is called (then resolves via the close path).
      await new Promise((resolve) => {
        const checkClosed = setInterval(() => {
          if (pageCloseCallCount > 0) {
            clearInterval(checkClosed);
            resolve();
          }
        }, 5);
      });
      gotoSettled = true;
    },
    waitForLoadState: async () => {},
    close: async () => { pageCloseCallCount += 1; },
  };
  const { browser } = makeFakeBrowser([fakePage]);
  mod._setConnectImplForTests(async () => ({
    browser, port: 5000, reused: false, profileDir: '/p', lockPath: '/l',
  }));

  // Fire abort 20ms after openPage starts — well after connect/newPage
  // resolve, while goto is still hanging.
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(
    () => mod.openPage('https://example.com/hangs', { signal: ac.signal }),
    err => err?.name === 'AbortError',
  );
  assert.equal(pageCloseCallCount >= 1, true,
    'page.close() must fire when abort listener triggers during goto');
  assert.equal(browser.closeCallCount, 1, 'browser must be closed on abort cleanup');
  assert.equal(mod.pageCount(), 0,
    'no pageId may be registered when abort fires during navigation');
  assert.equal(gotoSettled, true,
    'goto resolved via close (its hang condition unblocked) — proves abort listener fired');
});

test('openPage: signal aborted between connect and goto → cleanup + AbortError', async () => {
  const mod = await import('./pageRegistry.js');
  const fakePage = makeFakePage();
  const { browser } = makeFakeBrowser([fakePage]);
  const ac = new AbortController();
  mod._setConnectImplForTests(async () => {
    // Simulate: connect completes, caller flips signal in between
    ac.abort();
    return { browser, port: 5000, reused: false, profileDir: '/p', lockPath: '/l' };
  });
  await assert.rejects(
    () => mod.openPage('https://example.com/x', { signal: ac.signal }),
    err => err?.name === 'AbortError',
  );
  assert.equal(browser.closeCallCount, 1, 'cleanup must close browser on abort');
  assert.equal(mod.pageCount(), 0);
});

// ─── listPages ─────────────────────────────────────────────────────────────

test('listPages: returns metadata for every entry', async () => {
  const mod = await import('./pageRegistry.js');
  let callIdx = 0;
  mod._setConnectImplForTests(async () => {
    const page = makeFakePage();
    const { browser } = makeFakeBrowser([page]);
    callIdx += 1;
    return { browser, port: 5000, reused: false, profileDir: '/p', lockPath: '/l' };
  });
  const a = await mod.openPage('https://example.com/a');
  const b = await mod.openPage('https://example.com/b');
  const list = mod.listPages();
  assert.equal(list.length, 2);
  const urls = list.map(p => p.currentUrl).sort();
  assert.deepEqual(urls, ['https://example.com/a', 'https://example.com/b']);
  const ids = list.map(p => p.pageId).sort();
  assert.deepEqual(ids, [a.pageId, b.pageId].sort());
});
