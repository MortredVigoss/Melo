import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { upsertMemory, _resetStoreForTests } from './store.js';
import { repairMemoryBatch, memoryRepairStatus, diagnoseMemory } from './repair.js';
import { collectMemoryStatus } from './status.js';
let home, previous;
test.beforeEach(async () => { previous = process.env.MELO_HOME; home = await mkdtemp(join(tmpdir(), 'melo-repair-')); process.env.MELO_HOME = home; _resetStoreForTests(); for (let i=0;i<3;i++) upsertMemory({ id:`m${i}`,namespace:'chat:repair',kind:'fact',text:`memory ${i}` }); });
test.afterEach(async () => { _resetStoreForTests(); if (previous === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = previous; await rm(home,{recursive:true,force:true}); });
const provider = { modelId:'fixture', dims:1024, embed:async text => { const v = new Float32Array(1024); v[text.includes('1')?1:0]=1; return v; } };
test('staging survives failed batch and process store reopen; old vectors publish only after verification', async () => {
  let r=await repairMemoryBatch({home,providerPromise:provider,batchSize:1}); assert.equal(r.status,'paused'); assert.equal(r.completed,1);
  const db=new DatabaseSync(join(home,'desktop','store.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL').get().n,0);
  r=await repairMemoryBatch({home,providerPromise:{...provider,embed:async()=>null}}); assert.equal(r.status,'failed'); assert.equal(r.completed,1);
  _resetStoreForTests(); assert.equal(memoryRepairStatus(home).completed,1);
  r=await repairMemoryBatch({home,providerPromise:provider}); assert.equal(r.status,'complete');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL').get().n,3);
  assert.equal(db.prepare("SELECT value FROM _meta WHERE key='embedding_model_id'").get().value,'fixture'); db.close();
});
test('changed source during embed is caught before index publication', async()=> {
  const db=new DatabaseSync(join(home,'desktop','store.sqlite')); let changed=false;
  const r=await repairMemoryBatch({home,providerPromise:{...provider,embed:async text=>{ if(!changed){changed=true;db.prepare("UPDATE memories SET search_text='changed' WHERE id='m0'").run();} return provider.embed(text);}}});
  assert.equal(r.status,'paused'); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL').get().n,0);db.close();
});
test('offline and wrong dimensions diagnose distinctly without removing text',async()=>{
  const offline=await diagnoseMemory(collectMemoryStatus({meloHome:home}),null);assert.equal(offline.issues[0].code,'offline');
  const r=await repairMemoryBatch({home,providerPromise:{...provider,dims:768}}); assert.equal(r.status,'failed'); assert.equal(collectMemoryStatus({meloHome:home}).counts.memories,3);
});
test('diagnosis bypasses cached embeddings and reports actual returned dimensions',async()=>{
 let live=true;
 const p={...provider,probe:async()=>live ? provider.embed('probe') : null};
 assert.equal((await diagnoseMemory(collectMemoryStatus({meloHome:home}),p)).available,true);
 live=false;assert.equal((await diagnoseMemory(collectMemoryStatus({meloHome:home}),p)).available,false);
 const wrong={...provider,observedDims:768};const result=await diagnoseMemory(collectMemoryStatus({meloHome:home}),wrong);assert.equal(result.available,false);assert.ok(result.issues.some(i=>i.code==='dimensions'));
});
test('a failed final index transaction restores the existing index',async()=>{
 assert.equal((await repairMemoryBatch({home,providerPromise:provider})).status,'complete');
 const source=new DatabaseSync(join(home,'desktop','store.sqlite'));const old=Buffer.from(source.prepare("SELECT embedding FROM memories WHERE id='m0'").get().embedding);
 const stage=new DatabaseSync(join(home,'desktop','memory-repair.sqlite'));stage.prepare('UPDATE staged SET model=?, embedding=?').run('replacement',Buffer.alloc(4));stage.close();
 const result=await repairMemoryBatch({home,providerPromise:{...provider,modelId:'replacement'}});assert.equal(result.status,'failed');assert.deepEqual(Buffer.from(source.prepare("SELECT embedding FROM memories WHERE id='m0'").get().embedding),old);assert.equal(source.prepare("SELECT value FROM _meta WHERE key='embedding_model_id'").get().value,'fixture');source.close();
});
