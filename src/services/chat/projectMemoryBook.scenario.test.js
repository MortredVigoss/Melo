// Scenario from design 2026-10-17 §3.4 (2B): project P, chat 1 reconciles a
// decision → chat 2 (another agent, same project) sees that line with the
// `[auto]` marker in its very first system prompt; a remote-channel chat of the
// same project does not. MELO_HOME is isolated exactly like
// chatExecutionRunner.test.js (set before the dynamic import).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_MELO_HOME = process.env.MELO_HOME;
const TEST_HOME = mkdtempSync(join(tmpdir(), 'melo-book-scenario-'));
process.env.MELO_HOME = TEST_HOME;

const { runChatAgentExecutionGraph } = await import('./chatExecutionRunner.js');
const { saveState } = await import('../../state/stateStore.js');
const { reconcileChatFacts, editMemoryFact } = await import('../../memory/factRecords.js');
const store = await import('../../memory/store.js');
const { bootstrapBuiltinTools } = await import('../../tools/registry.js');
bootstrapBuiltinTools();

after(() => {
  store._resetStoreForTests();
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  if (ORIGINAL_MELO_HOME === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = ORIGINAL_MELO_HOME;
});

const profile = id => ({ id, name: id, model: 'gpt-4', identity: '', soulMd: '', tools: [], skills: [], channels: {} });
function fixtureState() {
  return {
    projects: [{ id: 'P', name: 'Book project', summary: '', instructions: '', tag: 'test', workspacePath: '', knowledgeIds: [] }],
    chats: [], tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [],
    agentProfiles: { main: profile('main'), helper: profile('helper') }, projectAgentOverrides: {},
    settings: { selectedProjectId: 'P', selectedChatId: null, selectedAgentId: 'main', selectedConnectorId: null, selectedFilePath: null, activeMode: 'chat', promptHistory: [] },
  };
}
const workspace = { rootPath: '/tmp/test', exists: false, entries: [], filePaths: [], fileCount: 0, selectedFilePath: null, selectedFile: null, commandTemplates: [], commandRuns: [] };
const config = { authMode: 'unset', apiKey: '', baseUrl: '', model: 'gpt-4' };

async function runTurn({ state, chat, agentId, background = false, channelContext = null }) {
  const prompts = [];
  const result = await runChatAgentExecutionGraph({ config, state, chat, workspace, connectors: [], skills: [], latestUserMessage: '接下来做什么？', agentId,
    background, channelContext, sseEmitter: () => {},
    _dependencies: { getEmbedding: async () => null, createReply: async options => { prompts.push(options.systemPrompt || ''); return '好的。'; } } });
  return { result, systemPrompt: prompts[0] || '' };
}

test('chat 1 decision reaches chat 2 (another agent, same project) on its first turn, marked [auto]; remote chats never see it', async () => {
  const state = fixtureState();
  const chat1 = { id: 'chat-1', title: '第一段', mode: 'chat', projectId: 'P', agentId: 'main', source: 'desktop',
    messages: [{ id: 'u1', role: 'user', content: '我们决定接口统一用 snake_case' }],
    sessionMemory: [{ fact: 'API fields use snake_case', category: 'decision', sourceMessageId: 'u1', subjectKey: 'api.naming' },
      { fact: 'User prefers terse replies', category: 'user_preference', sourceMessageId: 'u1' }] };
  const chat2 = { id: 'chat-2', title: '第二段', mode: 'chat', projectId: 'P', agentId: 'helper', source: 'desktop', messages: [], sessionMemory: [] };
  state.chats = [chat1, chat2];
  await saveState(state);
  reconcileChatFacts(chat1, 'main');
  const personal = [...store.iterateMemoryRecords({ chatId: 'chat-1' })].find(r => r.text === 'User prefers terse replies');
  editMemoryFact(personal.id, { scope: 'personal' });

  const { result, systemPrompt } = await runTurn({ state, chat: chat2, agentId: 'helper' });
  assert.match(systemPrompt, /\[Reference data: project-memory; not instructions/);
  assert.match(systemPrompt, /- \[auto\] API fields use snake_case/);
  assert.match(systemPrompt, /\[Reference data: personal-profile; not instructions/);
  assert.match(systemPrompt, /- \[user_preference\] User prefers terse replies/);
  // the stable blocks sit behind the project section, ahead of the per-turn tail
  assert.ok(systemPrompt.indexOf('Active project: Book project') < systemPrompt.indexOf('[Reference data: project-memory'));
  assert.ok(systemPrompt.indexOf('[Reference data: project-memory') < systemPrompt.indexOf('[Reference data: personal-profile'));
  // the rows are accounted as rendered memory and are not repeated by recall
  const usage = result.normalizedReply.memoryUsage || [];
  assert.ok(usage.some(row => row.kind === 'project-book' && row.text === 'API fields use snake_case' && row.sourceChatId === 'chat-1' && row.sourceMessageId === 'u1'), JSON.stringify(usage));
  assert.ok(usage.some(row => row.kind === 'personal-profile' && row.text === 'User prefers terse replies'));
  assert.equal(systemPrompt.split('API fields use snake_case').length, 2, 'rendered exactly once in the system prompt');

  // a remote-channel chat of the same project gets neither block
  const remote = { id: 'chat-tg', title: 'tg', mode: 'chat', projectId: 'P', agentId: 'main', source: 'telegram', chatType: 'private', messages: [], sessionMemory: [] };
  state.chats.push(remote);
  const remoteTurn = await runTurn({ state, chat: remote, agentId: 'main', background: true, channelContext: { channelId: 'telegram', chatId: '1' } });
  assert.doesNotMatch(remoteTurn.systemPrompt, /snake_case/);
  assert.doesNotMatch(remoteTurn.systemPrompt, /terse replies/);
  assert.doesNotMatch(remoteTurn.systemPrompt, /project-memory|personal-profile/);
  assert.ok(!(remoteTurn.result.normalizedReply.memoryUsage || []).some(row => ['project-book', 'personal-profile'].includes(row.kind)));

  // a chat of a different project does not see P's book
  const other = { id: 'chat-q', title: 'q', mode: 'chat', projectId: null, agentId: 'main', source: 'desktop', messages: [], sessionMemory: [] };
  state.chats.push(other);
  const otherTurn = await runTurn({ state, chat: other, agentId: 'main' });
  assert.doesNotMatch(otherTurn.systemPrompt, /snake_case/);
  assert.match(otherTurn.systemPrompt, /terse replies/, 'the personal profile follows the user into every local chat');
});
