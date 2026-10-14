import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, updateStateAtomically } from './stateStore.js';

test('loading and writing retain more than ten conversations and their messages', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-retention-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await updateStateAtomically(state => {
    state.chats = Array.from({ length: 12 }, (_, i) => ({ id: `chat-${i}`, title: `Chat ${i}`, mode: 'chat', messages: [{ id: `message-${i}`, role: 'user', content: 'keep me', createdAt: new Date().toISOString() }] }));
  }, { home });
  for (let i = 0; i < 3; i++) {
    assert.equal((await loadState({ home })).chats.length, 12);
    await updateStateAtomically(state => { state.settings.testCounter = i; }, { home });
  }
  assert.equal((await loadState({ home })).chats[11].messages[0].content, 'keep me');
});
