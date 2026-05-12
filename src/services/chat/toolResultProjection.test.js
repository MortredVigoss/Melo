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
import { projectToolResultForPersist } from './toolResultProjection.js';

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
