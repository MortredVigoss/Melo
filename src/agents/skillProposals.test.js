/**
 * Tests for Phase 3D — background skill-proposal clustering.
 *
 * Covers:
 *   - extractToolCallsFromMessages pulls both `role:'tool'` shapes AND
 *     inline <tool_call>…</tool_call> blocks in assistant content
 *   - proposeSkillsFromActivity rejects activities with < minToolCalls
 *   - proposeSkillsFromActivity rejects "pure chat" (no connector / no write)
 *   - proposeSkillsFromActivity accepts external-connector sequences
 *   - proposeSkillsFromActivity accepts file-write sequences
 *   - similar workflows in the same chat collapse into one proposal
 *   - different workflows in the same chat stay as two proposals
 *   - proposals are ordered newest-first
 *   - store dedupes by seedId
 *   - store.dismiss prevents resuggestion
 *   - store.prune caps maxEntries
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractToolCallsFromMessages,
  proposeSkillsFromActivity,
  createSkillProposalStore,
  __internals__,
} from './skillProposals.js';

const { toolCallSimilarity, toolIdMatchesAny, CONNECTOR_TOOL_HINTS } = __internals__;

// ─── extractToolCallsFromMessages ────────────────────────────────────────────

test('extractToolCallsFromMessages: picks up role:"tool" shape', () => {
  const out = extractToolCallsFromMessages([
    { role: 'user', content: 'hi' },
    { role: 'tool', toolName: 'web_search', args: { query: 'x' } },
    { role: 'tool', toolName: 'save_file', args: { path: '/tmp/x.txt' } },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].toolId, 'web_search');
  assert.equal(out[1].toolId, 'save_file');
});

test('extractToolCallsFromMessages: picks up <tool_call> in assistant content', () => {
  const out = extractToolCallsFromMessages([
    {
      role: 'assistant',
      content: [
        '<tool_call>{"id":"1","name":"telegram_send","arguments":{"to":"chat"}}</tool_call>',
        '<tool_call>{"id":"2","name":"web_search","arguments":{"query":"z"}}</tool_call>',
      ].join('\n'),
    },
  ]);
  assert.deepEqual(
    out.map(t => t.toolId),
    ['telegram_send', 'web_search'],
  );
});

test('extractToolCallsFromMessages: tolerates malformed <tool_call> JSON', () => {
  const out = extractToolCallsFromMessages([
    { role: 'assistant', content: '<tool_call>{bad json}</tool_call>' },
  ]);
  assert.equal(out.length, 0);
});

// ─── similarity + hint matchers ──────────────────────────────────────────────

test('toolIdMatchesAny matches substrings case-insensitively', () => {
  assert.equal(toolIdMatchesAny('Telegram_Send', CONNECTOR_TOOL_HINTS), true);
  assert.equal(toolIdMatchesAny('mcp:notion:search', CONNECTOR_TOOL_HINTS), true);
  assert.equal(toolIdMatchesAny('web_search', CONNECTOR_TOOL_HINTS), false);
});

test('toolCallSimilarity: identical sets → 1, disjoint → 0', () => {
  const a = [{ toolId: 'x' }, { toolId: 'y' }];
  const b = [{ toolId: 'x' }, { toolId: 'y' }];
  assert.equal(toolCallSimilarity(a, b), 1);

  const c = [{ toolId: 'p' }];
  assert.equal(toolCallSimilarity(a, c), 0);
});

test('toolCallSimilarity: partial overlap → Jaccard', () => {
  const a = [{ toolId: 'x' }, { toolId: 'y' }, { toolId: 'z' }];
  const b = [{ toolId: 'x' }, { toolId: 'w' }];
  // A ∩ B = {x}; A ∪ B = {x,y,z,w} → 1/4 = 0.25
  assert.equal(toolCallSimilarity(a, b), 0.25);
});

// ─── proposeSkillsFromActivity ───────────────────────────────────────────────

function ttoolCalls(msgs) {
  return msgs.map(toolName => ({ role: 'tool', toolName }));
}

test('proposeSkillsFromActivity: skips activities with < minToolCalls', () => {
  const out = proposeSkillsFromActivity([
    {
      chatId: 'c1',
      messages: ttoolCalls(['web_search', 'save_file']), // only 2
    },
  ]);
  assert.equal(out.length, 0);
});

test('proposeSkillsFromActivity: skips activities with no connector and no write', () => {
  const out = proposeSkillsFromActivity([
    {
      chatId: 'c1',
      messages: ttoolCalls(['web_search', 'calculator', 'read_file']),
    },
  ]);
  // 3 tool calls but none are connectors / writes → pure-chat, skip
  assert.equal(out.length, 0);
});

test('proposeSkillsFromActivity: accepts external-connector sequences', () => {
  const out = proposeSkillsFromActivity([
    {
      chatId: 'c1',
      messages: ttoolCalls(['web_search', 'telegram_send', 'read_file']),
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].chatId, 'c1');
  assert.equal(out[0].involvesConnectors, true);
  assert.equal(out[0].involvesWrites, false);
});

test('proposeSkillsFromActivity: accepts file-write sequences', () => {
  const out = proposeSkillsFromActivity([
    {
      chatId: 'c1',
      messages: ttoolCalls(['web_search', 'read_file', 'save_workspace_file']),
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].involvesWrites, true);
});

test('proposeSkillsFromActivity: similar workflows in same chat collapse to one', () => {
  const seq = ttoolCalls(['web_search', 'telegram_send', 'read_file']);
  const out = proposeSkillsFromActivity([
    { chatId: 'c1', messages: seq },
    { chatId: 'c1', messages: seq }, // duplicate
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].occurrences, 2);
});

test('proposeSkillsFromActivity: different workflows in same chat stay separate', () => {
  const out = proposeSkillsFromActivity([
    { chatId: 'c1', messages: ttoolCalls(['telegram_send', 'telegram_send', 'telegram_send']) },
    { chatId: 'c1', messages: ttoolCalls(['save_workspace_file', 'save_workspace_file', 'save_workspace_file']) },
  ]);
  assert.equal(out.length, 2);
});

test('proposeSkillsFromActivity: proposals are newest-first', () => {
  let t = 1000;
  const nowFn = () => ++t;
  const out = proposeSkillsFromActivity(
    [
      { chatId: 'c-old', messages: ttoolCalls(['telegram_send', 'save_file', 'web_search']) },
      { chatId: 'c-new', messages: ttoolCalls(['web_search', 'save_file', 'telegram_send']) },
    ],
    { nowFn },
  );
  assert.equal(out.length, 2);
  assert.ok(out[0].createdAt >= out[1].createdAt);
});

// ─── store ───────────────────────────────────────────────────────────────────

test('store: addMany dedupes by seedId and respects dismissed set', () => {
  const store = createSkillProposalStore();
  const added1 = store.addMany([
    { seedId: 's1', chatId: 'c1', createdAt: 1 },
    { seedId: 's2', chatId: 'c2', createdAt: 2 },
  ]);
  assert.equal(added1, 2);

  // Duplicate seedId → 0 new.
  const added2 = store.addMany([{ seedId: 's1', createdAt: 3 }]);
  assert.equal(added2, 0);

  // Dismiss then re-add → still 0.
  store.dismiss('s2');
  assert.equal(store.isDismissed('s2'), true);
  const added3 = store.addMany([{ seedId: 's2', createdAt: 4 }]);
  assert.equal(added3, 0);
});

test('store: list returns newest first', () => {
  const store = createSkillProposalStore();
  store.addMany([
    { seedId: 'a', createdAt: 100 },
    { seedId: 'b', createdAt: 500 },
    { seedId: 'c', createdAt: 300 },
  ]);
  const list = store.list();
  assert.deepEqual(list.map(p => p.seedId), ['b', 'c', 'a']);
});

test('store: prunes to maxEntries, dropping oldest', () => {
  const store = createSkillProposalStore({ maxEntries: 2 });
  store.addMany([
    { seedId: 'old', createdAt: 100 },
    { seedId: 'mid', createdAt: 200 },
  ]);
  store.addMany([{ seedId: 'new', createdAt: 300 }]);
  assert.equal(store.size(), 2);
  assert.equal(store.get('old'), null);
  assert.ok(store.get('mid'));
  assert.ok(store.get('new'));
});

test('store: dismiss removes + remembers to block future re-adds', () => {
  const store = createSkillProposalStore();
  store.addMany([{ seedId: 'x', createdAt: 1 }]);
  assert.equal(store.dismiss('x'), true);
  assert.equal(store.get('x'), null);
  // Future add of same seedId is blocked.
  assert.equal(store.addMany([{ seedId: 'x', createdAt: 2 }]), 0);
});
