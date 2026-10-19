// Architecture plan P1 (2026-10-19): project and Agent mutations return commit
// receipts; the HTTP adapter rebuilds the legacy bootstrap response. These
// tests drive the real route handlers and compare the response bytes with the
// old contract, `${JSON.stringify(getDesktopBootstrap())}\n` built after the
// commit, and pin the commit-then-bootstrap-failure semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'melo-bootstrap-after-commit-'));
const previousEnv = { MELO_HOME: process.env.MELO_HOME, MELO_TEST_MODE: process.env.MELO_TEST_MODE };
process.env.MELO_HOME = home;
process.env.MELO_TEST_MODE = '1';
test.after(async () => {
  for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(home, { recursive: true, force: true });
});

const { handleDomainRoutes } = await import('./domainRoutes.js');
const { sendBootstrapAfterCommit, receiptSummary } = await import('./bootstrapAfterCommit.js');
const { getDesktopBootstrap } = await import('../services/desktop/bootstrap.js');
const { loadState } = await import('../state/stateStore.js');

function request(body) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  stream.method = 'POST'; stream.headers = {}; stream.socket = { remoteAddress: '127.0.0.1' };
  return stream;
}
function response() {
  const out = { statusCode: null, body: '' };
  out.writeHead = code => { out.statusCode = code; }; out.end = chunk => { out.body += chunk || ''; };
  out.setHeader = () => {}; out.getHeader = () => undefined; out.headersSent = false;
  return out;
}
async function post(path, body = {}) {
  const res = response();
  await handleDomainRoutes(request(body), res, new URL(`http://localhost${path}`), () => true);
  return res;
}
// The pre-P1 route sent the bootstrap the mutation built right after its commit.
async function assertLegacyBytes(res, extra = null) {
  assert.equal(res.statusCode, 200, res.body);
  const legacy = await getDesktopBootstrap();
  assert.equal(res.body, `${JSON.stringify(extra ? { ...legacy, ...extra } : legacy)}\n`);
  return JSON.parse(res.body);
}

test('project and Agent routes answer with the exact legacy bootstrap bytes', async t => {
  // Search suggestions carry "now" timestamps; freeze the clock so both
  // bootstraps are comparable byte for byte.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-19T08:00:00.000Z') });

  // No workspacePath: the project gets its own empty folder, so the workspace
  // listing in the bootstrap does not pick up the home's SQLite side files.
  const created = await assertLegacyBytes(await post('/api/projects', { name: 'Route fixture' }));
  const project = created.projects.find(p => p.name === 'Route fixture');
  assert.ok(project);
  assert.equal(created.settings.selectedProjectId, project.id);

  const updated = await assertLegacyBytes(await post('/api/projects/update', { projectId: project.id, patch: { summary: 'Route summary' } }));
  assert.equal(updated.projects.find(p => p.id === project.id).summary, 'Route summary');
  // No project delete route exists; archiving is the removal path the UI uses.
  await assertLegacyBytes(await post('/api/projects/update', { projectId: project.id, patch: { archived: true } }));
  assert.equal((await loadState()).projects.find(p => p.id === project.id).archived, true);

  const withAgent = await assertLegacyBytes(await post('/api/agents/create-custom'));
  const agentId = withAgent.settings.selectedAgentId;
  assert.match(agentId, /^custom-agent-/);
  const voiced = await assertLegacyBytes(await post('/api/agents/update', { agentId, patch: { minimaxVoiceId: 'route-voice' }, scope: 'global', activeView: 'agent' }));
  assert.equal(voiced.customize.agents.find(a => a.id === agentId).minimaxVoiceId, 'route-voice');

  await assertLegacyBytes(await post('/api/agents/update', { agentId: 'main', patch: { instructions: 'Project persona' }, scope: 'project', projectId: project.id }));
  assert.equal((await loadState()).projectAgentOverrides[project.id].main.instructions, 'Project persona');
  // Clearing the project override is the Agent removal path.
  await assertLegacyBytes(await post('/api/agents/update', { agentId: 'main', patch: {}, scope: 'project', projectId: project.id, clearProjectOverride: true }));
  assert.equal((await loadState()).projectAgentOverrides[project.id], undefined);

  // The Markdown export warning is still merged into the bootstrap.
  const exportPath = join(home, 'desktop', 'agents', 'global', agentId, 'AGENT.md');
  await rm(exportPath, { force: true }); await mkdir(exportPath, { recursive: true });
  const warned = await assertLegacyBytes(
    await post('/api/agents/update', { agentId, patch: { instructions: 'Saved, export blocked' }, scope: 'global' }),
    { agentExportWarning: 'Agent 已保存；Markdown 导出未完成，可稍后重试。' },
  );
  assert.equal(Object.keys(warned).at(-1), 'agentExportWarning');
  await rm(exportPath, { recursive: true, force: true });
});

test('a committed save whose bootstrap rebuild fails answers 200 ok:true with the receipt, never an error', async () => {
  const configPath = join(home, 'config.json');
  const savedConfig = await readFile(configPath, 'utf8').catch(() => null);
  await writeFile(configPath, '{ not json');
  try {
    const res = await post('/api/projects', { name: 'Committed anyway', workspacePath: home });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(Object.keys(body), ['ok', 'receipt', 'bootstrapError']);
    assert.equal(body.ok, true);
    assert.equal(body.bootstrapError.code, 'BOOTSTRAP_UNAVAILABLE');
    assert.match(body.bootstrapError.message, /Failed to read config/);
    const state = await loadState();
    const project = state.projects.find(p => p.name === 'Committed anyway');
    assert.ok(project, 'the project was committed');
    assert.deepEqual(body.receipt, { revision: state._revision, changedIds: [project.id], removedIds: [], projectId: project.id });

    const agent = JSON.parse((await post('/api/agents/update', { agentId: 'main', patch: { minimaxVoiceId: 'kept-voice' } })).body);
    assert.equal(agent.ok, true);
    assert.equal(agent.receipt.agentId, 'main');
    assert.deepEqual(agent.receipt.changedIds, ['main']);
    assert.equal(Object.hasOwn(agent.receipt, 'agent'), false, 'records stay out of the fallback');
    assert.equal((await loadState()).agentProfiles.main.minimaxVoiceId, 'kept-voice');
  } finally {
    if (savedConfig === null) await rm(configPath, { force: true }); else await writeFile(configPath, savedConfig);
  }
  // Errors raised by the mutation itself still reach the dispatcher unchanged.
  await assert.rejects(post('/api/projects/update', { projectId: 'missing', patch: {} }), /Project not found/);
});

test('the fallback summary drops records, keeps ids and the export warning', async () => {
  const receipt = { agentId: 'main', scope: 'global', projectId: null, agent: { channels: { telegram: { botToken: 'fixture-secret' } } },
    revision: 7, changedIds: ['main'], removedIds: [], agentExportWarning: 'warning' };
  const res = response();
  await sendBootstrapAfterCommit(res, receipt, { buildBootstrap: async () => { throw new Error('fixture failure'); } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    receipt: { agentId: 'main', scope: 'global', projectId: null, revision: 7, changedIds: ['main'], removedIds: [], agentExportWarning: 'warning' },
    bootstrapError: { code: 'BOOTSTRAP_UNAVAILABLE', message: 'fixture failure' },
  });
  assert.doesNotMatch(res.body, /fixture-secret/);
  assert.deepEqual(receiptSummary({ project: { id: 'p' }, revision: 3, changedIds: ['p'], removedIds: [] }), { revision: 3, changedIds: ['p'], removedIds: [], projectId: 'p' });
});
