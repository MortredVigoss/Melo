/**
 * Phase F-2 follow-up (Codex C feedback, 2026-05-05): end-to-end
 * coverage of the production KNN recall path.
 *
 * Codex review of the previous follow-up commit pushed back that the
 * vec0-rewrite tests live one level above the pipeline they're meant
 * to protect — they prove `storeEmbedding` writes the right bytes,
 * but they never call the production `recallMemoriesTiered` /
 * `recallMemories` entry points. A regression in `knnRecall`'s SQL
 * (e.g. someone edits the WHERE/ORDER/LIMIT shape and silently
 * breaks the production query) would still pass the unit tests.
 *
 * This file fills that gap: seed a small memory store with distinct
 * embeddings, call the real `recallMemoriesTiered({ queryEmbedding })`
 * entrypoint, and assert that semantic recall actually surfaces the
 * row whose embedding matches the query vector. If the production
 * KNN SQL ever stops returning rows, this test goes red.
 *
 * Skips with `t.skip` when `sqlite-vec` is not installed (the only
 * legitimate reason to bypass — CI / release prep must always have
 * it because it's a production dep in package.json).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import {
  upsertMemory,
  saveMemoryEmbedding,
  recallMemoriesTiered,
  writeStoredEmbeddingModelId,
  _resetStoreForTests,
} from './store.js';

let _sqliteVecModule = null;
let _sqliteVecImportError = null;
try {
  _sqliteVecModule = await import('sqlite-vec');
} catch (err) {
  _sqliteVecImportError = err;
}
function sqliteVecAvailable() { return _sqliteVecModule !== null; }
function sqliteVecSkipReason() {
  return _sqliteVecImportError
    ? `sqlite-vec import failed: ${_sqliteVecImportError.message || _sqliteVecImportError}`
    : 'sqlite-vec module not loaded';
}
async function withSkippableSqliteVec(t, body) {
  if (!sqliteVecAvailable()) {
    t.skip(sqliteVecSkipReason());
    return;
  }
  await body(t);
}

let _tmpDir = null;

test.beforeEach(() => {
  _tmpDir = mkdtempSync(join(tmpdir(), 'melo-recall-e2e-'));
  process.env.MELO_HOME = _tmpDir;
  _resetStoreForTests();
});

test.afterEach(async () => {
  _resetStoreForTests();
  if (_tmpDir) await rm(_tmpDir, { recursive: true, force: true });
  _tmpDir = null;
});

// PRNG-seeded vectors so different seeds yield ~orthogonal embeddings —
// the recall assertion relies on the probe vector being CLOSER to the
// "matching" stored vector than to any of the decoys. mulberry32 with
// distinct seeds gives cosine distances spread well across the unit
// sphere, where the smooth sin-based generator produced near-collinear
// vectors that defeated the rank assertion.
function fakeEmbedding(seed) {
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

test('recallMemoriesTiered: queryEmbedding close to a specific row surfaces THAT row in contents', async (t) => {
  await withSkippableSqliteVec(t, () => {
    writeStoredEmbeddingModelId('test-model');

    // Seed three memories with distinct vectors. We'll probe with a
    // vector identical to memory-2 and assert recall surfaces it.
    const TARGET_SEED = 12345;
    const seeds = [{ id: 'mem-1', seed: 100 }, { id: 'mem-2', seed: TARGET_SEED }, { id: 'mem-3', seed: 999 }];
    for (const { id, seed } of seeds) {
      upsertMemory({
        id,
        namespace: 'chat:test',
        kind: 'prompt',
        sourceId: id,
        text: `text for ${id}`,
        metadata: { chatId: 'test' },
      });
      saveMemoryEmbedding(id, `text for ${id}`, fakeEmbedding(seed), 'test-model');
    }

    // Probe with the EXACT vector for mem-2 — KNN distance should
    // collapse to ~0 for that row, and stay larger for the other two.
    const probe = fakeEmbedding(TARGET_SEED);
    const result = recallMemoriesTiered({
      namespaces: ['chat:test'],
      queryEmbedding: probe,
      limits: { scenes: 0, frames: 0, contents: 8 },
    });

    // Production path returns { scenes, frames, contents, conflicts }.
    // Pin the shape so a refactor that flattens the result blows up.
    assert.ok(Array.isArray(result.contents), 'contents must be an array');
    assert.ok(Array.isArray(result.scenes));
    assert.ok(Array.isArray(result.frames));

    // The matching row must surface in the top of contents.
    const ids = result.contents.map(r => r.id);
    assert.ok(
      ids.includes('mem-2'),
      `recall must include the embedding-matched row mem-2; got contents=[${ids.join(', ')}]`,
    );
    // And it should rank first — closest vector wins.
    assert.equal(
      ids[0], 'mem-2',
      `mem-2 must rank first in contents (closest by KNN); got ranking=[${ids.join(', ')}]`,
    );
  });
});

test('recallMemoriesTiered: KNN actually contributes to ranking (probe far from all → no collapse to mem-1)', async (t) => {
  await withSkippableSqliteVec(t, () => {
    writeStoredEmbeddingModelId('test-model');

    // Same seed setup, but probe with a fourth distinct vector.
    // The ANN path should still order results by distance — different
    // probe vectors must produce different rankings, otherwise KNN is
    // a no-op and we're really just testing the keyword fallback.
    const seeds = [{ id: 'mem-1', seed: 100 }, { id: 'mem-2', seed: 200 }, { id: 'mem-3', seed: 300 }];
    for (const { id, seed } of seeds) {
      upsertMemory({
        id,
        namespace: 'chat:test',
        kind: 'prompt',
        sourceId: id,
        text: `text for ${id}`,
        metadata: { chatId: 'test' },
      });
      saveMemoryEmbedding(id, `text for ${id}`, fakeEmbedding(seed), 'test-model');
    }

    // Probe with each of the 3 stored vectors — the highest-ranked
    // result must rotate accordingly. If KNN were broken, all 3
    // probes would produce the same arbitrary ranking (likely the
    // keyword fallback's sort order).
    const probe1 = fakeEmbedding(100);
    const probe2 = fakeEmbedding(200);
    const probe3 = fakeEmbedding(300);
    const top1 = recallMemoriesTiered({
      namespaces: ['chat:test'],
      queryEmbedding: probe1,
      limits: { scenes: 0, frames: 0, contents: 3 },
    }).contents.map(r => r.id);
    const top2 = recallMemoriesTiered({
      namespaces: ['chat:test'],
      queryEmbedding: probe2,
      limits: { scenes: 0, frames: 0, contents: 3 },
    }).contents.map(r => r.id);
    const top3 = recallMemoriesTiered({
      namespaces: ['chat:test'],
      queryEmbedding: probe3,
      limits: { scenes: 0, frames: 0, contents: 3 },
    }).contents.map(r => r.id);

    assert.equal(top1[0], 'mem-1', `probe=seed:100 must rank mem-1 first; got [${top1.join(', ')}]`);
    assert.equal(top2[0], 'mem-2', `probe=seed:200 must rank mem-2 first; got [${top2.join(', ')}]`);
    assert.equal(top3[0], 'mem-3', `probe=seed:300 must rank mem-3 first; got [${top3.join(', ')}]`);
  });
});

test('recallMemoriesTiered: scene+frame tiers also exercised end-to-end', async (t) => {
  await withSkippableSqliteVec(t, () => {
    writeStoredEmbeddingModelId('test-model');

    // Build a 3-tier hierarchy so the scene/frame KNN paths are also
    // covered by the production query (not just the contents tier).
    upsertMemory({
      id: 'scene-1', namespace: 'chat:t', kind: 'scene', sourceId: 's1',
      text: 'high level summary',
      metadata: { sceneId: 's1', chatId: 't', startAt: '2026-05-01T00:00:00Z', endAt: '2026-05-02T00:00:00Z' },
    });
    saveMemoryEmbedding('scene-1', 'high level summary', fakeEmbedding(7777), 'test-model');

    upsertMemory({
      id: 'frame-1', namespace: 'chat:t', kind: 'frame', sourceId: 'f1',
      text: 'mid level frame',
      metadata: { frameId: 'f1', sceneId: 's1', chatId: 't', startAt: '2026-05-01T00:00:00Z', endAt: '2026-05-01T00:30:00Z' },
    });
    saveMemoryEmbedding('frame-1', 'mid level frame', fakeEmbedding(7777), 'test-model');

    upsertMemory({
      id: 'prompt-1', namespace: 'chat:t', kind: 'prompt', sourceId: 'p1',
      text: 'leaf prompt',
      metadata: { frameId: 'f1', sceneId: 's1', chatId: 't' },
    });
    saveMemoryEmbedding('prompt-1', 'leaf prompt', fakeEmbedding(7777), 'test-model');

    const probe = fakeEmbedding(7777);
    const result = recallMemoriesTiered({
      namespaces: ['chat:t'],
      queryEmbedding: probe,
      limits: { scenes: 3, frames: 3, contents: 3 },
    });

    // All three tiers must return their respective rows when the probe
    // is dead-on. A regression that breaks the scene/frame KNN-clause
    // restriction (kind = 'scene' / 'frame') would surface as missing
    // tier rows here.
    const sceneIds = result.scenes.map(r => r.id);
    const frameIds = result.frames.map(r => r.id);
    const contentIds = result.contents.map(r => r.id);
    assert.ok(sceneIds.includes('scene-1'), `scene tier must include scene-1; got [${sceneIds.join(', ')}]`);
    assert.ok(frameIds.includes('frame-1'), `frame tier must include frame-1; got [${frameIds.join(', ')}]`);
    assert.ok(contentIds.includes('prompt-1'), `content tier must include prompt-1; got [${contentIds.join(', ')}]`);
  });
});
