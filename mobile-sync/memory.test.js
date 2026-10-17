import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertMemory, getMemoriesByIds, _resetStoreForTests, isEntryInvalidated } from '../src/memory/store.js';
import { canRecallMemory } from '../src/memory/factPolicy.js';
import { refreshPortableWorkspace } from '../src/services/chat/portableWorkspace.js';
import { refreshPortableMemory, applyPortableMemory, portableMemoryID, stagePortableMemory, replayPortableMemory } from '../src/services/chat/portableMemory.js';
import { putWorkspace, mergeWorkspaces, resolveWorkspace, validateWorkspace } from './workspaceProtocol.js';
import { withoutDeletedChatContext } from './protocol.js';

test('memory sync preserves source, edits, stop/restore, conflicts and in-flight changes',()=>{
 const home=mkdtempSync(join(tmpdir(),'melo-memory-sync-')); const old=process.env.MELO_HOME;process.env.MELO_HOME=home;_resetStoreForTests();
 try {
  const state={chats:[{id:'chat-a',source:'iphone',title:'A',messages:[]},{id:'chat-b',source:'desktop',title:'B',messages:[]}],projects:[],artifacts:[],agentProfiles:{}};
  const row={id:'promoted:test',kind:'session-fact',namespace:'chat:chat-a',sourceId:'chat-a',text:'User dislikes coffee',searchText:'user dislikes coffee',createdAt:'2026-10-11T00:00:00.000Z',updatedAt:'2026-10-11T00:00:00.000Z',metadata:{chatId:'chat-a',agentId:'main',scope:'chat',audience:'local',sourceText:'I dislike coffee',category:'user_preference'}};
  upsertMemory(row);refreshPortableWorkspace(state);let expected=refreshPortableMemory(state);
  const mobile=structuredClone(state.mobileWorkspaceSync),id=portableMemoryID(row.id),v=mobile.records.find(r=>r.kind==='memory').versions[0].value;
  putWorkspace(mobile,'memory',id,{...v,text:'User prefers tea',scope:'personal',userEdited:true,updatedAt:'2026-10-11T00:01:00.000Z'},'phone');
  state.mobileWorkspaceSync=mergeWorkspaces(state.mobileWorkspaceSync,mobile);applyPortableMemory(state,expected);
  let updated=getMemoriesByIds([row.id])[0];assert.equal(updated.text,'User prefers tea');assert.equal(updated.metadata.userEdited,true);assert(canRecallMemory(updated,{chat:state.chats[0],agentId:'main'}));
  assert(!canRecallMemory(updated,{chat:{id:'remote',source:'telegram'},agentId:'main'}));
  expected=refreshPortableMemory(state);
  let value=state.mobileWorkspaceSync.records.find(r=>r.kind==='memory').versions[0].value;
  putWorkspace(state.mobileWorkspaceSync,'memory',id,{...value,status:'forgotten'},'phone');applyPortableMemory(state,expected);assert(isEntryInvalidated(getMemoriesByIds([row.id])[0].metadata));
  expected=refreshPortableMemory(state);value=state.mobileWorkspaceSync.records.find(r=>r.kind==='memory').versions[0].value;
  putWorkspace(state.mobileWorkspaceSync,'memory',id,{...value,status:'active',validTo:null},'phone');applyPortableMemory(state,expected);assert(!isEntryInvalidated(getMemoriesByIds([row.id])[0].metadata));
  expected=refreshPortableMemory(state);const fork=structuredClone(state.mobileWorkspaceSync);value=fork.records.find(r=>r.kind==='memory').versions[0].value;
  putWorkspace(fork,'memory',id,{...value,text:'phone change'},'phone');putWorkspace(state.mobileWorkspaceSync,'memory',id,{...value,text:'desktop change'},state.mobileWorkspaceDevice);state.mobileWorkspaceSync=mergeWorkspaces(state.mobileWorkspaceSync,fork);applyPortableMemory(state,expected);assert(isEntryInvalidated(getMemoriesByIds([row.id])[0].metadata));
  state.mobileWorkspaceSync=resolveWorkspace(state.mobileWorkspaceSync,'memory',id,0,'phone');applyPortableMemory(state);assert(!isEntryInvalidated(getMemoriesByIds([row.id])[0].metadata));
  expected=refreshPortableMemory(state);upsertMemory({...getMemoriesByIds([row.id])[0],text:'new live edit'});assert.throws(()=>applyPortableMemory(state,expected),/同步期间变化/);assert.equal(getMemoriesByIds([row.id])[0].text,'new live edit');
  expected=refreshPortableMemory(state);
  const baseline=structuredClone(state.mobileWorkspaceSync),before=getMemoriesByIds([row.id])[0].text;
  value=state.mobileWorkspaceSync.records.find(r=>r.kind==='memory').versions[0].value;
  putWorkspace(state.mobileWorkspaceSync,'memory',id,{...value,text:'durable phone change'},'phone');
  stagePortableMemory(state,expected,baseline);
  assert.equal(getMemoriesByIds([row.id])[0].text,before,'staging must not mutate the memory database before the state manifest is durable');
  const persisted=JSON.parse(JSON.stringify(state));
  replayPortableMemory(state);assert.equal(getMemoriesByIds([row.id])[0].text,'durable phone change');
  replayPortableMemory(persisted);assert.equal(getMemoriesByIds([row.id])[0].text,'durable phone change','replay after losing the completion marker is idempotent');
  expected=refreshPortableMemory(state);const beforeConcurrent=structuredClone(state.mobileWorkspaceSync);
  value=state.mobileWorkspaceSync.records.find(r=>r.kind==='memory').versions[0].value;
  putWorkspace(state.mobileWorkspaceSync,'memory',id,{...value,text:'phone concurrent change'},'phone');
  stagePortableMemory(state,expected,beforeConcurrent);
  upsertMemory({...getMemoriesByIds([row.id])[0],text:'desktop concurrent change'});
  replayPortableMemory(state);
  assert.equal(state.mobileWorkspaceSync.records.find(r=>r.id===id).versions.length,2);
  assert.equal(getMemoriesByIds([row.id])[0].text,'desktop concurrent change');
  assert(isEntryInvalidated(getMemoriesByIds([row.id])[0].metadata));
  const tombstones=[{id:'chat-a',deletedAt:'2026-10-11T01:00:00.000Z'}];assert(!withoutDeletedChatContext(state.mobileWorkspaceSync,tombstones).records.some(r=>r.kind==='memory'));
  state.mobileWorkspaceSync=resolveWorkspace(state.mobileWorkspaceSync,'memory',id,0,'phone');
  upsertMemory({...getMemoriesByIds([row.id])[0],metadata:{...row.metadata,mergedInto:'promoted:winner'}});
  refreshPortableMemory(state);
  let mergedValue=validateWorkspace(state.mobileWorkspaceSync).records.find(r=>r.id===id).versions[0].value;
  assert.equal(mergedValue.status,'historical','merged desktop memory must not become active on iPhone');
  assert.equal(mergedValue.mergedInto,'promoted:winner');
  applyPortableMemory(state);
  assert.equal(getMemoriesByIds([row.id])[0].metadata.mergedInto,'promoted:winner');
  const legitimate=structuredClone(state.mobileWorkspaceSync);
  putWorkspace(state.mobileWorkspaceSync,'memory',id,{...mergedValue,mergedInto:'forged-target'},'phone');
  assert.throws(()=>applyPortableMemory(state),/merge source mismatch/);
  state.mobileWorkspaceSync=legitimate;
  state.mobileDeletedChats=tombstones;state.chats=state.chats.filter(c=>c.id!=='chat-a');applyPortableMemory(state);assert(getMemoriesByIds([row.id])[0].metadata.quarantined);
 } finally {_resetStoreForTests(); if(old===undefined)delete process.env.MELO_HOME;else process.env.MELO_HOME=old;rmSync(home,{recursive:true,force:true});}
});

// Project memory book projection (design 2026-10-17 §3.4, 2B): `section` and
// `bookStatus` ride the wire as optional enum fields, survive a round trip,
// and are rejected when malformed. Older clients that omit them still validate.
test('memory sync carries the project memory book projection as optional fields',()=>{
 const home=mkdtempSync(join(tmpdir(),'melo-memory-book-sync-')); const old=process.env.MELO_HOME;process.env.MELO_HOME=home;_resetStoreForTests();
 try {
  const state={chats:[{id:'chat-a',source:'desktop',title:'A',projectId:'P',messages:[]}],projects:[{id:'P',name:'P'}],artifacts:[],agentProfiles:{}};
  const row={id:'book:promoted:test',kind:'session-fact',namespace:'project:P',sourceId:'chat-a',text:'API fields use snake_case',searchText:'api fields use snake_case',createdAt:'2026-10-11T00:00:00.000Z',updatedAt:'2026-10-11T00:00:00.000Z',
   metadata:{chatId:'chat-a',agentId:'main',scope:'project',projectId:'P',audience:'local',category:'decision',bookStatus:'auto',section:'decision'}};
  upsertMemory(row);refreshPortableWorkspace(state);const expected=refreshPortableMemory(state);
  const register=state.mobileWorkspaceSync.records.find(r=>r.kind==='memory'),v=register.versions[0].value;
  assert.equal(v.section,'decision');assert.equal(v.bookStatus,'auto');
  assert.doesNotThrow(()=>validateWorkspace(state.mobileWorkspaceSync));
  const legacy={...v};delete legacy.section;delete legacy.bookStatus;
  assert.doesNotThrow(()=>validateWorkspace({version:1,records:[{...register,versions:[{...register.versions[0],value:legacy}]}]}),'older clients omit the fields');
  assert.throws(()=>validateWorkspace({version:1,records:[{...register,versions:[{...register.versions[0],value:{...v,section:'misc'}}]}]}),/section|schema/);
  assert.throws(()=>validateWorkspace({version:1,records:[{...register,versions:[{...register.versions[0],value:{...v,bookStatus:'maybe'}}]}]}),/book status|schema/);
  // the phone confirms the row and moves it to another section
  const mobile=structuredClone(state.mobileWorkspaceSync);
  putWorkspace(mobile,'memory',register.id,{...v,bookStatus:'confirmed',section:'convention',updatedAt:'2026-10-11T00:01:00.000Z'},'phone');
  state.mobileWorkspaceSync=mergeWorkspaces(state.mobileWorkspaceSync,mobile);applyPortableMemory(state,expected);
  const updated=getMemoriesByIds([row.id])[0];
  assert.equal(updated.metadata.bookStatus,'confirmed');assert.equal(updated.metadata.section,'convention');assert.equal(updated.namespace,'project:P');
  assert.equal(refreshPortableMemory(state).size,1);
  assert.equal(state.mobileWorkspaceSync.records.find(r=>r.kind==='memory').versions[0].value.section,'convention');
 } finally { _resetStoreForTests(); if(old===undefined)delete process.env.MELO_HOME;else process.env.MELO_HOME=old; rmSync(home,{recursive:true,force:true}); }
});
