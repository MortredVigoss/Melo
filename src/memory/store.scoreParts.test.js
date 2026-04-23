/**
 * Search audit C-4 regression: recall scoring exposes a component breakdown
 * { semantic, keyword, useCountBoost, final } so future regressions can be
 * diffed against a structured log instead of an opaque scalar.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRecallScoreParts, useCountBoost } from './store.js';

test('computeRecallScoreParts: semantic path emits semantic + boost/600', () => {
  const metadata = { useCount: 10 };
  const { score, components } = computeRecallScoreParts({ metadata, semantic: 0.8 });
  const expectedBoost = useCountBoost(metadata); // log-scaled, deterministic
  assert.equal(components.semantic, 0.8);
  assert.equal(components.keyword, 0);
  assert.equal(components.useCountBoost, expectedBoost);
  // Semantic path scales the boost down by /600 so a hot fact doesn't drown
  // the cosine signal.
  const expectedFinal = 0.8 + expectedBoost / 600;
  assert.ok(Math.abs(score - expectedFinal) < 1e-6);
  assert.ok(Math.abs(components.final - expectedFinal) < 1e-3);
});

test('computeRecallScoreParts: keyword path adds full useCountBoost', () => {
  const metadata = { useCount: 10 };
  const { score, components } = computeRecallScoreParts({ metadata, keyword: 120 });
  const expectedBoost = useCountBoost(metadata);
  assert.equal(components.semantic, 0);
  assert.equal(components.keyword, 120);
  assert.equal(components.useCountBoost, expectedBoost);
  // Keyword path adds the full boost — hot facts WERE meant to dominate in
  // the classic scoring mode, unlike the semantic path where boost is tiny.
  assert.equal(score, 120 + expectedBoost);
  assert.equal(components.final, 120 + expectedBoost);
});

test('computeRecallScoreParts: missing metadata yields zero boost', () => {
  const { components } = computeRecallScoreParts({ metadata: {}, semantic: 0.5 });
  assert.equal(components.useCountBoost, 0);
});

test('computeRecallScoreParts: non-finite inputs collapse to 0', () => {
  const { components } = computeRecallScoreParts({
    metadata: { useCount: 'foo' },
    semantic: NaN,
    keyword: Infinity,
  });
  assert.equal(components.semantic, 0);
  assert.equal(components.keyword, 0);
  assert.equal(components.useCountBoost, 0);
  assert.equal(components.final, 0);
});

test('computeRecallScoreParts: rounds components to 4 decimals', () => {
  // 1/(1+99) = 0.01 exactly; throw a boost in to get a /600 fractional.
  const { components } = computeRecallScoreParts({
    metadata: { useCount: 7 },
    semantic: 0.012345678,
  });
  // Rounded to 4 decimals
  assert.equal(components.semantic, 0.0123);
  // final is semantic + boost/600 — should also round cleanly
  assert.ok(String(components.final).length <= 10);
});
