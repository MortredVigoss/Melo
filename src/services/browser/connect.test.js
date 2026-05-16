/**
 * Stage 2a: connectMeloChrome unit tests.
 *
 * No real Chrome / no real playwright-core — everything injected via the
 * `_setConnectImplForTests` and `_setEnsureChromeForTests` DI seams.  These
 * tests verify the connector's wiring contract:
 *   • Asks the launcher for a CDP port, passes it to connectOverCDP.
 *   • Propagates launcher errors as-is.
 *   • Honors `signal` at both await boundaries.
 *   • `withMeloChrome` always closes the browser (success or throw).
 *
 * Real-Chrome integration is intentionally out of scope here — Stage 2b
 * (fetchUrlTool wiring) will add a `MELO_TEST_REAL_CHROME=1`-guarded
 * integration test that spins a real instance.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

test.afterEach(async () => {
  const mod = await import('./connect.js');
  mod._setConnectImplForTests(null);
  mod._setEnsureChromeForTests(null);
});

function makeFakeBrowser({ closeShouldThrow = false } = {}) {
  let closeCallCount = 0;
  return {
    get closeCallCount() { return closeCallCount; },
    async close() {
      closeCallCount += 1;
      if (closeShouldThrow) throw new Error('disconnect failed');
    },
  };
}

// ─── Happy path ──────────────────────────────────────────────────────────────

test('connectMeloChrome: passes launcher port to connectOverCDP and returns browser+meta', async () => {
  const { connectMeloChrome, _setConnectImplForTests, _setEnsureChromeForTests } =
    await import('./connect.js');

  const fakeBrowser = makeFakeBrowser();
  let observedUrl = null;
  _setEnsureChromeForTests(async () => ({
    port: 43210,
    pid: 1234,
    reused: false,
    profileDir: '/tmp/melo-test-profile',
    lockPath: '/tmp/melo-test-lock',
  }));
  _setConnectImplForTests(async (url) => {
    observedUrl = url;
    return fakeBrowser;
  });

  const result = await connectMeloChrome();
  assert.equal(observedUrl, 'http://127.0.0.1:43210');
  assert.equal(result.browser, fakeBrowser);
  assert.equal(result.port, 43210);
  assert.equal(result.reused, false);
  assert.equal(result.profileDir, '/tmp/melo-test-profile');
  assert.equal(result.lockPath, '/tmp/melo-test-lock');
});

test('connectMeloChrome: forwards chromePath option to the launcher', async () => {
  const { connectMeloChrome, _setConnectImplForTests, _setEnsureChromeForTests } =
    await import('./connect.js');

  let observedChromePath = null;
  _setEnsureChromeForTests(async (opts) => {
    observedChromePath = opts?.chromePath;
    return { port: 5000, pid: 1, reused: true, profileDir: '/p', lockPath: '/l' };
  });
  _setConnectImplForTests(async () => makeFakeBrowser());

  await connectMeloChrome({ chromePath: '/opt/custom-chrome' });
  assert.equal(observedChromePath, '/opt/custom-chrome');
});

// ─── Error propagation ──────────────────────────────────────────────────────

test('connectMeloChrome: launcher error propagates (e.g. Chrome binary missing)', async () => {
  const { connectMeloChrome, _setEnsureChromeForTests } = await import('./connect.js');

  _setEnsureChromeForTests(async () => {
    throw new Error('Chrome binary not found at /fake/Chrome');
  });

  await assert.rejects(
    () => connectMeloChrome(),
    /Chrome binary not found/,
  );
});

test('connectMeloChrome: connectOverCDP error propagates (e.g. CDP refused)', async () => {
  const { connectMeloChrome, _setConnectImplForTests, _setEnsureChromeForTests } =
    await import('./connect.js');

  _setEnsureChromeForTests(async () => ({
    port: 1234, pid: 1, reused: false, profileDir: '/p', lockPath: '/l',
  }));
  _setConnectImplForTests(async () => {
    throw new Error('connection refused');
  });

  await assert.rejects(
    () => connectMeloChrome(),
    /connection refused/,
  );
});

// ─── Abort handling ─────────────────────────────────────────────────────────

test('connectMeloChrome: abort DURING connect await → close just-connected browser + AbortError (Codex B 🟠 闭环)', async () => {
  // Pre-fix the post-connect signal check was missing — abort during the
  // CDP handshake left a live browser handle returned to the caller, and
  // `withMeloChrome` would run the callback against it instead of bailing.
  // This test simulates "abort fires WHILE connect is awaiting" by having
  // the fake connect resolve after a microtask boundary, with the abort
  // tripped synchronously between connect-enter and connect-resolve.
  const { connectMeloChrome, _setConnectImplForTests, _setEnsureChromeForTests } =
    await import('./connect.js');

  const fakeBrowser = makeFakeBrowser();
  const ac = new AbortController();

  _setEnsureChromeForTests(async () => ({
    port: 7777, pid: 1, reused: false, profileDir: '/p', lockPath: '/l',
  }));
  _setConnectImplForTests(async () => {
    // Trip the abort INSIDE connect (between the pre-await check passing
    // and our connect resolving), then resolve with a live browser.
    ac.abort();
    return fakeBrowser;
  });

  await assert.rejects(
    () => connectMeloChrome({ signal: ac.signal }),
    err => err?.name === 'AbortError',
  );
  assert.equal(fakeBrowser.closeCallCount, 1, 'just-connected browser must be closed on post-await abort');
});

test('connectMeloChrome: aborted signal between launch and connect → AbortError (no connect attempt)', async () => {
  const { connectMeloChrome, _setConnectImplForTests, _setEnsureChromeForTests } =
    await import('./connect.js');

  const ac = new AbortController();
  _setEnsureChromeForTests(async () => {
    // Simulate "launcher returned but caller aborted before connect"
    ac.abort();
    return { port: 5000, pid: 1, reused: false, profileDir: '/p', lockPath: '/l' };
  });
  let connectCalled = false;
  _setConnectImplForTests(async () => {
    connectCalled = true;
    return makeFakeBrowser();
  });

  await assert.rejects(
    () => connectMeloChrome({ signal: ac.signal }),
    err => err?.name === 'AbortError',
  );
  assert.equal(connectCalled, false, 'must NOT call connectOverCDP after abort');
});

// ─── withMeloChrome wrapper ─────────────────────────────────────────────────

test('withMeloChrome: closes browser on success', async () => {
  const { withMeloChrome, _setConnectImplForTests, _setEnsureChromeForTests } =
    await import('./connect.js');

  const fakeBrowser = makeFakeBrowser();
  _setEnsureChromeForTests(async () => ({
    port: 6000, pid: 1, reused: true, profileDir: '/p', lockPath: '/l',
  }));
  _setConnectImplForTests(async () => fakeBrowser);

  const result = await withMeloChrome(async (browser, info) => {
    assert.equal(browser, fakeBrowser);
    assert.equal(info.port, 6000);
    return 'callback-return-value';
  });
  assert.equal(result, 'callback-return-value');
  assert.equal(fakeBrowser.closeCallCount, 1);
});

test('withMeloChrome: closes browser even when callback throws', async () => {
  const { withMeloChrome, _setConnectImplForTests, _setEnsureChromeForTests } =
    await import('./connect.js');

  const fakeBrowser = makeFakeBrowser();
  _setEnsureChromeForTests(async () => ({
    port: 6001, pid: 1, reused: true, profileDir: '/p', lockPath: '/l',
  }));
  _setConnectImplForTests(async () => fakeBrowser);

  await assert.rejects(
    () => withMeloChrome(async () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(fakeBrowser.closeCallCount, 1, 'browser must be closed even on callback throw');
});

test('withMeloChrome: browser.close failure swallowed (best-effort cleanup)', async () => {
  const { withMeloChrome, _setConnectImplForTests, _setEnsureChromeForTests } =
    await import('./connect.js');

  const fakeBrowser = makeFakeBrowser({ closeShouldThrow: true });
  _setEnsureChromeForTests(async () => ({
    port: 6002, pid: 1, reused: false, profileDir: '/p', lockPath: '/l',
  }));
  _setConnectImplForTests(async () => fakeBrowser);

  // Callback succeeds, close throws — should NOT propagate the close error.
  const result = await withMeloChrome(async () => 'ok');
  assert.equal(result, 'ok');
  assert.equal(fakeBrowser.closeCallCount, 1);
});

test('withMeloChrome: callback error wins over swallowed close error', async () => {
  const { withMeloChrome, _setConnectImplForTests, _setEnsureChromeForTests } =
    await import('./connect.js');

  const fakeBrowser = makeFakeBrowser({ closeShouldThrow: true });
  _setEnsureChromeForTests(async () => ({
    port: 6003, pid: 1, reused: false, profileDir: '/p', lockPath: '/l',
  }));
  _setConnectImplForTests(async () => fakeBrowser);

  await assert.rejects(
    () => withMeloChrome(async () => { throw new Error('callback-boom'); }),
    /callback-boom/, // not 'disconnect failed'
  );
  assert.equal(fakeBrowser.closeCallCount, 1);
});
