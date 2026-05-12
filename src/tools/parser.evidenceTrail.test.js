/**
 * src/tools/parser.evidenceTrail.test.js
 *
 * G-1e (2026-05-12): trail-into-prompt — `formatToolResult` now surfaces
 * `evidenceTrail` as a `<evidence_trail>` block when it's informative
 * (failure path OR multi-tier fallback).  Locks the surface format +
 * the inclusion heuristic so future "simplify by always emitting" or
 * "drop emission entirely" refactors break the suite.
 *
 * Why end-to-end formatToolResult tests + a couple of _shouldEmitEvidenceTrail
 * unit tests rather than just the decision function: the LLM-facing prompt
 * IS the contract here — escapeXml, ordering, separator character all
 * matter for downstream prompt parsing.  Locking the output string
 * shape catches drift even in helper internals.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatToolResult,
  formatToolResultsMessage,
  _shouldEmitEvidenceTrail,
} from './parser.js';

const CALL = { id: 'c1', name: 'fetch_url', arguments: {} };

// ─── inclusion heuristic ────────────────────────────────────────────────────

test('_shouldEmitEvidenceTrail: empty / missing trail → false', () => {
  assert.equal(_shouldEmitEvidenceTrail({ ok: true }), false);
  assert.equal(_shouldEmitEvidenceTrail({ ok: false, evidenceTrail: [] }), false);
  assert.equal(_shouldEmitEvidenceTrail({ evidenceTrail: null }), false);
  assert.equal(_shouldEmitEvidenceTrail(null), false);
});

test('_shouldEmitEvidenceTrail: ok=true + single-tier trail → false (no informational value)', () => {
  // The "everything worked on the first try" case is noise for the agent.
  assert.equal(
    _shouldEmitEvidenceTrail({
      ok: true,
      evidenceTrail: [{ tier: 'jina', outcome: 'ok', latencyMs: 220 }],
    }),
    false,
  );
});

test('_shouldEmitEvidenceTrail: ok=true + multi-tier trail → true (fallback happened, agent should see)', () => {
  // Even success-after-fallback is informative — agent learns which tiers
  // are flaky for this domain.
  assert.equal(
    _shouldEmitEvidenceTrail({
      ok: true,
      evidenceTrail: [
        { tier: 'jina', outcome: 'fail', latencyMs: 3500, reason: 'timeout' },
        { tier: 'direct', outcome: 'ok', latencyMs: 220 },
      ],
    }),
    true,
  );
});

test('_shouldEmitEvidenceTrail: ok=false → true regardless of length', () => {
  assert.equal(
    _shouldEmitEvidenceTrail({
      ok: false,
      evidenceTrail: [{ tier: 'jina', outcome: 'fail', latencyMs: 3500, reason: 'timeout' }],
    }),
    true,
  );
});

// ─── output format ─────────────────────────────────────────────────────────

test('formatToolResult: no trail → no <evidence_trail> block (backward compat)', () => {
  const out = formatToolResult(CALL, { ok: true, output: 'body' });
  assert.doesNotMatch(out, /<evidence_trail>/);
  assert.match(out, /<output>body<\/output>/);
});

test('formatToolResult: single-tier success → no <evidence_trail> block', () => {
  const out = formatToolResult(CALL, {
    ok: true,
    output: 'body',
    evidenceTrail: [{ tier: 'jina', outcome: 'ok', latencyMs: 220 }],
  });
  assert.doesNotMatch(out, /<evidence_trail>/,
    'single-tier success is uninformative noise — must not pollute the prompt');
});

test('formatToolResult: failure → <evidence_trail> block included', () => {
  const out = formatToolResult(CALL, {
    ok: false,
    output: 'Tier 1 (Jina) failed: timeout',
    error: 'jina timeout',
    evidenceTrail: [{ tier: 'jina', outcome: 'fail', latencyMs: 3500, reason: 'timeout' }],
  });
  assert.match(out, /<evidence_trail>jina: fail \(timeout, 3500ms\)<\/evidence_trail>/);
  // error block also still present
  assert.match(out, /<error>jina timeout<\/error>/);
});

test('formatToolResult: multi-tier with fallback → trail items joined by " → "', () => {
  const out = formatToolResult(CALL, {
    ok: true,
    output: 'body recovered',
    evidenceTrail: [
      { tier: 'jina', outcome: 'fail', latencyMs: 3500, reason: 'timeout' },
      { tier: 'direct', outcome: 'fail', latencyMs: 120, reason: 'http-403' },
      { tier: 'playwright', outcome: 'ok', latencyMs: 2200 },
    ],
  });
  assert.match(
    out,
    /<evidence_trail>jina: fail \(timeout, 3500ms\) → direct: fail \(http-403, 120ms\) → playwright: ok \(2200ms\)<\/evidence_trail>/,
    'multi-tier chain must serialize in order with " → " separator',
  );
});

test('formatToolResult: trail item without reason/latency → bare "tier: outcome" (no empty parens)', () => {
  const out = formatToolResult(CALL, {
    ok: false,
    output: 'cancelled',
    evidenceTrail: [
      { tier: 'jina', outcome: 'aborted' },
      { tier: 'direct', outcome: 'skip' },
    ],
  });
  assert.match(out, /<evidence_trail>jina: aborted → direct: skip<\/evidence_trail>/,
    'no reason + no latency → bare format, must not emit "()" placeholder');
});

test('formatToolResult: trail item with only latency (no reason) → "tier: outcome (Nms)"', () => {
  const out = formatToolResult(CALL, {
    ok: true,
    output: 'x',
    evidenceTrail: [
      { tier: 'jina', outcome: 'fail', latencyMs: 1234 },
      { tier: 'direct', outcome: 'ok', latencyMs: 50 },
    ],
  });
  assert.match(out, /jina: fail \(1234ms\) → direct: ok \(50ms\)/);
});

test('formatToolResult: trail item with only reason (no latency) → "tier: outcome (reason)"', () => {
  const out = formatToolResult(CALL, {
    ok: false,
    output: 'x',
    evidenceTrail: [{ tier: 'yt-dlp', outcome: 'fail', reason: 'http-403' }],
  });
  assert.match(out, /yt-dlp: fail \(http-403\)/);
  // No latency present — must not synthesize "0ms" or similar.
  assert.doesNotMatch(out, /0ms/);
});

test('formatToolResult: latency is rounded to integer (avoid noisy decimals in prompt)', () => {
  const out = formatToolResult(CALL, {
    ok: false,
    output: 'x',
    evidenceTrail: [{ tier: 'jina', outcome: 'fail', latencyMs: 234.789 }],
  });
  assert.match(out, /235ms/);
  assert.doesNotMatch(out, /234\.789/);
});

test('formatToolResult: trail content is escapeXml\'d (defensive against weird tier names)', () => {
  const out = formatToolResult(CALL, {
    ok: false,
    output: 'x',
    evidenceTrail: [{ tier: 'tier<>&', outcome: 'fail', reason: 'has < and > and &' }],
  });
  // Must not break the surrounding XML structure.
  assert.match(out, /<evidence_trail>.*&lt;.*&gt;.*&amp;.*<\/evidence_trail>/);
  assert.doesNotMatch(out, /<\/evidence_trail>.*<\/evidence_trail>/, 'no double closing tag from unescaped >');
});

// ─── multi-result wrapper ──────────────────────────────────────────────────

test('formatToolResultsMessage: each result keeps its own trail decision', () => {
  const pairs = [
    {
      call: { id: 'a', name: 'fetch_url' },
      result: { ok: true, output: 'ok', evidenceTrail: [{ tier: 'jina', outcome: 'ok' }] }, // single-tier → no trail
    },
    {
      call: { id: 'b', name: 'fetch_url' },
      result: {
        ok: false,
        output: 'failed',
        error: 'timeout',
        evidenceTrail: [
          { tier: 'jina', outcome: 'fail', latencyMs: 3000, reason: 'timeout' },
          { tier: 'direct', outcome: 'fail', latencyMs: 200, reason: 'http-403' },
        ],
      },
    },
  ];
  const out = formatToolResultsMessage(pairs);
  // First result (success, single-tier) → no trail block
  const first = out.split('\n\n')[0];
  assert.doesNotMatch(first, /<evidence_trail>/);
  // Second result (failure) → trail block included
  const second = out.split('\n\n')[1];
  assert.match(second, /<evidence_trail>jina: fail.*direct: fail/);
});

// ─── defensive ─────────────────────────────────────────────────────────────

test('formatToolResult: malformed trail item (non-object) → silently dropped', () => {
  const out = formatToolResult(CALL, {
    ok: false,
    output: 'x',
    evidenceTrail: [null, undefined, 'string', { tier: 'jina', outcome: 'fail' }],
  });
  // The malformed items get filter()'d out; only the valid one renders.
  assert.match(out, /<evidence_trail>jina: fail<\/evidence_trail>/);
});

test('formatToolResult: all-malformed trail → no <evidence_trail> block emitted', () => {
  const out = formatToolResult(CALL, {
    ok: false,
    output: 'x',
    evidenceTrail: [null, undefined, 'string'],
  });
  // After filtering, items.length === 0 → skip the block entirely.
  assert.doesNotMatch(out, /<evidence_trail>/);
});
