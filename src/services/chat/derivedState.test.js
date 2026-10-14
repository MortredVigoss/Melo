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
