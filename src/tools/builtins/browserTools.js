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
  async run({ pageId }, { _pageRegistry } = {}) {
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
      const text = await page.evaluate(() => document?.body?.innerText || '');
      const title = await page.evaluate(() => document?.title || '');
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
      debugWarn('browser_snapshot', `failed for ${pageId}: ${msg}`);
      return {
        ok: false,
        output: `browser_snapshot failed for ${pageId}: ${msg}`,
        error: 'SNAPSHOT_FAILED',
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
