import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { updateStateAtomically, loadState } from '../state/stateStore.js';
import { saveExecutionScene } from '../services/chat/executionScenes.js';
import { createExecutionScene } from '../shared/executionScene.js';

test('launch reset preserves live turns; paged and direct scene history include archived runs', {timeout:30000}, async t => {
  const home=await mkdtemp(join(tmpdir(),'melo-audit-http-'));
  let child,closed;
  t.after(async()=>{if(child){const kill=setTimeout(()=>child.kill('SIGKILL'),3000);child.kill('SIGTERM');await closed;clearTimeout(kill);}await rm(home,{recursive:true,force:true});});
  const runs=Array.from({length:65},(_,i)=>({runId:`run-${String(i).padStart(3,'0')}`,requestId:`q${i}`,chatId:'history',createdAt:new Date(i*1000).toISOString(),status:'completed'}));
  await updateStateAtomically(s=>{s.chats=[{id:'history',title:'History',messages:[]}];s.chatRuns=runs;},{home});
  await mkdir(join(home,'desktop','execution-scenes'),{recursive:true});
  for(const run of runs)await saveExecutionScene(home,{...createExecutionScene({runId:run.runId,chatId:run.chatId,query:run.runId,startedAt:run.createdAt}),status:'completed'});
  child=spawn(process.execPath,['src/server.js','--host','127.0.0.1','--port','0'],{env:{...process.env,MELO_HOME:home,MELO_TEST_MODE:'1',MELO_DREAMING_ENABLED:'0'},stdio:['ignore','pipe','pipe']});
  closed=once(child,'exit');
  const base=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(new Error(log.slice(-2000))),15000);child.stderr.on('data',b=>log+=b);child.stdout.on('data',b=>{log+=b;const m=log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});child.once('exit',()=>{clearTimeout(timer);reject(new Error(log.slice(-2000)));});});
  await updateStateAtomically(s=>{s.chatRuns.push({runId:'live',requestId:'live',chatId:'history',status:'running',createdAt:new Date().toISOString()});s.tasks=[{id:'task',title:'Live',status:'running',execution:{runId:'live',chatId:'history',status:'running'}}];},{home});
  assert.equal((await fetch(base+'/api/launch/reset')).status,200);
  const live=await loadState({home});
  assert.equal(live.tasks[0].status,'running');
  assert.equal(live.chatRuns.find(r=>r.runId==='live').status,'running');
  const seen=new Set();let cursor=null;let pages=0;
  do {
    const data=await(await fetch(base+'/api/chat/scenes?chatId=history'+(cursor?'&before='+cursor:''))).json();
    assert.ok(data.scenes.length<=20);
    for(const scene of data.scenes){assert.ok(!seen.has(scene.runId));seen.add(scene.runId);}
    cursor=data.nextCursor;pages++;
    assert.ok(pages<=5);
  } while(cursor);
  assert.equal(seen.size,65);
  const old=await(await fetch(base+'/api/chat/scenes?chatId=history&runId=run-000')).json();
  assert.equal(old.scenes[0].runId,'run-000');
  assert.ok(live.chatRuns.length<=51);
});
