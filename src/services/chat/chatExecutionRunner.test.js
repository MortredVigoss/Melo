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
// CRITICAL — MELO_HOME isolation:
// The approval early-exit triggers `saveState(state)` which writes
// `state.json` + `threads/*.json` and indexes into `store.sqlite` under
// `getMeloHome()`. Without isolation those writes go to the developer's
// real `~/.melo/desktop/` and clobber it. The first version of this
// test (gate-D, before fix) actually wiped the developer's state.json.
// Setup below points MELO_HOME at a fresh tmpdir BEFORE the runner
// module is imported (dynamic `await import` so static imports in the
// runner module observe the env), and tears it down on test exit.
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

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// ─── MELO_HOME isolation ────────────────────────────────────────────────────
//
// Capture the real `~/.melo/desktop/state.json` mtime so we can fail
// loudly at the end of the suite if the test somehow still wrote into
// the developer's real home. This is belt-and-suspenders on top of the
// MELO_HOME override below.
const REAL_HOME_STATE_PATH = join(homedir(), '.melo', 'desktop', 'state.json');
const REAL_STATE_MTIME_BEFORE =
  existsSync(REAL_HOME_STATE_PATH) ? statSync(REAL_HOME_STATE_PATH).mtimeMs : null;

const ORIGINAL_MELO_HOME = process.env.MELO_HOME;
const TEST_HOME = mkdtempSync(join(tmpdir(), 'melo-chat-runner-test-'));
process.env.MELO_HOME = TEST_HOME;

// Dynamic import: ensures the runner module's static imports
// (state/stateStore.js → getMeloHome() at saveState time) observe the
// `MELO_HOME` we just set above. A top-level `import { ... } from
// './chatExecutionRunner.js'` is hoisted and would not.
const { runChatAgentExecutionGraph } = await import('./chatExecutionRunner.js');

after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  if (ORIGINAL_MELO_HOME === undefined) {
    delete process.env.MELO_HOME;
  } else {
    process.env.MELO_HOME = ORIGINAL_MELO_HOME;
  }
  // Hard guard: a regression in the isolation setup would silently
  // touch the real home; assert here so the suite turns red.
  if (REAL_STATE_MTIME_BEFORE !== null && existsSync(REAL_HOME_STATE_PATH)) {
    const after = statSync(REAL_HOME_STATE_PATH).mtimeMs;
    if (after > REAL_STATE_MTIME_BEFORE) {
      throw new Error(
        `MELO_HOME isolation regressed — ${REAL_HOME_STATE_PATH} was modified during this test suite (mtime ${REAL_STATE_MTIME_BEFORE} → ${after}). Tests must not write outside ${TEST_HOME}.`,
      );
    }
  }
});

// ─── Minimal fixtures ───────────────────────────────────────────────────────
//
// Shape-compatible with the real types but kept as small as possible so
// recall paths return early without DB I/O work.

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

  // Belt-and-suspenders: verify saveState wrote into the isolated TEST_HOME
  // and not into the developer's real `~/.melo`.
  assert.ok(
    existsSync(join(TEST_HOME, 'desktop', 'state.json')),
    `expected state.json to land in TEST_HOME (${TEST_HOME})`,
  );
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
