// Recall stays read-only; actual model requests record one feedback batch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  upsertMemory,
  recallMemories,
  markMemoriesUsed,
  recordMemoryFeedback,
  saveMemoryEmbedding,
  writeStoredEmbeddingModelId,
  _resetStoreForTests,
} from './store.js';

let _sqliteVecModule = null;
try { _sqliteVecModule = await import('sqlite-vec'); } catch { /* optional */ }
function sqliteVecAvailable() { return _sqliteVecModule !== null; }

let _tmpDir = null;

test.beforeEach(() => {
  _tmpDir = mkdtempSync(join(tmpdir(), 'melo-recall-hits-'));
  process.env.MELO_HOME = _tmpDir;
  _resetStoreForTests();
});

test.afterEach(async () => {
  _resetStoreForTests();
  if (_tmpDir) await rm(_tmpDir, { recursive: true, force: true });
  _tmpDir = null;
});

// PRNG-seeded vectors — same shape as recallE2E for vec compatibility.
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

function readHits() {
  // Open read-only so we don't fight the writable handle the store keeps.
  const db = new DatabaseSync(join(_tmpDir, 'desktop', 'store.sqlite'), { readOnly: true });
  try {
    return db.prepare(
      'SELECT memory_id, hit_at, query_hash, rank, outcome FROM memory_hits ORDER BY rowid ASC',
    ).all();
  } finally {
    db.close();
  }
}

function seedRows(n, namespace = 'chat:test') {
  for (let i = 0; i < n; i += 1) {
    upsertMemory({
      id: `seed-${i}`,
      namespace,
      kind: 'prompt',
      text: `seed text ${i} singapore mango`,
      searchText: `seed text ${i} singapore mango`,
      metadata: { useCount: 0 },
    });
  }
}

test('recallMemories keyword recall is read-only; explicit feedback records candidate rank and query hash', () => {
  seedRows(4);
  const before = readHits();
  assert.equal(before.length, 0, 'hit log starts empty');

  const rows = recallMemories({
    namespaces: ['chat:test'],
    kinds: ['prompt'],
    query: 'singapore',
    limit: 4,
  });
  assert.ok(rows.length > 0, 'recall must surface seeded rows');

  assert.equal(readHits().length,0,'retrieval must not write feedback');
  recordMemoryFeedback({candidates:rows,requestId:'keyword-turn',query:'singapore'});
  const after = readHits();
  assert.equal(after.length, rows.length, 'one hit row per returned row');

  // Same query → same hash for every hit row in this batch.
  const hashes = new Set(after.map(h => h.query_hash));
  assert.equal(hashes.size, 1, 'all hits share the queryHash for this single recall');
  assert.ok([...hashes][0], 'queryHash must be set when query is non-empty');

  // Ranks must be 0..N-1 with no gaps and no duplicates.
  const ranks = after.map(h => h.rank).sort((a, b) => a - b);
  assert.deepEqual(ranks, rows.map((_, i) => i), 'ranks must be 0..N-1');

  // Outcome starts NULL — markMemoriesUsed promotes it later (test 3).
  for (const h of after) {
    assert.equal(h.outcome, null, 'outcome must be NULL at insert time');
    assert.ok(h.hit_at, 'hit_at must be a timestamp');
  }
});

test('recallMemories keyword path: empty-result recall does NOT pollute hits', () => {
  seedRows(2);
  // Recall against a namespace that has no rows.
  const rows = recallMemories({
    namespaces: ['chat:nonexistent-namespace'],
    kinds: ['prompt'],
    query: 'singapore',
    limit: 4,
  });
  assert.equal(rows.length, 0, 'no rows match the empty namespace');

  const hits = readHits();
  assert.equal(hits.length, 0, 'no rows recalled → no hit log entries');
});

test('explicit feedback creates hits for markMemoriesUsed without counting candidates as used', () => {
  seedRows(3);
  const rows = recallMemories({
    namespaces: ['chat:test'],
    kinds: ['prompt'],
    query: 'mango',
    limit: 3,
  });
  assert.ok(rows.length > 0);

  recordMemoryFeedback({candidates:rows,requestId:'mark-turn',query:'mango'});
  // Before mark: every hit outcome is NULL.
  const beforeMark = readHits();
  assert.ok(beforeMark.every(h => h.outcome === null));

  const updated = markMemoriesUsed(rows.map(r => r.id));
  assert.equal(updated, rows.length, 'one update per recalled id');

  const afterMark = readHits();
  for (const h of afterMark) {
    assert.equal(h.outcome, 'used', 'every recalled-then-marked hit flips to outcome=used');
  }
});

test('recallMemories semantic path uses the same explicit feedback contract', async (t) => {
  if (!sqliteVecAvailable()) {
    t.skip('sqlite-vec not installed');
    return;
  }
  writeStoredEmbeddingModelId('test-model');

  // Seed three rows with distinct embeddings; probe with mem-2's vector.
  const TARGET_SEED = 4242;
  const seeds = [
    { id: 'sem-1', seed: 11 },
    { id: 'sem-2', seed: TARGET_SEED },
    { id: 'sem-3', seed: 7777 },
  ];
  for (const { id, seed } of seeds) {
    upsertMemory({
      id,
      namespace: 'chat:test',
      kind: 'prompt',
      sourceId: id,
      text: `semantic body for ${id}`,
      searchText: `semantic body for ${id}`,
      metadata: { chatId: 'test' },
    });
    saveMemoryEmbedding(id, `semantic body for ${id}`, fakeEmbedding(seed), 'test-model');
  }

  const rows = recallMemories({
    namespaces: ['chat:test'],
    kinds: ['prompt'],
    query: 'probe',
    queryEmbedding: fakeEmbedding(TARGET_SEED),
    limit: 3,
  });
  assert.ok(rows.length > 0, 'semantic recall must return rows');

  assert.equal(readHits().length,0);
  recordMemoryFeedback({candidates:rows,requestId:'semantic-turn',query:'probe'});
  const hits = readHits();
  assert.equal(hits.length, rows.length, 'semantic path also writes one hit per row');
  assert.ok(hits.every(h => h.query_hash), 'queryHash present on semantic-path hits');

  const ranks = hits.map(h => h.rank).sort((a, b) => a - b);
  assert.deepEqual(ranks, rows.map((_, i) => i), 'ranks 0..N-1 on semantic path too');
});
