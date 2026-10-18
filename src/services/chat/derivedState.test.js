import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadState, updateStateAtomically } from '../../state/stateStore.js';
import { persistCompactSnapshot, persistSessionMemorySnapshot } from './derivedState.js';

test('late summaries preserve newly appended messages and cannot replace a newer derived result', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-derived-concurrency-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await updateStateAtomically(s => { s.chats = [{ id: 'summary', messages: [
    { id: 'first', role: 'user', content: 'First message' },
  ] }]; }, { home });
  const old = structuredClone((await loadState({ home })).chats[0]);
  Object.assign(old, { compactSummary: 'First summary', compactBoundaryMessageId: 'first', compactedMessageCount: 1, compactedAt: new Date().toISOString(), compactFailures: 0 });
  await updateStateAtomically(s => {
    s.chats[0].messages.push({ id: 'second', role: 'user', content: 'Concurrent message' });
    s.settings.whileSummarizing = 'kept';
  }, { home });
  await persistCompactSnapshot(old, { boundaryId: 'first', compactedCount: 1 }, { home });
  const current = (await loadState({ home })).chats[0];
  assert.equal(current.messages.length, 2);
  assert.equal(current.compactSummary, 'First summary');
  Object.assign(current, { compactSummary: 'Newer summary', compactBoundaryMessageId: 'second', compactedMessageCount: 2 });
  await persistCompactSnapshot(current, { boundaryId: 'second', compactedCount: 2 }, { home });
  await persistCompactSnapshot(old, { boundaryId: 'first', compactedCount: 1 }, { home });
  Object.assign(current, { sessionMemory: ['New fact'], memoryLastExtractedAtCount: 2, memoryLastExtractedAt: Date.now() });
  assert.equal(await persistSessionMemorySnapshot(current, { home }), true);
  Object.assign(old, { sessionMemory: ['Stale fact'], memoryLastExtractedAtCount: 1, memoryLastExtractedAt: Date.now() });
  assert.equal(await persistSessionMemorySnapshot(old, { home }), false);
  const final = await loadState({ home });
  assert.equal(final.settings.whileSummarizing, 'kept');
  assert.equal(final.chats[0].compactSummary, 'Newer summary');
  assert.deepEqual(final.chats[0].sessionMemory, ['New fact']);
  assert.deepEqual(final.chats[0].messages.map(m => m.id), ['first', 'second']);
});

// ─── 2026-10-18 bug audit (section 2) ────────────────────────────────────────

test('T4/L2: a background compaction finishing with a stale snapshot never lowers toolGroupsActivated, attachmentsExternalized or compactUpgradeAttempts', async t => {
  const { persistChatRuntimeFields, persistCompactFailure } = await import('./derivedState.js');
  const home = await mkdtemp(join(tmpdir(), 'melo-derived-stale-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const messages = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `t${i}` }));
  await updateStateAtomically(s => { s.chats = [{ id: 'bg', messages, toolGroupsActivated: [], attachmentsExternalized: false, compactUpgradeAttempts: 0 }]; }, { home });
  // Background pass takes its snapshot now (turn N).
  const stale = structuredClone((await loadState({ home })).chats[0]);
  // Turn N+1 commits runtime flags through the real path.
  const live = structuredClone((await loadState({ home })).chats[0]);
  live.toolGroupsActivated = ['media']; live.attachmentsExternalized = true; live.compactUpgradeAttempts = 2;
  await persistChatRuntimeFields(live, ['toolGroupsActivated', 'attachmentsExternalized', 'compactUpgradeAttempts'], { home });
  // Background pass completes on the stale snapshot.
  Object.assign(stale, { compactSummary: 'bg summary', compactCards: [{ id: 'c1', summary: 'bg summary', source: 'cloud' }], compactBoundaryMessageId: 'm3', compactedMessageCount: 4, compactedAt: new Date().toISOString(), compactFailures: 0, compactSummarySource: 'cloud', toolGroupsActivated: ['browser'] });
  await persistCompactSnapshot(stale, { boundaryId: 'm3', compactedCount: 4 }, { home });
  let current = (await loadState({ home })).chats[0];
  assert.equal(current.compactSummary, 'bg summary', 'the compaction itself lands');
  assert.deepEqual(current.toolGroupsActivated, ['browser', 'media'], 'tool groups merge as a union');
  assert.equal(current.attachmentsExternalized, true, 'migration mark is never lowered');
  assert.equal(current.compactUpgradeAttempts, 2, 'upgrade counter comes from the store');
  assert.deepEqual(stale.toolGroupsActivated, ['browser', 'media'], 'the snapshot is brought up to date');
  assert.equal(stale.attachmentsExternalized, true);
  // The upgrade path is the one writer allowed to set the counter.
  stale.compactUpgradeAttempts = 3;
  await persistCompactSnapshot(stale, { boundaryId: 'm3', compactedCount: 4 }, { home, upgrade: true });
  current = (await loadState({ home })).chats[0];
  assert.equal(current.compactUpgradeAttempts, 3);
  // L5: failures merge with max() so a stale writer cannot reset the breaker.
  stale.compactFailures = 1;
  await persistCompactFailure(stale, { home });
  const fresh = structuredClone((await loadState({ home })).chats[0]);
  fresh.compactFailures = 3;
  await persistCompactFailure(fresh, { home });
  stale.compactFailures = 2;
  await persistCompactFailure(stale, { home });
  assert.equal((await loadState({ home })).chats[0].compactFailures, 3);
  assert.equal(stale.compactFailures, 3, 'the caller sees the merged count');
});
