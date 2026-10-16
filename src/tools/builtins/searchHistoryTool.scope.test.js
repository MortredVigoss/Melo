import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexMessage, _resetConversationIndexForTests } from '../../memory/conversationIndex.js';
import { historySearchChatIds } from '../../services/chat/historyScope.js';
import { searchHistoryTool } from './searchHistoryTool.js';

const chats = [
  { id: 'p1-a', title: 'P1 A', projectId: 'p1', messages: [] },
  { id: 'p1-b', title: 'P1 B', projectId: 'p1', messages: [] },
  { id: 'p2-a', title: 'P2 A', projectId: 'p2', messages: [] },
  { id: 'free-a', title: 'Free A', projectId: null, messages: [] },
  { id: 'free-b', title: 'Free B', projectId: null, messages: [] },
  { id: 'tg', title: 'Telegram', projectId: null, source: 'telegram', messages: [] },
];

test('history search never crosses a project boundary or reaches channel chats', async t => {
  const previous = process.env.MELO_HOME;
  const home = mkdtempSync(join(tmpdir(), 'melo-history-scope-'));
  process.env.MELO_HOME = home;
  _resetConversationIndexForTests();
  t.after(() => { _resetConversationIndexForTests(); if (previous === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = previous; rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(home, 'desktop'), { recursive: true });
  writeFileSync(join(home, 'desktop', 'state.json'), JSON.stringify({ chats, projects: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }] }));
  for (const chat of chats) indexMessage(chat.id, chat.title, { id: `${chat.id}-m`, role: 'user', content: `部署端口 ${chat.id}`, createdAt: new Date().toISOString() });

  const state = { chats };
  assert.deepEqual(historySearchChatIds(state, 'p1-a'), ['p1-a', 'p1-b']);
  assert.deepEqual(historySearchChatIds(state, 'free-a'), ['free-a', 'free-b']);
  assert.deepEqual(historySearchChatIds(state, 'tg'), ['tg']);

  const found = async chatId => (await searchHistoryTool.run({ query: '部署端口', limit: 20 }, { chatId, meloHome: home })).meta.results.map(r => r.chatId).sort();
  assert.deepEqual(await found('p1-a'), ['p1-a', 'p1-b'], 'a project chat sees only its project');
  assert.deepEqual(await found('free-a'), ['free-a', 'free-b'], 'outside projects: only other chats outside projects');
  assert.deepEqual(await found('tg'), ['tg'], 'a channel chat sees only itself');
  // Naming another project's chat explicitly still returns nothing.
  const crossing = await searchHistoryTool.run({ query: '部署端口', chatId: 'p2-a' }, { chatId: 'p1-a', meloHome: home });
  assert.equal(crossing.meta.resultCount, 0);
});
