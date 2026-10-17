/**
 * G-1d slice 1 (2026-05-11): executor.js must preserve `evidenceTrail`
 * through tool-result normalization.
 *
 * Pre-fix: lines 95-105 normalized the rawResult to `{ ok, output, error,
 * meta }` and silently dropped any other field, including `evidenceTrail`
 * — the 3 search tools' fallback diagnostic structure from G-1a/b/c.
 * That meant the trail was produced inside the tool but unreachable to
 * `chatExecutionRunner` / `subAgent` / `skillExecutor` (`executeToolCalls`
 * consumers).  This file pins the preservation behavior so a future
 * "normalize result shape" refactor can't quietly bring back the drop.
 *
 * Real-behavior assertions (lessons-learned #2 — actual return-shape
 * inspection, not source grep):
 *   - tool returning evidenceTrail → executor preserves it on result
 *   - empty trail array → not attached (no `evidenceTrail: []` noise)
 *   - non-array trail → not attached (defensive ignore)
 *   - tool without trail → result shape unchanged (no `evidenceTrail` key)
 *   - error-path result (tool throws) → no evidenceTrail (we don't fabricate)
 *   - aborted-pre-execution result → no evidenceTrail
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {executeTool} from '../testSupport/directAgentFixture.js';

// Minimal tool shape — `requiresPermission: false` skips the permission
// gate so the test stays pure.  `isConcurrencySafe: true` is irrelevant
// for a single executeTool call but documents intent.
function makeTool(id, runFn) {
  return {
    id,
    requiresPermission: false,
    isConcurrencySafe: true,
    run: runFn,
  };
}

test('executeTool preserves evidenceTrail when tool produces one', async () => {
  const trail = [
    { tier: 'jina', outcome: 'fail', latencyMs: 600, reason: 'timeout' },
    { tier: 'direct', outcome: 'ok', latencyMs: 220 },
  ];
  const tool = makeTool('fake.fetch', async () => ({
    ok: true,
    output: 'body',
    meta: { url: 'https://example.test' },
    evidenceTrail: trail,
  }));

  const result = await executeTool(tool, { url: 'https://example.test' });
  assert.equal(result.ok, true);
  assert.equal(result.output, 'body');
  assert.deepEqual(result.evidenceTrail, trail,
    'evidenceTrail must survive normalization unchanged');
});

test('executeTool: empty evidenceTrail array is NOT attached (no [] noise)', async () => {
  const tool = makeTool('fake.empty-trail', async () => ({
    ok: true,
    output: 'body',
    meta: {},
    evidenceTrail: [],
  }));
  const result = await executeTool(tool, {});
  assert.ok(!('evidenceTrail' in result),
    'empty trail must not appear as `evidenceTrail: []` on result');
});

test('executeTool: non-array evidenceTrail is defensively ignored', async () => {
  const tool = makeTool('fake.bad-trail', async () => ({
    ok: true,
    output: 'body',
    meta: {},
    evidenceTrail: 'not-an-array',
  }));
  const result = await executeTool(tool, {});
  assert.ok(!('evidenceTrail' in result),
    'non-array trail must be dropped (executor must not propagate broken shape)');
});

test('executeTool: tool without evidenceTrail → result shape unchanged', async () => {
  const tool = makeTool('fake.no-trail', async () => ({
    ok: true,
    output: 'body',
    meta: { x: 1 },
  }));
  const result = await executeTool(tool, {});
  assert.ok(!('evidenceTrail' in result),
    'absent trail must remain absent — no spurious key');
  assert.equal(result.ok, true);
  assert.equal(result.output, 'body');
  assert.deepEqual(result.meta, { x: 1 });
});

test('executeTool: thrown error returns result without evidenceTrail (no fabrication)', async () => {
  const tool = makeTool('fake.throw', async () => {
    throw new Error('boom');
  });
  const result = await executeTool(tool, {});
  assert.equal(result.ok, false);
  // Envelope (B1): free-text errors map to a canonical code; the text survives in meta.detail.
  assert.equal(result.error, 'UNKNOWN');
  assert.equal(result.code, 'UNKNOWN');
  assert.equal(result.meta.detail, 'boom');
  assert.ok(!('evidenceTrail' in result),
    'error path must not fabricate an evidenceTrail');
});

test('executeTool: pre-execution abort returns ABORTED without evidenceTrail', async () => {
  const tool = makeTool('fake.abort-prev', async () => ({
    ok: true,
    output: 'should not run',
    evidenceTrail: [{ tier: 'should-not-appear', outcome: 'ok' }],
  }));
  const ac = new AbortController();
  ac.abort();
  const result = await executeTool(tool, {}, { signal: ac.signal });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ABORTED');
  assert.ok(!('evidenceTrail' in result),
    'pre-execution abort must not carry a trail (the tool never ran)');
});

test('executeTool: rawResult is a string (primitive) → no evidenceTrail attached', async () => {
  const tool = makeTool('fake.primitive', async () => 'just a string');
  const result = await executeTool(tool, {});
  assert.equal(result.ok, true);
  assert.equal(result.output, 'just a string');
  assert.ok(!('evidenceTrail' in result));
});
