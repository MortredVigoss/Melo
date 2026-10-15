import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {executeTool} from '../testSupport/directAgentFixture.js';
import { updateStateAtomically } from '../state/stateStore.js';
import { createRequestContext } from '../runtime/requestContext.js';

test('turn-bound tool calls do not wait behind the full-state write queue', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-bound-tool-'));
  let release, entered;
  const gate = new Promise(r => { release = r; });
  const ready = new Promise(r => { entered = r; });
  t.after(async () => { release(); await locked; await rm(home, {recursive:true,force:true}); });
  const locked = updateStateAtomically(async () => { entered(); await gate; }, { home });
  await ready;
  const context = Object.freeze({ ...createRequestContext({ home, chatId:'chat',requestId:'turn' }), turnBinding:{role:'custom',project:null,taskId:null} });
  const result = await Promise.race([
    executeTool({id:'read-probe',requiresPermission:false,run:async (_, {requestContext}) => ({ok:true,output:requestContext.permissionScope.role})}, {}, { requestContext:context }),
    new Promise((_, reject) => { const timer=setTimeout(()=>reject(new Error('tool waited for state lock')),500);timer.unref(); }),
  ]);
  assert.equal(result.output,'custom');
  release(); await locked;
});

test('task repair runs observe changed files and can rebuild after a known failure', async t => {
  const {writeFile} = await import('node:fs/promises');
  const {bashTool} = await import('./builtins/bashTool.js');
  const {resolveFileSafety} = await import('../safety/fileSafetyGate.js');
  const home = await mkdtemp(join(tmpdir(), 'melo-task-rebuild-'));
  t.after(() => rm(home,{recursive:true,force:true}));
  await writeFile(join(home,'package.json'),JSON.stringify({scripts:{build:'cat generated.txt'}}));
  const requestContext=Object.freeze({...createRequestContext({home,chatId:'chat',requestId:'turn'}),turnBinding:{role:'main',project:null,taskId:'task'}});
  const run = toolCallId => executeTool(bashTool,{command:'npm run build'}, {requestContext,workspacePath:home,toolCallId,
    sseEmitter:(event,payload)=>{if(event==='tool_permission')resolveFileSafety(payload.requestId,'once');}});
  const failed = await run('first');
  assert.equal(failed.ok,false);
  assert.ok(Number.isInteger(failed.meta.exitCode));
  await writeFile(join(home,'generated.txt'),'fresh output');
  const repaired=await run('second');
  assert.equal(repaired.ok,true);
  assert.match(repaired.output,/fresh output/);
  await writeFile(join(home,'generated.txt'),'newer output');
  assert.match((await run('third')).output,/newer output/);
  assert.equal((await run('third')).meta.replayed,true);
});
