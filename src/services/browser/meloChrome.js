/**
 * Melo's CDP-attach launcher for a dedicated Chrome instance.
 *
 * Why a separate Chrome instead of using the existing `@playwright/cli`-
 * subprocess path in src/web/playwrightFetcher.js:
 *
 *  • The CLI path launches Chromium itself and manages it via a daemon
 *    process — fragile (orphan daemons were the cause of the 2026-05-04
 *    system-freeze regression) and headless-by-default (anti-bot SPAs +
 *    auth-walled content fail).  This module attaches to a real Chrome
 *    window that the user can see, keep tabs in, and log in to.
 *
 *  • Dedicated profile at `$MELO_HOME/desktop/chrome-profile/` keeps Melo's
 *    Chrome separate from the user's daily Chrome — different
 *    `--user-data-dir` ⇒ different process ⇒ different cookies/storage,
 *    but the user only needs to log in once per site for Melo to use it.
 *    Visible window so the user can SEE what Melo is doing.
 *
 *  • Random debug port + lock file at `$MELO_HOME/desktop/chrome.lock`:
 *    reuses an already-running Melo Chrome across server restarts; if the
 *    lock points at a dead port we clear it and respawn.  Per-MELO_HOME
 *    isolation falls out of the path layout for free.
 *
 * Scope (Stage 1): launcher + reuse semantics only — no Playwright /
 * playwright-core dep yet, no tool wiring.  Stage 2 wires this into
 * fetchUrlTool and webSearchTool as a new tier.  Stage 3 adds interactive
 * browser_* tools (click / fill / wait / snapshot).
 *
 * Env / config:
 *   • MELO_CHROME_BINARY — override Chrome binary path (debugging /
 *     non-macOS / Chromium / Brave / Edge if user wants).
 *   • MELO_CHROME_LAUNCH_TIMEOUT_MS — startup wait budget (default 15s).
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';

import { getMeloHome } from '../../config.js';

const DEFAULT_CHROME_PATHS = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/usr/bin/google-chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
};

const DEFAULT_LAUNCH_TIMEOUT_MS = 15_000;
const PORT_PROBE_TIMEOUT_MS = 800;

// ─── Path helpers — capture at call site, never inside async closure ─────────
//
// All path-deriving helpers read getMeloHome() at the call site.  Async
// callers must NOT await first and then re-derive paths — see CLAUDE.md §6.
// The high-level ensureMeloChromeRunning() captures home once and threads
// the resolved paths through.

function chromeProfileDirFor(home) {
  return join(home, 'desktop', 'chrome-profile');
}

function lockFilePathFor(home) {
  return join(home, 'desktop', 'chrome.lock');
}

// ─── Free-port discovery ─────────────────────────────────────────────────────

async function findFreePortDefault() {
  // Ask the kernel for an unused TCP port by listening on 0 and reading the
  // assigned port back.  We close immediately; the port stays free for
  // Chrome to grab a moment later (small TOCTOU window but in practice
  // fine).
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = /** @type {{ port: number }} */ (srv.address()).port;
      srv.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

// ─── Port reachability probe ────────────────────────────────────────────────

async function isCdpPortReachable(port, fetchImpl, timeoutMs = PORT_PROBE_TIMEOUT_MS) {
  // Chrome exposes /json/version on the debug port once CDP is ready.  We
  // require webSocketDebuggerUrl in the response so a foreign HTTP server
  // happening to bind to the same port doesn't pass as Chrome.
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data?.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

// ─── Lock file (per-MELO_HOME) ───────────────────────────────────────────────

function readLock(lockPath) {
  if (!existsSync(lockPath)) return null;
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeLock(lockPath, data) {
  mkdirSync(join(lockPath, '..'), { recursive: true });
  writeFileSync(lockPath, JSON.stringify(data, null, 2));
}

function clearLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone — fine
  }
}

// ─── DI seams for tests ──────────────────────────────────────────────────────
//
// Production uses globalThis.fetch / node spawn / net.createServer / fs sync
// APIs directly.  Tests inject deterministic fakes via these setters; setting
// `null` restores the production impl (used in afterEach for hygiene).

let _spawnImpl = spawn;
let _fetchImpl = (...args) => globalThis.fetch(...args);
let _findFreePortImpl = findFreePortDefault;
let _existsSyncImpl = existsSync;
let _nowImpl = () => Date.now();
let _sleepImpl = ms => new Promise(r => setTimeout(r, ms));

export function _setDepsForTests(deps = {}) {
  _spawnImpl = deps.spawn || spawn;
  _fetchImpl = deps.fetch || ((...a) => globalThis.fetch(...a));
  _findFreePortImpl = deps.findFreePort || findFreePortDefault;
  _existsSyncImpl = deps.existsSync || existsSync;
  _nowImpl = deps.now || (() => Date.now());
  _sleepImpl = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function detectChromeBinary() {
  const override = process.env.MELO_CHROME_BINARY;
  if (override) return override;
  return DEFAULT_CHROME_PATHS[process.platform] || null;
}

/**
 * Idempotent.  If a previous Melo Chrome is still alive on its lock-file
 * port, reuse it (returns `reused: true`).  Otherwise spawns a fresh
 * detached Chrome with `--user-data-dir=<profile>` + a random debug port,
 * waits up to MELO_CHROME_LAUNCH_TIMEOUT_MS for CDP to come up, writes
 * the lock and returns connection info.
 *
 * Returns: `{ port, pid, reused, profileDir, lockPath }`
 *
 * Throws: if the Chrome binary isn't found, or if CDP doesn't come up
 * before the timeout (caller should treat both as "no real-browser tier
 * available for this query" and fall back to other tiers).
 */
export async function ensureMeloChromeRunning({
  chromePath,
  signal,
  launchTimeoutMs,
  extraArgs = [],
} = {}) {
  // CLAUDE.md §6: capture home + derived paths up front, never inside async
  // body, so a mid-flight MELO_HOME flip can't write to a different home's
  // lock file.
  const home = getMeloHome();
  const profileDir = chromeProfileDirFor(home);
  const lockPath = lockFilePathFor(home);
  const binary = chromePath || detectChromeBinary();
  const timeoutMs = Number(launchTimeoutMs || process.env.MELO_CHROME_LAUNCH_TIMEOUT_MS || DEFAULT_LAUNCH_TIMEOUT_MS);

  // 1. Check existing lock for a still-alive Chrome we can reuse.
  const existing = readLock(lockPath);
  if (existing?.port) {
    if (await isCdpPortReachable(existing.port, _fetchImpl)) {
      return {
        port: existing.port,
        pid: existing.pid || null,
        reused: true,
        profileDir,
        lockPath,
      };
    }
    // Stale lock — Chrome died or the user closed it.  Clear and respawn.
    clearLock(lockPath);
  }

  // 2. Validate Chrome binary BEFORE spending a port + spawning.  Distinct
  // error string so the caller can show the user a clear "install Chrome
  // or set MELO_CHROME_BINARY" message instead of a generic spawn failure.
  if (!binary) {
    throw new Error(`Chrome binary path unknown for platform ${process.platform} — set MELO_CHROME_BINARY`);
  }
  if (!_existsSyncImpl(binary)) {
    throw new Error(`Chrome binary not found at ${binary} — install Google Chrome or set MELO_CHROME_BINARY`);
  }

  // 3. Pick a free port + ensure profile dir exists.
  const port = await _findFreePortImpl();
  mkdirSync(profileDir, { recursive: true });

  // 4. Spawn Chrome detached so it survives Melo restarts.  Visible window
  // (no --headless) so the user can see what Melo is doing and intervene
  // (close tabs, log in to a site, etc).
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--disable-background-networking',
    ...extraArgs,
  ];
  const child = _spawnImpl(binary, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // 5. Wait for CDP to come up, polling every 400ms until timeout.  The
  // signal lets a caller (e.g. tool gate Stop) cancel a slow startup.
  const deadline = _nowImpl() + timeoutMs;
  while (_nowImpl() < deadline) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (await isCdpPortReachable(port, _fetchImpl)) {
      writeLock(lockPath, { port, pid: child.pid || null, startedAt: _nowImpl(), profileDir });
      return { port, pid: child.pid || null, reused: false, profileDir, lockPath };
    }
    await _sleepImpl(400);
  }

  // 6. Startup timed out.  Don't kill the child (it might still be coming
  // up async; user can close it manually if they want).  Caller falls
  // back to a non-CDP tier.
  throw new Error(`Chrome CDP port ${port} did not respond within ${timeoutMs}ms (binary=${binary})`);
}

/**
 * Read the current lock without launching — used by status / diagnostics
 * code that wants to know "is Melo Chrome alive right now" without
 * accidentally spawning one.  Returns `null` if no lock or lock points
 * at a dead port.
 */
export async function probeMeloChrome() {
  const home = getMeloHome();
  const lockPath = lockFilePathFor(home);
  const existing = readLock(lockPath);
  if (!existing?.port) return null;
  if (await isCdpPortReachable(existing.port, _fetchImpl)) {
    return { port: existing.port, pid: existing.pid || null, lockPath };
  }
  return null;
}

/**
 * Drop the lock file without killing Chrome.  Used by stage-2 / 3 code
 * when it wants to force a fresh launch on the next call (e.g. user has
 * rotated their profile dir).  Caller's responsibility to close any open
 * playwright-core connection before calling.
 */
export function clearMeloChromeLock() {
  const home = getMeloHome();
  clearLock(lockFilePathFor(home));
}

// Re-export low-level helpers under the `_internals` shape — same
// convention as src/services/search/apiDirect.js so test files don't
// re-derive private logic.
export const _internals = {
  DEFAULT_CHROME_PATHS,
  chromeProfileDirFor,
  lockFilePathFor,
  isCdpPortReachable,
  readLock,
  writeLock,
  clearLock,
};
