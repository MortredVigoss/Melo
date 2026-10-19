import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {projectMemoryPayload,projectMemoryEnvelope} from '../../mobile-sync/projectMemoryProtocol.js';
import {putWorkspace} from '../../mobile-sync/workspaceProtocol.js';

test('project book edits cross the real desktop sync route and survive cold restart', {timeout:90000}, async t=>{
  const home=await mkdtemp(join(tmpdir(),'melo-project-memory-http-')),token='project-memory-fixture-'.repeat(3);
  const env={...process.env,MELO_HOME:home,MELO_SYNC_TOKEN:token,MELO_TEST_MODE:'1',MELO_DREAMING_ENABLED:'0',MELO_MEMORY_RUNTIME:'0'};
  let child,closed,base;
  async function stop(){if(!child)return;const timer=setTimeout(()=>child.kill('SIGKILL'),3000);child.kill('SIGTERM');await closed;clearTimeout(timer);child=null;}
  async function start(){
    child=spawn(process.execPath,['src/server.js','--host','127.0.0.1','--port','0'],{env,stdio:['ignore','pipe','pipe']});closed=once(child,'exit');
    base=await new Promise((resolve,reject)=>{
      let logs='';const timer=setTimeout(()=>reject(new Error(logs.slice(-2000))),30000);
      child.stderr.on('data',b=>logs+=b);
      child.stdout.on('data',b=>{logs+=b;const m=logs.match(/listening at (http:[/][/]127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error(logs.slice(-2000)));});
    });
  }
  async function request(path,body){
    const r=await fetch(base+path,{method:body?'POST':'GET',headers:{origin:base,'content-type':'application/json',authorization:`Bearer ${token}`},body:body?JSON.stringify(body):undefined});
    assert.equal(r.status,200,await r.clone().text());return r.json();
  }
  t.after(async()=>{await stop();await rm(home,{recursive:true,force:true});});await start();
  assert.equal((await fetch(base+'/api/project-memory-sync')).status,401);
  const created=await request('/api/projects',{name:'Memory parity fixture'});
  const project=created.projects.find(p=>p.name==='Memory parity fixture');assert.ok(project);
  await request('/api/projects/memory-book',{projectId:project.id,text:'Keep compatibility',section:'convention'});
  const wire=await request('/api/project-memory-sync');assert.equal(wire.records.length,1);
  const row=wire.records[0],value=projectMemoryPayload(row.versions[0].value);
  assert.equal(value.chatId,'');assert.equal(value.origin,'project');
  putWorkspace(wire,'knowledge',row.id,projectMemoryEnvelope({...value,text:'Keep accounts and compatibility',updatedAt:'2099-01-01T00:00:00Z'}),'phone');
  const saved=await request('/api/project-memory-sync',wire);
  assert.equal(projectMemoryPayload(saved.records[0].versions[0].value).text,'Keep accounts and compatibility');
  const legacy=await request('/api/mobile-sync');assert.ok(!legacy.workspace.records.some(r=>r.kind==='memory'&&r.id===row.id));
  await stop();await start();
  const restored=await request('/api/project-memory-sync');assert.deepEqual(restored,saved);
  const book=await request('/api/projects/memory-book?projectId='+encodeURIComponent(project.id));
  assert.match(JSON.stringify(book),/Keep accounts and compatibility/);
});
