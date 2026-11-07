import test from 'node:test';
import assert from 'node:assert/strict';
import { RETIRED_AGENT_IDS, isRetiredAgentId, isUserFacingAgent, userFacingAgents } from './userAgents.js';

const stored = [
  { id: 'research', name: 'Research' },
  { id: 'custom-2', name: '懂王 川普' },
  { id: 'builder', name: 'Builder' },
  { id: 'main', name: 'Main agent' },
  { id: 'reviewer', name: 'Reviewer' },
  { id: 'custom-1', name: '金冬天' }
];

test('lists offer the default Agent first and every Agent the user created, never the retired lanes', () => {
  assert.deepEqual(userFacingAgents(stored).map(agent => agent.id), ['main', 'custom-2', 'custom-1']);
  for (const id of RETIRED_AGENT_IDS) assert.equal(isUserFacingAgent({ id }), false, id);
  assert.equal(isUserFacingAgent({ id: 'custom-1' }), true);
  assert.equal(isUserFacingAgent({ id: '' }), false);
  assert.equal(isUserFacingAgent(null), false);
});

test('a chat or project that still points at a retired lane keeps that one visible in its own picker', () => {
  assert.deepEqual(userFacingAgents(stored, { keepId: 'research' }).map(agent => agent.id), ['main', 'research', 'custom-2', 'custom-1']);
  assert.deepEqual(userFacingAgents(stored, { keepId: 'missing' }).map(agent => agent.id), ['main', 'custom-2', 'custom-1']);
});

test('filtering never mutates the stored list, so old chats and settings keep their data', () => {
  const before = stored.map(agent => agent.id);
  userFacingAgents(stored);
  assert.deepEqual(stored.map(agent => agent.id), before);
  assert.deepEqual(userFacingAgents(undefined), []);
  assert.equal(isRetiredAgentId('builder'), true);
  assert.equal(isRetiredAgentId(undefined), false);
});
