// Smoke test for sendChatMessage's remote-background path —
// sub-phase 7d-5δ commit 8f follow-up.
//
// Why this file exists: gate's C-grade on the 8f extraction caught a
// missing-import (APP_ROOT / COMMAND_TEMPLATES / commandTemplateDescriptor
// were referenced by the `shouldUseBackgroundWorkspace` branch but not
// imported into the new module). 724 unit tests went green because none
// of them actually drive sendChatMessage with `background: true` and a
// channelContext.channelId. This file adds that coverage so a future
// import-block regression on the remote path goes red before push.
//
// MELO_HOME isolation (per the data-loss lesson on commit 7c): mkdtemp
// before importing the runner, restore after, and assert the dev's real
// `~/.melo/desktop/state.json` mtime didn't change during the suite.
//
// Coverage:
//   • Test 1 (background remote path) — drives sendChatMessage with
//     background=true + channelContext, triggers approval early-exit so
//     the runner never has to call a real model. Exercises:
//       - the remote-background workspace fallback at line ~131 (which
//         hid the APP_ROOT/COMMAND_TEMPLATES missing-import bug)
//       - userMessage append + atomic persistence path
//       - approval path through runChatAgentExecutionGraph
//
// The non-background path is already covered by the runner's own smoke
// tests in chatExecutionRunner.test.js — no need to re-test it here.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const REAL_HOME_STATE_PATH = join(homedir(), '.melo', 'desktop', 'state.json');
const REAL_HOME_GUARD_ENABLED = process.env.MELO_TEST_GUARD_REAL_HOME === '1';
const REAL_STATE_MTIME_BEFORE =
  REAL_HOME_GUARD_ENABLED && existsSync(REAL_HOME_STATE_PATH)
    ? statSync(REAL_HOME_STATE_PATH).mtimeMs
    : null;

const ORIGINAL_MELO_HOME = process.env.MELO_HOME;
const TEST_HOME = mkdtempSync(join(tmpdir(), 'melo-sendchat-test-'));
mkdirSync(join(TEST_HOME, 'desktop'), { recursive: true });
mkdirSync(join(TEST_HOME, 'desktop', 'agents'), { recursive: true });
mkdirSync(join(TEST_HOME, 'desktop', 'threads'), { recursive: true });

// Seed state.json with a remote chat the runner's planner will hit.
writeFileSync(
  join(TEST_HOME, 'desktop', 'state.json'),
  JSON.stringify({
    projects: [],
    chats: [
      {
        id: 'tg-chat-1',
        title: 'remote-test',
        mode: 'chat',
        projectId: null,
        agentId: 'main',
        source: 'telegram',
        chatType: 'private',
        messages: [],
        sessionMemory: [],
      },
    ],
    tasks: [],
    approvals: [],
    artifacts: [],
    commandRuns: [],
    externalConnectors: [],
    externalToolRuns: [],
    agentProfiles: {
      main: {
        id: 'main',
        name: 'main',
        model: 'gpt-4',
        identity: '',
        soulMd: '',
        tools: ['local-command'],
        skills: [],
        // Telegram channel enabled so the channel-route / agent-channel
        // checks line up with the background path.
        channels: { telegram: { enabled: true, botToken: 'fake' } },
      },
    },
    projectAgentOverrides: {},
    settings: {
      selectedProjectId: null,
      selectedChatId: null,
      selectedAgentId: 'main',
      selectedConnectorId: null,
      selectedFilePath: null,
      activeMode: 'chat',
      promptHistory: [],
      enabledConnectorIds: [],
      enabledSkillIds: [],
      customSkills: [],
    },
  }),
);

process.env.MELO_HOME = TEST_HOME;
const { sendChatMessage } = await import('./sendChatMessage.js');

after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  if (ORIGINAL_MELO_HOME === undefined) {
    delete process.env.MELO_HOME;
  } else {
    process.env.MELO_HOME = ORIGINAL_MELO_HOME;
  }
  if (REAL_HOME_GUARD_ENABLED && REAL_STATE_MTIME_BEFORE !== null && existsSync(REAL_HOME_STATE_PATH)) {
    const after = statSync(REAL_HOME_STATE_PATH).mtimeMs;
    if (after > REAL_STATE_MTIME_BEFORE) {
      throw new Error(
        `MELO_HOME isolation regressed — ${REAL_HOME_STATE_PATH} was modified during this test suite.`,
      );
    }
  }
});

test('sendChatMessage remote background path: imports + workspace fallback resolve cleanly (would catch APP_ROOT/COMMAND_TEMPLATES regression)', async () => {
  // background: true + channelContext.channelId triggers the
  // shouldUseBackgroundWorkspace branch that synthesizes an empty
  // workspace using APP_ROOT / COMMAND_TEMPLATES / commandTemplateDescriptor.
  // "git status" + local-command tool triggers the runner's approval
  // early-exit so the real model is never called.
  const result = await sendChatMessage({
    chatId: 'tg-chat-1',
    content: 'git status',
    mode: 'chat',
    background: true,
    skipBootstrap: true,
    channelContext: {
      channelId: 'telegram',
      chatType: 'private',
      senderId: 'user-42',
      senderName: 'Test User',
      remoteChatId: 'tg-42',
    },
  });

  assert.ok(result, 'sendChatMessage must return a result');
  assert.equal(existsSync(join(TEST_HOME,'workspaces','chats','tg-chat-1')),false,'Remote approval without file execution must not create a workspace');
  assert.ok(result.assistantMessage, 'assistantMessage must be present');
  // background+skipBootstrap = no bootstrap payload.
  assert.equal(result.bootstrap, null);
  // The approval early-exit branch puts the assistant message body through
  // normalizeAssistantReplyForConversation. Just verify content is non-empty
  // (any string — exact wording is owned by buildApprovalResponse + may evolve).
  assert.ok(
    typeof result.assistantMessage.content === 'string' &&
      result.assistantMessage.content.length > 0,
    `expected non-empty assistant content, got: ${JSON.stringify(result.assistantMessage.content)}`,
  );
});

// 2026-11-08 (settings browser flake): a finished reply re-selected its chat
// and forced activeView back to 'chat', undoing where the user had gone while
// the reply was still being written. The send selects its chat when it
// starts; finishing leaves the user's later navigation alone.
test('a reply that finishes never pulls the view back after the user moved on', async () => {
  const { updateStateAtomically, loadState } = await import('../../state/stateStore.js');
  await updateStateAtomically(state => {
    if (!state.chats.some(chat => chat.id === 'desk-chat-1')) state.chats.push({ id: 'desk-chat-1', title: 'desk', mode: 'chat', projectId: null, agentId: 'main', source: 'desktop', messages: [], sessionMemory: [] });
    return state;
  });
  const previous = process.env.MELO_MOCK_RESPONSE;
  process.env.MELO_MOCK_RESPONSE = 'fixture response written in several chunks';
  let moved = false, selectedAtStart = null;
  try {
    const result = await sendChatMessage({ chatId: 'desk-chat-1', content: 'hello there', mode: 'chat', skipBootstrap: true,
      onDelta: async () => {
        if (moved) return;
        moved = true;
        selectedAtStart = (await loadState()).settings;
        // The user opens settings and another chat while the reply is still streaming.
        await updateStateAtomically(state => { state.settings.activeView = 'settings'; state.settings.selectedChatId = 'tg-chat-1'; return state; });
      } });
    assert.ok(moved, 'the reply streamed, so the user had time to move');
    assert.equal(selectedAtStart.activeView, 'chat', 'sending selected its chat when it started');
    assert.equal(selectedAtStart.selectedChatId, 'desk-chat-1');
    assert.ok(result.assistantMessage?.content, 'the reply was saved');
    const { settings } = await loadState();
    assert.equal(settings.activeView, 'settings', 'finishing kept the view the user opened');
    assert.equal(settings.selectedChatId, 'tg-chat-1', 'and the chat the user switched to');
  } finally {
    if (previous === undefined) delete process.env.MELO_MOCK_RESPONSE; else process.env.MELO_MOCK_RESPONSE = previous;
  }
});

// Same rule on the failure branch: the failure reply is saved, and the view,
// chat and mode the user picked while the reply was streaming all stay.
test('a reply that fails after the user moved on saves the failure and keeps their navigation', async () => {
  const { updateStateAtomically, loadState } = await import('../../state/stateStore.js');
  await updateStateAtomically(state => {
    if (!state.chats.some(chat => chat.id === 'desk-chat-2')) state.chats.push({ id: 'desk-chat-2', title: 'desk failure', mode: 'chat', projectId: null, agentId: 'main', source: 'desktop', messages: [], sessionMemory: [] });
    return state;
  });
  const previous = process.env.MELO_MOCK_RESPONSE;
  process.env.MELO_MOCK_RESPONSE = 'a partial answer that the provider drops halfway';
  let moved = false;
  try {
    const outcome = await sendChatMessage({ chatId: 'desk-chat-2', content: 'please answer', mode: 'chat', skipBootstrap: true,
      onDelta: async () => {
        if (moved) return;
        moved = true;
        await updateStateAtomically(state => { state.settings.activeView = 'settings'; state.settings.selectedChatId = 'tg-chat-1'; state.settings.activeMode = 'code'; return state; });
        throw Object.assign(new Error('provider dropped the stream'), { code: 'PROVIDER_ERROR' });
      } }).catch(error => ({ error }));
    assert.ok(moved, 'the reply started streaming before it failed');
    const state = await loadState();
    const failure = state.chats.find(chat => chat.id === 'desk-chat-2').messages.at(-1);
    assert.equal(failure.role, 'assistant', `the failure reply was saved (${outcome.error?.message || 'resolved'})`);
    assert.ok(failure.metadata?.executionError, 'it is marked as a failed execution');
    assert.deepEqual([state.settings.activeView, state.settings.selectedChatId, state.settings.activeMode], ['settings', 'tg-chat-1', 'code'], 'view, chat and mode stay where the user put them');
  } finally {
    if (previous === undefined) delete process.env.MELO_MOCK_RESPONSE; else process.env.MELO_MOCK_RESPONSE = previous;
  }
});
