/**
 * conversationIndex.deletion.test.js
 *
 * 2026-11-14. Two defects of the history search:
 *   - a deleted conversation stayed in the index (nothing ever removed it), so
 *     search_history kept returning excerpts of it;
 *   - the `after` filter compared the stored ISO text with a number, which is
 *     always true in SQLite, so it filtered nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createRequestContext } from '../runtime/requestContext.js';
import { runWithRequestContext } from '../runtime/requestScope.js';
import { loadState, updateStateAtomically } from '../state/stateStore.js';
import { deleteChat } from '../services/chat/chatMutations.js';
import { finishChatDeletions, stageDeletionCatchUp } from '../services/chat/chatDeletion.js';
import { searchHistoryTool } from '../tools/builtins/searchHistoryTool.js';
import {
  indexMessage,
  searchHistory,
  unindexChats,
  _resetConversationIndexForTests,
} from './conversationIndex.js';

const chat = id => ({ id, title: `Chat ${id}`, messages: [], mode: 'chat', projectId: null });
const message = (id, content, createdAt = '2026-10-17T00:00:00.000Z') => ({ id, role: 'user', content, createdAt });

async function withHome(t, fn) {
  const home = await mkdtemp(join(tmpdir(), 'melo-convidx-deletion-'));
  _resetConversationIndexForTests();
  t.after(async () => { _resetConversationIndexForTests(); await rm(home, { recursive: true, force: true }); });
  return runWithRequestContext(createRequestContext({ home }), () => fn({ home }));
}

function rowCounts(home, chatId) {
  const database = new DatabaseSync(join(home, 'desktop', 'search.sqlite'));
  try {
    const messageIds = database.prepare('SELECT message_id AS id FROM messages_fts WHERE chat_id = ?').all(chatId).map(row => row.id);
    return {
      messages: messageIds.length,
      scope: database.prepare('SELECT COUNT(*) AS n FROM message_scope WHERE chat_id = ?').get(chatId).n,
      dedup: database.prepare('SELECT COUNT(*) AS n FROM indexed_message_ids').get().n,
    };
  } finally { database.close(); }
}

test('the after filter keeps only messages created at or after the given instant', t => withHome(t, () => {
  indexMessage('c', 'Chat', message('jan', 'quarterly budget review', '2026-01-01T00:00:00.000Z'));
  indexMessage('c', 'Chat', message('jul', 'quarterly budget review', '2026-07-01T08:30:00.250Z'));
  indexMessage('c', 'Chat', message('offset', 'quarterly budget review', '2026-07-02T01:00:00+08:00'));   // 2026-07-01T17:00Z
  indexMessage('c', 'Chat', message('undated', 'quarterly budget review', ''));

  const ids = options => searchHistory('budget', options).map(row => row.messageId).sort();
  assert.deepEqual(ids({}), ['jan', 'jul', 'offset', 'undated'], 'no filter: everything');
  assert.deepEqual(ids({ after: '2026-06-01' }), ['jul', 'offset'], 'the January message and the undated one are not after June');
  assert.deepEqual(ids({ after: '2026-07-01T08:30:00.250Z' }), ['jul', 'offset'], 'the bound itself is included');
  assert.deepEqual(ids({ after: '2026-07-01T08:30:00.251Z' }), ['offset'], 'one millisecond later excludes it');
  assert.deepEqual(ids({ after: Date.parse('2026-07-01T17:00:00.001Z') }), [], 'a timestamp with an offset is compared as an instant');
  assert.deepEqual(ids({ after: '2027-01-01' }), []);
}));

test('unindexChats removes every row of the given chats and nothing of the others', t => withHome(t, ({ home }) => {
  indexMessage('gone', 'Gone', message('g1', 'kestrel migration notes'), { audience: 'desktop', projectId: 'p1' });
  indexMessage('gone', 'Gone', message('g2', 'kestrel rollout plan'), { audience: 'desktop', projectId: 'p1' });
  indexMessage('kept', 'Kept', message('k1', 'kestrel budget'), { audience: 'desktop', projectId: 'p1' });
  assert.deepEqual(rowCounts(home, 'gone'), { messages: 2, scope: 2, dedup: 3 });

  unindexChats(['gone', 'never-indexed', '']);
  assert.deepEqual(rowCounts(home, 'gone'), { messages: 0, scope: 0, dedup: 1 });
  assert.deepEqual(rowCounts(home, 'kept'), { messages: 1, scope: 1, dedup: 1 });
  assert.deepEqual(searchHistory('kestrel').map(row => row.chatId), ['kept']);

  // The dedup record went with the rows: the same message can be indexed again (a chat restored by sync).
  indexMessage('gone', 'Gone', message('g1', 'kestrel migration notes'), { audience: 'desktop', projectId: 'p1' });
  assert.equal(rowCounts(home, 'gone').messages, 1);
}));

test('liveChatIds drops rows of other chats and still fills the page', t => withHome(t, () => {
  for (let i = 0; i < 12; i += 1) indexMessage('dead', 'Dead', message(`d${i}`, 'osprey osprey osprey deployment'));
  for (let i = 0; i < 3; i += 1) indexMessage('alive', 'Alive', message(`a${i}`, `osprey deployment step ${i} with a longer body so it ranks lower`));
  assert.ok(searchHistory('osprey', { limit: 3 }).every(row => row.chatId === 'dead'), 'the dead chat ranks first without the filter');
  const live = searchHistory('osprey', { limit: 3, liveChatIds: new Set(['alive']) });
  assert.deepEqual(live.map(row => row.chatId), ['alive', 'alive', 'alive']);
  assert.deepEqual(searchHistory('osprey', { limit: 3, liveChatIds: new Set() }), []);
}));

test('deleting a conversation removes it from the history search; the other conversation stays', t => withHome(t, async ({ home }) => {
  await updateStateAtomically(state => { state.chats = [chat('a'), chat('b')]; state.settings.selectedChatId = 'a'; }, { home });
  indexMessage('a', 'Chat a', message('a1', 'heron launch checklist'), { audience: 'desktop', projectId: '' });
  indexMessage('b', 'Chat b', message('b1', 'heron launch retrospective'), { audience: 'desktop', projectId: '' });

  const before = await searchHistoryTool.run({ query: 'heron' }, { chatSource: 'desktop', projectId: '', meloHome: home });
  assert.deepEqual(before.meta.results.map(row => row.chatId).sort(), ['a', 'b']);

  await deleteChat('a');

  assert.deepEqual(rowCounts(home, 'a'), { messages: 0, scope: 0, dedup: 1 }, 'the rows are gone from the index itself');
  const after = await searchHistoryTool.run({ query: 'heron' }, { chatSource: 'desktop', projectId: '', meloHome: home });
  assert.deepEqual(after.meta.results.map(row => row.chatId), ['b']);
  assert.deepEqual((await loadState({ home })).pendingChatDeletions, []);
}));

test('rows of a conversation that no longer exists are never returned by the tool, even while they are still in the index', t => withHome(t, async ({ home }) => {
  await updateStateAtomically(state => { state.chats = [chat('b')]; }, { home });
  // A chat deleted before the cleanup removed index rows: rows present, chat absent, no tombstone.
  indexMessage('orphan', 'Orphan', message('o1', 'plover incident report'), { audience: 'desktop', projectId: '' });
  indexMessage('b', 'Chat b', message('b1', 'plover incident follow-up'), { audience: 'desktop', projectId: '' });
  assert.equal(rowCounts(home, 'orphan').messages, 1);
  const result = await searchHistoryTool.run({ query: 'plover' }, { chatSource: 'desktop', projectId: '', meloHome: home });
  assert.deepEqual(result.meta.results.map(row => row.chatId), ['b']);
  assert.doesNotMatch(result.output, /Orphan/);
}));

test('a failed index cleanup keeps the chat pending and the next run finishes it', t => withHome(t, async ({ home }) => {
  await updateStateAtomically(state => { state.chats = [chat('a')]; }, { home });
  indexMessage('a', 'Chat a', message('a1', 'curlew handover'), { audience: 'desktop', projectId: '' });

  // Make the index unopenable for the cleanup: a directory where the database file belongs.
  _resetConversationIndexForTests();
  const database = join(home, 'desktop', 'search.sqlite');
  const parked = join(home, 'desktop', 'search.sqlite.parked');
  const { rename } = await import('node:fs/promises');
  await rename(database, parked);
  await mkdir(database);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = text => warnings.push(String(text));
  try { await deleteChat('a'); } finally { console.warn = originalWarn; }
  assert.ok(warnings.some(text => text.includes('search cleanup deferred')), warnings.join('\n'));
  assert.deepEqual((await loadState({ home })).pendingChatDeletions, ['a'], 'not reported as cleaned up');

  await rm(database, { recursive: true });
  await rename(parked, database);
  _resetConversationIndexForTests();
  assert.equal(rowCounts(home, 'a').messages, 1, 'the rows are still there, waiting');
  await finishChatDeletions(home);
  assert.equal(rowCounts(home, 'a').messages, 0);
  assert.deepEqual((await loadState({ home })).pendingChatDeletions, []);
}));

test('the one-time catch-up unindexes chats deleted earlier without asking about their files again', t => withHome(t, async ({ home }) => {
  indexMessage('old', 'Old', message('o1', 'dunlin archive'), { audience: 'desktop', projectId: '' });
  indexMessage('kept', 'Kept', message('k1', 'dunlin archive'), { audience: 'desktop', projectId: '' });
  await updateStateAtomically(state => {
    state.chats = [chat('kept')];
    state.mobileDeletedChats = [{ id: 'old', deletedAt: '2026-09-01T00:00:00.000Z' }, { id: 'kept', deletedAt: '2026-09-01T00:00:00.000Z' }];
    state.chatDeletionCleanupVersion = 1;
    state.chatWorkspaceRetentions = [];
  }, { home });

  await updateStateAtomically(state => { stageDeletionCatchUp(state); return state; }, { home });
  let state = await loadState({ home });
  assert.equal(state.chatDeletionCleanupVersion, 2);
  assert.deepEqual(state.chatWorkspaceRetentions, [], 'version 1 already settled the files; nothing is asked again');
  await finishChatDeletions(home);

  assert.equal(rowCounts(home, 'old').messages, 0);
  assert.equal(rowCounts(home, 'kept').messages, 1, 'a chat that exists is never unindexed, tombstone or not');
  state = await loadState({ home });
  assert.ok(!state.pendingChatDeletions.includes('old'));

  // Already at version 2: nothing is staged again.
  await updateStateAtomically(s => { s.pendingChatDeletions = []; stageDeletionCatchUp(s); return s; }, { home });
  assert.deepEqual((await loadState({ home })).pendingChatDeletions, []);
}));

test('a state that never ran the catch-up goes through both steps once', t => withHome(t, async ({ home }) => {
  await updateStateAtomically(state => {
    state.chats = [];
    state.mobileDeletedChats = [{ id: 'first', deletedAt: '2026-09-01T00:00:00.000Z' }];
    delete state.chatDeletionCleanupVersion;
    state.chatWorkspaceRetentions = [];
    state.pendingChatDeletions = [];
  }, { home });
  await updateStateAtomically(state => { stageDeletionCatchUp(state); return state; }, { home });
  const state = await loadState({ home });
  assert.equal(state.chatDeletionCleanupVersion, 2);
  assert.deepEqual(state.pendingChatDeletions, ['first']);
  assert.deepEqual(state.chatWorkspaceRetentions.map(row => row.chatId), ['first'], 'the first step still records the file decision');
}));
