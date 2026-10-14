import test from 'node:test';
import assert from 'node:assert/strict';
import { startBackgroundRuntime } from './backgroundStartup.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
test('cold optional runtime does not block readiness and cannot start after shutdown',async t=>{
  let finish, started=0, notified=0, stopped=0;
  const pending=new Promise(resolve=>{finish=resolve;});
  const handle=startBackgroundRuntime(()=>{started++;return pending;},{onReady:()=>notified++});
  assert.equal(started,0);
  const server=createServer((_,response)=>response.end('ready'));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}`)).text(),'ready');
  assert.equal(started,1);assert.equal(notified,0);
  handle.stop();finish({stop:()=>stopped++});await handle.ready;
  assert.equal(notified,0);assert.equal(stopped,1);
});
test('ready runtime stops and a failed warm-up reports the failure without throwing',async()=>{
  let stopped=0,ready=0,error;
  const handle=startBackgroundRuntime(()=>({stop:()=>stopped++}),{onReady:()=>ready++});
  await handle.ready;handle.stop();assert.equal(stopped,1);assert.equal(ready,1);
  await startBackgroundRuntime(()=>{throw Error('fixture');},{onError:e=>{error=e;}}).ready;
  assert.equal(error.message,'fixture');
});
