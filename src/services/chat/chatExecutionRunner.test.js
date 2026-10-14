import { saveState, loadState } from '../../state/stateStore.js';
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
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname_test = dirname(fileURLToPath(import.meta.url));
const RUNNER_SOURCE = readFileSync(join(__dirname_test, 'chatExecutionRunner.js'), 'utf8');

// ─── Phase 6 follow-up (2026-05-05) — scope contract for activeAgentProfile ─
//
// Production bug: `'invoke-model'` graph node referenced bare
// `activeAgentProfile` at the MCP-tool filter line, but that variable
// is only declared inside the `'prepare'` node — a sibling async
// method with its own scope. Bare reference threw
// "ReferenceError: activeAgentProfile is not defined" the moment the
// model emitted any tool call. Text-only replies dodged the branch and
// stayed silent, so the bug shipped on 2026-04-29 and only surfaced via
// the providerErrors fallback "Melo could not complete the model
// request right now. Details: …".
//
// Fix: route through `graphState.activeAgentProfile` (the same fact
// already used at the model-invoke + verifier-model lines).
//
// This test pins the scope contract: outside the prepare node, every
// reference must use `graphState.activeAgentProfile` — a bare
// reference is a regression. Cheap source-level scan.

test('activeAgentProfile references obey scope contract: bare inside prepare, graphState. outside (Phase 6)', () => {
  // Bidirectional contract:
  //   • Inside `prepare` — references are LOCAL (declared at line 150).
  //     They must be the bare form. A `graphState.activeAgentProfile`
  //     here would throw at runtime because prepare's signature has no
  //     graphState parameter — that was the regression Codex caught
  //     when this test only scanned the outside half.
  //   • Outside prepare (`invoke-model`, `finalize`) — references must
  //     route through `graphState.activeAgentProfile`. A bare reference
  //     is the original 2026-04-29 bug ("activeAgentProfile is not
  //     defined" → providerErrors fallback message).
  //
  // Skip in both halves: comments, declaration forms, object-literal
  // key form `activeAgentProfile:`.
  const lines = RUNNER_SOURCE.split('\n');
  const prepareStart = lines.findIndex(l => /async\s+'prepare'\s*\(/.test(l));
  let prepareEnd = -1;
  for (let i = prepareStart + 1; i < lines.length; i++) {
    if (/^      \},\s*$/.test(lines[i])) { prepareEnd = i; break; }
  }
  assert.ok(prepareStart > 0 && prepareEnd > prepareStart, 'prepare node boundaries must be locatable');

  const outsideOffences = []; // bare references outside prepare
  const insideOffences = [];  // graphState. references inside prepare

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    const inPrepare = i >= prepareStart && i <= prepareEnd;

    const matches = line.matchAll(/\bactiveAgentProfile\b/g);
    for (const m of matches) {
      const idx = m.index;
      const before = line.slice(0, idx);
      const after = line.slice(idx + 'activeAgentProfile'.length);
      const usesGraphStatePrefix = /graphState\.\s*$/.test(before);
      // skip declarations & object-literal-key forms (both halves)
      if (/^:/.test(after)) continue;
      if (/\b(const|let|var|function)\s+$/.test(before)) continue;

      if (inPrepare && usesGraphStatePrefix) {
        // prepare has NO graphState param — would throw at runtime.
        insideOffences.push(`L${i + 1}: ${line.trim()}`);
      } else if (!inPrepare && !usesGraphStatePrefix) {
        outsideOffences.push(`L${i + 1}: ${line.trim()}`);
      }
    }
  }

  assert.deepEqual(
    outsideOffences, [],
    `Outside prepare, every reference must use graphState.activeAgentProfile:\n${outsideOffences.join('\n')}`,
  );
  assert.deepEqual(
    insideOffences, [],
    `Inside prepare, references must use the LOCAL bare form (no graphState.) — prepare has no graphState param:\n${insideOffences.join('\n')}`,
  );
});

// ─── MELO_HOME isolation ────────────────────────────────────────────────────
//
// The primary safety net is the MELO_HOME override below — every state
// write from the runner lands in TEST_HOME. The real `~/.melo` mtime
// belt-and-suspenders is opt-in via env var: `MELO_TEST_GUARD_REAL_HOME=1`
// flips it on. By default the guard is off so the suite cannot
// false-positive when the developer happens to be running real Melo
// (or another concurrent test) in the same machine session.
const REAL_HOME_STATE_PATH = join(homedir(), '.melo', 'desktop', 'state.json');
const REAL_HOME_GUARD_ENABLED = process.env.MELO_TEST_GUARD_REAL_HOME === '1';
const REAL_STATE_MTIME_BEFORE =
  REAL_HOME_GUARD_ENABLED && existsSync(REAL_HOME_STATE_PATH)
    ? statSync(REAL_HOME_STATE_PATH).mtimeMs
    : null;

const ORIGINAL_MELO_HOME = process.env.MELO_HOME;
const TEST_HOME = mkdtempSync(join(tmpdir(), 'melo-chat-runner-test-'));
process.env.MELO_HOME = TEST_HOME;

// Dynamic import: ensures the runner module's static imports
// (state/stateStore.js → getMeloHome() at saveState time) observe the
// `MELO_HOME` we just set above. A top-level `import { ... } from
// './chatExecutionRunner.js'` is hoisted and would not.
const { runChatAgentExecutionGraph } = await import('./chatExecutionRunner.js');

// Search-routing integration tests below need built-in tools (web_search,
// fetch_url) actually present in the registry — `shouldInjectToolsPrompt`
// is gated on `getAllTools().length > 0`, and only `desktopStore.js` calls
// `bootstrapBuiltinTools()` in production. The earlier approval-exit tests
// don't reach the tools-prompt branch, so they were unaffected; once we
// bootstrap they still pass (early-exit happens before the branch).
const { bootstrapBuiltinTools } = await import('../../tools/registry.js');
bootstrapBuiltinTools();

after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  if (ORIGINAL_MELO_HOME === undefined) {
    delete process.env.MELO_HOME;
  } else {
    process.env.MELO_HOME = ORIGINAL_MELO_HOME;
  }
  // Hard guard (opt-in via MELO_TEST_GUARD_REAL_HOME=1): a regression
  // in the isolation setup would silently touch the real home; assert
  // here so the suite turns red. Off by default — concurrent Melo runs
  // or other tests editing real state during this suite would otherwise
  // produce a false red.
  if (REAL_HOME_GUARD_ENABLED && REAL_STATE_MTIME_BEFORE !== null && existsSync(REAL_HOME_STATE_PATH)) {
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
  await saveState(state);

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
  const persisted = await loadState();
  assert.equal(persisted.approvals.length, 1);
  assert.equal(persisted.approvals[0].kind, 'command');

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
  await saveState(state);

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
  const persisted = await loadState();
  assert.equal(persisted.approvals.length, 1);
  assert.equal(persisted.approvals[0].kind, 'external-tool');
});

test('runChatAgentExecutionGraph: prepare phase smoke — non-approval message must not throw a scope error', async () => {
  // Codex follow-up (Phase 6 D 评级 2026-05-05): a non-approval message
  // bypasses the planCommandAction / planExternalConnectorAction
  // early-exit, so prepare runs through the agent-resolution +
  // channel-prompt + tool-routing + project-context assembly steps
  // BEFORE invoke-model is reached. This test catches any scope error
  // ("activeAgentProfile is not defined" / "Cannot read properties of
  // undefined (reading 'activeAgentProfile')") thrown anywhere in
  // prepare's first 295 lines.
  //
  // Coverage caveat (honest): prepare's tools-prompt branch at line
  // 300 is technically reached in production, but in this fixture
  // earlier prepare stages throw on the unset auth config before line
  // 300 runs. The static-source contract test above is the primary
  // defence for line 300+ — combining the two gives bidirectional
  // coverage (contract = static, this test = dynamic for early prepare).
  //
  // Anything model-call-related thrown from invoke-model is fine here
  // — the assertion is specifically about scope errors.
  const state = fixtureState();
  const chat = fixtureChat({ mode: 'chat' });
  state.chats = [chat];
  await saveState(state);

  let thrown = null;
  try {
    await runChatAgentExecutionGraph({
      config: fixtureConfig,
      state,
      chat,
      workspace: fixtureWorkspace(),
      connectors: [],
      skills: [],
      latestUserMessage: 'just thinking out loud about today',
      agentId: 'main',
    });
  } catch (err) {
    thrown = err;
  }

  if (thrown) {
    assert.doesNotMatch(
      String(thrown.message || ''),
      /activeAgentProfile is not defined|Cannot read properties of undefined \(reading ['"]activeAgentProfile['"]\)/,
      `prepare must not blow up with a scope error on activeAgentProfile (got: ${thrown.message})`,
    );
  }
});

// ─── Search routing → tool dispatch (Codex B-grade follow-up to f04248e) ────
//
// The searchRouter (src/retrieval/searchRouter.js) classifies each turn into
// one of {codex-native, melo-web, fetch-url, social-link, none} and the
// runner translates that route into BOTH (a) the prompt content
// (`buildSearchRoutingPrompt`) and (b) the dispatchable tool whitelist
// (`filterToolsForSearchPlan` → `visibleToolIds`). searchRouter.test.js
// already covers (a) via buildSearchPlan unit assertions; this block fills
// the runner-level gap for (b) flagged by Codex pre-push review.
//
// Strategy:
//   1. MELO_MOCK_RESPONSE shorts the model call so the graph reaches END
//      without leaving the process (createOpenAICompatibleReply line 1929
//      bypasses every provider branch when the env var is set).
//   2. After the graph completes, runStateGraph returns the merged final
//      state — which includes the `searchPlan` and `visibleToolIds`
//      written by the prepare node. We assert directly on those.
//
// What each test pins:
//   • searchPlan.route                 → which branch of buildSearchPlan fired
//   • searchPlan.nativeWebSearchEnabled → flag the runner forwards to
//                                         createCodexResponsesReply at line 450
//   • searchPlan.exposedNetworkTools   → output of buildSearchPlan
//   • visibleToolIds                   → what filterToolsForSearchPlan + the
//                                         tools-prompt branch ACTUALLY kept
//
// Regression coverage: a future change to DEEP_RESEARCH_PATTERN /
// EXPLICIT_LOCAL_SEARCH_PATTERN / LINK_READ_PATTERN, the trigger weights,
// the SEARCH_NETWORK_TOOL_IDS set, or the wire-up at lines 199 / 312 /
// 376 / 450 of chatExecutionRunner.js will turn at least one of these
// red. The test messages match the canonical fixtures in
// searchRouter.test.js so a changed regex flips both files in lockstep.

const ORIGINAL_MOCK_RESPONSE = process.env.MELO_MOCK_RESPONSE;
// Plain text, no `<tool_call>` blocks, so parseModelResponse returns
// `{ thinking, toolCalls: [] }` and the invoke-model loop exits on the
// first iteration without touching the executor.
process.env.MELO_MOCK_RESPONSE = 'integration-mock-reply';

after(() => {
  if (ORIGINAL_MOCK_RESPONSE === undefined) {
    delete process.env.MELO_MOCK_RESPONSE;
  } else {
    process.env.MELO_MOCK_RESPONSE = ORIGINAL_MOCK_RESPONSE;
  }
});

function fixtureCodexConfig() {
  return { authMode: 'codex', apiKey: '', baseUrl: '', model: 'gpt-4' };
}

function fixtureNonCodexConfig() {
  return { authMode: 'api-key', apiKey: 'sk-stub', baseUrl: '', model: 'gpt-4' };
}

async function runForRouteFixture({ latestUserMessage, config }) {
  const state = fixtureState();
  const chat = fixtureChat({ mode: 'chat' });
  state.chats = [chat];
  await saveState(state);
  return runChatAgentExecutionGraph({
    config,
    state,
    chat,
    workspace: fixtureWorkspace(),
    connectors: [],
    skills: [],
    latestUserMessage,
    agentId: 'main',
  });
}

test('search routing — codex-native: native web_search enabled, fetch_url not dispatched', async () => {
  // Same canonical message as searchRouter.test.js:18 — score ≥ 3 from the
  // weather + "查一下" triggers, no URL, no DEEP_RESEARCH/EXPLICIT_LOCAL/
  // LINK_READ pattern hit, codex auth → codex-native branch.
  const result = await runForRouteFixture({
    latestUserMessage: '帮我查一下今天墨尔本天气',
    config: fixtureCodexConfig(),
  });

  assert.equal(result.searchPlan?.route, 'codex-native');
  assert.equal(result.searchPlan?.nativeWebSearchEnabled, true);
  assert.deepEqual(result.searchPlan?.exposedNetworkTools, []);
  // visibleToolIds is the FINAL whitelist consulted by invoke-model when
  // resolving tool calls (chatExecutionRunner.js:499). Codex Responses
  // owns web_search server-side on this route; pushing a local web_search
  // or fetch_url tool would cause the model to emit XML tool calls in
  // parallel with the native capability — exactly the regression Codex
  // review was guarding against.
  const visible = new Set(result.visibleToolIds || []);
  assert.equal(visible.has('web_search'), false, 'web_search must be hidden on codex-native route');
  assert.equal(visible.has('fetch_url'), false, 'fetch_url must be hidden on codex-native route');
});

test('search routing — melo-web: native web_search disabled, both tools dispatched', async () => {
  // Same canonical message as searchRouter.test.js:60 — DEEP_RESEARCH_PATTERN
  // hits ("深度" / "多来源"), so the route forces local Melo web_search even
  // under codex auth.
  const result = await runForRouteFixture({
    latestUserMessage: '帮我做一个多来源深度调研，比较这几个产品',
    config: fixtureCodexConfig(),
  });

  assert.equal(result.searchPlan?.route, 'melo-web');
  assert.equal(result.searchPlan?.nativeWebSearchEnabled, false);
  assert.deepEqual(
    [...(result.searchPlan?.exposedNetworkTools || [])].sort(),
    ['fetch_url', 'web_search'],
  );
  const visible = new Set(result.visibleToolIds || []);
  assert.equal(visible.has('web_search'), true, 'web_search must be dispatched on melo-web route');
  assert.equal(visible.has('fetch_url'), true, 'fetch_url must be dispatched on melo-web route');
});

test('search routing — fetch-url: LINK_READ_PATTERN routes to fetch_url, web_search hidden', async () => {
  // No URL in the text, but LINK_READ_PATTERN matches "打开链接" — buildSearchPlan
  // takes the link-read-intent branch (route='fetch-url', reason='link-read-intent').
  // Pinning this here matters because LINK_READ_PATTERN was added in f04248e
  // specifically to catch user requests like "open this link / 打开链接 …" that
  // arrive without a pasted URL (e.g. when the user is referring to a link
  // already discussed earlier in the chat).
  const result = await runForRouteFixture({
    latestUserMessage: '帮我打开链接读一下里面写了啥',
    config: fixtureCodexConfig(),
  });

  assert.equal(result.searchPlan?.route, 'fetch-url');
  assert.equal(result.searchPlan?.reason, 'link-read-intent');
  assert.equal(result.searchPlan?.nativeWebSearchEnabled, false);
  assert.deepEqual(result.searchPlan?.exposedNetworkTools, ['fetch_url']);
  const visible = new Set(result.visibleToolIds || []);
  assert.equal(visible.has('fetch_url'), true, 'fetch_url must be dispatched on fetch-url route');
  assert.equal(visible.has('web_search'), false, 'web_search must be hidden on fetch-url route');
});

test('search routing — social-link: 抖音 / xiaohongshu URL routes to fetch_url with web_search hidden (Codex 83cf5d4 B 建议闭环)', async () => {
  // searchRouter.js:148 isSocialLinkUrl checks SOCIAL_HOST_PATTERN matching
  // (xiaohongshu|xhslink|douyin|iesdouyin|tiktok)\.com — these have a
  // dedicated social-preview reader path inside fetch_url, so the runner
  // must hide web_search to keep the model from issuing a parallel
  // generic search query that bypasses the social-link extractor.
  //
  // Codex pre-pp on 83cf5d4 flagged that the runner-level routing tests
  // covered codex-native / melo-web / fetch-url / none / non-codex but
  // NOT social-link — a regex regression on SOCIAL_HOST_PATTERN, the
  // hasSocialUrl gate, or the SEARCH_NETWORK_TOOL_IDS filter would let
  // web_search leak back into visibleToolIds for social URLs and the
  // unit-level searchRouter.test.js wouldn't catch it.
  //
  // Same canonical fixture as searchRouter.test.js:50 so a regex change
  // flips both files in lockstep.
  const result = await runForRouteFixture({
    latestUserMessage: '看看这个抖音 https://v.douyin.com/abc123/',
    config: fixtureCodexConfig(),
  });

  assert.equal(result.searchPlan?.route, 'social-link');
  assert.equal(result.searchPlan?.reason, 'social-url');
  assert.equal(result.searchPlan?.nativeWebSearchEnabled, false);
  assert.deepEqual(result.searchPlan?.exposedNetworkTools, ['fetch_url']);
  const visible = new Set(result.visibleToolIds || []);
  assert.equal(visible.has('fetch_url'), true, 'fetch_url must be dispatched on social-link route');
  assert.equal(visible.has('web_search'), false, 'web_search must be hidden so social-link reader is not bypassed');
});

test('search routing — social-link: xiaohongshu URL also routes to fetch_url (different host in SOCIAL_HOST_PATTERN)', async () => {
  // Cross-check the second canonical social host besides douyin — if
  // someone narrows SOCIAL_HOST_PATTERN to just douyin, this red-flags
  // the regression at the runner layer.
  const result = await runForRouteFixture({
    latestUserMessage: '帮我看下这条小红书 http://xhslink.com/a/foo123',
    config: fixtureCodexConfig(),
  });

  assert.equal(result.searchPlan?.route, 'social-link');
  assert.equal(result.searchPlan?.reason, 'social-url');
  assert.deepEqual(result.searchPlan?.exposedNetworkTools, ['fetch_url']);
  const visible = new Set(result.visibleToolIds || []);
  assert.equal(visible.has('fetch_url'), true);
  assert.equal(visible.has('web_search'), false);
});

test('search routing — none: no web intent, neither web_search nor fetch_url offered', async () => {
  // Same canonical message as searchRouter.test.js:82 — score is 0 and no
  // pattern hits, so the runner must offer neither network tool. This is
  // the "ordinary chat" baseline; if a future trigger weight bump makes
  // this message accidentally crosss the score≥3 threshold, the runner
  // would silently start exposing network tools to plain conversations.
  const result = await runForRouteFixture({
    latestUserMessage: '帮我写一段温柔一点的回复',
    config: fixtureCodexConfig(),
  });

  assert.equal(result.searchPlan?.route, 'none');
  assert.equal(result.searchPlan?.nativeWebSearchEnabled, false);
  assert.deepEqual(result.searchPlan?.exposedNetworkTools, []);
  const visible = new Set(result.visibleToolIds || []);
  assert.equal(visible.has('web_search'), false, 'web_search must be hidden when no web intent');
  assert.equal(visible.has('fetch_url'), false, 'fetch_url must be hidden when no web intent');
});

test('search routing — non-codex auth + web intent falls back to melo-web (not codex-native)', async () => {
  // Cross-check that `authMode !== 'codex'` correctly disables native search
  // even when scoreWebSearchIntent ≥ 3. Mirrors searchRouter.test.js:70 but
  // pinned at the runner level so a future provider-profile refactor that
  // forgets to pass authMode through to buildSearchPlan trips here.
  const result = await runForRouteFixture({
    latestUserMessage: '帮我查一下今天新加坡天气',
    config: fixtureNonCodexConfig(),
  });

  assert.equal(result.searchPlan?.route, 'melo-web');
  assert.equal(result.searchPlan?.nativeWebSearchEnabled, false);
  assert.deepEqual(
    [...(result.searchPlan?.exposedNetworkTools || [])].sort(),
    ['fetch_url', 'web_search'],
  );
  const visible = new Set(result.visibleToolIds || []);
  assert.equal(visible.has('web_search'), true);
  assert.equal(visible.has('fetch_url'), true);
});

test('main tool dispatch carries its MCP whitelist and resolved role model into a nested skill', async () => {
  const {registerTool,unregisterTool}=await import('../../tools/registry.js');
  const {runSkill}=await import('../../agents/skillExecutor.js');
  const state=fixtureState(),chat=fixtureChat({messages:[{id:'probe-user',role:'user',content:'Read the local file for this task'}]});
  state.chats=[chat];state.agentProfiles.main.model='role-selected-model';state.agentProfiles.main.enabledMcpServerIds=[];
  await saveState(state);
  let effects=0,dispatched,skillReplies=0;
  const forbidden={id:'mcp:blocked:probe',name:'probe',description:'must be blocked',parametersSchema:{type:'object',properties:{}},requiresPermission:false,run:async()=>{effects++;return {ok:true,output:'ran'};}};
  const probe={...forbidden,id:'scope_probe',run:async(_,context)=>{
    dispatched=context;
    return runSkill({skill:{id:'audit',type:'executable',name:'audit'},task:'probe',config:context.config,allowedToolIds:context.allowedToolIds,
      replyFn:async()=>skillReplies++===0?'<tool_call>{"id":"child","name":"mcp:blocked:probe","arguments":{}}</tool_call>':'done'});
  }};
  registerTool(forbidden);registerTool(probe);
  try {
    let replies=0;
    await runChatAgentExecutionGraph({config:fixtureConfig,state,chat,workspace:fixtureWorkspace(),connectors:[],skills:[],latestUserMessage:'Read the local file for this task',agentId:'main',
      _dependencies:{getEmbedding:async()=>null,createReply:async()=>replies++===0?'<tool_call>{"id":"parent","name":"scope_probe","arguments":{}}</tool_call>':'finished'}});
    assert.ok(dispatched,'probe must actually execute');assert.ok(Array.isArray(dispatched.allowedToolIds));assert.ok(!dispatched.allowedToolIds.includes(forbidden.id));
    assert.equal(dispatched.config.model,'role-selected-model');assert.equal(skillReplies,2);assert.equal(effects,0);
  } finally {unregisterTool(forbidden.id);unregisterTool(probe.id);}
});


test('optional fast judge retains the answer model and contributes its real usage receipt', async () => {
  const state = fixtureState(), chat = fixtureChat(); state.chats = [chat];
  const events = []; let judgments = 0, answers = 0;
  const config = { ...fixtureConfig, extraFast: { enabled: true } };
  await saveState(state);
  const result = await runChatAgentExecutionGraph({ config, state, chat, workspace: fixtureWorkspace(), connectors: [], skills: [],
    latestUserMessage: '今天的心情还算不错呢', agentId: 'main', sseEmitter: (type, value) => events.push({ type, value }),
    _dependencies: { getEmbedding: async () => null,
      judgeFast: async options => {
        judgments++; options.onDecision({ source: 'model', model: 'judge-mini', reportedModel: 'judge-mini',
          latencyMs: 10, usage: { input: 8, output: 1, cached: 0, cacheWrite: 0 } }); return 'casual';
      },
      createReply: async options => {
        answers++; assert.equal(options.model, 'gpt-4');
        options.onProviderResponse?.({ requestedModel: options.model, reportedModel: options.model, usage: { input: 20, output: 10, cached: 0, cacheWrite: 0 } });
        return '今天还不错。';
      },
    } });
  assert.equal(judgments, 1); assert.equal(answers, 1);
  assert.equal(result.normalizedReply.modelResponses[0].purpose, 'intent-judge');
  assert.equal(result.normalizedReply.usage.input, 28); assert.equal(result.normalizedReply.usage.output, 11);
  assert.equal(result.normalizedReply.usage.requests, 2);
  assert.ok(events.some(event => event.type === 'execution_event' && event.value.id === 'judge:intent'));
});
