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

// Capability probe — done ONCE at module load. The only legitimate
// reason to skip in a Melo dev/test env is `sqlite-vec` not being
// resolvable from node_modules; sqlite-vec is a production dep
// (package.json), so CI / release-prep must always have it. Anywhere
// else (load failure, SQL error, missing row) is a real test failure
// and should NOT be silently caught.
//
// Codex review (Phase F-2 ⚪ P2 follow-up 2026-05-05): the previous
// helpers caught every failure mode and returned a sentinel that the
// caller treated as "skip" — which made the rewrite-content
// assertion pass even when the vec0 layer was actually broken.
let _sqliteVecModule = null;
let _sqliteVecImportError = null;
try {
  _sqliteVecModule = await import('sqlite-vec');
} catch (err) {
  _sqliteVecImportError = err;
}
function sqliteVecAvailable() {
  return _sqliteVecModule !== null;
}
function sqliteVecSkipReason() {
  return _sqliteVecImportError
    ? `sqlite-vec import failed: ${_sqliteVecImportError.message || _sqliteVecImportError}`
    : 'sqlite-vec module not loaded';
}

// Helper: open a sibling readonly connection to inspect vec_memories.
// Throws on every failure path EXCEPT "sqlite-vec module unavailable"
// (which is the t.skip path the caller handles).
function vecCountForId(id) {
  if (!sqliteVecAvailable()) {
    const err = new Error('SKIP_NO_SQLITE_VEC');
    err.skip = true;
    throw err;
  }
  const path = join(process.env.MELO_HOME, 'desktop', 'store.sqlite');
  const db = new DatabaseSync(path, { allowExtension: true });
  try {
    _sqliteVecModule.load(db);
    const r = db.prepare('SELECT COUNT(*) AS n FROM vec_memories WHERE memory_id = ?').get(id);
    if (!r || typeof r.n !== 'number') {
      throw new Error(`vec_memories COUNT returned no row for memory_id=${id}`);
    }
    return r.n;
  } finally {
    try { db.close(); } catch {}
  }
}

// Helper: KNN distance from a probe vector to the row at memory_id.
// Throws on every failure path EXCEPT "sqlite-vec module unavailable".
// The original "swallow everything → return null" version made the
// rewrite-content assertion silently pass under a broken vec0 layer.
function vecDistance(memoryId, probeVec) {
  if (!sqliteVecAvailable()) {
    const err = new Error('SKIP_NO_SQLITE_VEC');
    err.skip = true;
    throw err;
  }
  const path = join(process.env.MELO_HOME, 'desktop', 'store.sqlite');
  const db = new DatabaseSync(path, { allowExtension: true });
  try {
    _sqliteVecModule.load(db);
    const buf = Buffer.from(probeVec.buffer);
    // vec0 KNN syntax: WHERE embedding MATCH ? AND k = ?  — the
    // explicit k=N constraint is required by sqlite-vec (a plain
    // `LIMIT N` after the MATCH is rejected with "A LIMIT or 'k = ?'
    // constraint is required on vec0 knn queries"). We pull the
    // top-K=8 hits and filter by memory_id in JS — KNN can't take an
    // arbitrary scalar predicate alongside the MATCH clause.
    const rows = db.prepare(`
      SELECT memory_id, distance FROM vec_memories
      WHERE embedding MATCH ? AND k = 8
    `).all(buf);
    const hit = rows.find(r => r.memory_id === memoryId);
    if (!hit || typeof hit.distance !== 'number') {
      throw new Error(
        `KNN top-8 did not include memory_id=${memoryId}. ` +
        `Either the row is missing from vec_memories or the probe vector is too far ` +
        `from every stored vector for the row to surface in the top-K window.`,
      );
    }
    return hit.distance;
  } finally {
    try { db.close(); } catch {}
  }
}

// Wrapper used by every test below: invokes `body(t)`. If body throws
// an error tagged `.skip = true` (capability-probe miss), forward to
// `t.skip(reason)`; any other error fails the test as usual.
async function withSkippableSqliteVec(t, body) {
  try {
    await body(t);
  } catch (err) {
    if (err?.skip === true) {
      t.skip(sqliteVecSkipReason());
      return;
    }
    throw err;
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
  // Mulberry32 PRNG seeded by `seed` so different seeds yield
  // approximately orthogonal vectors. The earlier sin-based generator
  // was too smooth — different seeds produced cosine ≈ 1, defeating
  // the distance-distinguishability assertion in the rewrite test.
  let s = (seed >>> 0) || 1;
  const arr = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    arr[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  return arr;
}

test('storeEmbedding first write inserts a vec_memories row', async (t) => {
  await withSkippableSqliteVec(t, () => {
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
    const vecCount = vecCountForId('mem-A');
    assert.equal(vecCount, 1, 'first write should produce exactly one vec_memories row');
  });
});

test('storeEmbedding re-write of same memoryId does NOT throw UNIQUE constraint', async (t) => {
  await withSkippableSqliteVec(t, () => {
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
    const vecCount = vecCountForId('mem-B');
    assert.equal(
      vecCount, 1,
      'rewrite should leave exactly one vec_memories row (not duplicate, not deleted)',
    );
  });
});

test('storeEmbedding rewrite REPLACES the on-disk vector content (not just count)', async (t) => {
  // Codex follow-up (Phase F-2 ⚪ P2 2026-05-05): the doesNotThrow +
  // count=1 pair above passes under the BUGGY implementation too —
  // storeEmbedding's outer catch swallows the UNIQUE error so
  // doesNotThrow trivially holds, and the stale row from the first
  // write satisfies count=1. The only assertion that distinguishes
  // fixed vs broken is "the on-disk vector content actually changed".
  // Use vec0 KNN distance as the witness: a probe equal to the SECOND
  // write's vector should land near distance ≈ 0 IF the row was
  // really replaced, and stay large under the bug (row still holds
  // the FIRST vector).
  await withSkippableSqliteVec(t, () => {
    writeStoredEmbeddingModelId('test-model');
    upsertMemory({
      id: 'mem-D',
      namespace: 'chat:1',
      kind: 'prompt',
      sourceId: 'm1',
      text: 'replace test',
      metadata: {},
    });

    const firstVec = fakeEmbedding(1);
    const secondVec = fakeEmbedding(500);
    // Sanity: the two vectors must be distinguishable. PRNG-seeded
    // (mulberry32) → different seeds yield ~orthogonal vectors.
    const cosine = (() => {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < 1024; i++) {
        dot += firstVec[i] * secondVec[i];
        na  += firstVec[i] * firstVec[i];
        nb  += secondVec[i] * secondVec[i];
      }
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    })();
    assert.ok(Math.abs(cosine) < 0.5, 'test fixtures must be distinguishable');

    // First write — establish baseline.
    saveMemoryEmbedding('mem-D', 'replace test', firstVec, 'test-model');

    // Probe with secondVec NOW (before rewrite). The on-disk row still
    // holds firstVec, so this distance should be relatively LARGE.
    const distBeforeRewrite = vecDistance('mem-D', secondVec);

    // Rewrite with the very different secondVec.
    saveMemoryEmbedding('mem-D', 'replace test', secondVec, 'test-model');

    // Probe with secondVec AFTER rewrite. Post-fix the row holds
    // secondVec → distance ≈ 0. Under the broken vec0 INSERT OR REPLACE
    // path the rewrite was silently dropped → row still holds firstVec
    // → distance unchanged from before. Both calls THROW (not silently
    // skip) on any non-import failure, so a truly broken vec0 layer
    // surfaces as a real test failure rather than a fake pass.
    const distAfterRewrite = vecDistance('mem-D', secondVec);
    assert.ok(
      distAfterRewrite < distBeforeRewrite - 0.01,
      `rewrite must replace vector content: distance to secondVec should drop after rewrite ` +
      `(before=${distBeforeRewrite.toFixed(4)}, after=${distAfterRewrite.toFixed(4)}). ` +
      `If after >= before, the rewrite was silently dropped — the buggy ` +
      `INSERT OR REPLACE path is the prime suspect.`,
    );
  });
});

test('storeEmbedding 10x rewrites of the same id stay clean', async (t) => {
  // Stress the pattern: simulate the exact production scenario where a
  // background fill-in retries the same row across multiple sessions.
  await withSkippableSqliteVec(t, () => {
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
    const vecCount = vecCountForId('mem-C');
    assert.equal(vecCount, 1, '10 rewrites still leave exactly one row');
  });
});
