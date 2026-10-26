import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDevelopmentRoutes } from './developmentRoutes.js';

test('development HTTP rejects foreign origins and sync credentials before any mutation', async t => {
  let creates = 0, approvals = 0;
  const service = { list: async () => [], prepare: async () => ({}), create: async body => { creates++; return body; }, approve: async () => { approvals++; return {}; } };
  const routes = createDevelopmentRoutes({ service });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    await routes.handle(request, response, url, (req, res) => {
      if (req.headers.origin === 'http://local.test') return true;
      res.writeHead(403); res.end(); return false;
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const post = (path, headers = {}, body = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/development/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('create', { origin: 'https://evil.test' })).status, 403);
  assert.equal((await post('approve', { origin: 'http://local.test', authorization: 'Bearer sync-token' })).status, 403);
  assert.equal(creates, 0); assert.equal(approvals, 0);
  assert.equal((await post('create', { origin: 'http://local.test' }, { goal: 'fixture' })).status, 200);
  assert.equal(creates, 1);
});

test('real server exposes development jobs and keeps mutations behind the origin gate', { timeout: 45000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-dev-http-'));
  const child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], { cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_MEMORY_RUNTIME: '0', MELO_DREAMING_ENABLED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'exit');
  t.after(async () => { const timer = setTimeout(() => child.kill('SIGKILL'), 5000); child.kill('SIGTERM'); await closed; clearTimeout(timer); await rm(home, { recursive: true, force: true }); });
  let log = '';
  child.stderr.on('data', chunk => { log += chunk; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(log.slice(-2000))), 20000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(log.slice(-2000))); });
    child.stdout.on('data', chunk => { log += chunk; const match = log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const result = await fetch(base + '/api/development/jobs'); assert.equal(result.status, 200); assert.deepEqual(await result.json(), { jobs: [] });
  const denied = await fetch(base + '/api/development/create', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 403);
});
