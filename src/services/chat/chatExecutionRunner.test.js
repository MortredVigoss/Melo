// Smoke tests for chatExecutionRunner — sub-phase 7d-5δ commit 7c.
//
// Why this file exists: gate's D-grade on the elephant extraction
// (commit 7b, 9c76db9) caught a real ReferenceError — `getAllTools()`
// was called from the runner but the import block left the symbol
// undeclared. The 719 unit tests went green because none of them
// exercise the runner's prepare phase end-to-end. This file fills the
// minimum viable gap so future import-block regressions get caught
// before push.
//
// Coverage:
//   • Test 1 (planCommandAction approval-exit) — exercises prepare phase
//     in full, including the tools-prompt assembly that previously
//     hid the bug. Triggers the approval early-exit so the runner
//     never has to call an actual model.
//   • Test 2 (planExternalConnectorAction approval-exit) — different
//     planner branch so the connector-tool path is also import-checked.
//
// Documented gap (follow-up): the `finalize` empty-reply fallback
// branch requires intercepting the model HTTP call. Both options
// (refactoring the runner to accept a `deps` object, or spinning up an
// in-test HTTP server) are bigger than this fix. Recorded in PROGRESS
// for a later cleanup commit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runChatAgentExecutionGraph } from './chatExecutionRunner.js';

// ─── Minimal fixtures ───────────────────────────────────────────────────────
//
// The runner pulls deeply into memory store / sqlite paths during prepare.
// These fixtures stay shape-compatible with the real types but deliberately
// keep arrays empty so the recall paths return early without DB I/O.

function fixtureState() {
  return {
    projects: [],
    chats: [],
    tasks: [],
    approvals: [],
    artifacts: [],
    commandRuns: [],
    externalConnectors: [],
    agentProfiles: {
      // Minimal profile that grants both local-command and external-connector
      // tools so each test can pick the planner branch it needs.
      main: {
        id: 'main',
        name: 'main',
        model: 'gpt-4',
        identity: '',
        soulMd: '',
        tools: ['local-command', 'external-connectors'],
        skills: [],
        channels: {},
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
    },
  };
}

function fixtureChat({ mode = 'chat', messages = [] } = {}) {
  return {
    id: 'chat-1',
    title: 'test',
    mode,
    projectId: null,
    agentId: 'main',
    messages,
    sessionMemory: [],
  };
}

function fixtureWorkspace() {
  return {
    rootPath: '/tmp/test',
    exists: false,
    entries: [],
    filePaths: [],
    fileCount: 0,
    selectedFilePath: null,
    selectedFile: null,
    commandTemplates: [],
    commandRuns: [],
  };
}

// classifyIntent returns 'factual' early when no apiKey/authMode is set, so
// no network call fires. getEmbedding is wrapped in `.catch(() => null)` by
// the runner. The compact path is gated on hasModelConfig=false, so it skips.
const fixtureConfig = {
  authMode: 'unset',
  apiKey: '',
  baseUrl: '',
  model: 'gpt-4',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

test('runChatAgentExecutionGraph imports + prepare phase resolve cleanly (planCommandAction approval-exit)', async () => {
  const state = fixtureState();
  const chat = fixtureChat({ mode: 'chat' });
  state.chats = [chat];

  // "git status" matches a curated planCommandAction pattern AND the agent
  // has local-command enabled — runner takes the approval early-exit and
  // never touches the model. This exercises:
  //   • the entire import block (would catch a missing export like
  //     getAllTools, the bug Codex flagged)
  //   • tools-prompt assembly path (shouldInjectToolsPrompt true when any
  //     tools are registered, which they are at module load)
  //   • planCommandAction → approval early-exit return shape
  const result = await runChatAgentExecutionGraph({
    config: fixtureConfig,
    state,
    chat,
    workspace: fixtureWorkspace(),
    connectors: [],
    skills: [],
    latestUserMessage: 'git status',
    agentId: 'main',
  });

  assert.ok(result, 'graph result must be defined');
  assert.ok(result.normalizedReply, 'approval-exit returns a normalizedReply');
  assert.ok(
    /approval/i.test(result.normalizedReply.content || ''),
    `approval response should mention approval (got: ${JSON.stringify(result.normalizedReply.content)})`,
  );
  // The approval was queued onto state.approvals.
  assert.ok(Array.isArray(state.approvals));
  assert.equal(state.approvals.length, 1);
  assert.equal(state.approvals[0].kind, 'command');
});

test('runChatAgentExecutionGraph approval-exit via planExternalConnectorAction', async () => {
  const state = fixtureState();
  const chat = fixtureChat({ mode: 'chat' });
  state.chats = [chat];

  // Build a synthetic external-MCP connector whose manifest tool name will
  // match the user message via planExternalConnectorAction. This exercises
  // a different planning branch from test 1.
  const connectors = [
    {
      id: 'mcp-fake',
      type: 'external-mcp',
      enabled: true,
      name: 'fakeconnector',
      manifest: {
        tools: [{ name: 'lookup' }],
      },
    },
  ];

  const result = await runChatAgentExecutionGraph({
    config: fixtureConfig,
    state,
    chat,
    workspace: fixtureWorkspace(),
    connectors,
    skills: [],
    latestUserMessage: 'please run fakeconnector lookup something',
    agentId: 'main',
  });

  assert.ok(result.normalizedReply, 'approval-exit returns a normalizedReply');
  assert.equal(state.approvals.length, 1);
  assert.equal(state.approvals[0].kind, 'external-tool');
});
