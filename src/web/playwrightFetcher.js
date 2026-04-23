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

import { execFile } from 'node:child_process';
import { debugWarn } from '../debug.js';

const DEFAULT_TIMEOUT_MS = 14_000;
const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_SESSION_NAME = 'melo-shared';

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
 * @param {{ sessionName: string, defaultTimeoutMs?: number, defaultMaxChars?: number, debugScope?: string }} opts
 * @returns {{
 *   sessionName: string,
 *   runCli: (args: string[], timeoutMs?: number) => Promise<string>,
 *   withLock: <T>(fn: () => Promise<T>) => Promise<T>,
 *   isAvailable: () => Promise<boolean>,
 *   navigate: (url: string, timeoutMs?: number) => Promise<void>,
 *   fetchPage: (url: string, opts?: { timeoutMs?: number, maxChars?: number }) => Promise<{ url: string, content: string | null }>,
 * }}
 */
export function createPlaywrightSession({
  sessionName,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  defaultMaxChars = DEFAULT_MAX_CHARS,
  debugScope = 'playwright',
} = {}) {
  if (!sessionName) {
    throw new Error('createPlaywrightSession requires a sessionName');
  }

  let _cliAvailable = null;
  let _browserOpen = false;
  let _chain = Promise.resolve();

  function runCli(args, timeoutMs = defaultTimeoutMs) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'npx',
        ['-y', '@playwright/cli@latest', `-s=${sessionName}`, '--raw', ...args],
        { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: '1' } },
        (err, stdout) => {
          if (err) return reject(err);
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
      await runCli(['open', url], timeoutMs);
      _browserOpen = true;
    } else {
      try {
        await runCli(['goto', url], timeoutMs);
      } catch (error) {
        debugWarn(debugScope, `[${sessionName}] goto failed, retrying with open for ${url}:`, error?.message || error);
        await runCli(['open', url], timeoutMs);
        _browserOpen = true;
      }
    }
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
        return { url, content: null };
      }
    });
  }

  return { sessionName, runCli, withLock, isAvailable, navigate, fetchPage };
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
export const fetchPageViaPlaywright = _defaultSession.fetchPage;
