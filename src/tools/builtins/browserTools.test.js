/**
 * Stage 3b: browser_open / browser_snapshot / browser_close tool tests.
 *
 * All three tools accept a `_pageRegistry` override via run() opts.
 * Tests inject a fake registry so we don't need a real Chrome.  The
 * actual page registry contract is tested in pageRegistry.test.js;
 * these tests only verify TOOL-LEVEL behavior:
 *   • Shape: ok / output / meta / error fields
 *   • Error mapping: registry errors → tool errors
 *   • Idempotent close
 *   • Schema sanity (id, requiresPermission, isConcurrencySafe)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserOpenTool,
  browserSnapshotTool,
  browserCloseTool,
  browserClickTool,
  browserFillTool,
  browserWaitForTool,
} from './browserTools.js';

function fakeRegistry({ openResult, openThrows, getResult, getThrows, closeResult } = {}) {
  return {
    openPage: async () => {
      if (openThrows) throw openThrows;
      return openResult || { pageId: 'pg-fake1234', currentUrl: 'https://example.com/x' };
    },
    getPage: () => {
      if (getThrows) throw getThrows;
      return getResult || {
        evaluate: async (fn) => {
          // crude: emulate document.body.innerText vs document.title by
          // returning the toString of the function — tests don't depend
          // on real DOM, just on which branch was called.
          const src = String(fn);
          if (src.includes('document?.title') || src.includes('document.title')) {
            return 'Fake Page Title';
          }
          return 'Fake page body text content. '.repeat(20); // ~600 chars
        },
        url: () => 'https://example.com/snapshot-test',
        // Stage 3c interactive ops — fakes are happy-path by default;
        // override per-test via getResult to inject throws / timeouts.
        click: async () => {},
        fill: async () => {},
        waitForSelector: async () => {},
      };
    },
    closePage: async () => closeResult ?? true,
    peekPageInfo: () => null,
  };
}

// ─── Schema sanity ──────────────────────────────────────────────────────────

test('Stage 3b (read-only-ish) tools have requiresPermission:false; isConcurrencySafe:false', () => {
  for (const tool of [browserOpenTool, browserSnapshotTool, browserCloseTool]) {
    assert.ok(tool.id, `tool ${tool.name} must have an id`);
    assert.equal(tool.isConcurrencySafe, false,
      `${tool.id} must be marked isConcurrencySafe:false (single-page resource)`);
    assert.equal(tool.requiresPermission, false,
      `${tool.id} Stage 3b is read-only-ish — Stage 3c state-changers carry requiresPermission:true`);
    assert.equal(typeof tool.run, 'function');
    assert.ok(tool.parametersSchema);
  }
  assert.equal(browserOpenTool.id, 'browser_open');
  assert.equal(browserSnapshotTool.id, 'browser_snapshot');
  assert.equal(browserCloseTool.id, 'browser_close');
});

test('Stage 3c state-changing tools (click + fill) require permission; wait_for does not', () => {
  // CLAUDE.md "Explicit permission" rules: clicking irreversible action
  // buttons + sending messages both require user approval per-call.
  // wait_for is pure observation — same permission profile as
  // browser_snapshot (false).
  assert.equal(browserClickTool.requiresPermission, true,
    'click can submit forms / follow links → user must approve');
  assert.equal(browserFillTool.requiresPermission, true,
    'fill modifies input state, triggers framework re-renders → user must approve');
  assert.equal(browserWaitForTool.requiresPermission, false,
    'wait_for is pure observation; no permission needed');
  // All 3 single-page-resource → not concurrency safe.
  for (const tool of [browserClickTool, browserFillTool, browserWaitForTool]) {
    assert.equal(tool.isConcurrencySafe, false, `${tool.id} must be isConcurrencySafe:false`);
  }
  assert.equal(browserClickTool.id, 'browser_click');
  assert.equal(browserFillTool.id, 'browser_fill');
  assert.equal(browserWaitForTool.id, 'browser_wait_for');
});

// ─── browser_open ───────────────────────────────────────────────────────────

test('browser_open: success returns {ok:true, meta:{pageId, currentUrl}}', async () => {
  const result = await browserOpenTool.run(
    { url: 'https://example.com/foo' },
    { _pageRegistry: fakeRegistry({ openResult: { pageId: 'pg-abcd1234', currentUrl: 'https://example.com/foo' } }) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.meta.pageId, 'pg-abcd1234');
  assert.equal(result.meta.currentUrl, 'https://example.com/foo');
  assert.match(result.output, /pg-abcd1234/);
});

test('browser_open: env-disabled error → ok:false error:"CDP_DISABLED"', async () => {
  const result = await browserOpenTool.run(
    { url: 'https://example.com/x' },
    {
      _pageRegistry: fakeRegistry({
        openThrows: new Error('Browser tools require MELO_CDP_ENABLED=1 (user-set env flag)'),
      }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'CDP_DISABLED');
  assert.match(result.output, /MELO_CDP_ENABLED/);
});

test('browser_open: generic open failure → ok:false error:"OPEN_FAILED"', async () => {
  const result = await browserOpenTool.run(
    { url: 'https://example.com/timeout' },
    {
      _pageRegistry: fakeRegistry({
        openThrows: new Error('net::ERR_TIMED_OUT'),
      }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'OPEN_FAILED');
  assert.match(result.output, /TIMED_OUT/);
});

// ─── browser_snapshot ───────────────────────────────────────────────────────

test('browser_snapshot: returns text + url + title; truncates over the cap', async () => {
  const result = await browserSnapshotTool.run(
    { pageId: 'pg-fake1234' },
    { _pageRegistry: fakeRegistry() },
  );
  assert.equal(result.ok, true);
  assert.equal(result.meta.pageId, 'pg-fake1234');
  assert.equal(result.meta.currentUrl, 'https://example.com/snapshot-test');
  assert.equal(result.meta.title, 'Fake Page Title');
  assert.ok(result.meta.textLength > 0);
  assert.ok(result.output.length <= 50_000, 'output must be truncated under the cap');
});

test('browser_snapshot: unknown pageId → ok:false error:"UNKNOWN_PAGE"', async () => {
  const result = await browserSnapshotTool.run(
    { pageId: 'pg-deadbeef' },
    {
      _pageRegistry: fakeRegistry({
        getThrows: new Error('Unknown pageId: pg-deadbeef (closed, expired, or never opened)'),
      }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'UNKNOWN_PAGE');
  assert.match(result.output, /Unknown pageId/);
});

test('browser_snapshot: page.evaluate throws → ok:false error:"SNAPSHOT_FAILED"', async () => {
  const result = await browserSnapshotTool.run(
    { pageId: 'pg-evalfail' },
    {
      _pageRegistry: fakeRegistry({
        getResult: {
          evaluate: async () => { throw new Error('execution context destroyed'); },
          url: () => 'https://example.com/x',
        },
      }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'SNAPSHOT_FAILED');
  assert.match(result.output, /execution context/);
});

test('browser_snapshot: empty body returns ok with placeholder output', async () => {
  const result = await browserSnapshotTool.run(
    { pageId: 'pg-empty' },
    {
      _pageRegistry: fakeRegistry({
        getResult: {
          evaluate: async () => '',
          url: () => 'https://example.com/empty',
        },
      }),
    },
  );
  assert.equal(result.ok, true);
  assert.match(result.output, /\(empty page body/);
  assert.equal(result.meta.textLength, 0);
});

// ─── browser_close ──────────────────────────────────────────────────────────

test('browser_close: closes an open page → ok:true meta.closed:true', async () => {
  const result = await browserCloseTool.run(
    { pageId: 'pg-was-open' },
    { _pageRegistry: fakeRegistry({ closeResult: true }) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.meta.closed, true);
  assert.match(result.output, /Closed page pg-was-open/);
});

test('browser_close: unknown pageId → ok:true meta.closed:false (idempotent)', async () => {
  const result = await browserCloseTool.run(
    { pageId: 'pg-never-opened' },
    { _pageRegistry: fakeRegistry({ closeResult: false }) },
  );
  assert.equal(result.ok, true,
    'closing an unknown id is a no-op success per pageRegistry contract');
  assert.equal(result.meta.closed, false);
  assert.match(result.output, /No-op/);
});

test('browser_snapshot: signal aborted during evaluate → ok:false error:"ABORTED" (Codex round-2 闭环)', async () => {
  // Round-2 caught: page.evaluate() doesn't listen to AbortSignal, so a
  // Stop during evaluate let the tool wait for natural CDP completion.
  // The fix wraps evaluate in awaitWithAbort so the tool returns
  // immediately on signal flip.  Page handle is NOT closed (persistent
  // handle semantic; caller can browser_close explicitly).
  const ac = new AbortController();
  // Fake page whose evaluate hangs forever — only signal abort lets the
  // test return.
  const fakeRegistry = {
    openPage: async () => ({}),
    getPage: () => ({
      evaluate: () => new Promise(() => { /* never resolves */ }),
      url: () => 'https://example.com/hangs',
    }),
    closePage: async () => true,
    peekPageInfo: () => null,
  };
  // Trip abort 10ms after the snapshot starts.
  setTimeout(() => ac.abort(), 10);
  const result = await browserSnapshotTool.run(
    { pageId: 'pg-hangs1234' },
    { signal: ac.signal, _pageRegistry: fakeRegistry },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ABORTED',
    'snapshot must return ABORTED when signal flips mid-evaluate');
  assert.match(result.output, /aborted/i);
});

// ─── Stage 3c: browser_click ────────────────────────────────────────────────

test('browser_click: success returns {ok:true, meta:{clicked:true, currentUrl}}', async () => {
  let clickedSelector = null;
  const result = await browserClickTool.run(
    { pageId: 'pg-c1', selector: 'button.submit' },
    { _pageRegistry: fakeRegistry({
      getResult: {
        click: async (sel) => { clickedSelector = sel; },
        url: () => 'https://example.com/after-click',
      },
    }) },
  );
  assert.equal(result.ok, true);
  assert.equal(clickedSelector, 'button.submit');
  assert.equal(result.meta.clicked, true);
  assert.equal(result.meta.currentUrl, 'https://example.com/after-click');
});

test('browser_click: missing/empty selector → BAD_INPUT (does not touch page)', async () => {
  let pageCalled = false;
  for (const selector of ['', '   ', null, undefined]) {
    const result = await browserClickTool.run(
      { pageId: 'pg-c2', selector },
      { _pageRegistry: { ...fakeRegistry(), getPage: () => { pageCalled = true; return {}; } } },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'BAD_INPUT');
  }
  assert.equal(pageCalled, false, 'getPage must not be called when selector is invalid');
});

test('browser_click: unknown pageId → UNKNOWN_PAGE', async () => {
  const result = await browserClickTool.run(
    { pageId: 'pg-dead', selector: 'button' },
    { _pageRegistry: fakeRegistry({
      getThrows: new Error('Unknown pageId: pg-dead (closed, expired, or never opened)'),
    }) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'UNKNOWN_PAGE');
});

test('browser_click: playwright timeout → CLICK_TIMEOUT (distinct from generic CLICK_FAILED)', async () => {
  const result = await browserClickTool.run(
    { pageId: 'pg-c3', selector: 'button.does-not-exist' },
    { _pageRegistry: fakeRegistry({
      getResult: {
        click: async () => { throw new Error('Timeout 10000ms exceeded.'); },
        url: () => 'https://example.com/x',
      },
    }) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'CLICK_TIMEOUT', 'timeout maps to CLICK_TIMEOUT so model can decide to wait_for first');
});

test('browser_click: generic click failure → CLICK_FAILED', async () => {
  const result = await browserClickTool.run(
    { pageId: 'pg-c4', selector: '.ok' },
    { _pageRegistry: fakeRegistry({
      getResult: {
        click: async () => { throw new Error('Element is not visible'); },
        url: () => 'https://example.com/x',
      },
    }) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'CLICK_FAILED');
});

test('browser_click: pre-aborted signal → ABORTED without ever calling page.click (state-change defense)', async () => {
  // Codex Stage 3c round-2 闭环: Stop fired BEFORE the tool runs must not
  // produce a side effect.  This is the cheap layer — the wrapper's
  // pre-flight check.  page.click() must never be reached.
  const ac = new AbortController();
  ac.abort();
  let clickCalls = 0;
  let closeCalls = 0;
  const fake = {
    openPage: async () => ({}),
    getPage: () => ({
      click: async () => { clickCalls++; },
      url: () => 'https://example.com/x',
    }),
    closePage: async () => { closeCalls++; return true; },
    peekPageInfo: () => null,
  };
  const result = await browserClickTool.run(
    { pageId: 'pg-pre', selector: 'button' },
    { signal: ac.signal, _pageRegistry: fake },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ABORTED');
  assert.match(result.output, /before start/);
  assert.equal(clickCalls, 0,
    'pre-aborted signal must short-circuit BEFORE page.click is touched (no side effect)');
  // closePage should NOT fire on pre-abort path (no page acquired yet).
  assert.equal(closeCalls, 0, 'pre-abort short-circuit must not close anything');
});

test('browser_click: in-flight abort → closePage fires + meta.pageInvalidated:true (state-change defense)', async () => {
  // Codex Stage 3c round-2 闭环: when abort fires DURING page.click, the
  // tool must close the page handle so the underlying playwright op
  // actually stops producing side effects.  The persistent handle is
  // gone — that's the documented price of reliable Stop on state changes.
  // Mock click resolves AFTER abort would have fired, so without the
  // abort listener we'd return ABORTED but the click would still complete
  // later.  Test asserts closePage fires synchronously on abort and meta
  // signals pageInvalidated:true so the agent knows to re-open.
  const ac = new AbortController();
  let closeCalls = 0;
  let closedPageId = null;
  const fake = {
    openPage: async () => ({}),
    getPage: () => ({
      // Long-running click — mirrors a real playwright op that doesn't
      // listen to AbortSignal.  We want the abort listener to fire
      // closePage *while this is still pending*.
      click: () => new Promise(resolve => setTimeout(resolve, 200)),
      url: () => 'https://example.com/x',
    }),
    closePage: async (id) => { closeCalls++; closedPageId = id; return true; },
    peekPageInfo: () => null,
  };
  setTimeout(() => ac.abort(), 10);
  const result = await browserClickTool.run(
    { pageId: 'pg-inflight', selector: 'button' },
    { signal: ac.signal, _pageRegistry: fake },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ABORTED');
  assert.equal(closeCalls, 1,
    'in-flight abort MUST call closePage to actually stop the underlying click');
  assert.equal(closedPageId, 'pg-inflight',
    'closePage must be called with the correct pageId');
  assert.equal(result.meta?.pageInvalidated, true,
    'meta.pageInvalidated:true tells the agent the handle is gone — re-open needed');
});

// ─── Stage 3c: browser_fill ─────────────────────────────────────────────────

test('browser_fill: success returns {ok:true, meta:{filled:true, valueLength}}', async () => {
  let filledArgs = null;
  const result = await browserFillTool.run(
    { pageId: 'pg-f1', selector: 'input[name="email"]', value: 'me@example.com' },
    { _pageRegistry: fakeRegistry({
      getResult: {
        fill: async (sel, val) => { filledArgs = { sel, val }; },
        url: () => 'https://example.com/form',
      },
    }) },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(filledArgs, { sel: 'input[name="email"]', val: 'me@example.com' });
  assert.equal(result.meta.filled, true);
  assert.equal(result.meta.valueLength, 'me@example.com'.length);
});

test('browser_fill: empty string clears the field (still ok)', async () => {
  const result = await browserFillTool.run(
    { pageId: 'pg-f2', selector: 'input', value: '' },
    { _pageRegistry: fakeRegistry() },
  );
  assert.equal(result.ok, true);
  assert.equal(result.meta.valueLength, 0);
});

test('browser_fill: non-string value → BAD_INPUT', async () => {
  const result = await browserFillTool.run(
    { pageId: 'pg-f3', selector: 'input', value: 42 },
    { _pageRegistry: fakeRegistry() },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'BAD_INPUT');
});

test('browser_fill: playwright timeout → FILL_TIMEOUT', async () => {
  const result = await browserFillTool.run(
    { pageId: 'pg-f4', selector: 'input.late', value: 'x' },
    { _pageRegistry: fakeRegistry({
      getResult: {
        fill: async () => { throw new Error('Timeout 10000ms exceeded.'); },
        url: () => 'https://example.com/x',
      },
    }) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'FILL_TIMEOUT');
});

test('browser_fill: pre-aborted signal → ABORTED without ever calling page.fill (state-change defense)', async () => {
  // Same contract as click — pre-aborted Stop must short-circuit before
  // page.fill is ever called, so no characters get typed into the field.
  const ac = new AbortController();
  ac.abort();
  let fillCalls = 0;
  let closeCalls = 0;
  const fake = {
    openPage: async () => ({}),
    getPage: () => ({
      fill: async () => { fillCalls++; },
      url: () => 'https://example.com/x',
    }),
    closePage: async () => { closeCalls++; return true; },
    peekPageInfo: () => null,
  };
  const result = await browserFillTool.run(
    { pageId: 'pg-pre-f', selector: 'input', value: 'should never type' },
    { signal: ac.signal, _pageRegistry: fake },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ABORTED');
  assert.match(result.output, /before start/);
  assert.equal(fillCalls, 0,
    'pre-aborted signal must short-circuit BEFORE page.fill is touched');
  assert.equal(closeCalls, 0);
});

test('browser_fill: in-flight abort → closePage fires + meta.pageInvalidated:true', async () => {
  // Same contract as click — in-flight abort closes the page handle to
  // stop the underlying playwright fill from continuing to write the
  // value / trigger autosave / fire validation handlers.
  const ac = new AbortController();
  let closeCalls = 0;
  let closedPageId = null;
  const fake = {
    openPage: async () => ({}),
    getPage: () => ({
      fill: () => new Promise(resolve => setTimeout(resolve, 200)),
      url: () => 'https://example.com/x',
    }),
    closePage: async (id) => { closeCalls++; closedPageId = id; return true; },
    peekPageInfo: () => null,
  };
  setTimeout(() => ac.abort(), 10);
  const result = await browserFillTool.run(
    { pageId: 'pg-inflight-f', selector: 'input', value: 'typing' },
    { signal: ac.signal, _pageRegistry: fake },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ABORTED');
  assert.equal(closeCalls, 1, 'in-flight abort MUST call closePage to actually stop the fill');
  assert.equal(closedPageId, 'pg-inflight-f');
  assert.equal(result.meta?.pageInvalidated, true);
});

// ─── Stage 3c: browser_wait_for ─────────────────────────────────────────────

test('browser_wait_for: selector found → ok:true {found:true, currentUrl}', async () => {
  let waitedSelector = null;
  const result = await browserWaitForTool.run(
    { pageId: 'pg-w1', selector: '.expanded' },
    { _pageRegistry: fakeRegistry({
      getResult: {
        waitForSelector: async (sel) => { waitedSelector = sel; return {}; },
        url: () => 'https://example.com/loaded',
      },
    }) },
  );
  assert.equal(result.ok, true);
  assert.equal(waitedSelector, '.expanded');
  assert.equal(result.meta.found, true);
  assert.equal(result.meta.currentUrl, 'https://example.com/loaded');
});

test('browser_wait_for: timeout → WAIT_TIMEOUT (expected "not found" signal, not noise)', async () => {
  const result = await browserWaitForTool.run(
    { pageId: 'pg-w2', selector: '.never-appears', timeoutMs: 200 },
    { _pageRegistry: fakeRegistry({
      getResult: {
        waitForSelector: async () => { throw new Error('Timeout 200ms exceeded.'); },
        url: () => 'https://example.com/x',
      },
    }) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'WAIT_TIMEOUT');
  assert.match(result.output, /did not appear/);
});

test('browser_wait_for: non-timeout failure → WAIT_FAILED', async () => {
  const result = await browserWaitForTool.run(
    { pageId: 'pg-w3', selector: 'bad selector!' },
    { _pageRegistry: fakeRegistry({
      getResult: {
        waitForSelector: async () => { throw new Error('Invalid selector: "bad selector!"'); },
        url: () => 'https://example.com/x',
      },
    }) },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'WAIT_FAILED');
});

test('browser_wait_for: signal abort → ABORTED', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10);
  const result = await browserWaitForTool.run(
    { pageId: 'pg-w4', selector: '.hangs' },
    {
      signal: ac.signal,
      _pageRegistry: fakeRegistry({
        getResult: {
          waitForSelector: () => new Promise(() => {}), // hangs forever
          url: () => 'https://example.com/x',
        },
      }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ABORTED');
});

test('browser_close: defensive — closePage throwing maps to error', async () => {
  // closePage is documented as best-effort but the tool must not let
  // a freak throw propagate unchecked.
  const errs = [];
  const result = await browserCloseTool.run(
    { pageId: 'pg-throw' },
    {
      _pageRegistry: {
        openPage: async () => ({}),
        getPage: () => ({}),
        closePage: async () => { throw new Error('weird failure'); },
        peekPageInfo: () => null,
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'CLOSE_FAILED');
  assert.match(result.output, /weird failure/);
});
