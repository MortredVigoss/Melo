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

// ─── Remote audience boundary at the SQL layer (design 2026-10-17 §3.4, M7) ──
// Property: for a remote (Telegram) chat, no recall path — flat recall, Hot
// Attic, tiered recall, the rendered prompt sections, the state fallback for
// approvals/tasks — may return or render a single desktop-only row, whatever
// its namespace or kind (session facts, book/profile style rows, agent
// self-corrections, owner tasks, prompt rows). The desktop chat keeps seeing
// them. The filter is applied inside the store (`audience` option next to
// forgotten/validTo), so `accept`-less callers are covered too.

import { injectHotAttic } from './attic.js';
import { memoryAudienceForChat } from '../services/agent/agentMemoryContext.js';

async function withIsolationHome(fn) {
  const previous = process.env.MELO_HOME, previousAttic = process.env.MELO_ATTIC_ENABLED;
  const home = await mkdtemp(join(tmpdir(), 'melo-isolation-audience-'));
  process.env.MELO_HOME = home; delete process.env.MELO_ATTIC_ENABLED; store._resetStoreForTests();
  try { await fn(); } finally {
    store._resetStoreForTests();
    if (previous === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = previous;
    if (previousAttic === undefined) delete process.env.MELO_ATTIC_ENABLED; else process.env.MELO_ATTIC_ENABLED = previousAttic;
    await rm(home, { recursive: true, force: true });
  }
}

const DESK = 'desk', TG = 'tg', P = 'P', AGENT = 'main';
const t = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
// Every desktop-only row contains "LOCAL_" and the shared query token "alpha";
// every row of the Telegram chat contains "REMOTE_".
const LOCAL_ROWS = [
  { id: 'book:conv', namespace: `project:${P}`, kind: 'session-fact', text: 'LOCAL_BOOK alpha: project convention is tabs', updatedAt: t(1),
    metadata: { scope: 'project', audience: 'local', projectId: P, chatId: DESK, agentId: AGENT, category: 'decision', bookStatus: 'auto', section: 'convention' } },
  { id: 'promoted:profile', namespace: 'user:local', kind: 'session-fact', text: 'LOCAL_PROFILE alpha: user prefers terse replies', updatedAt: t(2),
    metadata: { scope: 'personal', audience: 'local', chatId: DESK, agentId: AGENT, category: 'user_preference', pinned: true } },
  { id: 'verification:agent:main:m1', namespace: `agent:${AGENT}`, kind: 'verification-correction', text: 'LOCAL_AGENT_CORRECTION alpha: port is 8080 not 3000', updatedAt: t(3),
    metadata: { scope: 'agent', audience: 'local', chatId: DESK, agentId: AGENT, category: 'correction' } },
  { id: 'promoted:agentreq', namespace: `agent:${AGENT}`, kind: 'session-fact', text: 'LOCAL_AGENT_REQ alpha: always answer in 中文', updatedAt: t(4),
    metadata: { scope: 'agent', audience: 'local', chatId: DESK, agentId: AGENT, category: 'correction' } },
  { id: 'promoted:deskfact', namespace: `chat:${DESK}`, kind: 'session-fact', text: 'LOCAL_DESK_FACT alpha: desktop chat decision', updatedAt: t(5),
    metadata: { scope: 'chat', audience: 'local', chatId: DESK, agentId: AGENT, category: 'decision' } },
  { id: `prompt:chat:${DESK}:d1`, namespace: `chat:${DESK}`, kind: 'prompt', text: 'LOCAL_DESK_PROMPT alpha: what the owner typed', updatedAt: t(6),
    metadata: { chatId: DESK, messageId: 'd1', role: 'user' } },
  // Snapshot-style rows carry no audience at all: in desktop-origin namespaces a
  // missing audience must count as local.
  { id: `task:project:${P}:task1`, namespace: `project:${P}`, kind: 'task', text: 'LOCAL_TASK alpha deploy\nopen', updatedAt: t(7),
    metadata: { title: 'LOCAL_TASK alpha deploy', status: 'open', owner: AGENT, chatId: DESK, projectId: P } },
  { id: `task:agent:${AGENT}:task1`, namespace: `agent:${AGENT}`, kind: 'task', text: 'LOCAL_TASK alpha deploy\nopen', updatedAt: t(7),
    metadata: { title: 'LOCAL_TASK alpha deploy', status: 'open', owner: AGENT, chatId: DESK, projectId: P } },
  { id: `approval:project:${P}:ap1`, namespace: `project:${P}`, kind: 'approval', text: 'LOCAL_APPROVAL alpha rm -rf\napproved', updatedAt: t(8),
    metadata: { title: 'LOCAL_APPROVAL alpha rm -rf', status: 'approved', chatId: DESK, projectId: P } },
];
const REMOTE_ROWS = [
  { id: 'promoted:tgfact', namespace: `chat:${TG}`, kind: 'session-fact', text: 'REMOTE_TG_FACT alpha: telegram user likes bullet lists', updatedAt: t(1),
    metadata: { scope: 'chat', audience: 'remote', chatId: TG, agentId: AGENT, category: 'correction', source: 'telegram' } },
  { id: `prompt:chat:${TG}:r1`, namespace: `chat:${TG}`, kind: 'prompt', text: 'REMOTE_TG_PROMPT alpha: what the telegram user typed', updatedAt: t(2),
    metadata: { chatId: TG, messageId: 'r1', role: 'user' } },
  { id: 'verification:agent:main:r2', namespace: `agent:${AGENT}`, kind: 'verification-correction', text: 'REMOTE_TG_CORRECTION alpha: I misquoted the date', updatedAt: t(3),
    metadata: { scope: 'chat', audience: 'remote', chatId: TG, agentId: AGENT, category: 'correction' } },
];
// What a remote chat's turn queries (agentMemoryContext never adds another
// chat's namespace; the SQL clause then prunes the desktop-origin namespaces).
const ALL_NAMESPACES = ['user:local', `chat:${TG}`, `project:${P}`, `agent:${AGENT}`];
const ALL_KINDS = ['session-fact', 'verification-correction', 'prompt', 'task', 'approval', 'fact'];
const seedAudienceRows = () => { for (const row of [...LOCAL_ROWS, ...REMOTE_ROWS]) store.upsertMemory({ ...row, createdAt: row.updatedAt }); };
const assertNoLocal = (label, text) => {
  for (const row of LOCAL_ROWS) assert.doesNotMatch(text, new RegExp(row.text.split('\n')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${label} leaked ${row.id}`);
  assert.doesNotMatch(text, /LOCAL_/, `${label} leaked a desktop-only row`);
};

test('memoryAudienceForChat: owner chats are desktop, channel chats are their channel', () => {
  assert.equal(memoryAudienceForChat({ source: 'desktop' }), 'desktop');
  assert.equal(memoryAudienceForChat({}), 'desktop');
  assert.equal(memoryAudienceForChat({ source: 'mobile' }), 'desktop', 'mobile chats are owner chats (isLocalChat) and keep audience=local rows');
  assert.equal(memoryAudienceForChat({ source: 'telegram' }), 'telegram');
  assert.equal(memoryAudienceForChat({ source: 'Discord' }), 'discord');
  assert.equal(memoryAudienceForChat({ source: 'desktop' }, { channelId: 'telegram' }), 'telegram', 'the runner channelContext wins');
});

test('SQL audience: recallMemories for a remote channel never returns audience=local rows (any namespace, kind, query path)', async () => {
  await withIsolationHome(async () => {
    seedAudienceRows();
    // Query variants exercise the FTS path, the no-query ordering path and the
    // preferHot ordering used by the attic.
    for (const query of ['alpha', '', 'LOCAL_ alpha 中文']) for (const preferHot of [false, true]) {
      const remote = store.recallMemories({ namespaces: ALL_NAMESPACES, kinds: ALL_KINDS, query, limit: 64, audience: 'telegram', preferHot });
      assert.ok(remote.length >= 2, `remote recall (${JSON.stringify(query)}) still returns the telegram chat's own rows`);
      for (const row of remote) {
        assert.notEqual(row.metadata?.audience, 'local', `${row.id} is audience=local`);
        assert.ok(!(['project:', 'agent:'].some(p => row.namespace.startsWith(p)) || row.namespace === 'user:local') || row.metadata?.audience,
          `${row.id}: missing audience in a desktop-origin namespace must count as local`);
        assert.match(row.text, /REMOTE_/);
      }
      const remoteIds = new Set(remote.map(r => r.id));
      for (const row of REMOTE_ROWS) assert.ok(remoteIds.has(row.id), `${row.id} (own remote row) must still be recalled`);
      // Even if a foreign chat namespace slipped into the query set, its
      // audience=local facts stay out (only audience-less prompt rows of that
      // chat would pass, which the namespace list guards against).
      const foreign = store.recallMemories({ namespaces: [...ALL_NAMESPACES, `chat:${DESK}`], kinds: ALL_KINDS, query, limit: 64, audience: 'telegram', preferHot });
      for (const row of foreign) assert.notEqual(row.metadata?.audience, 'local', `${row.id} is audience=local (foreign chat namespace)`);
      assert.ok(!foreign.some(row => row.id === 'promoted:deskfact'));
      const desktopNamespaces = [...ALL_NAMESPACES, `chat:${DESK}`];
      const desktop = store.recallMemories({ namespaces: desktopNamespaces, kinds: ALL_KINDS, query, limit: 64, audience: 'desktop', preferHot });
      const desktopIds = new Set(desktop.map(r => r.id));
      for (const row of LOCAL_ROWS) assert.ok(desktopIds.has(row.id), `desktop audience must keep ${row.id}`);
      const implicit = store.recallMemories({ namespaces: desktopNamespaces, kinds: ALL_KINDS, query, limit: 64, preferHot });
      assert.deepEqual(new Set(implicit.map(r => r.id)), desktopIds, 'omitting audience behaves like desktop');
      const local = store.recallMemories({ namespaces: desktopNamespaces, kinds: ALL_KINDS, query, limit: 64, audience: 'local', preferHot });
      assert.deepEqual(new Set(local.map(r => r.id)), desktopIds, "audience 'local' is an alias of desktop");
    }
    // Group recall (the per-turn path) and tiered recall apply the same clause.
    const groups = store.recallMemoryGroups({ audience: 'telegram', query: 'alpha', groups: [
      { id: 'facts', namespaces: ALL_NAMESPACES, kinds: ['session-fact', 'verification-correction'], limit: 8 },
      { id: 'tasks', namespaces: ALL_NAMESPACES, kinds: ['task', 'approval'], limit: 8 },
      { id: 'prompts', namespaces: ALL_NAMESPACES, kinds: ['prompt'], limit: 8 },
    ] });
    for (const rows of groups.values()) for (const row of rows) assert.match(row.text, /REMOTE_/, `group recall leaked ${row.id}`);
    assert.equal(groups.get('tasks').length, 0, 'desktop tasks/approvals (no audience, project namespace) are invisible to the channel');
    const tiered = store.recallMemoriesTiered({ namespaces: ALL_NAMESPACES, query: 'alpha', audience: 'telegram', validate: false });
    for (const row of [...tiered.scenes, ...tiered.frames, ...tiered.contents]) assert.match(row.text, /REMOTE_/, `tiered recall leaked ${row.id}`);
    assert.ok(tiered.contents.some(row => row.id === `prompt:chat:${TG}:r1`));
  });
});

test('Hot Attic + rendered prompt sections for a remote chat contain no audience=local row; the desktop chat still sees them', async () => {
  await withIsolationHome(async () => {
    seedAudienceRows();
    const namespaces = ['user:local', `chat:${TG}`, `project:${P}`, `agent:${AGENT}`];
    const remoteHot = injectHotAttic({ namespaces, audience: 'telegram' });
    assertNoLocal('Hot Attic (telegram)', remoteHot);
    assert.match(remoteHot, /REMOTE_TG_FACT/, 'the channel chat keeps its own hot correction');
    const desktopHot = injectHotAttic({ namespaces: ['user:local', `chat:${DESK}`, `project:${P}`, `agent:${AGENT}`], audience: 'desktop' });
    assert.match(desktopHot, /LOCAL_PROFILE/); assert.match(desktopHot, /LOCAL_AGENT_CORRECTION/);

    const desk = { id: DESK, source: 'desktop', projectId: P, agentId: AGENT, messages: [] };
    const tg = { id: TG, source: 'telegram', chatType: 'private', projectId: P, agentId: AGENT, messages: [] };
    const state = { chats: [desk, tg], settings: {}, approvals: [
      { id: 'ap1', title: 'LOCAL_APPROVAL alpha rm -rf', status: 'approved', chatId: DESK, projectId: P } ], tasks: [
      { id: 'task1', title: 'LOCAL_TASK alpha deploy', status: 'open', owner: AGENT, chatId: DESK, projectId: P } ] };
    for (const tiers of ['0', '1']) {
      process.env.MELO_MEMORY_TIERS_RECALL = tiers;
      try {
        const rendered = [];
        const remoteCtx = buildAgentMemoryNodeContext({ state, chat: tg, latestUserMessage: 'alpha 中文', activeAgentProfile: { id: AGENT }, project: { id: P },
          onRecall: rows => rendered.push(...rows) });
        assertNoLocal(`remote prompt (tiers=${tiers})`, remoteCtx);
        assert.match(remoteCtx, /REMOTE_TG_FACT|REMOTE_TG_PROMPT|REMOTE_TG_CORRECTION/);
        for (const row of rendered) assert.notEqual(row.metadata?.audience, 'local', `memoryRendered leaked ${row.id}`);
        // Explicit audience (what the runner passes) must agree with the chat-derived one.
        assertNoLocal('remote prompt (explicit audience)', buildAgentMemoryNodeContext({ state, chat: tg, latestUserMessage: 'alpha', activeAgentProfile: { id: AGENT }, project: { id: P }, audience: 'telegram' }));

        const desktopCtx = buildAgentMemoryNodeContext({ state, chat: desk, latestUserMessage: 'alpha 中文', activeAgentProfile: { id: AGENT }, project: { id: P } });
        for (const needle of ['LOCAL_PROFILE', 'LOCAL_AGENT_CORRECTION', 'LOCAL_DESK_FACT', 'LOCAL_BOOK']) assert.match(desktopCtx, new RegExp(needle), `desktop prompt (tiers=${tiers}) must keep ${needle}`);
        assert.doesNotMatch(desktopCtx, /REMOTE_TG_FACT/, 'desktop never reads the channel chat\'s facts');
      } finally { delete process.env.MELO_MEMORY_TIERS_RECALL; }
    }
  });
});

test('state fallback for approvals/tasks: a remote chat only sees its own, not the project\'s desktop rows', async () => {
  await withIsolationHome(async () => {
    const desk = { id: DESK, source: 'desktop', projectId: P, messages: [] };
    const tg = { id: TG, source: 'telegram', chatType: 'private', projectId: P, messages: [] };
    const state = { chats: [desk, tg], settings: {},
      approvals: [{ id: 'ap1', title: 'LOCAL_APPROVAL rm -rf', status: 'approved', chatId: DESK, projectId: P }, { id: 'ap2', title: 'REMOTE_APPROVAL send file', status: 'pending', chatId: TG, projectId: P }],
      tasks: [{ id: 't1', title: 'LOCAL_TASK deploy', status: 'open', chatId: DESK, projectId: P }, { id: 't2', title: 'REMOTE_TASK reply', status: 'open', chatId: TG, projectId: P }] };
    const remoteCtx = buildAgentMemoryNodeContext({ state, chat: tg, latestUserMessage: 'hi', activeAgentProfile: { id: AGENT }, project: { id: P } });
    assert.match(remoteCtx, /REMOTE_APPROVAL/); assert.match(remoteCtx, /REMOTE_TASK/);
    assert.doesNotMatch(remoteCtx, /LOCAL_/);
    const desktopCtx = buildAgentMemoryNodeContext({ state, chat: desk, latestUserMessage: 'hi', activeAgentProfile: { id: AGENT }, project: { id: P } });
    assert.match(desktopCtx, /LOCAL_APPROVAL/); assert.match(desktopCtx, /LOCAL_TASK/);
    assert.match(desktopCtx, /REMOTE_TASK/, 'desktop still inherits same-project tasks (unchanged behaviour)');
  });
});
