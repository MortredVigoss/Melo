/**
 * CDP-attach connector — Stage 2a of the meloChrome rollout.
 *
 * This module is the bridge between meloChrome.js (launcher / lock-file
 * authority) and the actual Playwright API for driving a browser.  The
 * launcher gives us a CDP port; this module gives us a connected
 * `browser` handle via playwright-core's `chromium.connectOverCDP`.
 *
 * Stage 2a scope: just the connect helper.  Stage 2b wires this into
 * fetchUrlTool as a new tier; Stage 2c into webSearchTool's content-fetch
 * phase; Stage 3 adds interactive primitives (browser_open / click /
 * fill / wait / snapshot) on top.
 *
 * Lifecycle: caller owns the returned `browser` handle.  Call
 * `browser.close()` (CDP detach — does NOT kill the Chrome process; the
 * profile + window stay alive for the next call to reuse via the lock).
 * Re-using one Browser instance across many fetches is cheaper than
 * connecting per-call, but for v1 fetch-shaped callers (one-shot URL
 * grab) close-per-call is fine and matches the "don't leak handles"
 * principle.
 */

import { ensureMeloChromeRunning } from './meloChrome.js';

// DI seam — tests inject a fake connectOverCDP so they don't need a real
// Chrome.  Production resolves the real impl via dynamic import the first
// time it's needed (lazy: keeps cold startup fast for users who never use
// the CDP tier).
let _connectOverCDPImpl = null;
let _connectOverCDPOverride = null;
let _ensureChromeOverride = null;

async function resolveDefaultConnectImpl() {
  if (_connectOverCDPImpl) return _connectOverCDPImpl;
  // Dynamic import so a host without playwright-core (or a broken install)
  // doesn't crash module load; the caller sees a clear "playwright-core
  // unavailable" error at call time instead.
  const mod = await import('playwright-core');
  if (!mod?.chromium?.connectOverCDP) {
    throw new Error('playwright-core loaded but chromium.connectOverCDP is missing');
  }
  _connectOverCDPImpl = mod.chromium.connectOverCDP.bind(mod.chromium);
  return _connectOverCDPImpl;
}

export function _setConnectImplForTests(fn) {
  _connectOverCDPOverride = fn || null;
}

export function _setEnsureChromeForTests(fn) {
  _ensureChromeOverride = fn || null;
}

/**
 * Connect to Melo Chrome's CDP endpoint and return a playwright-core
 * Browser handle.  Idempotent w.r.t. the launcher (calls
 * ensureMeloChromeRunning which reuses an already-running Chrome).
 *
 * Returns: `{ browser, port, reused, profileDir, lockPath }`
 *
 * Throws:
 *   - launch-time errors (Chrome binary missing, CDP timeout) propagated
 *     from ensureMeloChromeRunning.
 *   - 'playwright-core not installed' if dynamic import fails.
 *   - AbortError if `signal` is aborted at any await boundary.
 */
export async function connectMeloChrome({ signal, chromePath } = {}) {
  const ensure = _ensureChromeOverride || ensureMeloChromeRunning;
  const launchInfo = await ensure({ signal, chromePath });
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const connect = _connectOverCDPOverride || await resolveDefaultConnectImpl();
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const browser = await connect(`http://127.0.0.1:${launchInfo.port}`);
  return {
    browser,
    port: launchInfo.port,
    reused: launchInfo.reused,
    profileDir: launchInfo.profileDir,
    lockPath: launchInfo.lockPath,
  };
}

/**
 * Convenience: connect, run a callback with the browser, always close on
 * exit (success or throw).  For one-shot fetches that don't need to keep
 * the Browser handle around.
 *
 * Note: `browser.close()` only detaches the CDP session — the actual
 * Chrome window stays open for reuse.
 */
export async function withMeloChrome(fn, opts = {}) {
  const { browser, ...info } = await connectMeloChrome(opts);
  try {
    return await fn(browser, info);
  } finally {
    try {
      await browser.close();
    } catch {
      // best-effort — if disconnect fails (Chrome already gone, signal
      // mid-disconnect, etc), the lock-file probe at the next launch will
      // catch any state drift.
    }
  }
}
