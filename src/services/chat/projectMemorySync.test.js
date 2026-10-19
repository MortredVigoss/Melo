import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createUserBookRow} from '../../memory/projectBook.js';
import {_resetStoreForTests,getMemoriesByIds,upsertMemory,withMemoryHome} from '../../memory/store.js';
import {refreshProjectMemory,stageProjectMemory,replayProjectMemory,projectMemoryFor} from './projectMemorySync.js';
import {refreshPortableMemory} from './portableMemory.js';
import {projectMemoryPayload,projectMemoryEnvelope,validateProjectMemory} from '../../../mobile-sync/projectMemoryProtocol.js';
import {putWorkspace,stableJSON,resolveWorkspace} from '../../../mobile-sync/workspaceProtocol.js';
import {createSyncServer} from '../../../mobile-sync/server.js';

async function isolated(fn) {
  const home=mkdtempSync(join(tmpdir(),'melo-project-origin-')), old=process.env.MELO_HOME;
  process.env.MELO_HOME=home;_resetStoreForTests();
  try{await fn(home);}finally{_resetStoreForTests();if(old===undefined)delete process.env.MELO_HOME;else process.env.MELO_HOME=old;rmSync(home,{recursive:true,force:true});}
}
function state(){return {chats:[],projects:[{id:'P',name:'Project'}],mobileWorkspaceDevice:'desktop',mobileWorkspaceSync:{version:1,records:[]}};}
function edit(workspace,patch){const phone=structuredClone(workspace),row=phone.records[0],v=projectMemoryPayload(row.versions[0].value);putWorkspace(phone,'knowledge',row.id,projectMemoryEnvelope({...v,...patch}),'phone');return phone;}

test('A7: project-origin facts round trip without a fake chat, retain scopes and do not change v1',()=>isolated(()=>{
  const s=state(),row=createUserBookRow({projectId:'P',text:'Keep the API compatible',section:'convention'});
  assert.equal(refreshPortableMemory(s).size,0,'old v1 remains compatible');
  assert.equal(refreshProjectMemory(s).size,1);
  const initial=stableJSON(s.projectMemorySync),v=projectMemoryPayload(s.projectMemorySync.records[0].versions[0].value);
  assert.equal(v.origin,'project');assert.equal(v.chatId,'');
  refreshProjectMemory(s);assert.equal(stableJSON(s.projectMemorySync),initial);
  stageProjectMemory(s,edit(s.projectMemorySync,{text:'Keep API and files compatible',updatedAt:'2099-01-01T00:00:00Z'}));
  assert.equal(getMemoriesByIds([row.id])[0].text,row.text,'durable journal before DB mutation');
  replayProjectMemory(s);replayProjectMemory(s);
  let saved=getMemoriesByIds([row.id])[0];
  assert.equal(saved.text,'Keep API and files compatible');assert.equal(saved.metadata.origin,'project');assert.equal(saved.metadata.chatId,null);
  const stable=stableJSON(s.projectMemorySync);refreshProjectMemory(s);assert.equal(stableJSON(s.projectMemorySync),stable,'no re-encoding ping-pong');
  stageProjectMemory(s,edit(s.projectMemorySync,{status:'forgotten',updatedAt:'2099-01-02T00:00:00Z'}));replayProjectMemory(s);
  saved=getMemoriesByIds([row.id])[0];assert.equal(saved.metadata.forgotten,true);
  assert.equal(s.chats.length,0);assert.equal(s.mobileWorkspaceSync.records.length,0);
}));

test('A7: crash recovery preserves a concurrent edit and explicit version resolution',()=>isolated(()=>{
  const s=state(),row=createUserBookRow({projectId:'P',text:'original',section:'decision'});refreshProjectMemory(s);
  stageProjectMemory(s,edit(s.projectMemorySync,{text:'phone',updatedAt:'2099-01-01T00:00:00Z'}));
  upsertMemory({...row,text:'desktop during journal',updatedAt:'2099-01-02T00:00:00Z'});
  replayProjectMemory(s);
  assert.equal(s.projectMemorySync.records[0].versions.length,2);
  refreshProjectMemory(s);assert.equal(s.projectMemorySync.records[0].versions.length,2);
  const register=s.projectMemorySync.records[0], index=register.versions.findIndex(v=>projectMemoryPayload(v.value).text==='phone');
  stageProjectMemory(s,resolveWorkspace(s.projectMemorySync,'knowledge',register.id,index,'desktop'));replayProjectMemory(s);
  assert.equal(s.projectMemorySync.records[0].versions.length,1);
}));

test('A7: rejects forged origin; unavailable project does not recreate a memory',()=>isolated(()=>{
  const s=state(),row=createUserBookRow({projectId:'P',text:'manual',section:'goal'});refreshProjectMemory(s);
  assert.throws(()=>validateProjectMemory(edit(s.projectMemorySync,{chatId:'invented'})));
  assert.throws(()=>validateProjectMemory(edit(s.projectMemorySync,{scope:'chat'})));
  assert.throws(()=>stageProjectMemory(s,edit(s.projectMemorySync,{projectId:'other'})));
  s.projects=[];stageProjectMemory(s,edit(s.projectMemorySync,{text:'late'}));replayProjectMemory(s);
  assert.equal(getMemoriesByIds([row.id])[0].text,'manual');
}));

test('A7: standalone relay keeps extension and legacy chat stores separate',()=>isolated(async home=>{
  const s=state();createUserBookRow({projectId:'P',text:'shared rule',section:'convention'});refreshProjectMemory(s);
  const server=createSyncServer({token:'t'.repeat(32),directory:join(home,'relay')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const post=(path,value,token='t'.repeat(32))=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(value)});
  try {
    assert.equal((await post('/v1/project-memory',s.projectMemorySync,'bad')).status,401);
    assert.equal((await post('/v1/project-memory',s.projectMemorySync)).status,200);
    const legacy=await (await post('/v1/sync',{version:1,chats:[]})).json();assert.deepEqual(legacy.chats,[]);assert.equal(legacy.workspace,undefined);
    const restored=await (await post('/v1/project-memory',{version:1,records:[]})).json();assert.equal(restored.records.length,1);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}));


test('A7: captured home survives an async boundary and restores the prior memory connection',()=>isolated(async home=>{
  const other=mkdtempSync(join(tmpdir(),'melo-project-other-'));
  try {
    const s=state(),bound=projectMemoryFor(home);
    const original=createUserBookRow({projectId:'P',text:'A only',section:'goal'});
    const otherRow=withMemoryHome(other,()=>createUserBookRow({projectId:'P',text:'B only',section:'goal'}));
    await Promise.resolve();process.env.MELO_HOME=other;
    bound.refresh(s);
    assert.deepEqual(s.projectMemorySync.records.map(r=>projectMemoryPayload(r.versions[0].value).text),['A only']);
    bound.stage(s,edit(s.projectMemorySync,{text:'A updated',updatedAt:'2099-01-01T00:00:00Z'}));bound.replay(s);
    assert.equal(getMemoriesByIds([original.id])[0].text,'A updated','previous A handle restored');
    assert.equal(withMemoryHome(other,()=>getMemoriesByIds([otherRow.id])[0].text),'B only');
    assert.throws(()=>withMemoryHome(other,()=>{throw new Error('expected');}),/expected/);
    assert.equal(getMemoriesByIds([original.id])[0].text,'A updated','restores even on failure');
  } finally {process.env.MELO_HOME=home;rmSync(other,{recursive:true,force:true});}
}));
