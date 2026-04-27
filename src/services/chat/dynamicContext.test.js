// Regression tests for the dynamic-context block — specifically that
// soft-deleted artifacts never reach the prompt.  Codex 2026-04-27 🟠
// audit: a tombstoned artifact still flowed through `connectors.some
// (artifacts && enabled)` into the next turn's prompt; that's a
// privacy + correctness regression because the user already "deleted"
// the row in the UI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDynamicContext } from './dynamicContext.js';

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
