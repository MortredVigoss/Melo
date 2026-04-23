import test from 'node:test';
import assert from 'node:assert/strict';
import { isEntryInvalidated, useCountBoost } from './store.js';

test('useCountBoost returns 0 for missing or non-positive counts', () => {
  assert.equal(useCountBoost({}), 0);
  assert.equal(useCountBoost(null), 0);
  assert.equal(useCountBoost({ useCount: 0 }), 0);
  assert.equal(useCountBoost({ useCount: -5 }), 0);
  assert.equal(useCountBoost({ useCount: 'abc' }), 0);
});

test('useCountBoost grows logarithmically and caps at 60', () => {
  // log2(2)*20 = 20
  assert.equal(useCountBoost({ useCount: 1 }), 20);
  // log2(11)*20 ≈ 69.19 → capped at 60
  assert.equal(useCountBoost({ useCount: 10 }), 60);
  // Very large counts are still capped
  assert.equal(useCountBoost({ useCount: 1_000_000 }), 60);
});

test('useCountBoost is monotonic in useCount', () => {
  let prev = -1;
  for (const n of [1, 2, 3, 5, 8, 13, 21]) {
    const boost = useCountBoost({ useCount: n });
    assert.ok(boost >= prev, `boost at ${n} (${boost}) should be >= prev ${prev}`);
    prev = boost;
  }
});

test('isEntryInvalidated returns false for missing or null validTo', () => {
  assert.equal(isEntryInvalidated({}), false);
  assert.equal(isEntryInvalidated({ validTo: null }), false);
  assert.equal(isEntryInvalidated({ validTo: '' }), false);
});

test('isEntryInvalidated returns true when validTo has passed', () => {
  const past = new Date(Date.now() - 10_000).toISOString();
  assert.equal(isEntryInvalidated({ validTo: past }), true);
});

test('isEntryInvalidated returns false when validTo is in the future', () => {
  const future = new Date(Date.now() + 10_000).toISOString();
  assert.equal(isEntryInvalidated({ validTo: future }), false);
});

test('isEntryInvalidated treats unparseable strings as active (fail-open)', () => {
  assert.equal(isEntryInvalidated({ validTo: 'not-a-date' }), false);
});
