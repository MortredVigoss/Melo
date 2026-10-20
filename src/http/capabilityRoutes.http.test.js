// Capability elevation HTTP routes (2026-10-20): validation, 404 for unknown
// or ended requests, grant listing and revocation, and the real server wiring
// (origin gate included).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createCapabilityRoutes } from './capabilityRoutes.js';
import { createRequestContext } from '../runtime/requestContext.js';
import { updateStateAtomically } from '../state/stateStore.js';
import { capabilitiesFromAtoms } from '../domain/agent/capabilityElevation.js';
import { capabilityScopeForProfile, withElevationSurface } from '../domain/agent/capabilityScope.js';
import { requestCapabilityElevation, resetCapabilityElevationForTests } from '../services/agent/capabilityElevation.js';

async function serve(t, home) {
  const routes = createCapabilityRoutes({ home });
  const gate = (request, response) => {
    if (!request.headers.origin || request.headers.origin === `http://127.0.0.1:${server.address().port}`) return true;
    response.writeHead(403, { 'content-type': 'application/json' }); response.end('{"error":"FORBIDDEN_ORIGIN"}'); return false;
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (!(await routes.handle(request, response, url, gate))) { response.writeHead(404); response.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    post: async (path, body, headers = {}) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }); return { status: r.status, json: await r.json() }; },
    get: async path => { const r = await fetch(base + path); return { status: r.status, json: await r.json() }; },
  };
}

test('respond / list / revoke validate input and only act on live requests', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-capability-http-'));
  t.after(async () => { resetCapabilityElevationForTests(); await rm(home, { recursive: true, force: true }); });
  await updateStateAtomically(state => { state.agentProfiles.main.capabilities = capabilitiesFromAtoms(['readFiles']); return state; }, { home });
  const http = await serve(t, home);

  assert.equal((await http.post('/api/capability-requests/respond', { requestId: '00000000-0000-4000-8000-000000000000', decision: 'run' })).status, 404);
  assert.equal((await http.post('/api/capability-requests/respond', { requestId: 'x', decision: 'run' })).status, 400);
  assert.equal((await http.post('/api/capability-requests/respond', { requestId: '00000000-0000-4000-8000-000000000000', decision: 'sudo' })).status, 400);
  assert.equal((await http.post('/api/capability-requests/respond', '{"requestId":')).status, 400);
  assert.equal((await http.post('/api/capability-requests/respond', '[1]')).status, 400);
  assert.equal((await http.post('/api/capability-grants/revoke', { id: 'cg_00000000-0000-4000-8000-000000000000' })).status, 404);
  assert.equal((await http.post('/api/capability-grants/revoke', { id: '../../etc' })).status, 400);
  assert.equal((await http.get('/api/capability-grants?agentId=../x')).status, 400);
  assert.deepEqual((await http.get('/api/capability-grants')).json, { ok: true, grants: [] });
  assert.equal((await http.post('/api/capability-requests/respond', { requestId: '00000000-0000-4000-8000-000000000000', decision: 'run' }, { origin: 'http://evil.example' })).status, 403);

  // A live request (the main Agent lacks runCommands) answered over HTTP.
  let requestId;
  const scope = withElevationSurface(capabilityScopeForProfile({ id: 'main', capabilities: capabilitiesFromAtoms(['readFiles']) }), true);
  const context = Object.freeze({ ...createRequestContext({ home, chatId: 'c1', runId: 'run-http', requestId: 'req' }), turnBinding: Object.freeze({ role: 'main', project: null, taskId: null }) });
  const outcome = requestCapabilityElevation({ scope, tool: { id: 'bash' }, args: {}, context, sseEmitter: (type, payload) => { if (type === 'capability_request') requestId = payload.requestId; } });
  while (!requestId) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await http.post('/api/capability-requests/respond', { requestId, decision: 'project' })).status, 400, 'project is not offered for enable-own');
  const answer = await http.post('/api/capability-requests/respond', { requestId, decision: 'run' });
  assert.equal(answer.status, 200);
  assert.equal(answer.json.grant.scope, 'run');
  assert.equal((await outcome).allowed, true);
  assert.equal((await http.post('/api/capability-requests/respond', { requestId, decision: 'run' })).status, 404, 'a decided request is gone');
  const listed = await http.get('/api/capability-grants?agentId=main');
  assert.equal(listed.json.grants.length, 1);
  assert.equal(listed.json.grants[0].label, '运行命令');
  assert.equal(listed.json.grants[0].bootId, undefined, 'process ids stay server-side');
  assert.equal((await http.post('/api/capability-grants/revoke', { id: listed.json.grants[0].id })).status, 200);
  assert.deepEqual((await http.get('/api/capability-grants')).json.grants, []);
});

test('the real server dispatches the capability routes behind its origin gate', { timeout: 45000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-capability-server-'));
  const child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_MEMORY_RUNTIME: '0', MELO_DREAMING_ENABLED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'exit');
  t.after(async () => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.kill('SIGTERM');
    await closed;
    clearTimeout(kill);
    await rm(home, { recursive: true, force: true });
  });
  let log = '';
  child.stderr.on('data', chunk => { log += chunk; });
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(log.slice(-1000))), 20000);
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(log.slice(-1000))); });
    child.stdout.on('data', chunk => {
      log += chunk;
      const match = log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const unknown = await post('/api/capability-requests/respond', { requestId: '00000000-0000-4000-8000-000000000000', decision: 'run' });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'CAPABILITY_REQUEST_NOT_FOUND');
  const forbidden = await post('/api/capability-requests/respond', { requestId: '00000000-0000-4000-8000-000000000000', decision: 'run' }, { origin: 'http://evil.example' });
  assert.equal(forbidden.status, 403);
  const grants = await fetch(base + '/api/capability-grants', { signal: AbortSignal.timeout(5000) });
  assert.equal(grants.status, 200);
  assert.deepEqual(await grants.json(), { ok: true, grants: [] });
});
