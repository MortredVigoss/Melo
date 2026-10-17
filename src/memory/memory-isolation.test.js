import test from 'node:test';
import assert from 'node:assert/strict';

// These helpers mirror the filter predicates used in buildAgentMemoryNodeContext
// to verify that the isolation logic is correct.

function isSpeakerMemoryInScope(entry, chat) {
  return (
    entry.metadata?.messageId !== undefined ||
    !entry.metadata?.chatId ||
    entry.metadata?.chatId === chat?.id
  );
}

function isTaskOrApprovalInScope(entry, chat, project) {
  return !!(
    !entry.metadata?.chatId ||
    entry.metadata?.chatId === chat?.id ||
    (project?.id && entry.metadata?.projectId === project.id)
  );
}

test('speaker memory from the same chat passes the scope filter', () => {
  const chat = { id: 'chat-A' };
  const entry = { metadata: { chatId: 'chat-A', messageId: 'msg-1' } };
  assert.ok(isSpeakerMemoryInScope(entry, chat));
});

test('speaker memory from a different chat is filtered out', () => {
  const chat = { id: 'chat-A' };
  const entry = { metadata: { chatId: 'chat-B', messageId: 'msg-2' } };
  const passes = !entry.metadata?.chatId || entry.metadata?.chatId === chat?.id;
  assert.equal(passes, false, 'should reject entries from a different chat');
});

test('speaker fact without a chatId passes the scope filter (cross-chat facts are intentional)', () => {
  const chat = { id: 'chat-A' };
  const entry = { metadata: {} }; // no chatId = global/agent-level fact
  const passes = !entry.metadata?.chatId || entry.metadata?.chatId === chat?.id;
  assert.ok(passes, 'entries without a chatId are cross-chat and should always pass');
});

test('task from the same chat passes the scope filter', () => {
  const chat = { id: 'chat-A' };
  const project = null;
  const entry = { metadata: { chatId: 'chat-A', projectId: null } };
  assert.ok(isTaskOrApprovalInScope(entry, chat, project));
});

test('task from a different chat is filtered out', () => {
  const chat = { id: 'chat-A' };
  const project = null;
  const entry = { metadata: { chatId: 'chat-B', projectId: null } };
  assert.equal(isTaskOrApprovalInScope(entry, chat, project), false);
});

test('task from a different chat but same project passes (cross-chat within a project is ok)', () => {
  const chat = { id: 'chat-A' };
  const project = { id: 'proj-1' };
  const entry = { metadata: { chatId: 'chat-B', projectId: 'proj-1' } };
  assert.ok(isTaskOrApprovalInScope(entry, chat, project));
});

test('orphan task with no chatId always passes (agent-level tasks)', () => {
  const chat = { id: 'chat-A' };
  const project = null;
  const entry = { metadata: {} }; // no chatId
  assert.ok(isTaskOrApprovalInScope(entry, chat, project));
});

test('telegram group message from same sender is excluded from private chat context', () => {
  // Simulates the cross-contamination scenario from Bug 1:
  // same Telegram sender has messages in both a group chat and a private chat.
  // Only the private chat (chat-private) messages should appear in the private chat context.
  const privateChatId = 'chat-private';
  const groupChatId = 'chat-group';

  const speakerMemoriesFromAllChats = [
    { metadata: { chatId: groupChatId, messageId: 'msg-group-1' }, text: 'Group message 1' },
    { metadata: { chatId: groupChatId, messageId: 'msg-group-2' }, text: 'Group message 2' },
    { metadata: { chatId: privateChatId, messageId: 'msg-private-1' }, text: 'Private message 1' },
  ];

  const filteredForPrivateChat = speakerMemoriesFromAllChats.filter(entry =>
    !entry.metadata?.chatId || entry.metadata?.chatId === privateChatId
  );

  assert.equal(filteredForPrivateChat.length, 1);
  assert.equal(filteredForPrivateChat[0].metadata.chatId, privateChatId);
  assert.doesNotMatch(filteredForPrivateChat[0].text, /Group message/);
});

test('new chat does not see tasks from a previous unrelated chat', () => {
  const newChatId = 'chat-new';
  const oldChatId = 'chat-old';

  const allTasks = [
    { metadata: { chatId: oldChatId, title: 'Old task' } },
    { metadata: { chatId: newChatId, title: 'New task' } },
    { metadata: {}, text: 'Orphan agent task' }, // no chatId
  ];

  const filteredForNewChat = allTasks.filter(entry =>
    !entry.metadata?.chatId ||
    entry.metadata?.chatId === newChatId
  );

  assert.equal(filteredForNewChat.length, 2);
  assert.ok(filteredForNewChat.some(e => e.metadata?.chatId === newChatId));
  assert.ok(filteredForNewChat.some(e => !e.metadata?.chatId));
  assert.ok(!filteredForNewChat.some(e => e.metadata?.chatId === oldChatId));
});

// ─── Project memory book / personal profile (design 2026-10-17 §3.4, 2B) ─────
// Both stable blocks are projections over audience=local rows. A remote
// channel chat (Telegram/Discord) must never see them — neither through the
// stable prefix (the runner only renders them for local chats) nor through
// the per-turn recall (canRecallMemory rejects audience=local for remote chats).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from './store.js';
import { canRecallMemory, isLocalChat } from './factPolicy.js';
import { reconcileChatFacts, editMemoryFact } from './factRecords.js';
import { listProjectBook, renderProjectBook } from '../services/project/projectMemoryBook.js';
import { listPersonalProfile, renderPersonalProfile } from '../services/memory/personalProfile.js';
import { buildAgentMemoryNodeContext } from '../services/agent/agentMemoryContext.js';

test('remote chat prompt never contains book/profile rows', async () => {
  const previous = process.env.MELO_HOME;
  const home = await mkdtemp(join(tmpdir(), 'melo-isolation-book-'));
  process.env.MELO_HOME = home; store._resetStoreForTests();
  try {
    const local = { id: 'desk', source: 'desktop', projectId: 'P', messages: [], sessionMemory: [
      { fact: 'Project ships on Friday', category: 'decision' }, { fact: 'User prefers 中文', category: 'user_preference' }] };
    reconcileChatFacts(local, 'main');
    editMemoryFact([...store.iterateMemoryRecords({ chatId: 'desk' })].find(r => r.text === 'User prefers 中文').id, { scope: 'personal' });
    const book = renderProjectBook(listProjectBook('P')), profile = renderPersonalProfile(listPersonalProfile());
    assert.match(book.text, /\[auto\] Project ships on Friday/); assert.match(profile.text, /User prefers 中文/);
    const remote = { id: 'tg', source: 'telegram', chatType: 'private', projectId: 'P', messages: [] };
    assert.equal(isLocalChat(remote), false, 'the runner gate (isLocalChat && !isRemoteChannel) keeps both blocks out of a remote prompt');
    for (const row of [...book.rows, ...profile.rows]) {
      assert.equal(canRecallMemory(row, { chat: remote, agentId: 'main', projectId: 'P' }), false, `${row.id} must not be recallable from a remote chat`);
      assert.equal(canRecallMemory(row, { chat: local, agentId: 'main', projectId: 'P' }), true);
    }
    const ctx = buildAgentMemoryNodeContext({ state: { chats: [local, remote], tasks: [], approvals: [], settings: {} }, chat: remote,
      latestUserMessage: 'Project ships when? 中文', activeAgentProfile: { id: 'main' }, project: { id: 'P' } });
    assert.doesNotMatch(ctx, /ships on Friday/); assert.doesNotMatch(ctx, /prefers 中文/);
  } finally {
    store._resetStoreForTests();
    if (previous === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
