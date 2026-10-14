import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {putWorkspace} from './workspaceProtocol.js';
import {createHash} from 'node:crypto';

test('context sync persists across restart, retains conflicts, and replays sources without rerunning tasks', {timeout:45000}, async t=>{
 const home=await mkdtemp(join(tmpdir(),'melo-sync-contract-')),token='fixture-sync-token-'.repeat(3);
 let child,closed,base;
 async function stop(){if(!child)return;const timer=setTimeout(()=>child.kill('SIGKILL'),3000);child.kill('SIGTERM');await closed;clearTimeout(timer);child=null;}
 t.after(async()=>{await stop();await rm(home,{recursive:true,force:true});});
 async function start(){child=spawn(process.execPath,['src/server.js','--host','127.0.0.1','--port','0'],{env:{...process.env,MELO_HOME:home,MELO_SYNC_TOKEN:token,MELO_TEST_MODE:'1',MELO_DREAMING_ENABLED:'0'},stdio:['ignore','pipe','pipe']});closed=once(child,'exit');return new Promise((resolve,reject)=>{let logs='';const timer=setTimeout(()=>reject(new Error(logs.slice(-2000))),15000);child.stderr.on('data',b=>logs+=b);child.stdout.on('data',b=>{logs+=b;const m=logs.match(/listening at (http:[/][/]127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});child.once('exit',()=>{clearTimeout(timer);reject(new Error(logs.slice(-2000)));});});}
 base=await start();
 async function request(path,body,auth=true){return fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});}
 assert.equal((await request('/api/mobile-sync',null,false)).status,401);
 const initial=await(await request('/api/mobile-sync')).json();assert.equal(initial.workspace.version,1);
 const date='2026-10-09T01:00:00.000Z',incoming={version:1,chats:[{id:'phone-chat',title:'phone',createdAt:date,updatedAt:date,messages:[{id:'phone-message',role:'assistant',content:'reference',createdAt:date}]}],workspace:{version:1,records:[]}};
 putWorkspace(incoming.workspace,'agent','phone-role',{name:'Phone role',instructions:'Be concise',identity:'',soul:''},'phone');
 putWorkspace(incoming.workspace,'conversation','phone-chat',{agentId:'phone-role',knowledgeIds:['note']},'phone');
 putWorkspace(incoming.workspace,'knowledge','note',{title:'Note',content:'mobile context'},'phone');
 const memoryID='promoted:http-fixture',memoryKey='memory_'+createHash('sha256').update(memoryID).digest('hex');
 putWorkspace(incoming.workspace,'memory',memoryKey,{id:memoryKey,memoryID,text:'User prefers tea',originalFact:'User prefers tea',scope:'chat',status:'active',chatId:'phone-chat',messageId:'',projectId:'',agentId:'phone-role',sourceText:'I prefer tea',category:'user_preference',updatedAt:date,userEdited:false},'phone');
 putWorkspace(incoming.workspace,'message','phone-message',{chatId:'phone-chat',models:[{requestedModel:'chosen',reportedModel:'actual'}],scene:{runId:'remote-run',status:'completed',sources:[{url:'https://example.org/ref',title:'Used source',appeared:true,cited:true,accessed:true,reading:'partial'}]}},'phone');
 const imported=await request('/api/mobile-sync',incoming);assert.equal(imported.status,200,await imported.clone().text());
 let scene=await(await request('/api/chat/scenes?chatId=phone-chat')).json();assert.equal(scene.scenes[0].sources[0].cited,true);assert.equal(scene.scenes[0].status,'completed');
 await stop();base=await start();
 const after=await(await request('/api/mobile-sync')).json();const role=after.workspace.records.find(r=>r.kind==='agent'&&r.id==='phone-role');assert.equal(role.versions[0].value.identity,'');assert.equal(role.versions[0].value.instructions,'Be concise');
 const memory=after.workspace.records.find(r=>r.kind==='memory'&&r.id===memoryKey);assert.equal(memory.versions[0].value.text,'User prefers tea');
 const paused=structuredClone(after);putWorkspace(paused.workspace,'memory',memoryKey,{...memory.versions[0].value,status:'forgotten',userEdited:true,updatedAt:'2026-10-09T02:00:00.000Z'},'phone');
 assert.equal((await request('/api/mobile-sync',paused)).status,200);
 await stop();base=await start();
 const restarted=await(await request('/api/mobile-sync')).json();assert.equal(restarted.workspace.records.find(r=>r.id===memoryKey).versions[0].value.status,'forgotten','restart must replay before legacy extraction can restore a forgotten memory');
 const note=after.workspace.records.find(r=>r.kind==='knowledge'&&r.id==='note');const changed=structuredClone(note);changed.versions=[{clock:{other:1},value:{...note.versions[0].value,content:'other edit'}}];
 const conflict=await(await request('/api/mobile-sync',{version:1,chats:[],workspace:{version:1,records:[changed]}})).json();const row=conflict.workspace.records.find(r=>r.id==='note');assert.equal(row.versions.length,2);
 const body={kind:'knowledge',id:'note',index:0,expected:row.versions[0]};const resolved=await request('/api/mobile-sync/resolve',body);assert.equal(resolved.status,200);assert.equal((await request('/api/mobile-sync/resolve',body)).status,409);
 const legacy=await(await request('/api/mobile-sync',{version:1,chats:[]})).json();assert.ok(legacy.workspace.records.some(r=>r.id==='phone-role'));
 const saved=JSON.parse(await readFile(join(home,'desktop/state.json'),'utf8'));const chat=saved.chats.find(c=>c.id==='phone-chat');assert.equal(chat.agentId,'phone-role');assert.equal(legacy.chats.find(c=>c.id==='phone-chat').messages.length,1);assert.equal(legacy.workspace.records.find(r=>r.kind==='message'&&r.id==='phone-message').versions[0].value.models[0].reportedModel,'actual');
});
