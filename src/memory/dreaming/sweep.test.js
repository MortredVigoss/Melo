import test from 'node:test';
import assert from 'node:assert/strict';
import { countAtticTransitions } from './sweep.js';

test('countAtticTransitions classifies cold→warm as promoted', () => {
  const r = countAtticTransitions([{ from: 'cold', to: 'warm' }]);
  assert.equal(r.promoted, 1);
  assert.equal(r.demoted, 0);
});

test('countAtticTransitions classifies warm→hot as promoted', () => {
  const r = countAtticTransitions([{ from: 'warm', to: 'hot' }]);
  assert.equal(r.promoted, 1);
  assert.equal(r.demoted, 0);
});

test('countAtticTransitions classifies hot→warm and hot→cold as demoted', () => {
  const r = countAtticTransitions([
    { from: 'hot', to: 'warm' },
    { from: 'hot', to: 'cold' },
  ]);
  assert.equal(r.demoted, 2);
  assert.equal(r.promoted, 0);
});

test('countAtticTransitions classifies warm→cold as demoted', () => {
  const r = countAtticTransitions([{ from: 'warm', to: 'cold' }]);
  assert.equal(r.demoted, 1);
});

test('countAtticTransitions treats unknown origin as cold (so → warm counts as promotion)', () => {
  const r = countAtticTransitions([
    { from: undefined, to: 'warm' },
    { from: null, to: 'hot' },
    { from: 'foo', to: 'cold' }, // unknown to cold == cold→cold == unchanged
  ]);
  assert.equal(r.promoted, 2);
  assert.equal(r.unchanged, 1);
  assert.equal(r.demoted, 0);
});

test('countAtticTransitions handles an empty list', () => {
  const r = countAtticTransitions([]);
  assert.deepEqual(r, { promoted: 0, demoted: 0, unchanged: 0 });
});

test('countAtticTransitions is insensitive to order', () => {
  const mixed = countAtticTransitions([
    { from: 'hot', to: 'warm' },
    { from: 'cold', to: 'warm' },
    { from: 'warm', to: 'cold' },
    { from: 'warm', to: 'warm' },
  ]);
  assert.equal(mixed.promoted, 1);
  assert.equal(mixed.demoted, 2);
  assert.equal(mixed.unchanged, 1);
});
