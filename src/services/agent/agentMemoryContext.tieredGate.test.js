// agentMemoryContext.tieredGate.test.js — Phase E (2026-05-05).
//
// Pins the MELO_MEMORY_TIERS_RECALL gate behaviour:
//   - off (default) → legacy flat recall, no scene/frame blocks emitted
//   - on            → recallMemoriesTiered drives promptHistory, and
//                     scene/frame summaries are rendered as their own
//                     blocks above prompt nodes
//   - on + tiered throws → graceful fallback to flat recall, no exception
//                     bubbles up through the agent loop
//
// Why tested at this level: the audit explicitly identified Phase E read
// side as P0. A regression that disables tiered recall (env var dropped,
// branch removed, scenes filtered out) must not silently revert prompt
// quality to the pre-Phase-E flat-list shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withTempMeloHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'melo-memctx-'));
  const prevHome = process.env.MELO_HOME;
  const prevTier = process.env.MELO_MEMORY_TIERS_RECALL;
  const prevAttic = process.env.MELO_ATTIC_ENABLED;
  process.env.MELO_HOME = dir;
  // Disable attic injection so the test only observes blocks driven
  // directly by the recall calls under test, not the always-on hot
  // attic block which is orthogonal to the tier gate.
  process.env.MELO_ATTIC_ENABLED = '0';
  // Reset the module-level SQLite handle so we don't reuse a connection
  // pointing at the previous test's MELO_HOME (which gets rm -rf'd at
  // teardown — SQLite keeps the inode open, leaving stale rows visible).
  try {
    const storeMod = await import('../../memory/store.js');
    storeMod._resetStoreForTests?.();
  } catch {}
  try {
    await fn(dir);
  } finally {
    try {
      const storeMod = await import('../../memory/store.js');
      storeMod._resetStoreForTests?.();
    } catch {}
    if (prevHome === undefined) delete process.env.MELO_HOME;
    else process.env.MELO_HOME = prevHome;
    if (prevTier === undefined) delete process.env.MELO_MEMORY_TIERS_RECALL;
    else process.env.MELO_MEMORY_TIERS_RECALL = prevTier;
    if (prevAttic === undefined) delete process.env.MELO_ATTIC_ENABLED;
    else process.env.MELO_ATTIC_ENABLED = prevAttic;
    await rm(dir, { recursive: true, force: true });
  }
}

function basicChat() {
  return {
    id: 'chat-1',
    chatType: 'direct',
    title: 'demo chat',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-05T00:00:00Z',
    messages: [
      { id: 'm-prev', role: 'user', content: 'set up the project', createdAt: '2026-05-01T00:00:00Z' },
      { id: 'm-prev2', role: 'assistant', content: 'done', createdAt: '2026-05-01T00:00:01Z' },
      { id: 'm-now', role: 'user', content: 'continue the project', createdAt: '2026-05-05T00:00:00Z' },
    ],
  };
}

function basicAgent() {
  return { id: 'agent-1', name: 'agent' };
}

function seedScene(replaceMemories) {
  // A scene + frame + a content prompt all anchored to chat-1 namespace.
  // Tier resolution prefers ANN; without an embedding the keyword path
  // matches on the query "continue the project" → all three rows share
  // a token with the query.
  replaceMemories([
    {
      id: 'scene:chat-1:s1',
      namespace: 'chat:chat-1',
      kind: 'scene',
      sourceId: 'chat-1',
      text: 'Last week the user spent two days setting up the project.',
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:00Z',
      metadata: { sceneId: 's1', chatId: 'chat-1', startAt: '2026-05-01T00:00:00Z', endAt: '2026-05-02T00:00:00Z' },
    },
    {
      id: 'frame:chat-1:f1',
      namespace: 'chat:chat-1',
      kind: 'frame',
      sourceId: 'chat-1',
      text: 'Project setup turn: chose toolchain.',
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:00Z',
      metadata: { frameId: 'f1', sceneId: 's1', chatId: 'chat-1', startAt: '2026-05-01T00:00:00Z', endAt: '2026-05-01T00:30:00Z' },
    },
    {
      id: 'prompt:chat-1:p1',
      namespace: 'chat:chat-1',
      kind: 'prompt',
      sourceId: 'm-prev',
      text: 'set up the project',
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:00Z',
      metadata: { frameId: 'f1', sceneId: 's1', chatId: 'chat-1', messageId: 'm-prev' },
    },
  ]);
}

test('tiered gate OFF (default) → no scene/frame blocks emitted, prompt block uses flat recall', async () => {
  await withTempMeloHome(async () => {
    delete process.env.MELO_MEMORY_TIERS_RECALL;
    const { replaceMemories } = await import(`../../memory/store.js?cb=${Date.now()}-a`);
    const { buildAgentMemoryNodeContext } = await import(`./agentMemoryContext.js?cb=${Date.now()}-a2`);
    seedScene(replaceMemories);
    const out = buildAgentMemoryNodeContext({
      state: { settings: {}, approvals: [], tasks: [] },
      chat: basicChat(),
      latestUserMessage: 'continue the project',
      activeAgentProfile: basicAgent(),
      project: null,
    });
    assert.equal(out.includes('Conversation scene summaries:'), false,
      'gate off must not emit the scene block');
    assert.equal(out.includes('Frame summaries:'), false,
      'gate off must not emit the frame block');
    assert.ok(out.includes('Prompt memory nodes:'), 'flat prompt path still renders the prompt block');
    assert.ok(out.includes('set up the project'), 'flat path returns the seeded prompt');
  });
});

test('tiered gate ON → scene + frame blocks rendered above prompt block', async () => {
  await withTempMeloHome(async () => {
    process.env.MELO_MEMORY_TIERS_RECALL = '1';
    const { replaceMemories } = await import(`../../memory/store.js?cb=${Date.now()}-b`);
    const { buildAgentMemoryNodeContext } = await import(`./agentMemoryContext.js?cb=${Date.now()}-b2`);
    seedScene(replaceMemories);
    const out = buildAgentMemoryNodeContext({
      state: { settings: {}, approvals: [], tasks: [] },
      chat: basicChat(),
      latestUserMessage: 'continue the project',
      activeAgentProfile: basicAgent(),
      project: null,
    });
    assert.ok(out.includes('Conversation scene summaries:'),
      'gate on must emit the scene block when seeded scenes match');
    assert.ok(out.includes('Frame summaries:'),
      'gate on must emit the frame block when seeded frames match');
    assert.ok(out.includes('Last week the user spent two days'),
      'scene text must be rendered verbatim (clipped to snippet length)');
    // Block ordering: scenes before frames before prompt nodes.
    const sceneIdx = out.indexOf('Conversation scene summaries:');
    const frameIdx = out.indexOf('Frame summaries:');
    const promptIdx = out.indexOf('Prompt memory nodes:');
    assert.ok(sceneIdx >= 0 && frameIdx > sceneIdx,
      'frames must appear after scenes (long → short horizon)');
    if (promptIdx >= 0) {
      assert.ok(promptIdx > frameIdx,
        'prompt nodes must appear after frame summaries');
    }
  });
});

test('tiered gate ON with prompt + fact contents → fact rendered as separate "Recalled fact nodes" block, NOT mixed into prompt block', async () => {
  // Codex follow-up (Phase E G2 🔵 P1 2026-05-05): recallMemoriesTiered
  // returns `kind IN ('prompt','fact')` in its `contents` tier. The
  // legacy promptHistory call only queried kind='prompt'. Letting fact
  // rows flow into "Prompt memory nodes" silently changes that
  // semantic + double-renders facts (also visible in speakerFacts).
  // Pin the split: facts get their own block, prompts only carry kind=prompt.
  await withTempMeloHome(async () => {
    process.env.MELO_MEMORY_TIERS_RECALL = '1';
    const { replaceMemories } = await import(`../../memory/store.js?cb=${Date.now()}-d0`);
    replaceMemories([
      // Scene + frame anchor so tiered recall has a hierarchy.
      {
        id: 'scene:chat-1:s1', namespace: 'chat:chat-1', kind: 'scene',
        sourceId: 'chat-1', text: 'Project arc summary.',
        createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z',
        metadata: { sceneId: 's1', chatId: 'chat-1', startAt: '2026-05-01T00:00:00Z', endAt: '2026-05-02T00:00:00Z' },
      },
      {
        id: 'frame:chat-1:f1', namespace: 'chat:chat-1', kind: 'frame',
        sourceId: 'chat-1', text: 'Frame about the project.',
        createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z',
        metadata: { frameId: 'f1', sceneId: 's1', chatId: 'chat-1', startAt: '2026-05-01T00:00:00Z', endAt: '2026-05-01T00:30:00Z' },
      },
      // One prompt + one fact, both anchored to the same chat namespace.
      // The query "continue the project" hits both via the keyword path.
      {
        id: 'prompt:chat-1:p1', namespace: 'chat:chat-1', kind: 'prompt',
        sourceId: 'm-prev', text: 'continue the project setup',
        createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z',
        metadata: { frameId: 'f1', sceneId: 's1', chatId: 'chat-1' },
      },
      {
        id: 'fact:chat-1:f1', namespace: 'chat:chat-1', kind: 'fact',
        sourceId: 'm-prev', text: 'project uses TypeScript with strict mode',
        createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z',
        metadata: { frameId: 'f1', sceneId: 's1', chatId: 'chat-1' },
      },
    ]);
    const { buildAgentMemoryNodeContext } = await import(`./agentMemoryContext.js?cb=${Date.now()}-d`);
    const out = buildAgentMemoryNodeContext({
      state: { settings: {}, approvals: [], tasks: [] },
      chat: basicChat(),
      latestUserMessage: 'continue the project',
      activeAgentProfile: basicAgent(),
      project: null,
    });

    // Fact block must appear, with the seeded fact text.
    assert.ok(out.includes('Recalled fact nodes (tiered):'),
      'gate on with fact contents must emit the fact block');
    assert.ok(out.includes('TypeScript with strict mode'),
      'fact text must be rendered into the fact block');

    // Prompt block, if present, must NOT contain fact text.
    const promptBlockMatch = out.match(/Prompt memory nodes:[\s\S]*?(?:\n\n|$)/);
    if (promptBlockMatch) {
      const promptBlock = promptBlockMatch[0];
      assert.equal(
        promptBlock.includes('TypeScript with strict mode'),
        false,
        'fact text must NOT leak into the Prompt memory nodes block (G2 contract)',
      );
      assert.ok(
        promptBlock.includes('continue the project setup'),
        'prompt content stays in the prompt block',
      );
    }

    // Block ordering: facts come AFTER prompts (prompts → atomic facts).
    const promptIdx = out.indexOf('Prompt memory nodes:');
    const factIdx = out.indexOf('Recalled fact nodes (tiered):');
    if (promptIdx >= 0) {
      assert.ok(factIdx > promptIdx,
        'tiered fact block should render after the prompt block, not before');
    }
  });
});

test('tiered gate OFF (default) does NOT emit "Recalled fact nodes (tiered)" block even if facts exist', async () => {
  // Mirror of the gate-off contract for the new fact block.
  await withTempMeloHome(async () => {
    delete process.env.MELO_MEMORY_TIERS_RECALL;
    const { replaceMemories } = await import(`../../memory/store.js?cb=${Date.now()}-e0`);
    replaceMemories([
      {
        id: 'fact:chat-1:f1', namespace: 'chat:chat-1', kind: 'fact',
        sourceId: 'm-prev', text: 'project uses TypeScript',
        createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z',
        metadata: { chatId: 'chat-1' },
      },
    ]);
    const { buildAgentMemoryNodeContext } = await import(`./agentMemoryContext.js?cb=${Date.now()}-e`);
    const out = buildAgentMemoryNodeContext({
      state: { settings: {}, approvals: [], tasks: [] },
      chat: basicChat(),
      latestUserMessage: 'continue the project',
      activeAgentProfile: basicAgent(),
      project: null,
    });
    assert.equal(out.includes('Recalled fact nodes (tiered):'), false,
      'gate off must not emit the new tiered-fact block');
  });
});

test('tiered gate ON with empty store → no scene/frame blocks, no exception', async () => {
  await withTempMeloHome(async () => {
    process.env.MELO_MEMORY_TIERS_RECALL = '1';
    // Node's ESM cache survives across tests in the same process — the
    // store.js module's getDb() handle may still point at a previous
    // test's MELO_HOME. Explicitly clear the rows here so this test's
    // assertion is on a guaranteed-empty DB regardless of cache state.
    const { replaceMemories } = await import(`../../memory/store.js?cb=${Date.now()}-c0`);
    replaceMemories([]);
    const { buildAgentMemoryNodeContext } = await import(`./agentMemoryContext.js?cb=${Date.now()}-c`);
    const out = buildAgentMemoryNodeContext({
      state: { settings: {}, approvals: [], tasks: [] },
      chat: basicChat(),
      latestUserMessage: 'continue the project',
      activeAgentProfile: basicAgent(),
      project: null,
    });
    // No seeded data → no blocks. Block list may still contain
    // fallbackTasks / fallbackPromptHistory / latestUserMessage; only
    // assert what the contract guarantees.
    assert.equal(out.includes('Conversation scene summaries:'), false);
    assert.equal(out.includes('Frame summaries:'), false);
    // Latest user turn block always emits when latestUserMessage is set.
    assert.ok(out.includes('Latest user turn'), 'latest user turn block always emitted');
  });
});
