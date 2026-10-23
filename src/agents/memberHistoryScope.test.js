// Bug audit 2026-10-18 T5: member / skill sub-loops did not forward
// `chatSource` / `projectId` to executeToolCalls, so read_history inside a
// member saw every chat as a project-less desktop chat: a member of a project
// chat could not read its own project and a telegram member could read desktop
// rows. These tests run the real read_history tool through runSubAgent.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_MELO_HOME = process.env.MELO_HOME;
const TEST_HOME = mkdtempSync(join(tmpdir(), 'melo-member-scope-'));
for (const dir of ['desktop', 'desktop/agents', 'desktop/threads']) mkdirSync(join(TEST_HOME, dir), { recursive: true });
const messages = prefix => Array.from({ length: 3 }, (_, i) => ({ id: `${prefix}-${i}`, role: i % 2 ? 'assistant' : 'user', content: `${prefix} message ${i}`, createdAt: `2026-10-0${i + 1}T10:00:00.000Z` }));
const chat = (id, extra) => ({ id, title: id, mode: 'chat', agentId: 'main', chatType: 'private', sessionMemory: [], messages: messages(id), ...extra });
writeFileSync(join(TEST_HOME, 'desktop', 'state.json'), JSON.stringify({
  projects: [{ id: 'p1', name: 'P1', instructions: '', createdAt: '2026-01-01T00:00:00.000Z' }, { id: 'p2', name: 'P2', instructions: '', createdAt: '2026-01-01T00:00:00.000Z' }],
  chats: [chat('own', { projectId: 'p1', source: 'desktop' }), chat('same', { projectId: 'p1', source: 'desktop' }), chat('other', { projectId: 'p2', source: 'desktop' }), chat('tg', { projectId: 'p1', source: 'telegram' })],
  tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [], externalToolRuns: [],
  agentProfiles: { main: { id: 'main', name: 'main', model: 'gpt-4o', identity: '', soulMd: '', tools: [], skills: [], channels: {} } },
  projectAgentOverrides: {},
  settings: { selectedProjectId: null, selectedChatId: null, selectedAgentId: 'main', selectedConnectorId: null, selectedFilePath: null, activeMode: 'chat', promptHistory: [], enabledConnectorIds: [], enabledSkillIds: [], customSkills: [] },
}));
process.env.MELO_HOME = TEST_HOME;

const { readHistoryTool } = await import('../tools/builtins/readHistoryTool.js');
const { registerTool, unregisterTool, getTool } = await import('../tools/registry.js');
const { runSubAgent, runSkill } = await import('../testSupport/directAgentFixture.js');

registerTool(readHistoryTool);
after(() => {
  unregisterTool('read_history');
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  if (ORIGINAL_MELO_HOME === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = ORIGINAL_MELO_HOME;
});

const config = { authMode: 'api-key', apiKey: 'sk-test', baseUrl: 'https://example.test', model: 'test-model' };
const call = args => `<tool_call>{"id":"c1","name":"read_history","arguments":${JSON.stringify(args)}}</tool_call>`;
function replyWith(first) {
  const queue = [first, 'done'];
  return async () => queue.shift() ?? '';
}
const outcome = result => (result.meta?.toolResults || [])[0];

test('T5: a member of a project chat can read_history another chat of its own project', async () => {
  const result = await runSubAgent({ task: 'read', config, chatId: 'own', chatSource: 'desktop', projectId: 'p1', allowedToolIds: ['read_history'], replyFn: replyWith(call({ chatId: 'same', limit: 1 })) });
  const entry = outcome(result);
  assert.ok(entry, 'the tool ran');
  assert.equal(entry.ok, true, JSON.stringify(entry));
  assert.equal(entry.errorCode, undefined);
});

test('T5: the same member is still fenced out of another project without scope=all', async () => {
  const foreign = outcome(await runSubAgent({ task: 'read', config, chatId: 'own', chatSource: 'desktop', projectId: 'p1', allowedToolIds: ['read_history'], replyFn: replyWith(call({ chatId: 'other', limit: 1 })) }));
  assert.equal(foreign.ok, false);
  assert.equal(foreign.errorCode, 'PERMISSION_DENIED');
});

test('T5: a telegram member cannot read desktop rows, not even with scope=all', async () => {
  for (const args of [{ chatId: 'own', limit: 1 }, { chatId: 'own', limit: 1, scope: 'all' }]) {
    const entry = outcome(await runSubAgent({ task: 'read', config, chatId: 'tg', chatSource: 'telegram', projectId: 'p1', allowedToolIds: ['read_history'], replyFn: replyWith(call(args)) }));
    assert.equal(entry.ok, false, JSON.stringify(args));
    assert.equal(entry.errorCode, 'PERMISSION_DENIED');
  }
  const own = outcome(await runSubAgent({ task: 'read', config, chatId: 'tg', chatSource: 'telegram', projectId: 'p1', allowedToolIds: ['read_history'], replyFn: replyWith(call({ limit: 1 })) }));
  assert.equal(own.ok, true, 'its own conversation stays readable');
});

test('T5: skills forward the conversation scope to their tools too', async () => {
  const seen = [];
  const registered = getTool('read_history');
  const original = registered.run;
  registered.run = async (args, context) => { seen.push({ chatSource: context.chatSource, projectId: context.projectId }); return original(args, context); };
  try {
    const skill = { id: 'reader', name: 'Reader', type: 'executable', systemPrompt: 'read', toolWhitelist: ['read_history'], maxIterations: 2 };
    const result = await runSkill({ skill, task: 'read', config, chatId: 'own', chatSource: 'desktop', projectId: 'p1', allowedToolIds: ['read_history'], replyFn: replyWith(call({ chatId: 'same', limit: 1 })) });
    assert.equal(result.ok, false, 'the two-round fixture has no remaining round for delivery verification');
    assert.equal(result.output, 'done', 'the candidate answer is retained');
    assert.equal(result.meta.completion.reason, 'GOAL_CHECK_BUDGET');
  } finally { registered.run = original; }
  assert.deepEqual(seen, [{ chatSource: 'desktop', projectId: 'p1' }]);
});
