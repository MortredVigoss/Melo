import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState, updateStateAtomically } from './stateStore.js';
import { atomicWriteJson } from '../storage.js';
import { withPerformanceTrace } from '../runtime/performanceTrace.js';

async function fixture(t, chats = 2) {
  const home = await mkdtemp(join(tmpdir(), 'melo-resident-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await updateStateAtomically(s => { s.chats = Array.from({ length: chats }, (_, i) => ({ id: `c${i}`, messages: [
    { id: `m${i}`, role: 'user', content: 'original', createdAt: '2026-01-01T00:00:00.000Z' },
  ] })); }, { home });
  return home;
}

test('reads see a committed revision without waiting for a suspended write', async t => {
  const home = await fixture(t);
  let ready, release;
  const entered = new Promise(r => { ready = r; });
  const barrier = new Promise(r => { release = r; });
  const write = updateStateAtomically(async s => { s.settings.testValue = 'new'; ready(); await barrier; }, { home });
  await entered;
  const read = await Promise.race([loadState({ home }), new Promise((_, reject) => {
    const timer = setTimeout(() => reject(Error('read joined write queue')), 1000); timer.unref();
  })]).finally(release);
  assert.equal(read.settings.testValue, undefined);
  await write;
  assert.equal((await loadState({ home })).settings.testValue, 'new');
});

test('owned snapshots isolate nested mutations and detect edits without timestamp or count changes', async t => {
  const home = await fixture(t);
  const a = await loadState({ home }), b = await loadState({ home });
  a.chats[0].messages[0].content = 'uncommitted';
  assert.equal(b.chats[0].messages[0].content, 'original');
  assert.equal((await loadState({ home })).chats[0].messages[0].content, 'original');
  await saveState(a);
  assert.equal((await loadState({ home })).chats[0].messages[0].content, 'uncommitted');
  await assert.rejects(saveState(b), { code: 'STATE_CONFLICT' });
});

test('64-chat warm reads and settings commits neither hydrate nor copy transcript bodies', async t => {
  const home = await fixture(t, 64);
  const stages = [];
  await withPerformanceTrace({ onTiming: row => stages.push(row.stage) }, async () => {
    const snapshot = await loadState({ home });
    assert.equal(snapshot.chats.length, 64);
    assert.equal(snapshot.chats[63].id, 'c63');
    await updateStateAtomically(s => { s.settings.testSetting = 'saved'; }, { home });
    await loadState({ home });
  });
  for (const name of ['state.manifest.read', 'state.threads.hydrate', 'state.chat.copy', 'state.skills.scan']) {
    assert.equal(stages.filter(stage => stage === name).length, 0, `${name} must not occur`);
  }
});

test('external manifest replacement invalidates the committed cache', async t => {
  const home = await fixture(t);
  const path = join(home, 'desktop/state.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.settings.externalValue = 'imported'; manifest._revision++;
  await atomicWriteJson(path, manifest);
  assert.equal((await loadState({ home })).settings.externalValue, 'imported');
  await updateStateAtomically(s => { s.settings.nextValue = 'kept'; }, { home });
  assert.equal((await loadState({ home })).settings.externalValue, 'imported');
});

test('a throwing mutator cannot contaminate the resident committed snapshot', async t => {
  const home = await fixture(t);
  await assert.rejects(updateStateAtomically(s => {
    s.chats[0].messages[0].content = 'discarded'; s.settings.contaminated = true; throw Error('abort');
  }, { home }));
  const read = await loadState({ home });
  assert.equal(read.chats[0].messages[0].content, 'original');
  assert.equal(read.settings.contaminated, undefined);
});
