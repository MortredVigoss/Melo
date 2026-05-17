/**
 * Persistent CDP page handle registry — Stage 3a of the meloChrome rollout.
 *
 * Stage 2b/2c gave fetchUrlTool / webSearchTool a one-shot "fetch one URL
 * via CDP attach" tier — but the page is opened, scraped, and closed in
 * a single call.  Stage 3 needs **persistent** pages so the agent can:
 *
 *   1. browser_open('https://reddit.com/r/...')      → pageId=p1
 *   2. browser_click(p1, '.expand-comments')
 *   3. browser_snapshot(p1)                          → see expanded body
 *   4. browser_close(p1)
 *
 * This module owns the page-handle lifecycle so Stage 3b/3c tools just
 * call `getPage(pageId)` to drive their playwright page object without
 * thinking about CDP attach / browser handles / cleanup.
 *
 * Key design commitments (Codex-relevant, diff-invisible):
 *   • MELO_CDP_ENABLED=1 gate (same env contract as Stage 2b/2c — env is
 *     the user's unconditional consent flag, not an agent-selectable enum).
 *   • One Browser handle PER persistent page (not shared).  Multiple
 *     handles to the same underlying Chrome is supported by CDP, slightly
 *     wastes WebSocket connections but keeps lifecycle bookkeeping simple
 *     for v1.  Optimize to shared handle later if real usage warrants.
 *   • contexts()[0] reuse — same as Stage 2b/2c: NEVER call
 *     browser.newContext() (would create isolated profile, lose login
 *     state).  Defensive fallback only when contexts() returns empty.
 *   • domcontentloaded + waitForLoadState('load', 3000) navigation —
 *     same as Stage 2b/2c, networkidle is unreachable on modern SPAs.
 *   • Idle sweep is a callable helper, NOT a module-load-time timer —
 *     callers (chat lifecycle / shutdown hook) drive it explicitly so we
 *     don't leak timers in test runs (CLAUDE.md §6: capture, don't schedule).
 *
 * NOT in Stage 3a scope:
 *   • The actual browser_* tools (Stage 3b/3c).
 *   • Per-MELO_HOME isolation (no current need — _pages is global; pages
 *     are short-lived enough that home switches mid-session aren't a
 *     concrete risk.  Add if a real bug surfaces.)
 *   • Cross-process coordination (same as Stage 1 launcher — out of scope).
 */

import { randomUUID } from 'node:crypto';

import { connectMeloChrome } from './connect.js';

// Page registry — pageId → { browser, page, openedAt, lastUsedAt, currentUrl }
const _pages = new Map();

const DEFAULT_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_LOAD_STABILITY_MS = 3000;

// DI seam for tests — production uses the real connectMeloChrome.
let _connectImplOverride = null;
export function _setConnectImplForTests(fn) {
  _connectImplOverride = fn || null;
}
export function _resetPagesForTests() {
  _pages.clear();
}

function newPageId() {
  // Short, grep-friendly: "pg-" + 8 hex chars of a v4 UUID.  Collisions
  // are astronomically unlikely at typical page counts (~10s); we don't
  // need full 128-bit uniqueness here.
  return `pg-${randomUUID().slice(0, 8)}`;
}

/**
 * Open a new persistent page navigating to `url`.  Returns a handle
 * `{ pageId, currentUrl }` that subsequent browser_* tools key on.
 *
 * Throws:
 *   • Error('MELO_CDP_ENABLED=1 required') — env gate refuses (same
 *     contract as Stage 2b/2c).
 *   • Launch / connect errors propagated from connectMeloChrome.
 *   • page.goto errors (network / TLS / timeout).
 */
export async function openPage(url, {
  signal,
  chromePath,
  openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS,
} = {}) {
  if (process.env.MELO_CDP_ENABLED !== '1') {
    throw new Error('Browser tools require MELO_CDP_ENABLED=1 (user-set env flag)');
  }
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error(`openPage: url must be http(s); got ${JSON.stringify(url)}`);
  }
  const connect = _connectImplOverride || connectMeloChrome;
  const launchInfo = await connect({ signal, chromePath });
  const { browser } = launchInfo;

  // Acquire / create the default context.  Per Stage 2b round-2 闭环:
  // MUST reuse contexts()[0] (persistent profile with login state); the
  // newContext() fallback is defensive only — won't fire for real CDP
  // attach, which always has at least one context.
  let context;
  let page;
  // Codex Stage 3a round-2 闭环 (2026-05-17): abort listener inside
  // openPage closes the page on signal flip — playwright's page.goto()
  // doesn't natively listen to AbortSignal, so a Stop during navigation
  // would otherwise let goto run to natural completion (could be 15s),
  // the page would get registered, and the user's Stop would be silently
  // ignored.  Same fix pattern as fetchUrlTool Stage 2c round-2.
  let abortListener = null;
  try {
    const contexts = typeof browser.contexts === 'function' ? browser.contexts() : [];
    context = (Array.isArray(contexts) && contexts[0])
      ? contexts[0]
      : await browser.newContext();
    page = await context.newPage();
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    // Wire abort → close-page so in-flight goto / waitForLoadState
    // returns immediately on Stop instead of running to natural timeout.
    if (signal) {
      abortListener = () => {
        page.close().catch(() => {}); // best-effort; outer finally also closes
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: openTimeoutMs,
    });
    // Post-goto re-check — page.close() above may have raced ahead, but
    // signal could also have flipped AFTER goto resolved naturally.
    // Either way, no registration.
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    try {
      await page.waitForLoadState('load', { timeout: DEFAULT_LOAD_STABILITY_MS });
    } catch { /* `load` may never fire on streamy pages — fine */ }
    // Final re-check — the load wait may have hung and abort fired
    // mid-wait via the listener.
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
  } catch (err) {
    // Don't leak the page or browser if goto / waitForLoadState fails
    // OR signal aborted anywhere in the await chain.
    if (page) {
      try { await page.close(); } catch { /* best-effort */ }
    }
    try { await browser.close(); } catch { /* best-effort */ }
    throw err;
  } finally {
    // Remove the listener unconditionally — by this point we've either
    // registered the page (listener no longer relevant) or we're
    // throwing (cleanup handled above).  Leaving the listener attached
    // would let a later abort try to close an already-closed page.
    if (signal && abortListener) {
      try { signal.removeEventListener('abort', abortListener); } catch {}
    }
  }

  const pageId = newPageId();
  const now = Date.now();
  _pages.set(pageId, {
    browser,
    page,
    openedAt: now,
    lastUsedAt: now,
    currentUrl: url,
  });
  return { pageId, currentUrl: url };
}

/**
 * Return the registered page object for `pageId`.  Bumps lastUsedAt so
 * the idle sweeper sees recent activity.  Throws if pageId is unknown
 * (already closed, mistyped, etc) — caller-facing tools should catch
 * and surface a clear "page handle expired" message.
 */
export function getPage(pageId) {
  const entry = _pages.get(pageId);
  if (!entry) {
    throw new Error(`Unknown pageId: ${pageId} (closed, expired, or never opened)`);
  }
  entry.lastUsedAt = Date.now();
  return entry.page;
}

/**
 * Return a read-only metadata snapshot for `pageId`, or null if absent.
 * Does NOT bump lastUsedAt — for status / debug surfaces that shouldn't
 * keep an idle page alive just by being inspected.
 */
export function peekPageInfo(pageId) {
  const entry = _pages.get(pageId);
  if (!entry) return null;
  return {
    pageId,
    currentUrl: entry.currentUrl,
    openedAt: entry.openedAt,
    lastUsedAt: entry.lastUsedAt,
  };
}

/**
 * Close `pageId` cleanly: close the page handle (releases CDP target),
 * close the browser handle (releases WS connection), drop the registry
 * entry.  Idempotent — closing an unknown id is a no-op (returns false).
 * Returns true if a page was actually closed.
 */
export async function closePage(pageId) {
  const entry = _pages.get(pageId);
  if (!entry) return false;
  _pages.delete(pageId);
  try { await entry.page.close(); } catch { /* best-effort */ }
  try { await entry.browser.close(); } catch { /* best-effort */ }
  return true;
}

/**
 * Close every registered page.  Used by shutdown hooks (server.js
 * onClose) and test cleanup.  Errors are swallowed — best-effort
 * cleanup, never propagates so callers' shutdown sequences don't break
 * on one stuck page.
 */
export async function closeAllPages() {
  const ids = [..._pages.keys()];
  for (const id of ids) {
    try { await closePage(id); } catch { /* swallow */ }
  }
}

/**
 * Sweep pages idle longer than `maxIdleMs`.  Returns the array of
 * pageIds that were closed.  Caller (chat lifecycle / explicit timer)
 * drives this — no module-load-time timer, per CLAUDE.md §6.
 */
export async function cleanupIdlePages(maxIdleMs) {
  if (!Number.isFinite(maxIdleMs) || maxIdleMs <= 0) return [];
  const cutoff = Date.now() - maxIdleMs;
  const closed = [];
  for (const [id, entry] of _pages.entries()) {
    if (entry.lastUsedAt < cutoff) {
      const ok = await closePage(id);
      if (ok) closed.push(id);
    }
  }
  return closed;
}

/**
 * Return the current registry size — debug / metric surface.  Doesn't
 * bump lastUsedAt of any entry.
 */
export function pageCount() {
  return _pages.size;
}

/**
 * Read-only snapshot of every registered page's metadata.  Same shape
 * as peekPageInfo for one id; useful for diagnostics tools to enumerate
 * open handles.
 */
export function listPages() {
  return [..._pages.entries()].map(([pageId, entry]) => ({
    pageId,
    currentUrl: entry.currentUrl,
    openedAt: entry.openedAt,
    lastUsedAt: entry.lastUsedAt,
  }));
}
