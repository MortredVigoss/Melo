import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createSyncServer } from './fixtures/v1/server.js';
import { validateSnapshot as oldDecode } from './fixtures/v1/protocol.js';
import { putWorkspace as oldPut } from './fixtures/v1/workspaceProtocol.js';
import { refreshPortableWorkspace, applyPortableWorkspace } from '../src/services/chat/portableWorkspace.js';
import { mergeWorkspaces } from './workspaceProtocol.js';

test('frozen v1 HTTP server keeps old/new/old long personas, chats and offline conflicts across restart', async t => {
  const directory=await mkdtemp(join(tmpdir(),'melo-v1-persona-')),token='fixture-persona-token-'.repeat(3);
  let server,base;
  const start=async()=>{server=createSyncServer({token,directory});server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;};
  const stop=async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
  t.after(async()=>{await stop();await rm(directory,{recursive:true,force:true});});
  const exchange=async snapshot=>{const r=await fetch(base+'/v1/sync',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(snapshot)});assert.equal(r.status,200);return oldDecode(await r.json());};
  const date='2026-10-15T00:00:00Z',chat={id:'chat',title:'Still syncs',createdAt:date,updatedAt:date,messages:[]};
  const old={version:1,chats:[chat],workspace:{version:1,records:[]}};
  const persona={name:'Legacy',instructions:'a'.repeat(50000),identity:'b'.repeat(50000),soul:'c'.repeat(50000),systemPrompt:'d'.repeat(50000)};
  oldPut(old.workspace,'agent','legacy',persona,'oldPhone');oldPut(old.workspace,'project','project',{name:'Project',agentOverrides:{legacy:persona}},'oldPhone');
  await start();const received=await exchange(old);
  let state={agentProfiles:{},projects:[],artifacts:[],chats:[{...chat,agentId:'legacy'}],mobileWorkspaceDevice:'desktop'};
  applyPortableWorkspace(state,received.workspace);refreshPortableWorkspace(state);
  let round=await exchange({version:1,chats:state.chats,workspace:state.mobileWorkspaceSync});
  for(const row of old.workspace.records) assert.deepEqual(round.workspace.records.find(r=>r.kind===row.kind&&r.id===row.id),row);
  state.agentProfiles.legacy.instructions='new unsplittable '.repeat(4000);refreshPortableWorkspace(state);
  const offline=structuredClone(round);oldPut(offline.workspace,'agent','legacy',{...persona,instructions:'Remote changed'},'oldPhone');await exchange(offline);
  state=JSON.parse(JSON.stringify(state));await stop();await start();
  state.chats[0].messages.push({id:'new-message',role:'user',content:'Chat is independent',createdAt:date});
  round=await exchange({version:1,chats:state.chats,workspace:state.mobileWorkspaceSync});
  assert.equal(round.chats[0].messages[0].content,'Chat is independent');
  applyPortableWorkspace(state,mergeWorkspaces(state.mobileWorkspaceSync,round.workspace));
  assert.equal(state.agentProfiles.legacy.instructions,'new unsplittable '.repeat(4000));
  state.agentProfiles.legacy.instructions='Local revised';refreshPortableWorkspace(state);
  round=await exchange({version:1,chats:state.chats,workspace:state.mobileWorkspaceSync});
  assert.equal(round.workspace.records.find(r=>r.kind==='agent'&&r.id==='legacy').versions.length,2);
});

test('desktop HTTP persists pending persona and its original clock through a cold restart', {timeout:60000}, async t=>{
  const {spawn}=await import('node:child_process');
  const {readFile}=await import('node:fs/promises');
  const home=await mkdtemp(join(tmpdir(),'melo-persona-cold-')),token='fixture-cold-sync-token-'.repeat(3);
  const env={...process.env,MELO_HOME:home,MELO_SYNC_TOKEN:token,MELO_TEST_MODE:'1',MELO_DREAMING_ENABLED:'0',MELO_MEMORY_RUNTIME:'0'};
  let child,closed,base;
  async function stop(){if(!child)return;const timer=setTimeout(()=>child.kill('SIGKILL'),3000);child.kill('SIGTERM');await closed;clearTimeout(timer);child=null;}
  async function start(){child=spawn(process.execPath,['src/server.js','--host','127.0.0.1','--port','0'],{env,stdio:['ignore','pipe','pipe']});closed=once(child,'exit');base=await new Promise((resolve,reject)=>{let logs='';const timer=setTimeout(()=>reject(new Error(logs.slice(-2000))),15000);child.stderr.on('data',b=>logs+=b);child.stdout.on('data',b=>{logs+=b;const m=logs.match(/listening at (http:[/][/]127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});child.once('exit',()=>{clearTimeout(timer);reject(new Error(logs.slice(-2000)));});});}
  async function request(path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:body?JSON.stringify(body):undefined});assert.equal(r.status,200,await r.clone().text());return r.json();}
  t.after(async()=>{await stop();await rm(home,{recursive:true,force:true});});await start();
  const date='2026-10-15T00:00:00Z',incoming={version:1,chats:[{id:'long-chat',title:'Long',createdAt:date,updatedAt:date,messages:[{id:'message',role:'user',content:'Still here',createdAt:date}]}],workspace:{version:1,records:[]}};
  oldPut(incoming.workspace,'agent','legacy',{name:'Legacy',instructions:'a'.repeat(30000),identity:'b'.repeat(30000)},'oldPhone');
  oldPut(incoming.workspace,'conversation','long-chat',{agentId:'legacy'},'oldPhone');
  oldDecode(await request('/api/mobile-sync',incoming));await stop();await start();
  const before=oldDecode(await request('/api/mobile-sync'));
  assert.deepEqual(before.workspace.records.find(r=>r.kind==='agent'&&r.id==='legacy'),incoming.workspace.records[0]);
  const full='new full persona '.repeat(4000);
  await request('/api/agents/update',{agentId:'legacy',patch:{instructions:full}});
  const held=oldDecode(await request('/api/mobile-sync'));
  assert.equal(held.chats.find(c=>c.id==='long-chat').messages[0].content,'Still here');
  assert.ok((await request('/api/bootstrap')).syncPendingPersonas.some(r=>r.id==='legacy'));
  const incompleteExport=await fetch(base+'/api/settings/export');
  assert.notEqual(incompleteExport.status,200);
  assert.match(await incompleteExport.text(),/部分人设暂不能完整导出/);

  await stop();await start();
  const bootstrap=await request('/api/bootstrap');assert.equal(bootstrap.customize.agents.find(a=>a.id==='legacy').instructions,full);
  assert.ok(bootstrap.syncPendingPersonas.some(r=>r.id==='legacy'));
  const saved=JSON.parse(await readFile(join(home,'desktop/state.json'),'utf8'));
  assert.deepEqual(saved.mobilePersonaSyncHolds['agent:legacy'].base,before.workspace.records.find(r=>r.kind==='agent'&&r.id==='legacy'));
  const remote=structuredClone(before);oldPut(remote.workspace,'agent','legacy',{name:'Legacy',instructions:'Remote edit'},'oldPhone');
  await request('/api/mobile-sync',remote);
  assert.equal((await request('/api/bootstrap')).customize.agents.find(a=>a.id==='legacy').instructions,full);
  await request('/api/agents/update',{agentId:'legacy',patch:{instructions:'Local revised'}});
  const released=oldDecode(await request('/api/mobile-sync'));
  assert.equal(released.workspace.records.find(r=>r.kind==='agent'&&r.id==='legacy').versions.length,2);
});
