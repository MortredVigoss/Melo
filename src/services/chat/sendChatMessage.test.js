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
