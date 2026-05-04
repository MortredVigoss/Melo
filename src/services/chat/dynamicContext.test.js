// Regression tests for the dynamic-context block — specifically that
// soft-deleted artifacts never reach the prompt.  Codex 2026-04-27 🟠
// audit: a tombstoned artifact still flowed through `connectors.some
// (artifacts && enabled)` into the next turn's prompt; that's a
// privacy + correctness regression because the user already "deleted"
// the row in the UI.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDynamicContext,
  buildSelectedFileContextBlock,
} from './dynamicContext.js';

function chatFixture({ id = 'chat-1', projectId = 'proj-1', messages = [] } = {}) {
  return { id, projectId, messages };
}

const EMPTY_WORKSPACE = {
  selectedFile: null,
  entries: [],
  rootPath: '/tmp/x',
  exists: false,
  fileCount: 0,
  selectedFilePath: null,
  commandRuns: [],
};

const ARTIFACT_CONNECTOR_ENABLED = [{ id: 'artifacts', enabled: true }];
const LOCAL_FILES_CONNECTOR_ENABLED = [{ id: 'local-files', enabled: true }];

test('buildDynamicContext: live artifacts surface in the "Recent artifacts" block', async () => {
  const state = {
    artifacts: [
      { id: 'a-live', chatId: 'chat-1', projectId: 'proj-1', title: 'Live Note', content: 'visible body' },
    ],
    commandRuns: [],
  };
  const out = await buildDynamicContext(
    state,
    chatFixture(),
    EMPTY_WORKSPACE,
    ARTIFACT_CONNECTOR_ENABLED,
  );
  assert.match(out, /Recent artifacts/);
  assert.match(out, /Live Note/);
  assert.match(out, /visible body/);
});

test('buildDynamicContext: soft-deleted artifacts are filtered out', async () => {
  const state = {
    artifacts: [
      { id: 'a-tomb', chatId: 'chat-1', projectId: 'proj-1', title: 'Tombstone Note',
        content: 'should never reach prompt', deletedAt: '2026-04-27T00:00:00.000Z' },
    ],
    commandRuns: [],
  };
  const out = await buildDynamicContext(
    state,
    chatFixture(),
    EMPTY_WORKSPACE,
    ARTIFACT_CONNECTOR_ENABLED,
  );
  // No live artifacts at all → no "Recent artifacts" block at all.
  assert.doesNotMatch(out, /Recent artifacts/);
  assert.doesNotMatch(out, /Tombstone Note/);
  assert.doesNotMatch(out, /should never reach prompt/);
});

test('buildDynamicContext: live artifacts pass through, tombstones drop', async () => {
  const state = {
    artifacts: [
      { id: 'a-tomb', chatId: 'chat-1', projectId: 'proj-1', title: 'Tomb', content: 'tomb body', deletedAt: '2026-04-27T00:00:00.000Z' },
      { id: 'a-live', chatId: 'chat-1', projectId: 'proj-1', title: 'Live',  content: 'live body' },
    ],
    commandRuns: [],
  };
  const out = await buildDynamicContext(
    state,
    chatFixture(),
    EMPTY_WORKSPACE,
    ARTIFACT_CONNECTOR_ENABLED,
  );
  assert.match(out, /Recent artifacts/);
  assert.match(out, /Live/);
  assert.match(out, /live body/);
  assert.doesNotMatch(out, /Tomb body/);
  // The literal "Tomb" title must not appear either.  Use a tighter
  // pattern so a substring of "Live"/"livestone" wouldn't match.
  assert.doesNotMatch(out, /- Tomb:/);
});

test('buildDynamicContext: artifacts connector disabled → no artifact block, even with live rows', async () => {
  const state = {
    artifacts: [{ id: 'a', chatId: 'chat-1', projectId: 'proj-1', title: 'Live', content: 'body' }],
    commandRuns: [],
  };
  const out = await buildDynamicContext(
    state,
    chatFixture(),
    EMPTY_WORKSPACE,
    [{ id: 'artifacts', enabled: false }],
  );
  assert.doesNotMatch(out, /Recent artifacts/);
  assert.doesNotMatch(out, /Live/);
});

test('buildSelectedFileContextBlock: small files keep full content for compatibility', () => {
  const out = buildSelectedFileContextBlock({
    path: 'src/small.js',
    language: 'javascript',
    content: 'export const answer = 42;\nconsole.log(answer);\n',
  }, 'review this file');

  assert.match(out, /Selected workspace file: src\/small\.js/);
  assert.match(out, /export const answer = 42/);
  assert.match(out, /console\.log\(answer\)/);
  assert.doesNotMatch(out, /optimized for token budget/);
});

test('buildSelectedFileContextBlock: large files include query-relevant excerpts instead of full content', () => {
  const lines = Array.from({ length: 260 }, (_, index) => `const filler${index + 1} = ${index + 1};`);
  lines[180] = 'export function suspiciousTokenRegressionGuard() { return "needle"; }';
  lines[250] = 'const distantTailThatShouldNotBeIncluded = true;';

  const out = buildSelectedFileContextBlock({
    path: 'src/large.js',
    language: 'javascript',
    content: lines.join('\n'),
  }, 'review suspiciousTokenRegressionGuard');

  assert.match(out, /optimized for token budget/);
  assert.match(out, /181\texport function suspiciousTokenRegressionGuard/);
  assert.doesNotMatch(out, /distantTailThatShouldNotBeIncluded/);
});

test('buildDynamicContext: local file context uses optimized excerpts for large selected files', async () => {
  const lines = Array.from({ length: 240 }, (_, index) => `line ${index + 1}: filler`);
  lines[119] = 'line 120: targetReviewNeedle lives here';

  const out = await buildDynamicContext(
    { artifacts: [], commandRuns: [] },
    chatFixture(),
    {
      ...EMPTY_WORKSPACE,
      selectedFile: {
        path: 'src/review-target.js',
        language: 'javascript',
        content: lines.join('\n'),
      },
      entries: [{ type: 'file', path: 'src/review-target.js' }],
    },
    LOCAL_FILES_CONNECTOR_ENABLED,
    'please review targetReviewNeedle',
  );

  assert.match(out, /Selected workspace file: src\/review-target\.js/);
  assert.match(out, /120\tline 120: targetReviewNeedle lives here/);
  assert.match(out, /Workspace snapshot/);
  assert.doesNotMatch(out, /240\tline 240: filler/);
});

test('buildSelectedFileContextBlock: truncated UI preview surfaces a header note', () => {
  // The selectedFile shape carries a `truncated` flag when the IDE
  // already capped the preview before the prompt was assembled.
  // The block must surface that to the model so it doesn't assume
  // the visible text is the entire file.
  const out = buildSelectedFileContextBlock({
    path: 'src/big.js',
    language: 'javascript',
    content: 'export const x = 1;\n',
    truncated: true,
  }, 'review');
  assert.match(out, /UI preview was already truncated/);
});

test('buildSelectedFileContextBlock: empty / stop-word-only query falls back to file head', () => {
  // When tokenizeContextQuery returns no useful tokens (empty
  // message, or only stop words like "看看 一下 帮我"), no line
  // scores positive — the block must still render something. Falls
  // back to seed=[0] so the model gets the file head, which is
  // typically imports + opening declarations.
  // Fixture needs > SELECTED_FILE_FULL_CONTEXT_CHARS (3000) to
  // trigger the snippet path; pad each line to make the total large.
  const lines = Array.from(
    { length: 300 },
    (_, i) => `const veryLongIdentifier${i + 1} = "padding-padding-padding-${i + 1}";`,
  );
  const out = buildSelectedFileContextBlock({
    path: 'src/file.js',
    language: 'javascript',
    content: lines.join('\n'),
  }, '看看 一下 帮我');  // all stop words → 0 tokens
  assert.match(out, /optimized for token budget/);
  // Head excerpt: line 1 should be present, deep tail should not.
  assert.match(out, /1\tconst veryLongIdentifier1 =/);
  assert.doesNotMatch(out, /300\tconst veryLongIdentifier300/);
});
