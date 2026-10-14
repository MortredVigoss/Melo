import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertMemory, getMemoriesByIds, iterateMemoryRecords, _resetStoreForTests, withTransaction, isEntryInvalidated } from '../src/memory/store.js';
import { canRecallMemory } from '../src/memory/factPolicy.js';
import { reconcileLegacyFacts, editMemoryFact } from '../src/memory/factRecords.js';
import { refreshPortableMemory, applyPortableMemory, stagePortableMemory, replayPortableMemory } from '../src/services/chat/portableMemory.js';
import { refreshPortableWorkspace } from '../src/services/chat/portableWorkspace.js';
import { putWorkspace, validateWorkspace } from './workspaceProtocol.js';
import { importMobileSnapshot } from '../src/http/mobileSyncRoutes.js';
import { finishChatDeletions } from '../src/services/chat/chatDeletion.js';
import { deleteChat } from '../src/services/chat/chatMutations.js';
import { getReminderScheduler } from '../src/reminders/scheduler.js';
import { compactChatRuns, listArchivedRuns } from '../src/services/chat/turnArchive.js';
import { loadState, updateStateAtomically } from '../src/state/stateStore.js';
import { createRequestContext } from '../src/runtime/requestContext.js';
import { runWithRequestContext } from '../src/runtime/requestScope.js';
const date='2026-10-11T00:00:00.000Z';
const chat=(id='source')=>({id,title:id,messages:[],source:'desktop',createdAt:date,updatedAt:date});
const row=(id='fact',chatId='source')=>({id,kind:'session-fact',namespace:'user:local',sourceId:chatId,text:'Likes  Tea',searchText:'likes tea',createdAt:date,updatedAt:date,metadata:{chatId,agentId:'main',scope:'personal',audience:'local',originalFact:'Likes  Tea'}});
async function isolated(work) {
 const home=mkdtempSync(join(tmpdir(),'melo-audit-five-'));
 try {return await runWithRequestContext(createRequestContext({home}),()=>work(home));}
 finally {_resetStoreForTests();rmSync(home,{recursive:true,force:true});}
}
test('sync preserves future and historical expiry; legacy edits preserve dates; normalized text attaches once',()=>isolated(()=>{
 const s={chats:[{...chat(),sessionMemory:[{fact:'  LIKES Tea ' }]}],projects:[],artifacts:[],agentProfiles:{}};
 upsertMemory({...row(),metadata:{...row().metadata,validTo:'2099-01-01T00:00:00.000Z'}});
 refreshPortableWorkspace(s);refreshPortableMemory(s);
 let r=s.mobileWorkspaceSync.records.find(r=>r.kind==='memory'), v=r.versions[0].value;
 assert.equal(v.validTo,'2099-01-01T00:00:00.000Z');
 putWorkspace(s.mobileWorkspaceSync,'memory',r.id,{...v,text:'  LIKES    Green TEA  ',updatedAt:'2026-10-11T01:00:00.000Z'},'phone');
 applyPortableMemory(s);
 assert.equal(getMemoriesByIds(['fact'])[0].metadata.validTo,v.validTo);
 assert.equal(getMemoriesByIds(['fact'])[0].searchText,'likes green tea');
 assert.equal(s.chats[0].sessionMemory.length,1);
 refreshPortableMemory(s);r=s.mobileWorkspaceSync.records.find(r=>r.kind==='memory');v={...r.versions[0].value};delete v.validTo;
 putWorkspace(s.mobileWorkspaceSync,'memory',r.id,{...v,text:'legacy edit'},'old-phone');applyPortableMemory(s);
 assert.equal(getMemoriesByIds(['fact'])[0].metadata.validTo,'2099-01-01T00:00:00.000Z');
 putWorkspace(s.mobileWorkspaceSync,'memory',r.id,{...v,status:'historical',validTo:'2025-01-01T00:00:00.000Z'},'phone');applyPortableMemory(s);
 refreshPortableMemory(s);r=s.mobileWorkspaceSync.records.find(r=>r.kind==='memory');v={...r.versions[0].value};delete v.validTo;
 putWorkspace(s.mobileWorkspaceSync,'memory',r.id,{...v,text:'historical edit',updatedAt:date},'old-phone');applyPortableMemory(s);
 assert.equal(getMemoriesByIds(['fact'])[0].metadata.validTo,'2025-01-01T00:00:00.000Z');
 putWorkspace(s.mobileWorkspaceSync,'memory',r.id,{...v,status:'active',text:'old phone stale active status'},'old-phone');applyPortableMemory(s);
 assert.equal(getMemoriesByIds(['fact'])[0].metadata.validTo,'2025-01-01T00:00:00.000Z');
 assert.throws(()=>validateWorkspace({version:1,records:[{...r,versions:[{...r.versions[0],value:{...v,validTo:'bad'}}]}]}),/validity/);
}));
test('maintenance and export traverse beyond 1000/10000 even while rows are updated',()=>isolated(()=>{
 withTransaction(()=>{for(let i=0;i<10005;i++)upsertMemory(row(`fact-${String(i).padStart(5,'0')}`,i<1002?'deleted':'source'));});
 const s={chats:[chat()],projects:[],artifacts:[],agentProfiles:{}};
 reconcileLegacyFacts(s);
 const rows=[...iterateMemoryRecords()];assert.equal(rows.length,10005);assert.equal(rows.filter(r=>r.metadata.sourceDeleted).length,1002);
 assert.throws(()=>editMemoryFact('fact-00000',{forgotten:false}),/来源对话已删除/);
 // Also exceed the old export cap using all live rows.
 withTransaction(()=>{for(let i=0;i<1100;i++)upsertMemory(row(`live-${i}`));});
 refreshPortableWorkspace(s);const expected=refreshPortableMemory(s);assert.equal(expected.size,10103);
}));
test('locked or running chat rejects the whole sync before applying deletions',()=>{
 for(const blocked of ['locked','running']) {
  const s={chats:[chat('safe'),{...chat(),locked:blocked==='locked'}],chatRuns:blocked==='running'?[{chatId:'source',status:'running'}]:[]};
  const before=structuredClone(s);
  assert.throws(()=>importMobileSnapshot(s,{version:1,chats:[],deletedChats:[{id:'safe',deletedAt:date},{id:'source',deletedAt:date}]}),e=>e.statusCode===409);
  assert.deepEqual(s,before);
 }
});
test('mobile and local deletion both durably cancel reminders, remove archive, quarantine shared memories and retry failure',()=>isolated(async home=>{
 const scheduler=getReminderScheduler(home);await scheduler.start(async()=>{});
 try {
  for(const mode of ['mobile','local']) {
   const id=mode;await updateStateAtomically(s=>{s.chats.push(chat(id));return s;},{home});upsertMemory(row(`promoted:fact-${mode}`,id));
   await scheduler.add({id:`reminder-${mode}`,chatId:id,text:'test',fireAt:Date.now()+3600000});
   const runs=Array.from({length:60},(_,i)=>({runId:`run-${mode}-${i}`,requestId:`request-${i}`,chatId:id,status:'completed',createdAt:new Date(i*1000).toISOString()}));
   compactChatRuns({chatRuns:structuredClone(runs)},runs,home);assert(listArchivedRuns(home,id).length>0);
   if(mode==='local') await deleteChat(id);
   else {
    await updateStateAtomically(s=>importMobileSnapshot(s,{version:1,chats:[],deletedChats:[{id,deletedAt:date}]}),{home});
    assert((await loadState({home})).pendingChatDeletions.includes(id));
    assert.equal(getMemoriesByIds([`promoted:fact-${mode}`])[0].metadata.quarantined,undefined,'no DB changes before committed cleanup');
    assert(!canRecallMemory(getMemoriesByIds([`promoted:fact-${mode}`])[0],{chat:chat('other'),deletedChatIds:new Set([id])}),'committed deletion excludes recall even before DB cleanup');
    const persist=scheduler.persist;scheduler.persist=async()=>{throw Error('injected disk failure');};
    try {await finishChatDeletions(home);} finally {scheduler.persist=persist;}
    assert((await loadState({home})).pendingChatDeletions.includes(id));
    await finishChatDeletions(home);await finishChatDeletions(home);
   }
   assert.equal((await scheduler.list(id)).length,0);assert.equal(listArchivedRuns(home,id).length,0);
   assert(isEntryInvalidated(getMemoriesByIds([`promoted:fact-${mode}`])[0].metadata));
   assert(!(await loadState({home})).pendingChatDeletions.includes(id));
  }
 } finally {scheduler.stop();}
}));
