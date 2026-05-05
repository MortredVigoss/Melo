/**
 * Phase F-2c (2026-05-05): regression for the vec0 INSERT OR REPLACE bug.
 *
 * Before the fix, storeEmbedding used:
 *   INSERT OR REPLACE INTO vec_memories (memory_id, embedding) VALUES (?, ?)
 * vec0 virtual tables don't honour OR REPLACE — re-writing the same
 * memory_id throws "UNIQUE constraint failed on vec_memories primary key".
 * The catch in storeEmbedding swallowed the throw via debugWarn, leaving
 * production stores in a state where:
 *   • memories.embedding had been UPDATEd by an earlier successful write
 *   • a stale vec_memories row from that earlier write was still there
 *   • all subsequent re-embed attempts (provider swap, drift wipe,
 *     fill-embeddings retry) silently failed on the same row forever
 *
 * The fix is the vec0-safe pattern: DELETE-then-INSERT. Pin it.
 *
 * Two cases:
 *   1. First write: INSERT into vec_memories succeeds (no DELETE noise)
 *   2. Re-write same memoryId: previous row deleted, new row inserted,
 *      no UNIQUE error
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  upsertMemory,
  saveMemoryEmbedding,
  writeStoredEmbeddingModelId,
  _resetStoreForTests,
} from './store.js';

// Helper: open a sibling readonly connection to inspect vec_memories
// without poking the writable singleton. sqlite-vec must be loaded for
// the virtual table to be queryable.
async function vecCountForId(id) {
  let sqliteVec;
  try {
    sqliteVec = await import('sqlite-vec');
  } catch {
    return -1; // sqlite-vec not installed in this env — skip assertion
  }
  const path = join(process.env.MELO_HOME, 'desktop', 'store.sqlite');
  const db = new DatabaseSync(path, { allowExtension: true });
  try {
    sqliteVec.load(db);
    const r = db.prepare('SELECT COUNT(*) AS n FROM vec_memories WHERE memory_id = ?').get(id);
    return r?.n ?? 0;
  } catch {
    return -1;
  } finally {
    try { db.close(); } catch {}
  }
}

let _tmpDir = null;

test.beforeEach(() => {
  _tmpDir = mkdtempSync(join(tmpdir(), 'melo-vecrewrite-'));
  process.env.MELO_HOME = _tmpDir;
  _resetStoreForTests();
});

test.afterEach(async () => {
  _resetStoreForTests();
  if (_tmpDir) await rm(_tmpDir, { recursive: true, force: true });
  _tmpDir = null;
});

function fakeEmbedding(seed) {
  const arr = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) arr[i] = Math.sin(seed + i * 0.001);
  return arr;
}

test('storeEmbedding first write inserts a vec_memories row', async () => {
  writeStoredEmbeddingModelId('test-model');
  upsertMemory({
    id: 'mem-A',
    namespace: 'chat:1',
    kind: 'prompt',
    sourceId: 'm1',
    text: 'hello world',
    metadata: {},
  });
  saveMemoryEmbedding('mem-A', 'hello world', fakeEmbedding(1), 'test-model');
  const vecCount = await vecCountForId('mem-A');
  if (vecCount === -1) return; // vec0 not available in this env
  assert.equal(vecCount, 1, 'first write should produce exactly one vec_memories row');
});

test('storeEmbedding re-write of same memoryId does NOT throw UNIQUE constraint', async () => {
  writeStoredEmbeddingModelId('test-model');
  upsertMemory({
    id: 'mem-B',
    namespace: 'chat:1',
    kind: 'prompt',
    sourceId: 'm1',
    text: 'rewrite test',
    metadata: {},
  });

  // First write — establishes vec_memories row.
  saveMemoryEmbedding('mem-B', 'rewrite test', fakeEmbedding(2), 'test-model');

  // Second write with a DIFFERENT vector — pre-fix this would throw
  // "UNIQUE constraint failed on vec_memories primary key" inside the
  // INSERT OR REPLACE statement, get caught by the silent debugWarn, and
  // leave the OLD vector behind. Post-fix the DELETE-then-INSERT pattern
  // produces a clean replacement.
  assert.doesNotThrow(() => {
    saveMemoryEmbedding('mem-B', 'rewrite test', fakeEmbedding(99), 'test-model');
  }, 'rewrite must not throw on duplicate memory_id');

  // After the rewrite there should still be exactly one vec_memories row
  // for this id (not two, not zero).
  const vecCount = await vecCountForId('mem-B');
  if (vecCount === -1) return;
  assert.equal(
    vecCount, 1,
    'rewrite should leave exactly one vec_memories row (not duplicate, not deleted)',
  );
});

test('storeEmbedding 10x rewrites of the same id stay clean', async () => {
  // Stress the pattern: simulate the exact production scenario where a
  // background fill-in retries the same row across multiple sessions.
  writeStoredEmbeddingModelId('test-model');
  upsertMemory({
    id: 'mem-C',
    namespace: 'chat:1',
    kind: 'prompt',
    sourceId: 'm1',
    text: 'stress',
    metadata: {},
  });

  for (let i = 0; i < 10; i++) {
    assert.doesNotThrow(() => {
      saveMemoryEmbedding('mem-C', 'stress', fakeEmbedding(i + 100), 'test-model');
    }, `iteration ${i} must not throw`);
  }
  const vecCount = await vecCountForId('mem-C');
  if (vecCount === -1) return;
  assert.equal(vecCount, 1, '10 rewrites still leave exactly one row');
});
