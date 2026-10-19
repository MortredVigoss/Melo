// Architecture plan P1 (2026-10-19): project and Agent saves keep their legacy
// HTTP contract through the real server dispatch: a full bootstrap (with the
// transport `_snapshot`) for old clients, and a bootstrap patch when the
// desktop UI sends its baseline token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { decodeBootstrap } from '../../desktop-ui/bootstrapPatch.js';

// `_snapshot` is per-response transport metadata and search suggestions carry
// the request time; everything else must match a fresh GET /api/bootstrap.
const comparable = ({ _snapshot, search, ...rest }) => rest;

test('project and Agent save routes return the legacy bootstrap through the real server', { timeout: 60000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-project-agent-http-'));
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
    const timeout = setTimeout(() => reject(new Error(log.slice(-1000))), 30000);
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(log.slice(-1000))); });
    child.stdout.on('data', chunk => {
      log += chunk;
      const match = log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  async function call(path, body, headers = {}) {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
    });
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  }
  async function assertFullBootstrap(payload) {
    assert.ok(payload._snapshot?.token, 'full bootstrap carries transport metadata');
    assert.equal(payload.kind, undefined);
    const fresh = await call('/api/bootstrap');
    assert.deepEqual(Object.keys(payload), Object.keys(fresh), 'same top-level fields in the same order');
    assert.equal(JSON.stringify(comparable(payload)), JSON.stringify(comparable(fresh)));
    return payload;
  }

  // No workspacePath: the project gets its own empty folder, so the workspace
  // listing does not pick up the home's SQLite side files between requests.
  const created = await assertFullBootstrap(await call('/api/projects', { name: 'HTTP fixture' }));
  const project = created.projects.find(p => p.name === 'HTTP fixture');
  assert.ok(project);
  assert.equal(created.settings.selectedProjectId, project.id);
  assert.ok(created.stateRevision > 0);

  // The desktop UI sends its baseline token and receives only changed sections.
  const patch = await call('/api/projects/update', { projectId: project.id, patch: { summary: 'Patched summary' } }, { 'x-melo-bootstrap-base': created._snapshot.token });
  assert.equal(patch.kind, 'bootstrap-patch');
  const updated = decodeBootstrap(patch, created);
  assert.equal(updated.projects.find(p => p.id === project.id).summary, 'Patched summary');
  assert.ok(updated.stateRevision > created.stateRevision);
  assert.equal(JSON.stringify(comparable(updated)), JSON.stringify(comparable(await call('/api/bootstrap'))));

  const archived = await assertFullBootstrap(await call('/api/projects/update', { projectId: project.id, patch: { archived: true } }));
  assert.ok(archived.stateRevision > updated.stateRevision);

  const withAgent = await assertFullBootstrap(await call('/api/agents/create-custom', {}));
  const agentId = withAgent.settings.selectedAgentId;
  assert.match(agentId, /^custom-agent-/);
  assert.ok(withAgent.customize.agents.some(agent => agent.id === agentId));

  const saved = await assertFullBootstrap(await call('/api/agents/update', { agentId, patch: { minimaxVoiceId: 'http-voice' }, scope: 'global', activeView: 'agent' }));
  assert.equal(saved.customize.agents.find(agent => agent.id === agentId).minimaxVoiceId, 'http-voice');
  assert.equal(saved.agentExportWarning, undefined);

  await assertFullBootstrap(await call('/api/agents/update', { agentId: 'main', patch: { instructions: 'HTTP project persona' }, scope: 'project', projectId: project.id }));
  const cleared = await assertFullBootstrap(await call('/api/agents/update', { agentId: 'main', patch: {}, scope: 'project', projectId: project.id, clearProjectOverride: true }));
  assert.equal(cleared.conversationProfiles.projects[project.id], undefined, 'the project override is gone');
});
