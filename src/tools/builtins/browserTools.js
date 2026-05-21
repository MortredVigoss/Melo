/**
 * Stage 3b: persistent CDP browser tools — read-only-ish surface.
 *
 *   browser_open(url)        → opens a persistent page, returns { pageId, currentUrl }
 *   browser_snapshot(pageId) → returns { text, currentUrl, title } for a registered page
 *   browser_close(pageId)    → releases the page + browser handles; idempotent
 *
 * Stage 3c adds state-changing tools (browser_click / browser_fill /
 * browser_wait_for) that share the same pageRegistry but carry
 * requiresPermission:true.
 *
 * Design commitments:
 *   • All three tools gated transitively via the registry — openPage()
 *     refuses when MELO_CDP_ENABLED !== '1' (Stage 3a contract).
 *     snapshot / close don't re-check the env explicitly because the
 *     only way to obtain a valid pageId is through openPage, which
 *     enforces the gate.  Unknown pageId yields a clear registry error.
 *   • requiresPermission:false for ALL three — fetchUrlTool already
 *     does navigation with `false`; persistent handle semantics
 *     don't change the data-flow trust boundary on the user's side.
 *     The state-changing tools (click / fill) in Stage 3c are where
 *     requiresPermission:true lives.
 *   • isConcurrencySafe:false — a single page is a serial resource;
 *     two snapshots in-flight could race the same DOM read.
 *   • Test seam: each tool accepts an optional `_pageRegistry` override
 *     in run() opts.  Production callers leave it null and the real
 *     ./services/browser/pageRegistry.js binding wins.  Same pattern
 *     as fetchUrlTool's _readSocialLink / _tryCdpChrome.
 */

import {
  openPage,
  getPage,
  closePage,
  peekPageInfo,
} from '../../services/browser/pageRegistry.js';
import { debugWarn } from '../../debug.js';

// Default registry impl bundle — overridable per-call via _pageRegistry.
const DEFAULT_REGISTRY = { openPage, getPage, closePage, peekPageInfo };

const TEXT_CHARS_CAP = 50_000;

// awaitWithAbort — wrap a promise so a caller signal can reject the await
// immediately even if the underlying playwright op (evaluate, etc) keeps
// running internally.  Same shape as webSearchTool.abortRace; kept inline
// for v1 (the "extract to shared helper" follow-up is a separate refactor).
async function awaitWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return new Promise((resolve, reject) => {
    let listener;
    const cleanup = () => {
      if (listener) {
        try { signal.removeEventListener('abort', listener); } catch {}
        listener = null;
      }
    };
    listener = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', listener, { once: true });
    promise.then(
      v => { cleanup(); resolve(v); },
      e => { cleanup(); reject(e); },
    );
  });
}

// ─── browser_open ────────────────────────────────────────────────────────────

export const browserOpenTool = {
  id: 'browser_open',
  name: 'Browser open',
  description:
    'Open a persistent browser page at the given URL via CDP attach to the user\'s Melo Chrome ' +
    '(carries logged-in cookies + anti-bot bypass).  Returns a pageId handle that subsequent ' +
    'browser_* tools can drive: snapshot the page body, click selectors (Stage 3c), fill forms, ' +
    'wait for content, etc.  Requires MELO_CDP_ENABLED=1 (user-set env flag).  Always call ' +
    'browser_close when done — pages otherwise idle out via the registry sweeper.',
  category: 'web',
  isConcurrencySafe: false,
  requiresPermission: false,
  parametersSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'http(s) URL to navigate to.  Must be reachable from the user\'s Chrome.',
      },
    },
    required: ['url'],
  },
  examples: [
    { url: 'https://news.ycombinator.com' },
    { url: 'https://github.com/anthropics/anthropic-sdk-python/issues' },
  ],
  async run({ url }, { signal, _pageRegistry } = {}) {
    const registry = _pageRegistry || DEFAULT_REGISTRY;
    try {
      const { pageId, currentUrl } = await registry.openPage(url, { signal });
      return {
        ok: true,
        output: `Opened page ${pageId} → ${currentUrl}`,
        meta: { pageId, currentUrl },
      };
    } catch (err) {
      const msg = String(err?.message || err || 'unknown error');
      debugWarn('browser_open', `failed to open ${url}: ${msg}`);
      return {
        ok: false,
        output: `browser_open failed for "${url}": ${msg}`,
        error: msg.includes('MELO_CDP_ENABLED') ? 'CDP_DISABLED' : 'OPEN_FAILED',
      };
    }
  },
};

// ─── browser_snapshot ────────────────────────────────────────────────────────

export const browserSnapshotTool = {
  id: 'browser_snapshot',
  name: 'Browser snapshot',
  description:
    'Capture the current text + URL + title of a browser page opened via browser_open. ' +
    'Pure read — does not navigate or interact.  Use after clicking / filling / waiting to ' +
    'see what the page looks like now.  Text is truncated to ~50k chars; the agent should ' +
    'wait_for a specific selector if the page is expected to be larger.',
  category: 'web',
  isConcurrencySafe: false,
  requiresPermission: false,
  parametersSchema: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'Handle returned by browser_open.',
      },
    },
    required: ['pageId'],
  },
  examples: [
    { pageId: 'pg-1a2b3c4d' },
  ],
  async run({ pageId }, { signal, _pageRegistry } = {}) {
    const registry = _pageRegistry || DEFAULT_REGISTRY;
    let page;
    try {
      page = registry.getPage(pageId);
    } catch (err) {
      return {
        ok: false,
        output: `browser_snapshot: ${err?.message || err}`,
        error: 'UNKNOWN_PAGE',
      };
    }
    try {
      // Codex Stage 3b round-2 闭环 (2026-05-17): wrap evaluate() in
      // awaitWithAbort so a caller signal flip rejects the tool's wait
      // immediately.  page.evaluate() doesn't natively listen to
      // AbortSignal; the underlying CDP call keeps running until natural
      // completion / executor timeout, but the tool returns to the
      // caller in microseconds.  Page handle stays alive (we do NOT
      // page.close() on abort — that would defeat persistent-handle
      // semantics; caller can explicitly browser_close if they want).
      const text = await awaitWithAbort(
        page.evaluate(() => document?.body?.innerText || ''),
        signal,
      );
      const title = await awaitWithAbort(
        page.evaluate(() => document?.title || ''),
        signal,
      );
      const currentUrl = typeof page.url === 'function' ? page.url() : '';
      const trimmed = String(text || '').trim().slice(0, TEXT_CHARS_CAP);
      return {
        ok: true,
        output: trimmed || `(empty page body for ${pageId})`,
        meta: {
          pageId,
          currentUrl,
          title: String(title || ''),
          textLength: trimmed.length,
        },
      };
    } catch (err) {
      const msg = String(err?.message || err || 'unknown error');
      if (err?.name === 'AbortError' || signal?.aborted) {
        return {
          ok: false,
          output: `browser_snapshot aborted for ${pageId}`,
          error: 'ABORTED',
        };
      }
      debugWarn('browser_snapshot', `failed for ${pageId}: ${msg}`);
      return {
        ok: false,
        output: `browser_snapshot failed for ${pageId}: ${msg}`,
        error: 'SNAPSHOT_FAILED',
      };
    }
  },
};

// ─── browser_click ───────────────────────────────────────────────────────────

const DEFAULT_INTERACT_TIMEOUT_MS = 10_000;

export const browserClickTool = {
  id: 'browser_click',
  name: 'Browser click',
  description:
    'Click an element on a browser page opened via browser_open.  Selector is a CSS selector ' +
    '(e.g. "button.submit", "[data-testid=\'expand\']", "a:has-text(\'Sign in\')").  This is a ' +
    'state-changing operation — it may submit forms, follow links, fire JS handlers, etc.  ' +
    'After clicking, use browser_snapshot to see what changed, or browser_wait_for if the ' +
    'click triggers a navigation / async load.  If aborted mid-click, the persistent ' +
    'page handle is invalidated (closed) to guarantee the underlying playwright op stops ' +
    'producing side effects — subsequent ops require a fresh browser_open.',
  category: 'web',
  isConcurrencySafe: false,
  // State-changing: click can submit forms / send messages / make
  // purchases.  Per CLAUDE.md "Explicit permission" rules: clicking
  // irreversible action buttons + sending messages both require user
  // approval per-call.
  requiresPermission: true,
  parametersSchema: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'Handle returned by browser_open.',
      },
      selector: {
        type: 'string',
        description:
          'CSS selector matching the element to click.  Playwright extensions like ' +
          '`button:has-text("Submit")` are supported.',
      },
      timeoutMs: {
        type: 'number',
        description:
          'How long to wait for the selector to be clickable.  Default 10000.  Caller ' +
          'should use browser_wait_for first if the element appears async.',
      },
    },
    required: ['pageId', 'selector'],
  },
  examples: [
    { pageId: 'pg-1a2b3c4d', selector: 'button.submit' },
    { pageId: 'pg-1a2b3c4d', selector: 'a:has-text("Sign in")' },
  ],
  async run({ pageId, selector, timeoutMs }, { signal, _pageRegistry } = {}) {
    const registry = _pageRegistry || DEFAULT_REGISTRY;
    if (typeof selector !== 'string' || !selector.trim()) {
      return { ok: false, output: 'browser_click: selector required', error: 'BAD_INPUT' };
    }
    // Codex Stage 3c round-2 闭环 (2026-05-17): pre-flight abort check
    // BEFORE touching the registry / page object.  Without this, a Stop
    // that fires between scheduling and run() entry would still call
    // page.click() and produce side effects.  This is the cheap layer
    // that catches the most common Stop-before-op-start case.
    if (signal?.aborted) {
      return {
        ok: false,
        output: `browser_click aborted before start for ${pageId}`,
        error: 'ABORTED',
      };
    }
    let page;
    try {
      page = registry.getPage(pageId);
    } catch (err) {
      return {
        ok: false,
        output: `browser_click: ${err?.message || err}`,
        error: 'UNKNOWN_PAGE',
      };
    }
    const tMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Number(timeoutMs)
      : DEFAULT_INTERACT_TIMEOUT_MS;
    // Codex Stage 3c round-2 闭环 (2026-05-17): for state-changing ops,
    // abort must actually stop the underlying playwright op — not just
    // make the wrapper return ABORTED early.  Playwright has no native
    // signal support, so the only way to guarantee click stops is to
    // close the page (same approach Stage 3a openPage uses for in-flight
    // goto).  This invalidates the persistent handle; the caller must
    // re-open.  This is the price of a reliable Stop on state-changing
    // ops — chosen over the alternative ("ABORTED but op may have
    // completed") because the latter is non-actionable for an agent.
    let abortListener = null;
    let pageInvalidatedByAbort = false;
    // 2026-05-21 audit闭环 #8: capture the in-flight closePage Promise
    // so the outer finally can await it before returning ABORTED.
    // Pre-fix this was fire-and-forget — agent would receive `error:
    // ABORTED + meta.pageInvalidated:true` and immediately re-fire
    // browser_open, but the previous page's close was still racing
    // against the new open's CDP attach → two connectOverCDP sessions
    // briefly contending for the same Chrome.
    let closingPromise = null;
    if (signal) {
      abortListener = () => {
        pageInvalidatedByAbort = true;
        // Start the close — capture so finally awaits it.
        closingPromise = Promise.resolve(registry.closePage(pageId)).catch(() => {});
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }
    try {
      await awaitWithAbort(page.click(selector, { timeout: tMs }), signal);
      const currentUrl = typeof page.url === 'function' ? page.url() : '';
      return {
        ok: true,
        output: `Clicked ${selector} on ${pageId}`,
        meta: { pageId, selector, currentUrl, clicked: true },
      };
    } catch (err) {
      const msg = String(err?.message || err || 'unknown error');
      if (err?.name === 'AbortError' || signal?.aborted) {
        return {
          ok: false,
          output: `browser_click aborted for ${pageId} (page handle invalidated)`,
          error: 'ABORTED',
          meta: { pageId, pageInvalidated: pageInvalidatedByAbort || true },
        };
      }
      debugWarn('browser_click', `failed for ${pageId} ${selector}: ${msg}`);
      // Playwright timeout has a distinct shape — surface as a separate
      // error code so the model can decide whether to retry vs change
      // strategy (e.g. use browser_wait_for first).
      const isTimeout = /Timeout|timeout/i.test(msg) || /exceeded/i.test(msg);
      return {
        ok: false,
        output: `browser_click failed for ${pageId} (${selector}): ${msg}`,
        error: isTimeout ? 'CLICK_TIMEOUT' : 'CLICK_FAILED',
      };
    } finally {
      if (signal && abortListener) {
        try { signal.removeEventListener('abort', abortListener); } catch {}
      }
      // 2026-05-21 audit闭环 #8: await the in-flight close before
      // returning so the caller can't observe ABORTED then race a new
      // browser_open against a still-closing browser handle.  closing
      // Promise is .catch()-wrapped above so this await never throws.
      if (closingPromise) {
        await closingPromise;
      }
    }
  },
};

// ─── browser_fill ────────────────────────────────────────────────────────────

export const browserFillTool = {
  id: 'browser_fill',
  name: 'Browser fill',
  description:
    'Fill an input / textarea / contenteditable element on a browser page.  Clears any ' +
    'existing value first and types the new text.  Selector is a CSS selector matching ' +
    'the field.  State-changing: may trigger reactive framework re-renders, validation, ' +
    'form auto-saves, etc.  Use browser_click on a submit button afterward to actually ' +
    'submit; fill alone does not submit.  If aborted mid-fill, the persistent page handle ' +
    'is invalidated (closed) so the underlying playwright op stops producing side effects ' +
    '— subsequent ops require a fresh browser_open.',
  category: 'web',
  isConcurrencySafe: false,
  requiresPermission: true,
  parametersSchema: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'Handle returned by browser_open.',
      },
      selector: {
        type: 'string',
        description: 'CSS selector matching the input / textarea / contenteditable.',
      },
      value: {
        type: 'string',
        description: 'Text to type.  Empty string clears the field.',
      },
      timeoutMs: {
        type: 'number',
        description: 'How long to wait for the selector to be fillable.  Default 10000.',
      },
    },
    required: ['pageId', 'selector', 'value'],
  },
  examples: [
    { pageId: 'pg-1a2b3c4d', selector: 'input[name="email"]', value: 'me@example.com' },
    { pageId: 'pg-1a2b3c4d', selector: 'textarea#composer-input', value: 'Hello, world.' },
  ],
  async run({ pageId, selector, value, timeoutMs }, { signal, _pageRegistry } = {}) {
    const registry = _pageRegistry || DEFAULT_REGISTRY;
    if (typeof selector !== 'string' || !selector.trim()) {
      return { ok: false, output: 'browser_fill: selector required', error: 'BAD_INPUT' };
    }
    if (typeof value !== 'string') {
      return { ok: false, output: 'browser_fill: value must be a string', error: 'BAD_INPUT' };
    }
    // Codex Stage 3c round-2 闭环: pre-flight abort check before touching
    // the page object — Stop that fires between schedule and run() entry
    // must not produce a fill side effect.
    if (signal?.aborted) {
      return {
        ok: false,
        output: `browser_fill aborted before start for ${pageId}`,
        error: 'ABORTED',
      };
    }
    let page;
    try {
      page = registry.getPage(pageId);
    } catch (err) {
      return {
        ok: false,
        output: `browser_fill: ${err?.message || err}`,
        error: 'UNKNOWN_PAGE',
      };
    }
    const tMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Number(timeoutMs)
      : DEFAULT_INTERACT_TIMEOUT_MS;
    // Codex Stage 3c round-2 闭环: same as click — for state-changing ops,
    // abort must close the page to actually stop the underlying op.
    // Persistent handle invalidation is the cost; the alternative ("we
    // returned ABORTED but the field may still autofill") is unactionable.
    //
    // 2026-05-21 audit闭环 #8: capture closingPromise so the outer
    // finally awaits before returning ABORTED — prevents CDP attach
    // contention between still-closing browser and the agent's immediate
    // re-open.
    let abortListener = null;
    let pageInvalidatedByAbort = false;
    let closingPromise = null;
    if (signal) {
      abortListener = () => {
        pageInvalidatedByAbort = true;
        closingPromise = Promise.resolve(registry.closePage(pageId)).catch(() => {});
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }
    try {
      await awaitWithAbort(page.fill(selector, value, { timeout: tMs }), signal);
      return {
        ok: true,
        output: `Filled ${selector} on ${pageId} (${value.length} chars)`,
        meta: { pageId, selector, valueLength: value.length, filled: true },
      };
    } catch (err) {
      const msg = String(err?.message || err || 'unknown error');
      if (err?.name === 'AbortError' || signal?.aborted) {
        return {
          ok: false,
          output: `browser_fill aborted for ${pageId} (page handle invalidated)`,
          error: 'ABORTED',
          meta: { pageId, pageInvalidated: pageInvalidatedByAbort || true },
        };
      }
      debugWarn('browser_fill', `failed for ${pageId} ${selector}: ${msg}`);
      const isTimeout = /Timeout|timeout/i.test(msg) || /exceeded/i.test(msg);
      return {
        ok: false,
        output: `browser_fill failed for ${pageId} (${selector}): ${msg}`,
        error: isTimeout ? 'FILL_TIMEOUT' : 'FILL_FAILED',
      };
    } finally {
      if (signal && abortListener) {
        try { signal.removeEventListener('abort', abortListener); } catch {}
      }
      if (closingPromise) {
        await closingPromise;
      }
    }
  },
};

// ─── browser_wait_for ────────────────────────────────────────────────────────

export const browserWaitForTool = {
  id: 'browser_wait_for',
  name: 'Browser wait for',
  description:
    'Wait for an element matching the selector to appear on the page.  Useful after ' +
    'browser_click triggers an async load (e.g. clicking "Load more" → wait for new ' +
    'comments to render).  Pure observation — no state change.  Returns ok:true when ' +
    'the element appears; ok:false WAIT_TIMEOUT when the timeout fires.',
  category: 'web',
  isConcurrencySafe: false,
  // Read-only observation — no state change, no permission needed (matches
  // browser_snapshot's requiresPermission:false).
  requiresPermission: false,
  parametersSchema: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'Handle returned by browser_open.',
      },
      selector: {
        type: 'string',
        description: 'CSS selector to wait for.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Max time to wait.  Default 10000.',
      },
    },
    required: ['pageId', 'selector'],
  },
  examples: [
    { pageId: 'pg-1a2b3c4d', selector: '.comment-thread', timeoutMs: 5000 },
  ],
  async run({ pageId, selector, timeoutMs }, { signal, _pageRegistry } = {}) {
    const registry = _pageRegistry || DEFAULT_REGISTRY;
    if (typeof selector !== 'string' || !selector.trim()) {
      return { ok: false, output: 'browser_wait_for: selector required', error: 'BAD_INPUT' };
    }
    let page;
    try {
      page = registry.getPage(pageId);
    } catch (err) {
      return {
        ok: false,
        output: `browser_wait_for: ${err?.message || err}`,
        error: 'UNKNOWN_PAGE',
      };
    }
    const tMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Number(timeoutMs)
      : DEFAULT_INTERACT_TIMEOUT_MS;
    try {
      await awaitWithAbort(
        page.waitForSelector(selector, { timeout: tMs }),
        signal,
      );
      const currentUrl = typeof page.url === 'function' ? page.url() : '';
      return {
        ok: true,
        output: `Selector ${selector} appeared on ${pageId}`,
        meta: { pageId, selector, currentUrl, found: true },
      };
    } catch (err) {
      const msg = String(err?.message || err || 'unknown error');
      if (err?.name === 'AbortError' || signal?.aborted) {
        return {
          ok: false,
          output: `browser_wait_for aborted for ${pageId}`,
          error: 'ABORTED',
        };
      }
      const isTimeout = /Timeout|timeout/i.test(msg) || /exceeded/i.test(msg);
      // Timeout in wait_for is the expected "not found" signal — not a
      // debug-worthy event.  Other failures go to debug.
      if (!isTimeout) {
        debugWarn('browser_wait_for', `failed for ${pageId} ${selector}: ${msg}`);
      }
      return {
        ok: false,
        output: isTimeout
          ? `browser_wait_for timed out for ${pageId} (${selector} did not appear within ${tMs}ms)`
          : `browser_wait_for failed for ${pageId} (${selector}): ${msg}`,
        error: isTimeout ? 'WAIT_TIMEOUT' : 'WAIT_FAILED',
      };
    }
  },
};

// ─── browser_close ───────────────────────────────────────────────────────────

export const browserCloseTool = {
  id: 'browser_close',
  name: 'Browser close',
  description:
    'Release a browser page handle obtained from browser_open.  Idempotent: calling on an ' +
    'already-closed or unknown pageId is a no-op (returns ok:true with `closed:false`).  ' +
    'Best practice: close pages when the agent is done so the registry doesn\'t accumulate ' +
    'stale handles.',
  category: 'web',
  isConcurrencySafe: false,
  requiresPermission: false,
  parametersSchema: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'Handle returned by browser_open.',
      },
    },
    required: ['pageId'],
  },
  examples: [
    { pageId: 'pg-1a2b3c4d' },
  ],
  async run({ pageId }, { _pageRegistry } = {}) {
    const registry = _pageRegistry || DEFAULT_REGISTRY;
    try {
      const closed = await registry.closePage(pageId);
      return {
        ok: true,
        output: closed
          ? `Closed page ${pageId}`
          : `No-op: pageId ${pageId} not in registry (already closed or never opened)`,
        meta: { pageId, closed },
      };
    } catch (err) {
      // closePage swallows individual errors internally; this catch is
      // defensive against future signature changes.
      const msg = String(err?.message || err || 'unknown error');
      debugWarn('browser_close', `failed for ${pageId}: ${msg}`);
      return {
        ok: false,
        output: `browser_close failed for ${pageId}: ${msg}`,
        error: 'CLOSE_FAILED',
      };
    }
  },
};
