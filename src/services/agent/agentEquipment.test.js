// 2026-10-22 (user report: 懂王 / 金冬天 "skills and MCP were never added"):
// every Agent is equipped with what the install already has on — skills, MCP
// servers, external connectors — and the capability set is the only
// authority at run time, so what the editor shows ticked is what the Agent uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { updateStateAtomically } from '../../state/stateStore.js';
import { createDefaultState } from '../../state/stateHydration.js';
import { normalizeCapabilities } from '../../domain/agent/capabilities.js';
import { filterSkillsForAgent } from '../../domain/agent/agentTools.js';
import { createCustomAgent } from './agentMutations.js';
import { installedEquipment } from './agentEquipment.js';

const DEFAULT_MCP = ['antv-chart', 'markdown2pdf', 'mermaid', 'playwright'];
const DEFAULT_SKILLS = ['artifact-curator', 'connector-builder', 'project-planner', 'skill-creator'];
const sorted = list => [...list].sort();

test('a stale legacy skill whitelist no longer hides the skills the capability set grants', () => {
  const skills = [{ id: 'project-planner' }, { id: 'skill-creator' }, { id: 'ui-fixture-skill' }];
  const capabilities = normalizeCapabilities({ readFiles: true, skills: ['project-planner', 'skill-creator'] });
  // 金冬天's real profile: capability set lists the skills, legacy field is [].
  const agent = { id: 'custom-1', capabilities, enabledSkillIds: [] };
  assert.deepEqual(filterSkillsForAgent(skills, agent).map(skill => skill.id), ['project-planner', 'skill-creator']);
  // The capability set still limits: a skill it does not list stays off.
  assert.deepEqual(filterSkillsForAgent(skills, { ...agent, enabledSkillIds: ['ui-fixture-skill'] }).map(skill => skill.id), ['project-planner', 'skill-creator']);
  // Profiles without a capability set keep the legacy whitelist.
  assert.deepEqual(filterSkillsForAgent(skills, { id: 'old', tools: ['skills'], enabledSkillIds: ['skill-creator'] }).map(skill => skill.id), ['skill-creator']);
  // A skill scoped to other Agents stays scoped.
  assert.deepEqual(filterSkillsForAgent([{ id: 'project-planner', allowedAgentIds: ['main'] }], agent), []);
});

test('installed equipment: globally enabled skills, usable MCP servers and enabled external connectors only', () => {
  const state = {
    settings: { enabledSkillIds: ['skill-creator', 'my-skill'], enabledConnectorIds: ['local-files', 'ext-on'],
      customSkills: [{ id: 'my-skill', name: 'Mine', type: 'executable', systemPrompt: 'x' }, { id: 'off-skill', name: 'Off', type: 'executable', systemPrompt: 'y' }] },
    externalConnectors: [{ id: 'ext-on' }, { id: 'ext-off' }],
  };
  const equipment = installedEquipment(state, { enablePlaywrightMcp: true, enableMermaidMcp: false, mcpServers: { 'my-mcp': { command: 'x' } } });
  assert.deepEqual(sorted(equipment.skills), ['my-skill', 'skill-creator']);
  assert.deepEqual(equipment.mcpServers, ['my-mcp', 'playwright']);
  assert.deepEqual(equipment.connectors, ['ext-on']);
});

test('a new Agent starts with the full base set plus everything the install has on', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-agent-equipment-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await runWithRequestContext(createRequestContext({ home, env: { MELO_TEST_MODE: '1' } }), async () => {
    await updateStateAtomically(state => { state.externalConnectors = [{ id: 'ext-1', name: 'Ext' }]; state.settings.enabledConnectorIds = [...state.settings.enabledConnectorIds, 'ext-1']; return state; }, { home });
    const created = await createCustomAgent();
    const c = created.agent.capabilities;
    assert.deepEqual([c.readFiles, c.writeFiles, c.runCommands, c.network, c.knowledgeMemory, c.generateMedia, c.delegate], [true, true, true, true, true, true, false]);
    assert.deepEqual(sorted(c.skills), DEFAULT_SKILLS);
    assert.deepEqual(sorted(c.mcpServers), DEFAULT_MCP);
    assert.deepEqual(c.connectors, ['ext-1']);
  });
});

test('a fresh install equips its default Agents the same way', () => {
  for (const [id, profile] of Object.entries(createDefaultState().agentProfiles)) {
    assert.deepEqual(sorted(profile.capabilities.skills), DEFAULT_SKILLS, id);
    assert.deepEqual(sorted(profile.capabilities.mcpServers), DEFAULT_MCP, id);
    assert.equal(profile.capabilities.network, true, id);
  }
});
