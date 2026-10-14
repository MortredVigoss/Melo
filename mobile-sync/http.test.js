import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
test('desktop HTTP sync requires authentication and persists imported phone messages through restart', { timeout: 45000 }, async t => {
 const home = await mkdtemp(join(tmpdir(),'melo-mobile-http-'));
 await mkdir(join(home,'desktop'),{recursive:true});
 await writeFile(join(home,'desktop/state.json'),JSON.stringify({chats:[{id:'desktop-test',title:'Desktop',messages:[{id:'reminder:legacy',role:'assistant',content:'Reminder received',createdAt:'2026-10-06T12:00:00.000Z'}]}]}));
 const token='integration-test-token-'.repeat(3);
 let child, closed;
 async function stop() { if (!child) return; child.kill('SIGTERM'); const kill=setTimeout(()=>child?.kill('SIGKILL'),5000); await closed; clearTimeout(kill); child=null; }
 async function start() {
  child=spawn(process.execPath,['src/server.js','--host','127.0.0.1','--port','0'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,MELO_HOME:home,MELO_SYNC_TOKEN:token,MELO_TEST_MODE:'1',MELO_DREAMING_ENABLED:'0'},stdio:['ignore','pipe','pipe']});
  closed=once(child,'exit');
  return new Promise((resolve,reject)=>{
   let log=''; const timeout=setTimeout(()=>reject(new Error('Server startup timeout: '+log.slice(-500))),15000);
   child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Server exited: '+log.slice(-500)));});
   child.stderr.on('data',chunk=>{log+=chunk;});
   child.stdout.on('data',chunk=>{log+=chunk;const match=log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});
  });
 }
 t.after(async()=>{await stop();await rm(home,{recursive:true,force:true});});
 let base=await start();
 assert.equal((await fetch(base+'/api/mobile-sync')).status,401);
 const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
 const stamp='2026-10-06T12:00:00.000Z';
 const body={version:1,chats:[{id:'phone-test',title:'Phone',createdAt:stamp,updatedAt:stamp,messages:[{id:'phone-message',role:'user',content:'Hello from phone',createdAt:stamp}]}]};
 const response=await fetch(base+'/api/mobile-sync',{method:'POST',headers,body:JSON.stringify(body)});
 assert.equal(response.status,200);
 assert.equal((await response.json()).chats.find(chat=>chat.id==='phone-test').messages.length,1);
 const blocked=await fetch(base+'/api/mobile-sync',{method:'POST',headers:{...headers,origin:'https://attacker.invalid'},body:JSON.stringify(body)});
 assert.equal(blocked.status,403);
 await stop();base=await start();
 const after=await(await fetch(base+'/api/mobile-sync',{headers})).json();
 assert.equal(after.chats.find(chat=>chat.id==='phone-test').messages[0].content,'Hello from phone');
 assert.equal(after.chats.find(chat=>chat.id==='desktop-test').messages[0].id,'reminder:legacy');
 assert.ok(after.workspace.records.some(row=>row.id==='reminder:legacy'));
 const deletion=await fetch(base+'/api/chats/delete',{method:'POST',headers,body:JSON.stringify({chatId:'phone-test'})});
 assert.equal(deletion.status,200,await deletion.clone().text());
 await stop();base=await start();
 const stale=await fetch(base+'/api/mobile-sync',{method:'POST',headers,body:JSON.stringify(body)});
 assert.equal(stale.status,200);
 const updated=await stale.json();
 assert.ok(!updated.chats.some(chat=>chat.id==='phone-test'));
 assert.ok(updated.deletedChats.some(row=>row.id==='phone-test'));
 const fromPhone=await fetch(base+'/api/mobile-sync',{method:'POST',headers,body:JSON.stringify({version:1,chats:[],deletedChats:[{id:'desktop-test',deletedAt:stamp}]})});
 assert.equal(fromPhone.status,200);
 assert.equal((await fromPhone.json()).chats.length,0);
 const oversized=await fetch(base+'/api/mobile-sync',{method:'POST',headers,body:JSON.stringify({version:1,chats:[],padding:'x'.repeat(8*1024*1024)})});
 assert.equal(oversized.status,413,await oversized.clone().text());
 const unchanged=await(await fetch(base+'/api/mobile-sync',{headers})).json();
 assert.equal(unchanged.chats.length,0);assert.equal(unchanged.deletedChats.length,2);
});
