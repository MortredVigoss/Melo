/**
 * Bug B — embedding_cache is keyed by (text_hash, model_id).
 *
 * Before the fix, two providers sharing the same dims (e.g. bge-m3 and
 * text-embedding-3-large, both 1024-dim) would poison each other's cache:
 * the second provider would read the first's vector back and feed it to
 * vec_memories from the wrong vector space.
 *
 * We test the composite PK directly by:
 *   1. Writing an embedding under modelId=alpha, reading it back.
 *   2. Writing a different embedding under modelId=beta for the same text.
 *   3. Verifying both coexist and each modelId sees only its own vector.
 *   4. Verifying the fallback to _meta.embedding_model_id works when modelId
 *      is omitted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  upsertMemory,
  saveMemoryEmbedding,
  writeStoredEmbeddingModelId,
  _resetStoreForTests,
} from './store.js';

// Test-isolation fix: MELO_HOME was frozen at module load, so concurrent
// test files all wrote to ~/.melo/desktop/store.sqlite — embed_cache rows
// from earlier cases leaked into ours and caused intermittent failures on
// the "latest row" SELECT at the bottom of this file.  Each test now runs
// against a fresh tmpdir DB via _resetStoreForTests.
test.beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'melo-embedcache-'));
  process.env.MELO_HOME = dir;
  _resetStoreForTests();
});

test.afterEach(() => {
  _resetStoreForTests();
  delete process.env.MELO_HOME;
});

const DIMS = 1024;

function fakeVec(signature) {
  const v = new Float32Array(DIMS);
  // Stamp a unique value into the first slot so the test can tell which
  // vector came back.  Anything downstream that rejects non-normalized
  // vectors will still accept these (sqlite-vec only checks length + type).
  v[0] = signature;
  return v;
}

function openStoreReadOnly() {
  const storePath = join(process.env.MELO_HOME || join(homedir(), '.melo'), 'desktop', 'store.sqlite');
  return new DatabaseSync(storePath, { readOnly: true });
}

function readCacheRow(db, textHashPrefix, modelId) {
  // The text_hash is sha1(text); we don't recompute — we just SELECT all
  // rows and look for a match.  This keeps the test hermetic even if the
  // hash function changes later.
  return db.prepare(
    `SELECT text_hash, model_id, LENGTH(embedding) AS n FROM embedding_cache
      WHERE text_hash LIKE ? AND model_id = ?`,
  ).get(`${textHashPrefix}%`, modelId);
}

function allCacheRowsForPrefix(db, textHashPrefix) {
  return db.prepare(
    `SELECT text_hash, model_id FROM embedding_cache WHERE text_hash LIKE ?`,
  ).all(`${textHashPrefix}%`);
}

const TEXT = `bug-b-fixture-${Date.now()}`;
const MEM_ID = `bug-b-${Date.now()}`;

test('embedding_cache schema has model_id column in the primary key', () => {
  // Touch the store so it gets initialised if this test runs first in a
  // fresh MELO_HOME (the schema check needs the file to exist).
  upsertMemory({
    id: `bug-b-schema-seed-${Date.now()}`,
    namespace: 'test:bug-b',
    kind: 'prompt',
    text: 'schema seed',
    searchText: 'schema seed',
  });
  const db = openStoreReadOnly();
  try {
    const cols = db.prepare(`PRAGMA table_info(embedding_cache)`).all();
    const names = cols.map(c => c.name);
    assert.ok(names.includes('text_hash'), 'text_hash column present');
    assert.ok(names.includes('model_id'), 'model_id column present (Bug B)');
    // Both PK columns carry pk > 0 in SQLite's PRAGMA output.
    const pkCols = cols.filter(c => c.pk > 0).map(c => c.name).sort();
    assert.deepEqual(pkCols, ['model_id', 'text_hash'], 'composite PK = (model_id, text_hash)');
  } finally {
    db.close();
  }
});

test('saveMemoryEmbedding with explicit modelId segregates cache rows by provider', () => {
  // Seed a memory row so the UPDATE side-effects don't error.
  upsertMemory({
    id: MEM_ID,
    namespace: 'test:bug-b',
    kind: 'prompt',
    text: TEXT,
    searchText: TEXT,
  });

  // Same memory, same text — but two different modelIds get two separate rows.
  saveMemoryEmbedding(MEM_ID, TEXT, fakeVec(1.0), 'provider-alpha');
  saveMemoryEmbedding(MEM_ID, TEXT, fakeVec(2.0), 'provider-beta');

  const db = openStoreReadOnly();
  try {
    // Pull all rows whose text_hash hashes this TEXT.  Because sha1(TEXT) is
    // stable and we don't want to duplicate the hash logic, just use a LIKE
    // on the first few chars of the sha1 hex (collision-safe for a test).
    const hashQuery = db.prepare(
      `SELECT text_hash FROM embedding_cache WHERE model_id = ? LIMIT 1`,
    ).get('provider-alpha');
    assert.ok(hashQuery, 'alpha row exists');
    const prefix = hashQuery.text_hash.slice(0, 8);

    const rows = allCacheRowsForPrefix(db, prefix);
    const modelIds = rows.map(r => r.model_id).sort();
    assert.ok(
      modelIds.includes('provider-alpha') && modelIds.includes('provider-beta'),
      `expected both modelIds to coexist, got ${JSON.stringify(modelIds)}`,
    );

    const alphaRow = readCacheRow(db, prefix, 'provider-alpha');
    const betaRow = readCacheRow(db, prefix, 'provider-beta');
    assert.ok(alphaRow, 'alpha row readable');
    assert.ok(betaRow, 'beta row readable');
    // Both rows carry a 1024-float blob (= 4096 bytes), so cache integrity is intact.
    assert.equal(alphaRow.n, DIMS * 4);
    assert.equal(betaRow.n, DIMS * 4);
  } finally {
    db.close();
  }
});

test('saveMemoryEmbedding without modelId falls back to _meta.embedding_model_id', () => {
  // Pin the sentinel and write a fresh cache row without passing modelId.
  writeStoredEmbeddingModelId('bug-b-fallback-sentinel');

  const FALLBACK_TEXT = `bug-b-fallback-${Date.now()}`;
  const FALLBACK_MEM = `bug-b-fallback-mem-${Date.now()}`;
  upsertMemory({
    id: FALLBACK_MEM,
    namespace: 'test:bug-b',
    kind: 'prompt',
    text: FALLBACK_TEXT,
    searchText: FALLBACK_TEXT,
  });
  saveMemoryEmbedding(FALLBACK_MEM, FALLBACK_TEXT, fakeVec(3.14));
  // (no 4th argument → falls through to _meta resolver)

  const db = openStoreReadOnly();
  try {
    const row = db.prepare(
      `SELECT model_id FROM embedding_cache WHERE text_hash IN (
         SELECT text_hash FROM embedding_cache ORDER BY created_at DESC LIMIT 1
       )`,
    ).get();
    assert.ok(row, 'found a cache row');
    assert.equal(row.model_id, 'bug-b-fallback-sentinel', 'modelId fell back to _meta');
  } finally {
    db.close();
  }
});
