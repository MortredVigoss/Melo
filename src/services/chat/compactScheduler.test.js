// Background pre-compaction through the real store (2026-10-18 audit L4/L5/L15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadState, updateStateAtomically } from '../../state/stateStore.js';
import { precompactIfNeeded, _resetCompactSchedulerForTests } from './compactScheduler.js';
import { MAX_COMPACT_FAILURES } from '../../memory/contextWindow.js';

const config = { authMode: 'local', baseUrl: 'http://127.0.0.1:1', model: 'local-model' };
const SUMMARISER = /conversation summarizer/;

async function seed(t, { count = 60, size = 600 } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'melo-precompact-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const messages = Array.from({ length: count }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${'词'.repeat(size)}`, createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString() }));
  await updateStateAtomically(s => { s.chats = [{ id: 'bg', title: 'bg', mode: 'chat', agentId: 'main', messages, sessionMemory: [] }]; }, { home });
  return { home, chat: structuredClone((await loadState({ home })).chats[0]) };
}

test('L5: background failures are counted and persisted; the breaker trips after MAX_COMPACT_FAILURES and the summariser is not called again', async t => {
  _resetCompactSchedulerForTests();
  const { home, chat } = await seed(t);
  // A cloud error falls back to the extractive summary, so the realistic
  // failure is a request that never answers (timeout / abort).
  let calls = 0;
  const createReply = options => { calls++; return new Promise((_, reject) => options.signal?.addEventListener('abort', () => reject(options.signal.reason))); };
  for (let turn = 0; turn < MAX_COMPACT_FAILURES; turn += 1) {
    const fresh = structuredClone((await loadState({ home })).chats[0]);
    await assert.rejects(precompactIfNeeded(fresh, { config, home, createReply, timeoutMs: 20 }), `turn ${turn}: no summary`);
    assert.equal((await loadState({ home })).chats[0].compactFailures, turn + 1, 'failure count is persisted');
  }
  const attemptsBefore = calls;
  assert.ok(attemptsBefore >= MAX_COMPACT_FAILURES);
  const tripped = structuredClone((await loadState({ home })).chats[0]);
  assert.equal(tripped.compactFailures, MAX_COMPACT_FAILURES);
  assert.equal(await precompactIfNeeded(tripped, { config, home, createReply }), null, 'breaker open: no plan, no request');
  assert.equal(calls, attemptsBefore);
  assert.equal(chat.compactFailures || 0, 0, 'the seed snapshot was never mutated');
});

test('L15: a hung summariser times out, the failure is recorded and the chat is not left in flight', async t => {
  _resetCompactSchedulerForTests();
  const { home } = await seed(t);
  const fresh = structuredClone((await loadState({ home })).chats[0]);
  let aborted = false;
  const createReply = options => new Promise((_, reject) => { options.signal?.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); }); });
  await assert.rejects(precompactIfNeeded(fresh, { config, home, createReply, timeoutMs: 50 }), /timed out|COMPACT_TIMEOUT|aborted/i);
  assert.equal(aborted, true, 'the request was aborted');
  assert.equal((await loadState({ home })).chats[0].compactFailures, 1);
  // The slot is free again: a working summariser compacts on the next pass.
  const working = structuredClone((await loadState({ home })).chats[0]);
  let summarised = 0;
  const ok = await precompactIfNeeded(working, { config, home, createReply: async options => { if (SUMMARISER.test(options.systemPrompt)) summarised++; return '# 早期\n1. Request: test'; } });
  assert.equal(ok?.compacted, true);
  assert.equal(summarised, 1);
  const stored = (await loadState({ home })).chats[0];
  assert.equal(stored.compactFailures, 0, 'success resets the breaker');
  assert.equal(stored.compactCards.length, 1);
});

test('L4: the trigger follows the effective history window of the last turn and the chunk follows the budget', async t => {
  _resetCompactSchedulerForTests();
  const { home } = await seed(t, { count: 20, size: 300 });
  const chat = structuredClone((await loadState({ home })).chats[0]);
  // Pending history (~20 × 300 CJK chars) is below 70% of the local 12k window but above 70% of a 4k effective window.
  let transcripts = [];
  const createReply = async options => { transcripts.push(options.messages[0].content); return '# 卡片\n1. Request: x'; };
  assert.equal(await precompactIfNeeded(structuredClone(chat), { config, home, createReply }), null, 'nominal window: nothing to do yet');
  const result = await precompactIfNeeded(structuredClone(chat), { config, home, createReply, historyWindowTokens: 4000 });
  assert.equal(result?.compacted, true, 'effective window: compacts now');
  assert.equal(transcripts.length, 1);
  // Chunk size = compactChunkTokens (8000 for the local budget), so the chunk is bounded well below the old fixed 45k.
  const stored = (await loadState({ home })).chats[0];
  assert.ok(stored.compactedMessageCount > 0 && stored.compactedMessageCount < 20);
});
