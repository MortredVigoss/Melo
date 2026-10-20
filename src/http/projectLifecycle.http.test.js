import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { atomicWriteJson } from '../storage.js';

test('real project routes detach safely, invalidate approvals, and recover durable deletion after restart', { timeout: 60000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-project-http-'));
  const original = join(home, 'original.png');
  const forbidden = join(home, 'must-not-exist');
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
  await writeFile(original, bytes);
  await atomicWriteJson(join(home, 'desktop/state.json'), {
    projects: [{ id: 'old', name: 'Old', workspacePath: home }, { id: 'new', name: 'New', workspacePath: home }],
    chats: [{ id: 'chat', projectId: 'old', title: 'Keep chat', messages: [{ id: 'message', role: 'assistant', content: 'original text' }] }],
    approvals: [{ id: 'approval', chatId: 'chat', status: 'pending', kind: 'command', payload: { command: `touch '${forbidden}'` } }],
    chatRuns: [{ id: 'completed', chatId: 'chat', projectId: 'old', status: 'completed', workspacePath: home }],
  });
  let child, closed, base;
  async function stop() {
    if (!child) return;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.kill('SIGTERM'); await closed; clearTimeout(timeout); child = null;
  }
  t.after(async () => { await stop(); await rm(home, { recursive: true, force: true }); });
  async function start() {
    child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], {
      env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_MEMORY_RUNTIME: '0', MELO_DREAMING_ENABLED: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    closed = once(child, 'exit');
    let log = '';
    child.stderr.on('data', chunk => { log += chunk; });
    base = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(log.slice(-1000))), 20000);
      child.once('exit', () => { clearTimeout(timeout); reject(new Error(log.slice(-1000))); });
      child.stdout.on('data', chunk => {
        log += chunk;
        const match = log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
  }
  async function post(path, body, expected = 200) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  }
  await start();
  const moved = await post('/api/chats/update', { chatId: 'chat', patch: { projectId: 'new' } });
  assert.equal(moved.approvals.find(row => row.id === 'approval').status, 'rejected');
  const rejected = await fetch(base + '/api/approvals/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId: 'approval' }) });
  assert.notEqual(rejected.status, 200);
  await assert.rejects(readFile(forbidden), { code: 'ENOENT' });
  const deleted = await post('/api/projects/lifecycle', { projectId: 'new', action: 'delete', operationId: 'delete-once' });
  assert.ok(deleted.projects.find(row => row.id === 'new').deletedAt);
  assert.equal(deleted.chats.find(row => row.id === 'chat').projectId, null);
  await stop(); await start();
  const replay = await post('/api/projects/lifecycle', { projectId: 'new', action: 'delete', operationId: 'after-response-loss' });
  assert.equal(replay.projects.find(row => row.id === 'new').lifecycle.deleteOperationId, 'delete-once');
  const restored = await post('/api/projects/lifecycle', { projectId: 'new', action: 'restore', operationId: 'restore-once' });
  const replacement = restored.projects.find(row => row.id === 'new').lifecycle.restoredProjectId;
  assert.ok(replacement && replacement !== 'new');
  const again = await post('/api/projects/lifecycle', { projectId: 'new', action: 'restore', operationId: 'restore-retry' });
  assert.equal(again.projects.filter(row => row.id === replacement).length, 1);
  assert.deepEqual(await readFile(original), bytes);
  const saved = JSON.parse(await readFile(join(home, 'desktop/state.json'), 'utf8'));
  assert.equal(saved.chatRuns.find(row => row.id === 'completed').projectId, 'old');
  assert.equal(saved.chatRuns.find(row => row.id === 'completed').workspacePath, home);
});
