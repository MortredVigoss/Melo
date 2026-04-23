/**
 * Phase 1 #1 — MMR diversity rerank.
 *
 * applyMmrRerank(sorted, lim, λ) picks items iteratively, trading raw score
 * vs novelty against already-picked embeddings. Tests cover:
 *   - empty / short input returns input unchanged
 *   - duplicate embeddings get deduped in favor of lower-ranked novel items
 *   - pinned rows bypass the diversity penalty (can't be squeezed out)
 *   - rows without usable embeddings fall back to score order (no regression)
 *   - cross-comparison: a rerank never produces an empty result from a non-empty input
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMmrRerank } from './store.js';

/** Build a row whose embedding blob decodes to `vector`. */
function row(id, score, vector, { pinned = false } = {}) {
  const f32 = Float32Array.from(vector);
  return {
    id,
    score,
    metadata: pinned ? { pinned: true } : {},
    // node:sqlite surfaces BLOBs as Uint8Array; mimic that shape
    embedding: Buffer.from(f32.buffer.slice(0)),
  };
}

function rowNoEmb(id, score, { pinned = false } = {}) {
  return { id, score, metadata: pinned ? { pinned: true } : {}, embedding: null };
}

test('applyMmrRerank: empty array returns []', () => {
  assert.deepEqual(applyMmrRerank([], 5), []);
});

test('applyMmrRerank: null/undefined input returns []', () => {
  assert.deepEqual(applyMmrRerank(null, 5), []);
  assert.deepEqual(applyMmrRerank(undefined, 5), []);
});

test('applyMmrRerank: n <= lim returns a copy of the input order', () => {
  const input = [row('a', 0.9, [1, 0, 0]), row('b', 0.8, [0, 1, 0])];
  const out = applyMmrRerank(input, 5);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'a');
  assert.equal(out[1].id, 'b');
  // Must be a new array (defensive copy) — callers sometimes mutate results.
  assert.notEqual(out, input);
});

test('applyMmrRerank: near-duplicate gets skipped in favor of a novel lower-scored row', () => {
  // Candidates:
  //   a (score 0.90, vec [1,0,0])      ← picked first (highest score)
  //   b (score 0.89, vec [1,0,0])      ← near-duplicate of a
  //   c (score 0.70, vec [0,1,0])      ← novel direction
  // With λ=0.7, pick 2:  first a, then c (diversity wins over b's tiny edge).
  const input = [
    row('a', 0.90, [1, 0, 0]),
    row('b', 0.89, [1, 0, 0]),
    row('c', 0.70, [0, 1, 0]),
  ];
  const out = applyMmrRerank(input, 2, 0.7);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'a');
  assert.equal(out[1].id, 'c', 'expected c (novel) to beat b (duplicate)');
});

test('applyMmrRerank: pinned rows bypass the diversity penalty', () => {
  // a (score 0.90, [1,0,0]) ← picked first
  // b (score 0.89, [1,0,0], pinned) ← duplicate, BUT pinned → no penalty
  // c (score 0.70, [0,1,0])
  // With pinned bypass, b should still beat c because its score is higher and
  // its diversity penalty is forced to 0.
  const input = [
    row('a', 0.90, [1, 0, 0]),
    row('b', 0.89, [1, 0, 0], { pinned: true }),
    row('c', 0.70, [0, 1, 0]),
  ];
  const out = applyMmrRerank(input, 2, 0.7);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'a');
  assert.equal(out[1].id, 'b', 'pinned row must not be squeezed out by duplicate-penalty');
});

test('applyMmrRerank: no usable embeddings → fall back to score order', () => {
  const input = [
    rowNoEmb('a', 0.90),
    rowNoEmb('b', 0.50),
    rowNoEmb('c', 0.80),
  ];
  // Fallback returns top-lim in given order — sorted has already been sorted
  // by the caller, so we mimic that here.
  const sorted = input.slice().sort((x, y) => y.score - x.score);
  const out = applyMmrRerank(sorted, 2);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'a');
  assert.equal(out[1].id, 'c');
});

test('applyMmrRerank: partial embeddings still work — no-emb rows get 0 diversity penalty', () => {
  // a has an embedding, b does not. b should still be pickable.
  const input = [
    row('a', 0.90, [1, 0, 0]),
    rowNoEmb('b', 0.85),
  ];
  const out = applyMmrRerank(input, 2, 0.7);
  assert.equal(out.length, 2);
  // Order: a (highest score) then b (no embedding → no penalty, still second)
  assert.equal(out[0].id, 'a');
  assert.equal(out[1].id, 'b');
});

test('applyMmrRerank: honors lim cap', () => {
  const input = [
    row('a', 0.9, [1, 0, 0]),
    row('b', 0.8, [0, 1, 0]),
    row('c', 0.7, [0, 0, 1]),
    row('d', 0.6, [1, 1, 0]),
  ];
  const out = applyMmrRerank(input, 2, 0.7);
  assert.equal(out.length, 2);
});

test('applyMmrRerank: result preserves row objects (not copies)', () => {
  const a = row('a', 0.9, [1, 0, 0]);
  const b = row('b', 0.8, [0, 1, 0]);
  const out = applyMmrRerank([a, b], 5);
  assert.equal(out[0], a, 'rerank must return original row references, not clones');
  assert.equal(out[1], b);
});
