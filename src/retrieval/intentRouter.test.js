import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyIntent,
  intentAllowsUncertaintyMarker,
  intentRequiresVerification,
  lruGet,
  lruSet,
  _resetIntentCacheForTests,
} from './intentRouter.js';

test('classifyIntent handles obvious casual and factual turns with rules only', async () => {
  assert.equal(await classifyIntent('hi'), 'casual');
  assert.equal(await classifyIntent('What is Singapore?'), 'factual');
  assert.equal(await classifyIntent('什么是向量数据库？'), 'factual');
});

test('classifyIntent handles coding, creative, and high-stakes turns with rules', async () => {
  assert.equal(await classifyIntent('Please debug this Python function'), 'coding');
  assert.equal(await classifyIntent('帮我写一首诗'), 'creative');
  assert.equal(await classifyIntent('What dosage should I take?'), 'high-stakes');
});

test('intent verification gates stay narrow', () => {
  assert.equal(intentRequiresVerification('factual'), true);
  assert.equal(intentRequiresVerification('high-stakes'), true);
  assert.equal(intentRequiresVerification('coding'), false);
  assert.equal(intentAllowsUncertaintyMarker('creative'), false);
  assert.equal(intentAllowsUncertaintyMarker('factual'), true);
});

/**
 * Search audit B-1 regression: INTENT_CACHE is a real LRU — reading a key
 * moves it to the "most recently used" tail so it survives the next
 * eviction.  The old code evicted the oldest-*inserted* key regardless of
 * recency; a query repeated right before eviction would still get dropped.
 */
test('lruGet promotes a key so it survives the next eviction', () => {
  const cache = new Map();
  lruSet(cache, 'a', 1, 3);
  lruSet(cache, 'b', 2, 3);
  lruSet(cache, 'c', 3, 3);
  // Touch 'a' so it becomes most-recently-used.
  assert.equal(lruGet(cache, 'a'), 1);
  // Now insert 'd' → max is 3 so the LRU entry evicts.  With FIFO 'a' would
  // be the one evicted (oldest inserted); with LRU semantics 'b' goes.
  lruSet(cache, 'd', 4, 3);
  assert.ok(cache.has('a'), 'a survives because it was just read');
  assert.ok(!cache.has('b'), 'b is evicted (least recently used)');
  assert.ok(cache.has('c'));
  assert.ok(cache.has('d'));
});

test('lruSet on existing key moves it to the tail', () => {
  const cache = new Map();
  lruSet(cache, 'a', 1, 3);
  lruSet(cache, 'b', 2, 3);
  lruSet(cache, 'a', 99, 3);  // refresh
  lruSet(cache, 'c', 3, 3);
  lruSet(cache, 'd', 4, 3);   // should evict b, not a
  assert.ok(cache.has('a'));
  assert.ok(!cache.has('b'));
  assert.equal(cache.get('a'), 99);
});

test('lruGet on missing key returns undefined and does not mutate', () => {
  const cache = new Map();
  lruSet(cache, 'a', 1, 3);
  assert.equal(lruGet(cache, 'missing'), undefined);
  assert.equal(cache.size, 1);
});

test('classifyIntent cache is isolated — _resetIntentCacheForTests clears it', async () => {
  // Rule-classifier turns don't populate the cache at all; smoke-test the
  // reset helper so test runs can't poison each other.
  _resetIntentCacheForTests();
  assert.equal(await classifyIntent('hi'), 'casual');
});

