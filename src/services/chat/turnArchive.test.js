import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactChatRuns, findArchivedRun, listArchivedRuns } from './turnArchive.js';
import { updateStateAtomically, loadState } from '../../state/stateStore.js';
import { beginChatRun } from './turnLedger.js';
import { chatRequestFingerprint } from './requestContract.js';

test('terminal history is bounded in the manifest and old requests still replay safely', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-turn-archive-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const input = { chatId: 'c', content: 'hello' };
  const runs = Array.from({ length: 75 }, (_, i) => ({ runId: `run-${i}`, requestId: `request-${i}`, chatId: 'c', status: 'completed', createdAt: new Date(i * 1000).toISOString(), assistantMessageId: `reply-${i}`, fingerprint: chatRequestFingerprint(input) }));
  await updateStateAtomically(s => {
    s.chats = [{ id: 'c', title: 'c', messages: runs.map(r => ({ id: r.assistantMessageId, role: 'assistant', content: r.runId, createdAt: r.createdAt })) }];
    s.chatRuns = [...runs, { runId: 'active', requestId: 'active', chatId: 'c', status: 'running', createdAt: '1960' }];
  }, { home });
  await updateStateAtomically(s => { s.settings.touch = true; }, { home });
  const state = await loadState({ home });
  assert.equal(state.chatRuns.length, 51);
  assert.equal(findArchivedRun(home, 'c', { requestId: 'request-0' }).runId, 'run-0');
  const result = await beginChatRun(input, { home, requestId: 'request-0' });
  assert.equal(result.replay.id, 'reply-0');
  await assert.rejects(beginChatRun({ ...input, content: 'changed' }, { home, requestId: 'request-0' }), { code: 'REQUEST_ID_CONFLICT' });
  const first = listArchivedRuns(home, 'c', { limit: 10 });
  const second = listArchivedRuns(home, 'c', { limit: 10, before: first.at(-1) });
  assert.equal(new Set([...first, ...second].map(r => r.runId)).size, 20);
  assert.equal(state.chats[0].messages.length, 75);
});
test('new or changed terminal records are never archived ahead of their manifest commit', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-turn-archive-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runs = Array.from({ length: 60 }, (_, i) => ({ runId: `r${i}`, requestId: `q${i}`, chatId: 'c', createdAt: String(i).padStart(3, '0'), status: 'completed' }));
  const state = { chatRuns: structuredClone(runs) };
  compactChatRuns(state, [], home);
  assert.equal(state.chatRuns.length, 60);
  const committed = structuredClone(runs); committed[0].status = 'running';
  compactChatRuns(state, committed, home);
  assert.ok(state.chatRuns.some(r => r.runId === 'r0'));
  assert.equal(findArchivedRun(home, 'c', { runId: 'r0' }), null);
});
