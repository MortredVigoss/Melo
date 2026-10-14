import test from 'node:test';
import assert from 'node:assert/strict';
import { exportMobileSnapshot, importMobileSnapshot } from '../src/http/mobileSyncRoutes.js';
import { refreshPortableWorkspace } from '../src/services/chat/portableWorkspace.js';
import { mergeSnapshots, validateSnapshot, requireDeletionAcknowledgement } from './protocol.js';
import { createReminderDelivery } from '../src/reminders/delivery.js';
import { recoverTaskRuns } from '../src/services/task/taskRunLifecycle.js';
import { hydrateState } from '../src/state/stateHydration.js';

const date='2026-10-10T01:00:00.000Z';
const chat=()=>({id:'chat',title:'Test',createdAt:date,updatedAt:date,messages:[{id:'m',role:'user',content:'hello',createdAt:date}]});
const state=()=>({chats:[chat()]});
test('legacy reminder IDs survive text and workspace round trips without rewriting identity',()=>{
 const source=state();source.chats[0].messages.push({id:'reminder:old-id',role:'assistant',content:'提醒',createdAt:date});
 refreshPortableWorkspace(source);
 const snapshot=exportMobileSnapshot(source,{workspace:true});
 importMobileSnapshot(source,snapshot);
 assert.equal(source.chats[0].messages.length,2);
 assert.equal(snapshot.chats[0].messages[1].id,'reminder:old-id');
 assert.ok(snapshot.workspace.records.some(r=>r.id==='reminder:old-id'));
});
test('new reminder IDs are portable and retries of legacy delivery stay idempotent',async()=>{
 const source=state();const delivery=createReminderDelivery({update:async fn=>fn(source)});
 await delivery({id:'new-id',chatId:'chat',text:'water'});
 assert.equal(source.chats[0].messages[1].id,'reminder_new-id');
 source.chats[0].messages[1].id='reminder:new-id';
 await delivery({id:'new-id',chatId:'chat',text:'water'});
 assert.equal(source.chats[0].messages.length,2);
});
test('deletion survives stale desktop/phone uploads, server restart snapshots, and hydration',()=>{
 const old={version:1,chats:[chat()]};
 const deleted={version:1,chats:[],deletedChats:[{id:'chat',deletedAt:date}]};
 for(const [a,b] of [[old,deleted],[deleted,old]]) {
   const first=mergeSnapshots(a,b);
   assert.deepEqual(first.chats,[]);
   assert.deepEqual(first.deletedChats,deleted.deletedChats);
   assert.deepEqual(mergeSnapshots(JSON.parse(JSON.stringify(first)),old),first);
 }
 const local=hydrateState({...state(),mobileDeletedChats:deleted.deletedChats});
 importMobileSnapshot(local,old);
 assert.equal(local.chats.length,0);
 assert.deepEqual(exportMobileSnapshot(local).deletedChats,deleted.deletedChats);
});
test('mobile deletion never removes an external channel with the same ID',()=>{
 const source=state();source.chats[0].externalThreadKey='telegram:agent:1';
 assert.throws(()=>importMobileSnapshot(source,{version:1,chats:[],deletedChats:[{id:'chat',deletedAt:date}]}));
 assert.equal(source.chats.length,1);
});
test('501 conversations and a 200001 character message sync intact; missing dates use stable fallback',()=>{
 const source={chats:Array.from({length:501},(_,i)=>({...chat(),id:`chat_${i}`}))};
 source.chats[0].messages[0].content='长'.repeat(200001);
 delete source.chats[0].messages[0].createdAt;
 const snapshot=exportMobileSnapshot(source);
 assert.equal(snapshot.chats.length,501);
 assert.equal(snapshot.chats[0].messages[0].content.length,200001);
 assert.equal(snapshot.chats[0].messages[0].createdAt,date);
 assert.deepEqual(mergeSnapshots(snapshot,snapshot).chats.length,501);
 assert.equal(source.chats[0].messages[0].createdAt,undefined);
});
test('deleted content cannot cause an immutable-message conflict or revive workspace rows',()=>{
 const left={version:1,chats:[chat()]};const source=state();refreshPortableWorkspace(source);
 const right={...exportMobileSnapshot(source,{workspace:true}),deletedChats:[{id:'chat',deletedAt:date}]};
 right.chats[0].messages[0].content='stale changed content';
 const merged=mergeSnapshots(left,right);
 assert.equal(merged.chats.length,0);
 assert.ok(!merged.workspace.records.some(r=>r.kind==='conversation'&&r.id==='chat'));
});
test('invalid deletion dates/IDs and arbitrary message colon IDs remain rejected',()=>{
 for(const row of [{id:'../escape',deletedAt:date},{id:'chat',deletedAt:'bad'}])assert.throws(()=>validateSnapshot({version:1,chats:[],deletedChats:[row]}));
 const c=chat();c.messages[0].id='arbitrary:unsafe';assert.throws(()=>validateSnapshot({version:1,chats:[c]}));
});
test('relay refuses an old service that silently strips a deletion',()=>{
 const sent={version:1,chats:[],deletedChats:[{id:'chat',deletedAt:date}]};
 assert.throws(()=>requireDeletionAcknowledgement(sent,{version:1,chats:[]}),/acknowledge/);
 requireDeletionAcknowledgement(sent,sent);
});
test('workspace context count uses the same byte capacity, not a second hidden row limit',()=>{
 const workspace={version:1,records:Array.from({length:12001},(_,i)=>({kind:'conversation',id:`c${i}`,versions:[{clock:{desktop:1},value:{agentId:'main'}}]}))};
 const result=validateSnapshot({version:1,chats:[],workspace});
 assert.equal(result.workspace.records.length,12001);
 assert.ok(Buffer.byteLength(JSON.stringify(result))<8*1024*1024);
});
test('recovering a running task without a run ID advances its checkpoint once',()=>{
 const task={id:'task',status:'running',syncRevision:3,updatedAt:date};const source={tasks:[task]};
 recoverTaskRuns(source);
 assert.equal(task.status,'blocked');assert.equal(task.syncRevision,4);assert.notEqual(task.updatedAt,date);
 recoverTaskRuns(source);assert.equal(task.syncRevision,4);
});
