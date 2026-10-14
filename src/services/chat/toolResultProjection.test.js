/**
 * src/services/chat/toolResultProjection.test.js
 *
 * Producer-side coverage for G-1d slice 2.  Codex review of commit 1
 * (B + ⚪) noted that the persist-chain testing was hydration-only —
 * the projection from executor `{ call, result }` to the shape that
 * lands on `assistantMessage.toolResults` had no direct test.
 * This file closes that gap so a future refactor of the projection
 * (e.g. adding/removing fields) trips the gate immediately.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { projectToolResultForPersist, deriveUnifiedErrorCode } from './toolResultProjection.js';

// ─── happy path ────────────────────────────────────────────────────────────

test('projects full call + result → { toolCallId, toolName, ok, evidenceTrail }', () => {
  const trail = [
    { tier: 'jina', outcome: 'fail', latencyMs: 3500, reason: 'timeout' },
    { tier: 'direct', outcome: 'ok', latencyMs: 220 },
  ];
  const projected = projectToolResultForPersist(
    { id: 'call_abc', name: 'fetch_url' },
    { ok: true, output: '...', evidenceTrail: trail, meta: {} },
  );
  assert.equal(projected.toolCallId, 'call_abc');
  assert.equal(projected.toolName, 'fetch_url');
  assert.equal(projected.ok, true);
  assert.deepEqual(projected.evidenceTrail, trail);
});

// ─── evidenceTrail inclusion gating ─────────────────────────────────────────

test('absent evidenceTrail → no evidenceTrail key on output (sparse field)', () => {
  const p = projectToolResultForPersist(
    { id: 'a', name: 'bash' },
    { ok: true, output: 'pwd: /tmp' },
  );
  assert.ok(!('evidenceTrail' in p),
    'tools without a trail must NOT get an empty/missing key — sparse by design');
});

test('empty evidenceTrail array → field omitted (no empty array noise)', () => {
  const p = projectToolResultForPersist(
    { id: 'a', name: 'fetch_url' },
    { ok: true, evidenceTrail: [] },
  );
  assert.ok(!('evidenceTrail' in p),
    'empty trail array must produce no evidenceTrail key (matches conditional-spread elsewhere)');
});

test('non-array evidenceTrail → field omitted (defensive)', () => {
  const p = projectToolResultForPersist(
    { id: 'a', name: 'fetch_url' },
    { ok: true, evidenceTrail: 'not an array' },
  );
  assert.ok(!('evidenceTrail' in p));
});

test('single-item evidenceTrail → kept (no length minimum at projection level)', () => {
  // Display gating (≥2 OR ok=false) happens at the renderer (UI side).
  // Projection stores everything truthy; the gate is rendering-time policy.
  const p = projectToolResultForPersist(
    { id: 'a', name: 'fetch_url' },
    { ok: true, evidenceTrail: [{ tier: 'jina', outcome: 'ok' }] },
  );
  assert.deepEqual(p.evidenceTrail, [{ tier: 'jina', outcome: 'ok' }]);
});

// ─── ok mapping ─────────────────────────────────────────────────────────────

test('ok=false → ok: false', () => {
  const p = projectToolResultForPersist({ id: 'a', name: 't' }, { ok: false });
  assert.equal(p.ok, false);
});

test('ok=true → ok: true', () => {
  const p = projectToolResultForPersist({ id: 'a', name: 't' }, { ok: true });
  assert.equal(p.ok, true);
});

test('ok omitted → ok: true (default — conservative "not explicitly failed")', () => {
  const p = projectToolResultForPersist({ id: 'a', name: 't' }, {});
  assert.equal(p.ok, true);
});

test('ok = null → ok: true (null !== false, so default applies)', () => {
  const p = projectToolResultForPersist({ id: 'a', name: 't' }, { ok: null });
  assert.equal(p.ok, true);
});

// ─── malformed call / result ────────────────────────────────────────────────

test('missing call.id → toolCallId = "" (no undefined leak)', () => {
  const p = projectToolResultForPersist({ name: 'bash' }, { ok: true });
  assert.equal(p.toolCallId, '');
});

test('missing call.name → toolName = "" (no undefined leak)', () => {
  const p = projectToolResultForPersist({ id: 'a' }, { ok: true });
  assert.equal(p.toolName, '');
});

test('non-string id/name → coerced to "" (defensive)', () => {
  const p = projectToolResultForPersist(
    { id: 42, name: { weird: 'object' } },
    { ok: true },
  );
  assert.equal(p.toolCallId, '');
  assert.equal(p.toolName, '');
});

test('null call → empty strings + ok defaults to true', () => {
  const p = projectToolResultForPersist(null, { ok: true });
  assert.equal(p.toolCallId, '');
  assert.equal(p.toolName, '');
  assert.equal(p.ok, true);
});

test('null result → ok: true (default), no trail', () => {
  const p = projectToolResultForPersist({ id: 'a', name: 't' }, null);
  assert.equal(p.ok, true);
  assert.ok(!('evidenceTrail' in p));
});

// ─── 架构 audit #2 闭环: unified errorCode enrichment (SearchTask adapter) ──
//
// These assert the REAL invariant (not just "field exists"): a failed
// search tool with a specific trail reason must derive the precise unified
// code via the adapter — i.e. the adapter is actually wired and reading the
// trail, resolving the "701 lines, 0 callers" finding.

test('web_search fail with serp.fail(no-results) trail → errorCode NO_RESULTS (adapter reads trail, not conflated SEARCH_FAILED)', () => {
  const result = {
    ok: false,
    error: 'SEARCH_FAILED', // the conflated legacy code the model used to see
    output: 'no results',
    evidenceTrail: [
      { tier: 'cache', outcome: 'fail', latencyMs: 5, reason: 'no-hit' },
      { tier: 'serp', outcome: 'fail', latencyMs: 4000, reason: 'no-results' },
    ],
    meta: { query: 'asdfqwerzxcv' },
  };
  const p = projectToolResultForPersist({ id: 'c1', name: 'web_search' }, result);
  assert.equal(p.errorCode, 'NO_RESULTS',
    'adapter must disambiguate SEARCH_FAILED → NO_RESULTS from the serp.fail(no-results) trail');
  // The legacy `error` on the raw result is untouched (no model-prose change).
  assert.equal(result.error, 'SEARCH_FAILED');
});

test('web_search fail with content-fetch network failure → errorCode NETWORK (distinct from no-results)', () => {
  const result = {
    ok: false,
    error: 'SEARCH_FAILED',
    evidenceTrail: [
      { tier: 'serp', outcome: 'fail', latencyMs: 3000, reason: 'network' },
    ],
    meta: {},
  };
  const p = projectToolResultForPersist({ id: 'c2', name: 'web_search' }, result);
  assert.equal(p.errorCode, 'NETWORK',
    'same legacy SEARCH_FAILED must derive NETWORK when the trail reason is network');
});

test('fetch_url fail (url-fetch source) derives a unified errorCode', () => {
  const result = {
    ok: false,
    error: 'FETCH_FAILED',
    evidenceTrail: [
      { tier: 'jina', outcome: 'fail', latencyMs: 5000, reason: 'timeout' },
      { tier: 'direct', outcome: 'fail', latencyMs: 3000, reason: 'network' },
    ],
    meta: {},
  };
  const p = projectToolResultForPersist({ id: 'c3', name: 'fetch_url' }, result);
  assert.ok(typeof p.errorCode === 'string' && p.errorCode.length > 0,
    'fetch_url failures must carry a derived unified errorCode');
});

test('successful search tool → NO errorCode (only failures enriched)', () => {
  const p = projectToolResultForPersist(
    { id: 'c4', name: 'web_search' },
    { ok: true, output: 'results', evidenceTrail: [{ tier: 'serp', outcome: 'ok' }] },
  );
  assert.ok(!('errorCode' in p), 'success must not carry an errorCode');
});

test('non-search tool failure retains its machine-readable error code', () => {
  const p = projectToolResultForPersist(
    { id: 'c5', name: 'bash' },
    { ok: false, error: 'EXIT_1', output: 'command failed' },
  );
  assert.equal(p.errorCode, 'EXIT_1');
});

test('deriveUnifiedErrorCode: returns null for success, non-search, and is exception-safe', () => {
  assert.equal(deriveUnifiedErrorCode({ name: 'web_search' }, { ok: true }), null);
  assert.equal(deriveUnifiedErrorCode({ name: 'bash' }, { ok: false }), null);
  // Garbage result must not throw — best-effort enrichment.
  assert.equal(deriveUnifiedErrorCode({ name: 'web_search' }, null), null);
  assert.doesNotThrow(() => deriveUnifiedErrorCode({ name: 'fetch_url' }, { ok: false }));
});

test('browser capability failures and real permission denials persist distinctly', () => {
  assert.equal(projectToolResultForPersist({ name: 'browser_open' }, { ok: false, error: 'CDP_DISABLED' }).errorCode, 'CDP_DISABLED');
  assert.equal(projectToolResultForPersist({ name: 'browser_click' }, { ok: false, error: 'User denied', meta: { denied: true } }).errorCode, 'PERMISSION_DENIED');
  assert.equal(projectToolResultForPersist({ name: 'browser_open' }, { ok: false, error: 'secret or arbitrary upstream message' }).errorCode, 'TOOL_FAILED');
});
