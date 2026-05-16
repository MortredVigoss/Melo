/**
 * meloChrome launcher unit tests.
 *
 * No real Chrome spawn — all OS interactions (spawn / fetch / port-find /
 * existsSync / clock / sleep) are injected via _setDepsForTests, so the
 * tests verify the launcher's decision logic deterministically without
 * needing Google Chrome on the test host.
 *
 * Isolated MELO_HOME per test via mkdtemp — same pattern as
 * trailLogger.test.js (and the lessons-learned-#3 file safety guard).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_PREFIX = join(tmpdir(), 'melo-chrome-test-');
let prevMeloHome;
let tmpHome;

test.beforeEach(() => {
  prevMeloHome = process.env.MELO_HOME;
  tmpHome = mkdtempSync(TMP_PREFIX);
  process.env.MELO_HOME = tmpHome;
});

test.afterEach(async () => {
  if (prevMeloHome === undefined) delete process.env.MELO_HOME;
  else process.env.MELO_HOME = prevMeloHome;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  const mod = await import('./meloChrome.js');
  mod._setDepsForTests({});
  // Reset the singleflight latch — a test that left _activeLaunch dangling
  // (rejected promise nobody awaited) would otherwise leak into the next
  // test and the spawn count would be off.
  mod._resetActiveLaunchForTests();
});

// ─── Shared fakes ────────────────────────────────────────────────────────────

function makeFakeChild({ pid = 99999, fireErrorOnce = null } = {}) {
  // spawn-return shape minimum surface: pid + unref() + on() + kill().
  // Codex G-2b round-7: launcher attaches 'error' listener for unhandled
  // spawn failures and calls kill() on abort/timeout cleanup — tests need
  // both surfaces.  fireErrorOnce, if set, fires synchronously on the
  // first .on('error', handler) call so we can deterministically exercise
  // the spawn-error code path.
  let killCount = 0;
  const child = {
    pid,
    killed: false,
    unref: () => {},
    on: (event, handler) => {
      if (event === 'error' && fireErrorOnce) {
        // Fire synchronously when the listener attaches.  Real EventEmitter
        // would emit 'error' asynchronously after spawn fails, but the
        // launcher's polling loop spins on microtasks (mocked sleep() is
        // `async () => {}`) so a setImmediate-scheduled error never fires.
        // Sync emission is the right test-shape: it exercises the
        // launcher's "error observed → throw + kill" path deterministically.
        handler(fireErrorOnce);
      }
    },
    kill: () => {
      killCount += 1;
      child.killed = true;
    },
    get killCount() { return killCount; },
  };
  return child;
}

function makeReachableFetch({ acceptPort } = {}) {
  // Pretends to be Chrome's /json/version endpoint on the given port and
  // 404s on every other port.  Real Chrome's response includes
  // webSocketDebuggerUrl — the launcher refuses anything else, so we
  // include it for happy-path mocks and omit it for "wrong server"
  // tests.
  return async (url) => {
    const m = String(url).match(/^http:\/\/127\.0\.0\.1:(\d+)\//);
    if (!m) return { ok: false, status: 404, json: async () => ({}) };
    const port = Number(m[1]);
    if (acceptPort !== undefined && port !== acceptPort) {
      throw new Error('connection refused');
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        Browser: 'Chrome/130.0.0',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/abc-123`,
      }),
    };
  };
}

// ─── Happy path: fresh launch ───────────────────────────────────────────────

test('ensureMeloChromeRunning: fresh launch writes lock + returns reused:false', async () => {
  const { ensureMeloChromeRunning, _setDepsForTests, _internals } = await import('./meloChrome.js');

  let spawnCount = 0;
  let spawnArgs = null;
  _setDepsForTests({
    spawn: (binary, args) => {
      spawnCount += 1;
      spawnArgs = args;
      return makeFakeChild({ pid: 42 });
    },
    fetch: makeReachableFetch({ acceptPort: 51234 }),
    findFreePort: async () => 51234,
    existsSync: () => true, // pretend Chrome binary exists
  });

  const result = await ensureMeloChromeRunning({ chromePath: '/fake/Chrome' });
  assert.equal(result.reused, false);
  assert.equal(result.port, 51234);
  assert.equal(result.pid, 42);
  assert.equal(spawnCount, 1);
  // Lock file written under tmpHome/desktop/chrome.lock
  const lockPath = _internals.lockFilePathFor(tmpHome);
  assert.ok(existsSync(lockPath), 'lock file must be written');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(lock.port, 51234);
  assert.equal(lock.pid, 42);
  // Spawn args carry the expected dedicated-profile flags
  assert.ok(spawnArgs.some(a => a.startsWith(`--user-data-dir=`)));
  assert.ok(spawnArgs.includes('--remote-debugging-port=51234'));
  assert.ok(spawnArgs.includes('--no-first-run'));
});

// ─── Reuse path: lock points at live Chrome ─────────────────────────────────

test('ensureMeloChromeRunning: existing live Chrome returns reused:true (no respawn)', async () => {
  const { ensureMeloChromeRunning, _setDepsForTests, _internals } = await import('./meloChrome.js');

  // Pre-write a lock file pointing at port 9999.
  const lockPath = _internals.lockFilePathFor(tmpHome);
  _internals.writeLock(lockPath, { port: 9999, pid: 1234, startedAt: 100 });

  let spawnCount = 0;
  _setDepsForTests({
    spawn: () => { spawnCount += 1; return makeFakeChild(); },
    fetch: makeReachableFetch({ acceptPort: 9999 }),
    existsSync: () => true,
  });

  const result = await ensureMeloChromeRunning({ chromePath: '/fake/Chrome' });
  assert.equal(result.reused, true);
  assert.equal(result.port, 9999);
  assert.equal(result.pid, 1234);
  assert.equal(spawnCount, 0, 'must not respawn when existing Chrome is alive');
});

// ─── Stale lock: lock present but port dead → respawn ───────────────────────

test('ensureMeloChromeRunning: stale lock (port dead) → clear lock + respawn', async () => {
  const { ensureMeloChromeRunning, _setDepsForTests, _internals } = await import('./meloChrome.js');

  const lockPath = _internals.lockFilePathFor(tmpHome);
  _internals.writeLock(lockPath, { port: 7777, pid: 5555, startedAt: 0 });

  // Fetch fails on the stale port (7777) but succeeds on the freshly-picked
  // port (54321).  Use a single fake that switches behavior by URL.
  const freshPort = 54321;
  const fetchFn = async (url) => {
    if (url.includes(`:7777/`)) {
      throw new Error('connection refused');
    }
    if (url.includes(`:${freshPort}/`)) {
      return makeReachableFetch({ acceptPort: freshPort })(url);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  let spawnCount = 0;
  _setDepsForTests({
    spawn: () => { spawnCount += 1; return makeFakeChild({ pid: 8888 }); },
    fetch: fetchFn,
    findFreePort: async () => freshPort,
    existsSync: () => true,
  });

  const result = await ensureMeloChromeRunning({ chromePath: '/fake/Chrome' });
  assert.equal(result.reused, false);
  assert.equal(result.port, freshPort);
  assert.equal(result.pid, 8888);
  assert.equal(spawnCount, 1);
  // Lock now reflects the new port (old port 7777 was cleared and rewritten)
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(lock.port, freshPort);
});

// ─── Binary missing ─────────────────────────────────────────────────────────

test('ensureMeloChromeRunning: Chrome binary not found → explicit install error', async () => {
  const { ensureMeloChromeRunning, _setDepsForTests } = await import('./meloChrome.js');

  _setDepsForTests({ existsSync: () => false }); // binary missing

  await assert.rejects(
    () => ensureMeloChromeRunning({ chromePath: '/does/not/exist' }),
    /not found.*install Google Chrome or set MELO_CHROME_BINARY/,
  );
});

test('ensureMeloChromeRunning: no chromePath + no MELO_CHROME_BINARY on unknown platform → clear error', async () => {
  const { ensureMeloChromeRunning, _setDepsForTests, _internals } = await import('./meloChrome.js');

  // Drop the default for this platform so detectChromeBinary returns null
  // when no override is set.
  const savedDefault = _internals.DEFAULT_CHROME_PATHS[process.platform];
  delete _internals.DEFAULT_CHROME_PATHS[process.platform];
  delete process.env.MELO_CHROME_BINARY;

  _setDepsForTests({ existsSync: () => false });

  await assert.rejects(
    () => ensureMeloChromeRunning(),
    /Chrome binary path unknown for platform/,
  );

  _internals.DEFAULT_CHROME_PATHS[process.platform] = savedDefault;
});

// ─── Launch timeout: port never comes up ────────────────────────────────────

test('ensureMeloChromeRunning: CDP port never reachable → timeout error', async () => {
  const { ensureMeloChromeRunning, _setDepsForTests } = await import('./meloChrome.js');

  let nowValue = 0;
  _setDepsForTests({
    spawn: () => makeFakeChild(),
    fetch: async () => { throw new Error('connection refused'); }, // never reachable
    findFreePort: async () => 60001,
    existsSync: () => true,
    now: () => nowValue,
    sleep: () => { nowValue += 500; }, // advance virtual clock per "sleep"
  });

  await assert.rejects(
    () => ensureMeloChromeRunning({ chromePath: '/fake/Chrome', launchTimeoutMs: 2000 }),
    /did not respond within 2000ms/,
  );
});

// ─── Abort during startup wait ──────────────────────────────────────────────

test('ensureMeloChromeRunning: signal abort during startup wait → AbortError', async () => {
  const { ensureMeloChromeRunning, _setDepsForTests } = await import('./meloChrome.js');

  const ac = new AbortController();
  let nowValue = 0;
  _setDepsForTests({
    spawn: () => makeFakeChild(),
    fetch: async () => { throw new Error('not yet'); },
    findFreePort: async () => 60002,
    existsSync: () => true,
    now: () => nowValue,
    sleep: () => { nowValue += 200; ac.abort(); }, // abort after first sleep
  });

  await assert.rejects(
    () => ensureMeloChromeRunning({ chromePath: '/fake/Chrome', signal: ac.signal, launchTimeoutMs: 5000 }),
    err => err?.name === 'AbortError',
  );
});

// ─── Wrong server on the port (not Chrome) ──────────────────────────────────

test('isCdpPortReachable: requires webSocketDebuggerUrl in response', async () => {
  const { _internals, _setDepsForTests } = await import('./meloChrome.js');

  const wrongServer = async () => ({
    ok: true, status: 200,
    json: async () => ({ Browser: 'NotChrome' }), // missing webSocketDebuggerUrl
  });
  _setDepsForTests({ fetch: wrongServer });

  const reachable = await _internals.isCdpPortReachable(12345, wrongServer);
  assert.equal(reachable, false, 'a foreign HTTP server on the port must not pass as Chrome');
});

test('isCdpPortReachable: HTTP 200 + webSocketDebuggerUrl passes', async () => {
  const { _internals } = await import('./meloChrome.js');

  const realChrome = async () => ({
    ok: true, status: 200,
    json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:12345/devtools/browser/x' }),
  });
  const reachable = await _internals.isCdpPortReachable(12345, realChrome);
  assert.equal(reachable, true);
});

test('isCdpPortReachable: fetch throws → returns false (no propagation)', async () => {
  const { _internals } = await import('./meloChrome.js');
  const throwFetch = async () => { throw new Error('ECONNREFUSED'); };
  const reachable = await _internals.isCdpPortReachable(12345, throwFetch);
  assert.equal(reachable, false);
});

// ─── probeMeloChrome ────────────────────────────────────────────────────────

test('probeMeloChrome: no lock file → null', async () => {
  const { probeMeloChrome, _setDepsForTests } = await import('./meloChrome.js');
  _setDepsForTests({});
  const result = await probeMeloChrome();
  assert.equal(result, null);
});

test('probeMeloChrome: live lock → returns port+pid; dead lock → null', async () => {
  const { probeMeloChrome, _setDepsForTests, _internals } = await import('./meloChrome.js');
  const lockPath = _internals.lockFilePathFor(tmpHome);
  _internals.writeLock(lockPath, { port: 9876, pid: 555, startedAt: 0 });

  _setDepsForTests({ fetch: makeReachableFetch({ acceptPort: 9876 }) });
  const live = await probeMeloChrome();
  assert.equal(live?.port, 9876);
  assert.equal(live?.pid, 555);

  _setDepsForTests({ fetch: async () => { throw new Error('refused'); } });
  const dead = await probeMeloChrome();
  assert.equal(dead, null);
});

// ─── clearMeloChromeLock ────────────────────────────────────────────────────

test('clearMeloChromeLock: removes lock file (no-op when absent)', async () => {
  const { clearMeloChromeLock, _internals } = await import('./meloChrome.js');
  const lockPath = _internals.lockFilePathFor(tmpHome);
  _internals.writeLock(lockPath, { port: 1, pid: 1, startedAt: 0 });
  assert.ok(existsSync(lockPath));

  clearMeloChromeLock();
  assert.equal(existsSync(lockPath), false);

  // Idempotent
  clearMeloChromeLock();
  assert.equal(existsSync(lockPath), false);
});

// ─── detectChromeBinary respects MELO_CHROME_BINARY env override ─────────────

test('detectChromeBinary: MELO_CHROME_BINARY env overrides platform default', async () => {
  const { detectChromeBinary } = await import('./meloChrome.js');
  const saved = process.env.MELO_CHROME_BINARY;
  process.env.MELO_CHROME_BINARY = '/opt/brave-browser';
  try {
    assert.equal(detectChromeBinary(), '/opt/brave-browser');
  } finally {
    if (saved === undefined) delete process.env.MELO_CHROME_BINARY;
    else process.env.MELO_CHROME_BINARY = saved;
  }
});

// ─── Codex G-2b round-7 闭环 (2026-05-16) ──────────────────────────────────

test('ensureMeloChromeRunning: spawn fires error → throws "Chrome failed to spawn" (no Node crash)', async () => {
  const { ensureMeloChromeRunning, _setDepsForTests } = await import('./meloChrome.js');

  let killedChild = null;
  _setDepsForTests({
    spawn: () => {
      const c = makeFakeChild({ pid: 7777, fireErrorOnce: new Error('EACCES: permission denied') });
      killedChild = c;
      return c;
    },
    fetch: async () => { throw new Error('never reachable'); },
    findFreePort: async () => 33333,
    existsSync: () => true,
    sleep: async () => {}, // fast spin so the error handler tick can run
  });

  await assert.rejects(
    () => ensureMeloChromeRunning({ chromePath: '/fake/Chrome', launchTimeoutMs: 3000 }),
    /Chrome failed to spawn.*EACCES: permission denied/,
  );
  assert.equal(killedChild?.killed, true, 'spawn-error path must kill the bad child');
});

test('ensureMeloChromeRunning: concurrent callers share a single launch (singleflight)', async () => {
  const { ensureMeloChromeRunning, _setDepsForTests } = await import('./meloChrome.js');

  let spawnCount = 0;
  // Slow the launch loop so both callers enter while it's in-flight.
  let probeCallCount = 0;
  _setDepsForTests({
    spawn: () => { spawnCount += 1; return makeFakeChild({ pid: 9090 }); },
    fetch: async (url) => {
      probeCallCount += 1;
      // First probe call returns "not yet"; second returns ready.  Both
      // callers awaiting the singleflight should see the same ready result.
      if (probeCallCount === 1) throw new Error('not yet');
      return {
        ok: true, status: 200,
        json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:38000/x' }),
      };
    },
    findFreePort: async () => 38000,
    existsSync: () => true,
    sleep: async () => {}, // fast spin
  });

  const [a, b] = await Promise.all([
    ensureMeloChromeRunning({ chromePath: '/fake/Chrome' }),
    ensureMeloChromeRunning({ chromePath: '/fake/Chrome' }),
  ]);
  assert.equal(spawnCount, 1, 'singleflight must spawn exactly once for concurrent callers');
  assert.equal(a.port, 38000);
  assert.equal(b.port, 38000);
  assert.deepEqual(a, b, 'both concurrent callers must receive the same launch result');
});

test('ensureMeloChromeRunning: abort during startup wait → kills spawned child + no lock written', async () => {
  const { ensureMeloChromeRunning, _setDepsForTests, _internals } = await import('./meloChrome.js');

  const ac = new AbortController();
  let nowValue = 0;
  let spawnedChild = null;
  _setDepsForTests({
    spawn: () => { spawnedChild = makeFakeChild({ pid: 4242 }); return spawnedChild; },
    fetch: async () => { throw new Error('not yet'); },
    findFreePort: async () => 41000,
    existsSync: () => true,
    now: () => nowValue,
    sleep: () => { nowValue += 200; ac.abort(); }, // abort after first sleep
  });

  await assert.rejects(
    () => ensureMeloChromeRunning({ chromePath: '/fake/Chrome', signal: ac.signal, launchTimeoutMs: 5000 }),
    err => err?.name === 'AbortError',
  );
  assert.equal(spawnedChild?.killed, true, 'abort must kill the just-spawned child');
  // Lock file must NOT exist after abort — next attempt should respawn
  const lockPath = _internals.lockFilePathFor(tmpHome);
  assert.equal(existsSync(lockPath), false, 'abort path must not write a stale lock');
});

test('ensureMeloChromeRunning: timeout → kills spawned child (no phantom window)', async () => {
  const { ensureMeloChromeRunning, _setDepsForTests } = await import('./meloChrome.js');

  let nowValue = 0;
  let spawnedChild = null;
  _setDepsForTests({
    spawn: () => { spawnedChild = makeFakeChild({ pid: 5252 }); return spawnedChild; },
    fetch: async () => { throw new Error('never up'); },
    findFreePort: async () => 42000,
    existsSync: () => true,
    now: () => nowValue,
    sleep: () => { nowValue += 500; }, // advance virtual clock
  });

  await assert.rejects(
    () => ensureMeloChromeRunning({ chromePath: '/fake/Chrome', launchTimeoutMs: 1500 }),
    /did not respond within 1500ms/,
  );
  assert.equal(spawnedChild?.killed, true, 'timeout must kill the half-up child');
});

test('isCdpPortReachable: timer cleaned up even when fetch throws (no leaked timeout)', async () => {
  const { _internals } = await import('./meloChrome.js');

  // The fix is "clearTimeout in finally" — we can't directly observe timer
  // queue state from Node tests, but we CAN assert the function returns
  // false promptly (well under the timeout window) when fetch throws,
  // which is the user-visible contract the fix enforces.
  const startMs = Date.now();
  const result = await _internals.isCdpPortReachable(
    50000,
    async () => { throw new Error('immediate fail'); },
    /* timeoutMs */ 5000,
  );
  const elapsed = Date.now() - startMs;
  assert.equal(result, false);
  assert.ok(elapsed < 1000, `probe must return promptly on throw, took ${elapsed}ms`);
});
