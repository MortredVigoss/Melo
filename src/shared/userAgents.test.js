import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('phone starters synced to the desktop are hidden there too, and both hosts keep one list', () => {
  const synced = [{ id: 'main' }, { id: 'writer', name: '写作伙伴' }, { id: 'analyst', name: '分析助手' }, { id: 'custom-3', name: '自定义' }];
  assert.deepEqual(userFacingAgents(synced).map(agent => agent.id), ['main', 'custom-3']);
  assert.equal(isRetiredAgentId('writer'), true); assert.equal(isRetiredAgentId('analyst'), true);
  const swift = readFileSync(new URL('../../ios/Melo/AgentProfile.swift', import.meta.url), 'utf8');
  const literal = /static let retiredBuiltInIDs: Set<String> = \[([^\]]*)\]/.exec(swift);
  assert.ok(literal, 'the phone list is declared as a literal');
  assert.deepEqual([...literal[1].matchAll(/"([^"]+)"/g)].map(m => m[1]).sort(), [...RETIRED_AGENT_IDS].sort());
});

