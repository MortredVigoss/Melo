import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { applyMemoryStoreSchema } from './storeSchema.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'melo-schema-boundary-'));
  const handles = [];
  t.after(() => {
    for (const db of handles) { try { db.close(); } catch {} }
    rmSync(directory, { recursive: true, force: true });
  });
  return name => {
    const db = new DatabaseSync(join(directory, name));
    handles.push(db);
    return db;
  };
}
function insertMemory(db, id = 'original') {
  db.prepare(`INSERT INTO memories (id, namespace, kind, text, search_text, created_at, updated_at)
    VALUES (?, 'project:original', 'fact', '原文 untouched', '原文 untouched', '2026-01-01', '2026-01-01')`).run(id);
}

test('schema initialization preserves caller ownership, durable data, and repeat-open behavior', t => {
  const open = fixture(t);
  const first = open('store.sqlite');
  assert.deepEqual(applyMemoryStoreSchema(first, false), { vecAvailable: false });
  assert.equal(first.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(first.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(first.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  insertMemory(first);
  first.close();
  const reopened = open('store.sqlite');
  applyMemoryStoreSchema(reopened, false);
  applyMemoryStoreSchema(reopened, false);
  assert.equal(reopened.prepare('SELECT text FROM memories').get().text, '原文 untouched');
  // The schema helper must neither close nor own a transaction on this handle.
  reopened.exec('BEGIN IMMEDIATE');
  insertMemory(reopened, 'rollback');
  reopened.exec('ROLLBACK');
  assert.equal(reopened.prepare('SELECT count(*) AS count FROM memories').get().count, 1);
});

test('legacy caches and hit tables migrate without losing valid rows and remain idempotent', t => {
  const db = fixture(t)('legacy.sqlite');
  applyMemoryStoreSchema(db, false);
  insertMemory(db);
  db.exec(`DROP TABLE embedding_cache;
    CREATE TABLE embedding_cache (text_hash TEXT PRIMARY KEY, embedding BLOB NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO _meta VALUES ('embedding_model_id', 'legacy-model');
    DROP TABLE memory_hits;
    CREATE TABLE memory_hits (memory_id TEXT, hit_at TEXT, query_hash TEXT, rank INTEGER, outcome TEXT);
    INSERT INTO memory_hits VALUES ('original', '2026-01-01', 'query', 1, 'used');
    INSERT INTO memory_hits VALUES ('orphan', '2026-01-01', 'query', 2, 'used');`);
  const bytes = Buffer.from([0, 255, 17, 4]);
  db.prepare("INSERT INTO embedding_cache VALUES ('hash', ?, '2026-01-01')").run(bytes);
  applyMemoryStoreSchema(db, false);
  applyMemoryStoreSchema(db, false);
  assert.deepEqual(Buffer.from(db.prepare('SELECT embedding FROM embedding_cache').get().embedding), bytes);
  assert.equal(db.prepare('SELECT model_id FROM embedding_cache').get().model_id, 'legacy-model');
  assert.equal(db.prepare('SELECT count(*) AS count FROM memory_hits').get().count, 1);
  db.prepare("INSERT INTO embedding_cache VALUES ('hash', 'new-model', ?, '2026-02-01')").run(bytes);
  assert.equal(db.prepare('SELECT count(*) AS count FROM embedding_cache').get().count, 2);
  db.exec("INSERT INTO memory_hits (memory_id, hit_at, request_id) VALUES ('original', '2026-02-01', 'request')");
  assert.throws(() => db.exec("INSERT INTO memory_hits (memory_id, hit_at, request_id) VALUES ('original', '2026-02-01', 'request')"), /UNIQUE/);
  db.exec("DELETE FROM memories WHERE id = 'original'");
  assert.equal(db.prepare('SELECT count(*) AS count FROM memory_hits').get().count, 0);
});

test('unavailable vector module and incompatible old index remain recoverable without deleting data', t => {
  const open = fixture(t);
  const missing = open('missing-vec.sqlite');
  assert.deepEqual(applyMemoryStoreSchema(missing, true), { vecAvailable: false });
  insertMemory(missing);
  assert.equal(missing.prepare('SELECT text FROM memories').get().text, '原文 untouched');
  const legacy = open('old-vec.sqlite');
  legacy.exec(`CREATE TABLE vec_memories (memory_id TEXT PRIMARY KEY, embedding "float[3]");
    INSERT INTO vec_memories VALUES ('saved-vector', 'original vector bytes');`);
  assert.deepEqual(applyMemoryStoreSchema(legacy, true), { vecAvailable: false });
  assert.equal(legacy.prepare("SELECT value FROM _meta WHERE key = 'embedding_repair_required'").get().value, '1');
  assert.equal(legacy.prepare('SELECT embedding FROM vec_memories').get().embedding, 'original vector bytes');
});

test('schema calls use only their supplied handles across home changes', t => {
  const open = fixture(t), a = open('a.sqlite'), b = open('b.sqlite');
  const before = process.env.MELO_HOME;
  t.after(() => { if (before === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = before; });
  process.env.MELO_HOME = '/nonexistent/not-the-schema-owner-a';
  applyMemoryStoreSchema(a, false);
  insertMemory(a, 'a');
  process.env.MELO_HOME = '/nonexistent/not-the-schema-owner-b';
  applyMemoryStoreSchema(b, false);
  insertMemory(b, 'b');
  applyMemoryStoreSchema(a, false);
  assert.deepEqual(a.prepare('SELECT id FROM memories').all().map(row => row.id), ['a']);
  assert.deepEqual(b.prepare('SELECT id FROM memories').all().map(row => row.id), ['b']);
});
