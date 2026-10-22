// Capability elevation rule 6: new custom Agents start from the contract's
// starter set — every base ability except delegation since 2026-10-22 (user
// decision) — or copy an existing Agent's settings ("基于已有 Agent").
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { loadState, updateStateAtomically } from '../../state/stateStore.js';
import { normalizeCapabilities, emptyCapabilities } from '../../domain/agent/capabilities.js';
import { CAPABILITY_ELEVATION } from '../../domain/agent/capabilityElevation.js';
import { createCustomAgent } from './agentMutations.js';
import { buildNewCustomAgent, starterCapabilities } from './agentProfileService.js';

async function inHome(t, work) {
  const home = await mkdtemp(join(tmpdir(), 'melo-agent-starter-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return runWithRequestContext(createRequestContext({ home, env: { MELO_TEST_MODE: '1' } }), () => work(home));
}

test('the starter set is the contract one: every base ability except delegation, plus the equipment the install has on', () => {
  assert.deepEqual(CAPABILITY_ELEVATION.newAgentStarter, ['readFiles', 'writeFiles', 'runCommands', 'network', 'knowledgeMemory', 'generateMedia']);
  assert.deepEqual(starterCapabilities(), normalizeCapabilities({ readFiles: true, writeFiles: true, runCommands: true, network: true, knowledgeMemory: true, generateMedia: true }));
  const { profile } = buildNewCustomAgent({});
  assert.deepEqual(profile.capabilities, starterCapabilities());
  assert.equal(profile.capabilities.delegate, false, 'delegation is switched on per Agent');
  assert.deepEqual([profile.capabilities.mcpServers, profile.capabilities.skills, profile.capabilities.connectors], [[], [], []], 'nothing installed, nothing listed');
  const equipped = buildNewCustomAgent({}, { equipment: { skills: ['skill-creator'], mcpServers: ['playwright'], connectors: ['ext-1'] } }).profile.capabilities;
  assert.deepEqual(equipped, normalizeCapabilities({ ...starterCapabilities(), skills: ['skill-creator'], mcpServers: ['playwright'], connectors: ['ext-1'] }));
});

test('create: starter by default; "基于已有 Agent" copies settings, never channels, tokens, name or avatar; persona only when ticked', t => inHome(t, async home => {
  await updateStateAtomically(state => {
    Object.assign(state.agentProfiles.builder, {
      capabilities: normalizeCapabilities({ readFiles: true, writeFiles: true, runCommands: true, mcpServers: ['github'] }),
      collaboration: { canDelegate: true, delegateTargets: ['research'], maxDelegationDepth: 2, maxIterations: 12, maxTokens: 64000, timeoutMs: 300000 },
      contextSources: { projects: true, knowledge: false, memory: true },
      model: 'builder-model', instructions: '# Builder persona\nBuild carefully.', description: 'Builds things', mood: 'focused',
      minimaxVoiceId: 'voice-b', edgeTtsVoice: 'en-US-Guy', ttsSpeed: 1.2, voicePersonality: 'calm builder voice',
      avatarData: 'data:image/png;base64,AAAA',
      channels: { telegram: { enabled: true, botToken: 'secret-token', chatId: '42' } },
    });
    return state;
  }, { home });

  const plain = await createCustomAgent();
  // Starter set plus what this home has on (default skills and MCP presets; agentEquipment.test.js).
  assert.deepEqual({ ...plain.agent.capabilities, skills: [], mcpServers: [], connectors: [] }, starterCapabilities());
  assert.ok(plain.agent.capabilities.skills.length > 0 && plain.agent.capabilities.mcpServers.length > 0);

  const copied = await createCustomAgent({ basedOn: 'builder' });
  const builder = (await loadState({ home })).agentProfiles.builder;
  assert.deepEqual(copied.agent.capabilities, builder.capabilities);
  assert.deepEqual(copied.agent.collaboration, builder.collaboration);
  assert.deepEqual(copied.agent.contextSources, builder.contextSources);
  assert.equal(copied.agent.model, 'builder-model');
  assert.notEqual(copied.agent.name, builder.name);
  assert.equal(copied.agent.avatarData, '');
  assert.equal(JSON.stringify(copied.agent.channels).includes('secret-token'), false, 'bot tokens are never copied');
  assert.notEqual(copied.agent.instructions, builder.instructions, 'persona is not copied unless ticked');
  assert.equal(copied.agent.minimaxVoiceId, '');
  assert.notEqual(copied.agent.description, 'Builds things');

  const withPersona = await createCustomAgent({ basedOn: 'builder', copyPersona: true });
  assert.equal(withPersona.agent.instructions, builder.instructions);
  assert.equal(withPersona.agent.description, 'Builds things');
  assert.equal(withPersona.agent.minimaxVoiceId, 'voice-b');
  assert.equal(withPersona.agent.voicePersonality, 'calm builder voice');
  assert.equal(JSON.stringify(withPersona.agent.channels).includes('secret-token'), false);

  // Independent afterwards: changing the source does not touch the copy.
  await updateStateAtomically(state => { state.agentProfiles.builder.capabilities = emptyCapabilities(); return state; }, { home });
  assert.equal((await loadState({ home })).agentProfiles[copied.agentId].capabilities.writeFiles, true);

  await assert.rejects(createCustomAgent({ basedOn: 'nobody' }), { statusCode: 400 });
}));

test('migration: existing custom Agents keep exactly their saved capabilities', t => inHome(t, async home => {
  const first = await createCustomAgent();
  await updateStateAtomically(state => { state.agentProfiles[first.agentId].capabilities = emptyCapabilities(); return state; }, { home });
  await createCustomAgent();
  const state = await loadState({ home });
  assert.deepEqual(state.agentProfiles[first.agentId].capabilities, emptyCapabilities(), 'an existing Agent is never retro-enabled');
}));
