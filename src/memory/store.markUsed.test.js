import test from 'node:test';
import assert from 'node:assert/strict';
import {
  replaceMemories,
  recordMemoryHit,
  getHitStats,
  markMemoriesUsed,
} from './store.js';

function mkEntry(id) {
  return {
    id,
    namespace: 'chat:test-mark-used',
    kind: 'fact',
    text: `Fact ${id}`,
    searchText: `fact ${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: { category: 'preference' },
  };
}

test('markMemoriesUsed flips outcome on the most recent NULL-outcome hit per id', () => {
  replaceMemories([mkEntry('mu-a'), mkEntry('mu-b'), mkEntry('mu-c')]);

  // Seed three hits per id, all with outcome=null
  for (const id of ['mu-a', 'mu-b', 'mu-c']) {
    recordMemoryHit({ memoryId: id, queryHash: 'q1', rank: 0 });
    recordMemoryHit({ memoryId: id, queryHash: 'q2', rank: 1 });
    recordMemoryHit({ memoryId: id, queryHash: 'q3', rank: 2 });
  }

  const n = markMemoriesUsed(['mu-a', 'mu-c']);
  assert.equal(n, 2, 'two rows updated');

  const stats = getHitStats({ memoryIds: ['mu-a', 'mu-b', 'mu-c'], windowDays: 1 });
  const byId = new Map(stats.map(r => [r.memoryId, r]));

  // mu-a and mu-c should have goodOutcomes=1; mu-b stays at 0.
  assert.equal(byId.get('mu-a').goodOutcomes, 1, 'mu-a flipped');
  assert.equal(byId.get('mu-c').goodOutcomes, 1, 'mu-c flipped');
  assert.equal(byId.get('mu-b').goodOutcomes, 0, 'mu-b untouched');
  // Hit counts preserved
  assert.equal(byId.get('mu-a').hits, 3);
  assert.equal(byId.get('mu-b').hits, 3);
});

test('markMemoriesUsed ignores rows whose outcome is already set', () => {
  replaceMemories([mkEntry('mu-d')]);

  // Two hits, one already marked 'used'
  recordMemoryHit({ memoryId: 'mu-d', queryHash: 'q1', rank: 0, outcome: 'used' });
  recordMemoryHit({ memoryId: 'mu-d', queryHash: 'q2', rank: 1 });

  const n = markMemoriesUsed(['mu-d']);
  assert.equal(n, 1, 'only the NULL-outcome row got updated');

  const stats = getHitStats({ memoryIds: ['mu-d'], windowDays: 1 });
  assert.equal(stats[0].goodOutcomes, 2, 'both outcomes now set');
});

test('markMemoriesUsed returns 0 for empty / missing ids', () => {
  assert.equal(markMemoriesUsed([]), 0);
  assert.equal(markMemoriesUsed(['does-not-exist']), 0);
});

test('markMemoriesUsed respects the windowMs boundary', () => {
  replaceMemories([mkEntry('mu-e')]);
  recordMemoryHit({ memoryId: 'mu-e', queryHash: 'q1', rank: 0 });

  // Zero window = reject hits unless they share the exact nowIso timestamp,
  // which the UPDATE's `>=` comparison effectively excludes because the row
  // was written microseconds ago.  A tiny negative window is even more
  // clearly empty.
  assert.equal(markMemoriesUsed(['mu-e'], { windowMs: -1 }), 0, 'past-only window finds nothing');
  assert.equal(markMemoriesUsed(['mu-e'], { windowMs: 60_000 }), 1, 'normal window finds it');
});
