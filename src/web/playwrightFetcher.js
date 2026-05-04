/**
 * Shared Playwright CLI fetcher.
 *
 * Used by:
 *   - web_search tool   → SERP scraping + content enrichment  (session 'melo-search')
 *   - fetch_url tool    → 3rd-layer fallback for SPA / JS-rendered pages
 *                         (session 'melo-shared' — default)
 *
 * Single-browser process model per named session: each session drives ONE
 * persistent browser window. All navigate→eval sequences within a session
 * MUST go through that session's lock, because concurrent callers would
 * stomp on each other's page state. Different sessions (e.g. melo-search
 * vs melo-shared) don't share a browser and so don't share a lock — they
 * can run concurrently.
 *
 * Availability is cached in-process per session; first call pays the
 * ~1s `--version` cost.
 *
 * History: the bottom module-level exports (`runPlaywrightCli`, `withPwLock`,
 * `pwNavigate`, `isPlaywrightCliAvailable`, `fetchPageViaPlaywright`) bind
 * to the `melo-shared` session for backward compatibility with
 * fetchUrlTool.js. webSearchTool.js creates its own session via
 * `createPlaywrightSession({ sessionName: 'melo-search' })` so the two
 * don't fight for the same browser window.
 */

import { execFile, execSync } from 'node:child_process';
import { debugWarn } from '../debug.js';

// Hygiene fix #2 (system-freeze regression, 2026-05-04 second
// occurrence): Codex's first hygiene fix (idle-close + isConcurrencySafe
// + SWR dedup at commit 506814d) only addressed WITHIN-session
// accumulation. The system froze a second time; ps showed 144+
// `playwright_chromiumdev_profile-*` Chrome helpers + 20+ detached
// `cliDaemon.js melo-(shared|search)` daemons spanning multiple
// hours — each prior melo run / crash / SIGKILL left orphan daemons
// that kept spawning Chrome instances.
//
// Root cause: `npx -y @playwright/cli` spawns a detached daemon
// (PPID=1 after parent exits). The daemon owns its own Chrome
// process. Without an explicit `playwright-cli close`, the daemon
// runs forever — and even our close path only fires on graceful
// idle-close, not on crash / SIGKILL / unhandled exception.
//
// Fix: two complementary cleanups:
//
//   1. cleanupStalePlaywrightDaemons() at module load
//      pkills any melo-shared/melo-search daemon left from prior
//      runs. Idempotent. Covers the cross-process / crash recovery
//      path. This is the ROOT cause fix — every fresh melo start
//      cleans up whatever previous runs left behind.
//
//   2. installExitHooks() process-level signal handlers
//      Best-effort graceful shutdown when the current melo process
//      receives SIGINT/SIGTERM or runs to natural completion. Sync
//      pkill so it actually executes before the process dies.
//      Doesn't help on SIGKILL (no signal delivery) or hard crash —
//      that's why #1 exists.
//
// Trade-off: we pkill ALL `melo-(shared|search)` daemons across
// ALL melo instances. Two melo instances running concurrently can
// kill each other's daemons → the other instance's next web_search
// call respawns, paying a ~1s cold-start hit. Compared to the
// system-freeze cost of leaving daemons forever, this is the right
// trade-off.

function cleanupStalePlaywrightDaemons() {
  // macOS uses pkill from procps; Linux ditto. Skip on Windows
  // (we don't support it as a melo target anyway).
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  try {
    // Match the daemon arg pattern: `cliDaemon.js melo-shared` /
    // `cliDaemon.js melo-search`. Anchored at end-of-line to avoid
    // matching a hypothetical `cliDaemon.js melo-shared-extra`.
    execSync(
      'pkill -f "cliDaemon\\.js melo-(shared|search)$"',
      { timeout: 5000, stdio: 'ignore' },
    );
  } catch {
    // pkill exits 1 when no processes match — perfectly normal on
    // a clean system. Any other error is also non-fatal.
  }
}

// Run cleanup at module load — idempotent. Every melo cold-start
// reaps whatever the previous run left orphaned.
cleanupStalePlaywrightDaemons();

let _exitHooksInstalled = false;
function installExitHooks() {
  if (_exitHooksInstalled) return;
  _exitHooksInstalled = true;
  const cleanup = () => {
    try { cleanupStalePlaywrightDaemons(); } catch { /* never throw from exit hook */ }
  };
  // Common shutdown signals — clean up before re-exiting with the
  // standard signal exit codes.
  process.once('SIGINT', () => { cleanup(); process.exit(130); });
  process.once('SIGTERM', () => { cleanup(); process.exit(143); });
  // Natural process exit (event loop drain) — best-effort sync
  // cleanup. Node fires beforeExit only when no more work is queued.
  process.once('beforeExit', cleanup);
}
installExitHooks();

const DEFAULT_TIMEOUT_MS = 14_000;
const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_SESSION_NAME = 'melo-shared';
const DEFAULT_IDLE_CLOSE_MS = 15_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
// Pin to a known-good version: `@latest` makes npx revalidate
// against the registry on every cold start (network-dependent +
// non-reproducible — different ops boxes can resolve to different
// versions on the same day). The MELO_PLAYWRIGHT_CLI_PACKAGE env
// var is the escape hatch for ops who need to test against a newer
// version. Bump this constant when the pin needs upgrading.
const PLAYWRIGHT_CLI_PACKAGE = process.env.MELO_PLAYWRIGHT_CLI_PACKAGE || '@playwright/cli@0.1.11';

// ─── Pure helper (shared across sessions) ────────────────────────────────────

export function cleanPageText(text) {
  return text
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^Title:.*\n/m, '')
    .replace(/^URL Source:.*\n/m, '')
    .replace(/^Markdown Content:.*\n/m, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Session factory ─────────────────────────────────────────────────────────

/**
 * Create an isolated Playwright CLI session. Each session has its own:
 *   - browser window (keyed by `sessionName` via `-s=<name>`)
 *   - availability cache
 *   - mutex chain (navigate→eval serialization)
 *
 * @param {{ sessionName: string, defaultTimeoutMs?: number, defaultMaxChars?: number, debugScope?: string, idleCloseMs?: number }} opts
 * @returns {{
 *   sessionName: string,
 *   runCli: (args: string[], timeoutMs?: number) => Promise<string>,
 *   withLock: <T>(fn: () => Promise<T>) => Promise<T>,
 *   isAvailable: () => Promise<boolean>,
 *   navigate: (url: string, timeoutMs?: number) => Promise<void>,
 *   close: (timeoutMs?: number) => Promise<void>,
 *   closeSoon: (delayMs?: number) => void,
 *   fetchPage: (url: string, opts?: { timeoutMs?: number, maxChars?: number }) => Promise<{ url: string, content: string | null }>,
 * }}
 */
export function createPlaywrightSession({
  sessionName,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  defaultMaxChars = DEFAULT_MAX_CHARS,
  debugScope = 'playwright',
  idleCloseMs = DEFAULT_IDLE_CLOSE_MS,
} = {}) {
  if (!sessionName) {
    throw new Error('createPlaywrightSession requires a sessionName');
  }

  let _cliAvailable = null;
  let _browserOpen = false;
  let _closeRequested = false;
  let _idleTimer = null;
  let _chain = Promise.resolve();

  function clearIdleTimer() {
    if (_idleTimer) {
      clearTimeout(_idleTimer);
      _idleTimer = null;
    }
  }

  function closeSoon(delayMs = idleCloseMs) {
    clearIdleTimer();
    if (delayMs == null || delayMs < 0) return;
    if (!_browserOpen && !_closeRequested) return;
    _closeRequested = true;
    _idleTimer = setTimeout(() => {
      _idleTimer = null;
      close().catch(error => {
        debugWarn(debugScope, `[${sessionName}] idle close failed:`, error?.message || error);
      });
    }, delayMs);
    _idleTimer.unref?.();
  }

  function runCli(args, timeoutMs = defaultTimeoutMs) {
    clearIdleTimer();
    const command = args?.[0];
    return new Promise((resolve, reject) => {
      const child = execFile(
        'npx',
        ['-y', PLAYWRIGHT_CLI_PACKAGE, `-s=${sessionName}`, '--raw', ...args],
        { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: '1' } },
        (err, stdout) => {
          if (command === 'close') {
            _browserOpen = false;
            _closeRequested = false;
          } else if (_browserOpen) {
            closeSoon();
          }
          if (err) {
            if (err.killed || err.signal || /timed out|timeout/i.test(String(err.message || ''))) {
              _closeRequested = true;
              closeSoon(0);
            }
            return reject(err);
          }
          resolve(stdout || '');
        },
      );
      child.stderr?.resume();
    });
  }

  function withLock(fn) {
    const result = _chain.then(() => fn());
    // Swallow error for the chain only — caller still sees it
    _chain = result.catch(() => {});
    return result;
  }

  async function isAvailable() {
    if (_cliAvailable !== null) return _cliAvailable;
    try {
      await runCli(['--version'], 8000);
      _cliAvailable = true;
    } catch (error) {
      debugWarn(debugScope, `[${sessionName}] CLI not available:`, error?.message || error);
      _cliAvailable = false;
    }
    return _cliAvailable;
  }

  async function navigate(url, timeoutMs = defaultTimeoutMs) {
    if (!_browserOpen) {
      // First open: runCli's callback fires while _browserOpen is
      // still false, so its auto-closeSoon branch is skipped. Need
      // explicit closeSoon here AFTER flipping _browserOpen.
      await runCli(['open', url], timeoutMs);
      _browserOpen = true;
      _closeRequested = false;
      closeSoon();
    } else {
      try {
        // goto: _browserOpen is already true when runCli's callback
        // fires, so its auto-closeSoon already scheduled the timer.
        // No explicit call here (was redundant, removed in self-
        // review of round 14 hygiene fix).
        await runCli(['goto', url], timeoutMs);
      } catch (error) {
        debugWarn(debugScope, `[${sessionName}] goto failed, retrying with open for ${url}:`, error?.message || error);
        // Fallback open: same logic as first open above —
        // _browserOpen was already true going in but runCli error
        // path ran first, leaving it ambiguous; re-flip + re-
        // schedule explicitly.
        await runCli(['open', url], timeoutMs);
        _browserOpen = true;
        _closeRequested = false;
        closeSoon();
      }
    }
  }

  async function close(timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS) {
    const result = _chain.then(async () => {
      clearIdleTimer();
      if (!_browserOpen && !_closeRequested) return;
      try {
        await runCli(['close'], timeoutMs);
      } catch (error) {
        debugWarn(debugScope, `[${sessionName}] close failed:`, error?.message || error);
      } finally {
        _browserOpen = false;
        _closeRequested = false;
      }
    });
    _chain = result.catch(() => {});
    return result;
  }

  async function fetchPage(url, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
    const maxChars = opts.maxChars ?? defaultMaxChars;
    return withLock(async () => {
      try {
        await navigate(url, timeoutMs);
        const waitAndExtract = `(async () => {
          const get = () => (document.body?.innerText || '').trim();
          let prev = get();
          for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 500));
            const cur = get();
            if (cur.length > 200 && cur.length === prev.length) break;
            prev = cur;
          }
          return get();
        })()`;
        const raw = await runCli(['eval', waitAndExtract], timeoutMs);
        let text = raw;
        try {
          text = JSON.parse(raw);
        } catch {
          // raw may already be a plain string — accept as-is
        }
        if (!text || typeof text !== 'string' || text.length < 50) {
          debugWarn(debugScope, `[${sessionName}] empty/short content for ${url} (length=${text?.length || 0})`);
          return { url, content: null };
        }
        const clean = cleanPageText(text);
        return { url, content: clean.slice(0, maxChars) };
      } catch (error) {
        debugWarn(debugScope, `[${sessionName}] page fetch failed for ${url}:`, error?.message || error);
        closeSoon(0);
        return { url, content: null };
      }
    });
  }

  return { sessionName, runCli, withLock, isAvailable, navigate, close, closeSoon, fetchPage };
}

// ─── Default (melo-shared) session — back-compat exports ─────────────────────
//
// fetchUrlTool.js imports { fetchPageViaPlaywright, isPlaywrightCliAvailable }
// from here and assumes the shared session. Preserve that surface so the
// consolidation is zero-behavior-change for existing callers.

const _defaultSession = createPlaywrightSession({
  sessionName: DEFAULT_SESSION_NAME,
  debugScope: 'playwright',
});

export const runPlaywrightCli = _defaultSession.runCli;
export const withPwLock = _defaultSession.withLock;
export const isPlaywrightCliAvailable = _defaultSession.isAvailable;
export const pwNavigate = _defaultSession.navigate;
export const closePlaywrightSession = _defaultSession.close;
export const closePlaywrightSessionSoon = _defaultSession.closeSoon;
export const fetchPageViaPlaywright = _defaultSession.fetchPage;
