import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { startDerivedIndexing } from './derivedIndexing.js';
import { createRequestContext } from './requestContext.js';
import { runWithRequestContext } from './requestScope.js';
import { updateStateAtomically, loadState } from '../state/stateStore.js';
import { withPerformanceTrace } from './performanceTrace.js';
import { registerDerivedDispatcher, derivedIndexStatus } from '../state/derivedDispatcher.js';
import { recordMemoryFeedback, getHitStats, getMemoriesByIds } from '../memory/store.js';

async function homeFor(t) {
  const home = await mkdtemp(join(tmpdir(), 'melo-worker-index-'));
  return home;
}
const seed = s => { s.chats = [{ id: 'thread', title: 'Index test', messages: [
  { id: 'question', role: 'user', content: '记住我喜欢紫色。', createdAt: '2026-01-01T00:00:00.000Z' },
], sessionMemory: [{ fact: 'User prefers purple', category: 'preference', extractedAt: '2026-01-01T00:00:00.000Z' }] }]; };

test('worker catches up to committed revisions, preserves hits, and never indexes on the main save path', async t => {
  const home = await homeFor(t);
  const worker = startDerivedIndexing({ home, env: { MELO_TEST_MODE: '1' } });
  t.after(async () => { await worker.stop(); await rm(home,{recursive:true,force:true}); });
  const stages = [];
  const first = await withPerformanceTrace({ onTiming: r => stages.push(r.stage) }, () => updateStateAtomically(seed, { home }));
  assert.equal(stages.filter(stage => stage === 'memory.index').length, 0);
  await worker.flush({ revision: first._revision });
  assert.equal(derivedIndexStatus(home).status,'ready');
  assert.equal(derivedIndexStatus(home).indexedRevision,first._revision);
  assert.equal(typeof derivedIndexStatus(home).lastDurationMs,'number');
  const marker = JSON.parse(await readFile(join(home,'desktop/derived-index.json'),'utf8'));
  assert.equal(marker.revision, first._revision);
  await runWithRequestContext(createRequestContext({home}), async () => {
    const db = new DatabaseSync(join(home,'desktop/store.sqlite'), {readOnly:true});
    const row = db.prepare("SELECT id FROM memories WHERE kind='prompt' LIMIT 1").get(); db.close();
    assert.ok(row);
    recordMemoryFeedback({candidates:getMemoriesByIds([row.id]),usedIds:[row.id],requestId:'hit-1',query:'purple'});
    const saved = await updateStateAtomically(s => { s.settings.selection = 'new'; }, {home});
    await worker.flush({revision:saved._revision});
    assert.equal(getHitStats({memoryIds:[row.id]})[0].hits,1);
  });
});

test('a crash before dispatch leaves a durable pending revision which restart replays', async t => {
  const home = await homeFor(t);
  // Simulate death after manifest commit but before the worker receives it.
  const remove = registerDerivedDispatcher(home, () => {});
  const saved = await updateStateAtomically(seed, {home});
  remove();
  await assert.rejects(readFile(join(home,'desktop/derived-index.json')), {code:'ENOENT'});
  const worker = startDerivedIndexing({home,env:{MELO_TEST_MODE:'1'}});
  t.after(async () => { await worker.stop(); await rm(home,{recursive:true,force:true}); });
  await worker.flush({revision:saved._revision});
  const db = new DatabaseSync(join(home,'desktop/store.sqlite'), {readOnly:true});
  assert.ok(db.prepare('SELECT count(*) AS n FROM memories').get().n > 0); db.close();
});

test('failed indexing does not lose the saved message; restart catches up after repair', async t => {
  const home = await homeFor(t);
  await mkdir(join(home,'desktop/store.sqlite'),{recursive:true});
  let worker = startDerivedIndexing({home,env:{MELO_TEST_MODE:'1'}});
  t.after(async () => { await worker.stop(); await rm(home,{recursive:true,force:true}); });
  const saved = await updateStateAtomically(seed,{home});
  await assert.rejects(worker.flush({revision:saved._revision,timeoutMs:500}), {code:'DERIVED_INDEX_PENDING'});
  assert.equal((await loadState({home})).chats[0].messages[0].content,'记住我喜欢紫色。');
  await worker.stop({drain:false});
  await rm(join(home,'desktop/store.sqlite'),{recursive:true,force:true});
  worker = startDerivedIndexing({home,env:{MELO_TEST_MODE:'1'}});
  await worker.flush({revision:saved._revision});
  assert.equal(worker.status().indexedRevision,saved._revision);
});

test('coalesced edits and deletion converge to latest revision without retaining derived source rows', async t => {
  const home = await homeFor(t);
  const worker = startDerivedIndexing({home,env:{MELO_TEST_MODE:'1'}});
  t.after(async () => { await worker.stop(); await rm(home,{recursive:true,force:true}); });
  const saved = await updateStateAtomically(seed,{home});
  await worker.flush({revision:saved._revision});
  await Promise.all(Array.from({length:8},(_,n)=>updateStateAtomically(s=>{
    s.chats[0].messages[0].content=`edit ${n}`;
  },{home})));
  const deleted = await updateStateAtomically(s=>{s.chats=[];},{home});
  await worker.flush({revision:deleted._revision});
  const db = new DatabaseSync(join(home,'desktop/store.sqlite'), {readOnly:true});
  assert.equal(db.prepare("SELECT count(*) AS n FROM memories WHERE kind='prompt' AND json_extract(metadata_json,'$.chatId')='thread'").get().n,0);
  assert.ok(db.prepare("SELECT count(*) AS n FROM memories WHERE id LIKE 'promoted:%'").get().n > 0);
  db.close();
});
