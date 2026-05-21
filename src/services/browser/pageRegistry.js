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
import { getMeloHome } from '../../config.js';

// Page registry — pageId → { browser, page, openedAt, lastUsedAt, currentUrl, home }
//
// 2026-05-21 audit finding #3: entries carry the MELO_HOME captured at
// openPage time.  getPage / closePage / peekPageInfo validate that the
// current home matches before honoring the request — without this guard,
// pageId from home A can be used by code running under home B to drive
// home A's Chrome profile (cookies, login state, opened tabs) — a
// per-MELO_HOME isolation穿透.  Production single-home stays unchanged:
// captured home always equals current home → validation passes silently.
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

  // Codex Stage 3b round-2 闭环 (2026-05-17): use page.url() after
  // navigation, not the input url.  30x / login / consent redirects
  // mean the page actually landed somewhere else; persisting the
  // original URL would mislead subsequent browser_* tools and the
  // model (e.g. "still on the login page" misclassification when the
  // page has already redirected to the dashboard).  Falls back to the
  // input url if page.url() is missing / fake page.
  const landedUrl = (typeof page.url === 'function' ? page.url() : '') || url;
  const pageId = newPageId();
  const now = Date.now();
  // 2026-05-21 audit闭环 #3: capture home at open time.  Subsequent
  // getPage / closePage / peekPageInfo validate against current home.
  _pages.set(pageId, {
    browser,
    page,
    openedAt: now,
    lastUsedAt: now,
    currentUrl: landedUrl,
    home: getMeloHome(),
  });
  return { pageId, currentUrl: landedUrl };
}

/**
 * Cross-home guard: if the page handle was opened under a different
 * MELO_HOME than the current call, refuse to honor it.  Returns
 * `{ ok: true, entry }` when home matches, or throws a descriptive error.
 *
 * This is shared between getPage / closePage / peekPageInfo so the
 * isolation contract is enforced uniformly.  2026-05-21 audit闭环 #3.
 */
function _assertHomeMatch(pageId, entry) {
  const current = getMeloHome();
  if (entry.home && entry.home !== current) {
    throw new Error(
      `pageId ${pageId} was opened under a different MELO_HOME ` +
      `(${entry.home}); current home is ${current}.  Cross-home page ` +
      `handles are forbidden — open a new page under the current home.`,
    );
  }
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
  _assertHomeMatch(pageId, entry);
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
  // 2026-05-21 #3: peek MUST also enforce the home guard — a debug surface
  // that leaks "this pageId exists under home A" to a home-B caller breaks
  // the same isolation contract as getPage doing the actual driving.
  _assertHomeMatch(pageId, entry);
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
  // Caller-driven close MUST honor home isolation (same contract as
  // getPage / peekPageInfo).  Bulk cleanup paths (closeAllPages,
  // cleanupIdlePages) bypass via _closePageInternal directly.
  _assertHomeMatch(pageId, entry);
  return _closePageInternal(pageId, entry);
}

/**
 * Internal close — bypasses the home guard.  Used by closeAllPages /
 * cleanupIdlePages where we want to release resources regardless of
 * which home opened the page (process shutdown / age sweep don't have
 * a "current home" to validate against — they SERVE the cleanup intent
 * of every home).  Never throws.
 */
async function _closePageInternal(pageId, entry) {
  _pages.delete(pageId);
  try { await entry.page.close(); } catch { /* best-effort */ }
  try { await entry.browser.close(); } catch { /* best-effort */ }
  return true;
}

/**
 * Close every registered page.  Used by shutdown hooks (server.js
 * shutdown() — wired 2026-05-21 audit闭环 #2) and test cleanup.  Errors
 * are swallowed — best-effort cleanup, never propagates so callers'
 * shutdown sequences don't break on one stuck page.  Bypasses the
 * home guard since shutdown serves cleanup intent of every home.
 */
export async function closeAllPages() {
  const entries = [..._pages.entries()];
  for (const [id, entry] of entries) {
    try { await _closePageInternal(id, entry); } catch { /* swallow */ }
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
  // Snapshot entries first (the iteration sees the size at start; the
  // _closePageInternal mutations happen inside, but iteration is over a
  // captured array).  Same home-bypass intent as closeAllPages — age
  // eviction is cleanup, not a user-driven access, so home guard
  // doesn't apply.
  const snapshot = [..._pages.entries()];
  for (const [id, entry] of snapshot) {
    if (entry.lastUsedAt < cutoff) {
      const ok = await _closePageInternal(id, entry);
      if (ok) closed.push(id);
    }
  }
  return closed;
}

/**
 * Return the count of registered pages for the current MELO_HOME.
 *
 * 2026-05-21 audit闭环 #3 round-2 (Codex C #6): pre-fix this returned
 * `_pages.size` (process-level total).  In a multi-home runtime, that
 * leaked the count of pages opened under other homes — "you can deduce
 * home A opened N pages" is itself a side-channel.  Read surfaces use
 * filter-not-throw semantics (debug API should degrade gracefully on
 * cross-home, not crash); write surfaces (getPage/closePage) keep
 * throw semantics since caller intent for cross-home write is unclear.
 */
export function pageCount() {
  const current = getMeloHome();
  let n = 0;
  for (const entry of _pages.values()) {
    if (!entry.home || entry.home === current) n++;
  }
  return n;
}

/**
 * Read-only snapshot of every registered page's metadata FOR THE
 * CURRENT MELO_HOME.  Same shape as peekPageInfo for one id; useful for
 * diagnostics tools to enumerate open handles.
 *
 * 2026-05-21 audit闭环 #3 round-2 (Codex C #6): pre-fix this returned
 * entries from every home — leaking pageId / currentUrl / openedAt of
 * pages opened by other profiles.  Filter to the current home so this
 * debug surface honors the same isolation boundary as peekPageInfo /
 * getPage.  Process-level total (for shutdown / metrics callers that
 * legitimately want global state) is intentionally NOT exposed —
 * closeAllPages handles the global-cleanup case directly.
 */
export function listPages() {
  const current = getMeloHome();
  const out = [];
  for (const [pageId, entry] of _pages.entries()) {
    if (entry.home && entry.home !== current) continue;
    out.push({
      pageId,
      currentUrl: entry.currentUrl,
      openedAt: entry.openedAt,
      lastUsedAt: entry.lastUsedAt,
    });
  }
  return out;
}
