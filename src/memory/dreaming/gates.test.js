import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreGate, passesHotGate, filterHotCandidates, GATE_CONFIG } from './gates.js';

test('scoreGate returns zeros for empty stats', () => {
  const { score, components } = scoreGate({});
  assert.equal(score, 0);
  assert.equal(components.recall, 0);
  assert.equal(components.diversity, 0);
  assert.equal(components.outcome, 0);
});

test('scoreGate saturates recall at ~10 hits', () => {
  const low = scoreGate({ hits: 1, distinctQueries: 1, goodOutcomes: 1 });
  const high = scoreGate({ hits: 10, distinctQueries: 1, goodOutcomes: 1 });
  const higher = scoreGate({ hits: 100, distinctQueries: 1, goodOutcomes: 1 });
  assert.ok(high.components.recall > low.components.recall);
  assert.ok(higher.components.recall - high.components.recall < 0.1);
});

test('passesHotGate requires meaningful combined signal', () => {
  // Single hit, no diversity, no outcome → should fail.
  assert.equal(passesHotGate({ hits: 1, distinctQueries: 1, goodOutcomes: 0 }), false);
  // 10 hits, 3 distinct queries, all used → should pass.
  assert.equal(passesHotGate({ hits: 10, distinctQueries: 3, goodOutcomes: 10 }), true);
});

test('filterHotCandidates partitions by threshold', () => {
  const cands = [
    { id: 'a', stats: { hits: 10, distinctQueries: 3, goodOutcomes: 10 } }, // pass
    { id: 'b', stats: { hits: 1, distinctQueries: 1, goodOutcomes: 0 } },   // fail
    { id: 'c', stats: { hits: 5, distinctQueries: 2, goodOutcomes: 4 } },   // likely pass
  ];
  const { accepted, rejected } = filterHotCandidates(cands);
  assert.ok(accepted.includes('a'));
  assert.ok(rejected.includes('b'));
  assert.equal(accepted.length + rejected.length, 3);
});

test('gate weights sum to ~1.0', () => {
  const sum =
    GATE_CONFIG.RECALL_WEIGHT +
    GATE_CONFIG.DIVERSITY_WEIGHT +
    GATE_CONFIG.OUTCOME_WEIGHT;
  assert.ok(Math.abs(sum - 1) < 0.01);
});
