import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { replaceMemories, saveMemoryEmbedding, _resetStoreForTests } from './store.js';
import { EMBEDDING_DIMS } from './embeddings.js';

test('snapshot vector reconciliation keeps unchanged vectors and rolls back a failed replacement', async () => {
  const oldHome = process.env.MELO_HOME;
  const home = await mkdtemp(join(tmpdir(), 'melo-snapshot-vectors-'));
  process.env.MELO_HOME = home;
  _resetStoreForTests();
  let database;
  try {
    const entry = { id: 'existing', namespace: 'chat:test', kind: 'fact', text: 'keep me', searchText: 'keep me' };
    replaceMemories([entry]);
    const vector = new Float32Array(EMBEDDING_DIMS); vector[0] = 1;
    saveMemoryEmbedding(entry.id, entry.searchText, vector);
    database = new DatabaseSync(join(home, 'desktop/store.sqlite'), { allowExtension: true });
    sqliteVec.load(database);
    const original = database.prepare('SELECT embedding FROM vec_memories WHERE memory_id = ?').get(entry.id);
    replaceMemories([{ ...entry, metadata: { topicTags: ['updated'] } }]);
    assert.deepEqual(database.prepare('SELECT embedding FROM vec_memories WHERE memory_id = ?').get(entry.id), original);
    const duplicate = { ...entry, id: 'duplicate' };
    assert.throws(() => replaceMemories([duplicate, duplicate]), /UNIQUE|constraint/i);
    assert.equal(database.prepare('SELECT count(*) AS n FROM memories WHERE id = ?').get(entry.id).n, 1);
    assert.deepEqual(database.prepare('SELECT embedding FROM vec_memories WHERE memory_id = ?').get(entry.id), original);
    replaceMemories([{ ...entry, text: 'different content', searchText: 'different content' }]);
    assert.equal(database.prepare('SELECT count(*) AS n FROM vec_memories').get().n, 0);
  } finally {
    database?.close(); _resetStoreForTests();
    if (oldHome === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});
