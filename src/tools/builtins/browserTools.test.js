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
      };
    },
    closePage: async () => closeResult ?? true,
    peekPageInfo: () => null,
  };
}

// ─── Schema sanity ──────────────────────────────────────────────────────────

test('all 3 browser tools register the expected identity + safety attributes', () => {
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
