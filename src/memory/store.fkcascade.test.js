/**
 * P2-9 regression: memory_hits has an ON DELETE CASCADE FK to memories,
 * and PRAGMA foreign_keys is enforced at the connection level.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  upsertMemory,
  deleteMemoryById,
  getHitStats,
  recordMemoryHit,
  cleanupOrphanHits,
} from './store.js';

test('deleting a memory cascades to memory_hits', async () => {
  const id = 'fk-cascade-1';
  upsertMemory({
    id,
    namespace: 'chat:fk',
    kind: 'fact',
    text: 'hello fk',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  });
  recordMemoryHit({ memoryId: id, queryHash: 'q', rank: 0 });
  recordMemoryHit({ memoryId: id, queryHash: 'q', rank: 1 });

  const [before] = getHitStats({ memoryIds: [id], windowDays: 30 });
  assert.ok(before?.hits >= 2, 'hits are recorded before delete');

  const ok = deleteMemoryById(id);
  assert.equal(ok, true);

  const [after] = getHitStats({ memoryIds: [id], windowDays: 30 });
  assert.equal(after?.hits || 0, 0, 'FK cascade wipes hits when memory is deleted');
});

test('cleanupOrphanHits is a no-op under the FK constraint', async () => {
  // Newly-booted DB: any hit has a matching memory (because recordMemoryHit
  // requires the memory to exist first, and cascade handles deletes).
  const id = 'fk-cascade-2';
  upsertMemory({
    id,
    namespace: 'chat:fk',
    kind: 'fact',
    text: 'still here',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  });
  recordMemoryHit({ memoryId: id, queryHash: 'q', rank: 0 });

  assert.equal(cleanupOrphanHits(), 0, 'no orphans to delete after FK cascade is in place');
});
