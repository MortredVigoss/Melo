import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWriteJson } from '../storage.js';
import { enqueueStateWrite, updateStateAtomically, readStateSnapshot } from './stateStore.js';

test('queued state mutations pin state, checkpoints and memory to the scheduling home', async t => {
  const root = await mkdtemp(join(tmpdir(), 'melo-queued-home-'));
  const homeA = join(root, 'A');
  const homeB = join(root, 'B');
  const previous = process.env.MELO_HOME;
  t.after(async () => {
    await delay(100);
    if (previous === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  await atomicWriteJson(join(homeA, 'desktop/state.json'), {
    chats: [{ id: 'home-a-chat', title: 'A chat', mode: 'chat', messages: [] }],
  });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const blocked = enqueueStateWrite(() => gate);
  process.env.MELO_HOME = homeA;
  const writing = updateStateAtomically(state => {
    state.chats[0].messages.push({ id: 'bound-message', role: 'assistant', content: 'Bound to A', createdAt: new Date().toISOString() });
    return state;
  });
  process.env.MELO_HOME = homeB;
  release();
  await blocked;
  await writing;
  const restored = await readStateSnapshot({ home: homeA, persistRepair: false });
  assert.equal(restored.chats[0].messages[0].id, 'bound-message');
  const saved = JSON.parse(await readFile(join(homeA, 'desktop/state.json'), 'utf8'));
  assert.equal(saved.chats[0].id, 'home-a-chat');
  await access(join(homeA, 'desktop/store.sqlite'));
  await assert.rejects(access(join(homeB, 'desktop/state.json')), { code: 'ENOENT' });
  await assert.rejects(access(join(homeB, 'desktop/store.sqlite')), { code: 'ENOENT' });
});
