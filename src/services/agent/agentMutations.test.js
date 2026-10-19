// Architecture plan P1 (2026-10-19): Agent commands return a commit receipt
// built from the committed transaction. This test deliberately imports neither
// services/desktop/bootstrap.js nor desktop UI code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { loadState } from '../../state/stateStore.js';
import { createCustomAgent, updateAgentProfile } from './agentMutations.js';

async function inHome(t, work) {
  const home = await mkdtemp(join(tmpdir(), 'melo-agent-receipt-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return runWithRequestContext(createRequestContext({ home, env: { MELO_TEST_MODE: '1' } }), () => work(home));
}
const manifestRevision = async home => JSON.parse(await readFile(join(home, 'desktop', 'state.json'), 'utf8'))._revision;
const RECEIPT_KEYS = ['agent', 'agentId', 'changedIds', 'projectId', 'removedIds', 'revision', 'scope'];

test('create and global update return the committed Agent record and a monotonic revision', t => inHome(t, async home => {
  const created = await createCustomAgent();
  assert.deepEqual(Object.keys(created).sort(), RECEIPT_KEYS);
  assert.match(created.agentId, /^custom-agent-/);
  assert.equal(created.scope, 'global');
  assert.equal(created.projectId, null);
  assert.deepEqual(created.changedIds, [created.agentId]);
  assert.deepEqual(created.removedIds, []);
  assert.equal(created.revision, await manifestRevision(home));
  let state = await loadState({ home });
  assert.deepEqual(created.agent, state.agentProfiles[created.agentId]);
  assert.equal(state.settings.selectedAgentId, created.agentId);
  assert.equal(state.settings.activeView, 'agent');

  const voice = await updateAgentProfile(created.agentId, { minimaxVoiceId: 'voice-a', ttsSpeed: 1.3 });
  assert.ok(voice.revision > created.revision);
  assert.equal(voice.revision, await manifestRevision(home));
  assert.deepEqual(voice.changedIds, [created.agentId], 'other Agents are not reported as changed');
  assert.equal(voice.agent.minimaxVoiceId, 'voice-a');
  assert.equal(voice.agent.ttsSpeed, 1.3);
  state = await loadState({ home });
  assert.deepEqual(voice.agent, state.agentProfiles[created.agentId]);

  const persona = await updateAgentProfile('main', { instructions: 'Receipt persona' }, { activeView: 'customize' });
  assert.ok(persona.revision > voice.revision);
  assert.deepEqual(persona.changedIds, ['main']);
  assert.equal(persona.agent.instructions, 'Receipt persona');
  assert.equal((await loadState({ home })).settings.activeView, 'customize');
}));

test('project overrides report the project scope and clearing one returns the removed id', t => inHome(t, async home => {
  const saved = await updateAgentProfile('main', { instructions: 'Project persona', minimaxVoiceId: 'project-voice' }, { scope: 'project', projectId: 'p1' });
  assert.equal(saved.scope, 'project');
  assert.equal(saved.projectId, 'p1');
  assert.deepEqual(saved.changedIds, ['main']);
  assert.deepEqual(saved.removedIds, []);
  assert.equal(saved.agent.minimaxVoiceId, 'project-voice');
  let state = await loadState({ home });
  assert.deepEqual(saved.agent, state.projectAgentOverrides.p1.main);
  assert.equal(state.agentProfiles.main.minimaxVoiceId, '', 'the global profile is untouched');

  const cleared = await updateAgentProfile('main', {}, { scope: 'project', projectId: 'p1', clearProjectOverride: true });
  assert.ok(cleared.revision > saved.revision);
  assert.equal(cleared.agent, null);
  assert.deepEqual(cleared.changedIds, []);
  assert.deepEqual(cleared.removedIds, ['main']);
  state = await loadState({ home });
  assert.equal(state.projectAgentOverrides.p1, undefined);

  // Clearing again removes nothing; the receipt says so instead of repeating the id.
  const again = await updateAgentProfile('main', {}, { scope: 'project', projectId: 'p1', clearProjectOverride: true });
  assert.deepEqual(again.removedIds, []);
  assert.ok(again.revision >= cleared.revision);
}));

test('rejected Agent saves commit nothing; export failure still returns the receipt with a warning', t => inHome(t, async home => {
  // A legacy tool list without capabilities requires a confirmed migration preview.
  await mkdir(join(home, 'desktop'), { recursive: true });
  await writeFile(join(home, 'desktop', 'state.json'), JSON.stringify({ _storageFormat: 3, agentProfiles: { main: { instructions: 'Legacy', tools: ['local-files'] } } }));
  const before = await updateAgentProfile('main', { instructions: 'Before' });
  await assert.rejects(updateAgentProfile('main', { capabilities: { readFiles: true } }), /预览/);
  await assert.rejects(updateAgentProfile('main', {}, { scope: 'project', projectId: 'p2' }), /override is empty/);
  assert.equal(await manifestRevision(home), before.revision);

  const dir = join(home, 'desktop', 'agents', 'global', 'main');
  await rm(join(dir, 'AGENT.md'), { force: true }); await mkdir(join(dir, 'AGENT.md'), { recursive: true });
  const saved = await updateAgentProfile('main', { instructions: 'Saved despite export failure' });
  assert.match(saved.agentExportWarning, /已保存/);
  assert.ok(saved.revision > before.revision);
  assert.deepEqual(saved.changedIds, ['main']);
  assert.equal((await loadState({ home })).agentProfiles.main.instructions, 'Saved despite export failure');
}));

test('a duplicated bot token disabled on another Agent appears in changedIds', t => inHome(t, async home => {
  await mkdir(join(home, 'desktop'), { recursive: true });
  await writeFile(join(home, 'desktop', 'state.json'), JSON.stringify({ _storageFormat: 3, agentProfiles: {
    main: { instructions: 'Main' }, research: { instructions: 'Research', channels: { telegram: { enabled: true, botToken: 'shared-fixture-token' } } },
  } }));
  const receipt = await updateAgentProfile('main', { channels: { telegram: { enabled: true, botToken: 'shared-fixture-token' } } });
  const state = await loadState({ home });
  assert.equal(state.agentProfiles.main.channels.telegram.botToken, 'shared-fixture-token');
  assert.equal(state.agentProfiles.research.channels.telegram.enabled, false, 'the other owner of the token is disabled');
  assert.deepEqual([...receipt.changedIds].sort(), ['main', 'research']);
  assert.deepEqual(receipt.agent, state.agentProfiles.main);
}));
