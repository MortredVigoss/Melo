// 2026-10-18 audit L1: a supplement typed mid-turn is appended to the stored
// question's content AND its blocks, so the UI (messageVisibleText) and the
// next turn's model history both carry it. Runs the real sendChatMessage
// persistence path with the mocked model.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_MELO_HOME = process.env.MELO_HOME;
const ORIGINAL_MOCK_RESPONSE = process.env.MELO_MOCK_RESPONSE;
const TEST_HOME = mkdtempSync(join(tmpdir(), 'melo-supplement-e2e-'));
for (const dir of ['desktop', 'desktop/agents', 'desktop/threads']) mkdirSync(join(TEST_HOME, dir), { recursive: true });

writeFileSync(join(TEST_HOME, 'desktop', 'state.json'), JSON.stringify({
  projects: [],
  chats: [{ id: 'sup-chat-1', title: 'supplement-test', mode: 'chat', projectId: null, agentId: 'main', source: 'desktop', chatType: 'private', messages: [], sessionMemory: [] }],
  tasks: [], approvals: [], artifacts: [], commandRuns: [], externalConnectors: [], externalToolRuns: [],
  agentProfiles: { main: { id: 'main', name: 'main', model: 'gpt-4o', identity: '', soulMd: '', tools: [], skills: [], channels: {} } },
  projectAgentOverrides: {},
  settings: { selectedProjectId: null, selectedChatId: null, selectedAgentId: 'main', selectedConnectorId: null, selectedFilePath: null,
    activeMode: 'chat', promptHistory: [], enabledConnectorIds: [], enabledSkillIds: [], customSkills: [] },
}));

process.env.MELO_HOME = TEST_HOME;
process.env.MELO_MOCK_RESPONSE = 'mock-reply';
const { sendChatMessage } = await import('./sendChatMessage.js');
const { beginSupplements, addSupplement, takeSupplements, endSupplements } = await import('./supplements.js');
const { loadState } = await import('../../state/stateStore.js');
const { messageVisibleText } = await import('../../domain/message/messageBlocks.js');
const { buildModelMessagesFromChat } = await import('./messageBuilder.js');
const { searchHistory, _resetConversationIndexForTests } = await import('../../memory/conversationIndex.js');

after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  if (ORIGINAL_MELO_HOME === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = ORIGINAL_MELO_HOME;
  if (ORIGINAL_MOCK_RESPONSE === undefined) delete process.env.MELO_MOCK_RESPONSE; else process.env.MELO_MOCK_RESPONSE = ORIGINAL_MOCK_RESPONSE;
});

test('a used supplement lands in the stored question content, its blocks, the visible text, the next turn history and the search index', { timeout: 60000 }, async () => {
  _resetConversationIndexForTests();
  // The route begins the run; the agent loop takes the supplement before its
  // next model call. Simulate that: the supplement is already "used" when
  // the reply is persisted.
  beginSupplements('sup-chat-1');
  addSupplement('sup-chat-1', '改成五言绝句');
  takeSupplements('sup-chat-1');
  try {
    const result = await sendChatMessage({ chatId: 'sup-chat-1', content: '写一首关于秋天的诗', mode: 'chat', skipBootstrap: true });
    assert.ok(result.assistantMessage);
  } finally {
    endSupplements('sup-chat-1');
  }
  const state = await loadState({ home: TEST_HOME });
  const chat = state.chats.find(entry => entry.id === 'sup-chat-1');
  const question = chat.messages.find(message => message.role === 'user');
  assert.match(question.content, /写一首关于秋天的诗\n\n补充：改成五言绝句$/);
  assert.ok(Array.isArray(question.blocks) && question.blocks.length, 'blocks were rebuilt');
  assert.match(messageVisibleText(question), /改成五言绝句/, 'the UI text (blocks first) shows the supplement');
  // Next turn: the model history built from the stored chat carries the supplement.
  const nextTurn = { ...chat, messages: [...chat.messages, { id: 'next', role: 'user', content: '再来一首' }] };
  const history = buildModelMessagesFromChat(nextTurn, { windowTokens: 60000 });
  const sent = history.find(message => message.role === 'user' && /秋天/.test(typeof message.content === 'string' ? message.content : JSON.stringify(message.content)));
  assert.ok(sent, 'the original question is in the next turn history');
  assert.match(typeof sent.content === 'string' ? sent.content : JSON.stringify(sent.content), /改成五言绝句/);
  // L19: the stored (amended) question is what got indexed.
  const hits = searchHistory('五言绝句', { audience: 'desktop' });
  assert.ok(hits.some(hit => hit.messageId === question.id), 'the supplement is searchable');
});
