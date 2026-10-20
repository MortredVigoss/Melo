import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { projectMemoryPayload, projectMemoryEnvelope } from '../../mobile-sync/projectMemoryProtocol.js';
import { putWorkspace } from '../../mobile-sync/workspaceProtocol.js';

test('fresh and existing project memory survives concurrent saves, edits, sync, indexing and restart', { timeout: 90000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-project-memory-concurrent-http-'));
  const token = 'isolated-project-concurrency-fixture-'.repeat(3);
  const env = { ...process.env, MELO_HOME: home, MELO_SYNC_TOKEN: token, MELO_TEST_MODE: '1', MELO_DREAMING_ENABLED: '0', MELO_MEMORY_RUNTIME: '0' };
  const barrier = new Int32Array(new SharedArrayBuffer(8));
  let child, closed, base, worker;
  async function stop() {
    if (!child) return;
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.kill('SIGTERM'); await closed; clearTimeout(timer); child = null;
  }
  async function start() {
    child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    closed = once(child, 'exit');
    base = await new Promise((resolve, reject) => {
      let logs = '';
      const timer = setTimeout(() => reject(new Error(logs.slice(-3000))), 30000);
      child.stderr.on('data', bytes => logs += bytes);
      child.stdout.on('data', bytes => {
        logs += bytes;
        const match = logs.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(logs.slice(-3000))); });
    });
  }
  async function request(path, body) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET',
      headers: { origin: base, 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    return response.json();
  }
  t.after(async () => {
    Atomics.store(barrier, 0, 1);
    if (worker) await worker.terminate();
    await stop(); await rm(home, { recursive: true, force: true });
  });
  await start();
  const created = await request('/api/projects', { name: 'Concurrent memory fixture' });
  const project = created.projects.find(p => p.name === 'Concurrent memory fixture');
  assert.ok(project);
  worker = new Worker(`
    const {parentPort, workerData} = require('node:worker_threads');
    (async () => {
      const {indexKnowledgeDocuments} = await import(workerData.module);
      const barrier = new Int32Array(workerData.barrier);
      let n = 0;
      try {
        do {
          indexKnowledgeDocuments({home: workerData.home, documents: [{id:'fixture', content:'Concurrent index revision ' + n}]});
          Atomics.add(barrier, 1, 1);
          if (n++ === 0) parentPort.postMessage('ready');
          await new Promise(resolve => setTimeout(resolve, 5));
        } while (!Atomics.load(barrier, 0));
        parentPort.postMessage({ok:true, writes:n});
      } catch (error) { parentPort.postMessage({ok:false, error:error.message}); }
    })();
  `, { eval: true, workerData: { home, barrier: barrier.buffer, module: new URL('../memory/knowledgeIndex.js', import.meta.url).href } });
  assert.equal((await once(worker, 'message'))[0], 'ready');
  const indexed = once(worker, 'message');
  const expected = new Map();
  for (let phase = 0; phase < 2; phase++) {
    const writesBefore = Atomics.load(barrier, 1);
    const rows = await Promise.all(Array.from({ length: 8 }, (_, i) => request('/api/projects/memory-book', {
      projectId: project.id, text: `Phase ${phase} original memory ${i}`, section: 'convention',
    })));
    rows.forEach(row => expected.set(row.id, row.text));
    const wire = await request('/api/project-memory-sync');
    const remoteRow = wire.records.find(row => projectMemoryPayload(row.versions[0].value).memoryID === rows[0].id);
    assert.ok(remoteRow);
    const remoteText = `Phase ${phase} phone edit`;
    putWorkspace(wire, 'knowledge', remoteRow.id, projectMemoryEnvelope({
      ...projectMemoryPayload(remoteRow.versions[0].value), text: remoteText, updatedAt: `2099-01-0${phase + 1}T00:00:00Z`,
    }), 'phone');
    expected.set(rows[0].id, remoteText);
    await Promise.all([
      request('/api/project-memory-sync', wire),
      ...rows.slice(1).map((row, i) => {
        const text = `Phase ${phase} desktop edit ${i}`; expected.set(row.id, text);
        return request('/api/memory/facts/update', { id: row.id, patch: { text, pinned: true } });
      }),
    ]);
    assert.ok(Atomics.load(barrier, 1) > writesBefore, 'independent index writes overlap requests');
    await stop(); await start();
    const book = await request('/api/projects/memory-book?projectId=' + encodeURIComponent(project.id));
    let rawDiagnostic = [];
    if (book.records.length !== expected.size) {
      const { withMemoryHome, iterateMemoryRecords } = await import('../memory/store.js');
      rawDiagnostic = withMemoryHome(home, () => [...iterateMemoryRecords()].filter(row => expected.has(row.id)));
    }
    assert.equal(book.records.length, expected.size, 'no lost or duplicate memory after restart: ' + JSON.stringify({expected:[...expected],actual:book.records.map(row=>[row.id,row.text]),raw:rawDiagnostic}));
    for (const row of book.records) assert.equal(row.text, expected.get(row.id));
    const synced = await request('/api/project-memory-sync');
    assert.equal(synced.records.length, expected.size);
    for (const row of synced.records) {
      assert.equal(row.versions.length, 1, 'independent edits do not invent conflicts');
      const value = projectMemoryPayload(row.versions[0].value);
      assert.equal(value.text, expected.get(value.memoryID));
    }
  }
  Atomics.store(barrier, 0, 1);
  const result = (await indexed)[0];
  assert.equal(result.ok, true, result.error);
  assert.ok(result.writes > 2);
});
