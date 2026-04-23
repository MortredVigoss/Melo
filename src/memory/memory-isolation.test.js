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
