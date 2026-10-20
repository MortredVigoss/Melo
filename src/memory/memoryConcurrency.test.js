import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { withTransaction, _resetStoreForTests, patchMemories } from './store.js';
import { createUserBookRow, listProjectBook } from './projectBook.js';
import { indexKnowledgeDocuments } from './knowledgeIndex.js';
import { runWithRequestContext } from '../runtime/requestScope.js';

test('project memory read-then-write stays atomic against a background index connection', { timeout: 15000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-memory-concurrency-'));
  const barrier = new Int32Array(new SharedArrayBuffer(8));
  let worker;
  t.after(async () => {
    if (worker) await worker.terminate();
    _resetStoreForTests();
    await rm(home, { recursive: true, force: true });
  });
  _resetStoreForTests();
  await runWithRequestContext({ env: { ...process.env, MELO_HOME: home } }, async () => {
    createUserBookRow({ projectId: 'P', text: 'Keep the original memory' });
    indexKnowledgeDocuments({ home, documents: [{ id: 'source', content: 'Original knowledge' }] });
    worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { indexKnowledgeDocuments } = await import(workerData.module);
        const barrier = new Int32Array(workerData.barrier);
        parentPort.postMessage('ready');
        Atomics.wait(barrier, 0, 0, 10000);
        try {
          indexKnowledgeDocuments({home: workerData.home, documents: [{id: 'source', content: 'Concurrent knowledge update'}]});
          parentPort.postMessage({ok: true});
        } catch (e) { parentPort.postMessage({ok: false, message: e.message, code: e.errcode}); }
        finally { Atomics.store(barrier, 1, 1); Atomics.notify(barrier, 1); }
      })();
    `, { eval: true, workerData: { home, barrier: barrier.buffer, module: new URL('./knowledgeIndex.js', import.meta.url).href } });
    assert.equal((await once(worker, 'message'))[0], 'ready');
    const indexed = once(worker, 'message');
    let saved, error;
    try {
      withTransaction(() => {
        assert.equal(listProjectBook('P').length, 1);
        Atomics.store(barrier, 0, 1); Atomics.notify(barrier, 0);
        // Deferred BEGIN lets the other connection commit over this read
        // snapshot, then fails with SQLITE_BUSY_SNAPSHOT at the first write.
        // A writer reservation blocks the worker until this transaction ends.
        // Bound the wait so the test cannot deadlock the reserved transaction.
        Atomics.wait(barrier, 1, 0, 1000);
        saved = createUserBookRow({ projectId: 'P', text: 'Preserve the new memory too' });
      });
    } catch (e) { error = e; }
    assert.deepEqual((await indexed)[0], { ok: true });
    if (error) throw error;
    assert.ok(saved.id);
    _resetStoreForTests();
    assert.deepEqual(listProjectBook('P').map(row => row.text).sort(), ['Keep the original memory', 'Preserve the new memory too']);
    const db = new DatabaseSync(join(home, 'desktop', 'store.sqlite'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT text FROM knowledge_chunks').get().text, 'Concurrent knowledge update'); }
    finally { db.close(); }
  });
});

test('a failed nested book write rolls back atomically and releases its writer reservation', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-memory-rollback-'));
  t.after(async () => { _resetStoreForTests(); await rm(home, { recursive: true, force: true }); });
  _resetStoreForTests();
  runWithRequestContext({ env: { ...process.env, MELO_HOME: home } }, () => {
    const original = createUserBookRow({ projectId: 'P', text: 'Keep the committed row' });
    assert.throws(() => withTransaction(() => {
      createUserBookRow({ projectId: 'P', text: 'Must not survive a failed transaction' });
      withTransaction(() => { throw new Error('controlled failure'); });
    }), /controlled failure/);
    assert.deepEqual(listProjectBook('P').map(row => row.id), [original.id]);
    // A separate writer can commit immediately; no transaction/handle leaks.
    assert.equal(indexKnowledgeDocuments({ home, documents: [{ id: 'source', content: 'Written after rollback' }] }), true);
    createUserBookRow({ projectId: 'P', text: 'A subsequent save succeeds' });
    _resetStoreForTests();
    assert.equal(listProjectBook('P').length, 2);
  });
});

// A cold process may meet a writer before WAL/schema setup. The timeout must
// already be installed before the first PRAGMA that needs a database lock.
for (const disposable of [false, true]) test(`cold ${disposable ? 'captured-path' : 'cached'} memory open waits for an independent writer`, { timeout: 15000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-memory-cold-lock-'));
  const path = join(home, 'desktop', 'store.sqlite');
  await mkdir(join(home, 'desktop'));
  const seed = new DatabaseSync(path);
  seed.exec("CREATE TABLE startup_probe(value TEXT); INSERT INTO startup_probe VALUES ('before')");
  seed.close();
  let worker;
  t.after(async () => { if (worker) await worker.terminate(); _resetStoreForTests(); await rm(home, { recursive: true, force: true }); });
  _resetStoreForTests();
  worker = new Worker(`
    const {parentPort,workerData} = require('node:worker_threads');
    const {DatabaseSync} = require('node:sqlite');
    const db = new DatabaseSync(workerData);
    db.exec('BEGIN EXCLUSIVE');
    parentPort.postMessage('locked');
    parentPort.once('message', () => setTimeout(() => {
      db.exec("UPDATE startup_probe SET value='after'; COMMIT"); db.close(); parentPort.postMessage('committed');
    }, 300));
  `, { eval: true, workerData: path });
  assert.equal((await once(worker, 'message'))[0], 'locked');
  const committed = once(worker, 'message');
  worker.postMessage('open');
  let failure;
  try {
    runWithRequestContext({ env: { ...process.env, MELO_HOME: home } }, () => {
      if (disposable) patchMemories([], { storePath: path });
      else assert.deepEqual(listProjectBook('P'), []);
    });
  } catch (error) { failure = error; }
  assert.equal((await committed)[0], 'committed');
  if (failure) throw failure;
  _resetStoreForTests();
  const check = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(check.prepare('SELECT value FROM startup_probe').get().value, 'after');
    assert.equal(check.prepare('SELECT count(*) AS n FROM memories').get().n, 0);
  } finally { check.close(); }
});
