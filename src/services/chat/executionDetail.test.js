import test from 'node:test';
import assert from 'node:assert/strict';
import { observeModelReplies } from './executionPipeline.js';
import { createExecutionScene, applyExecutionEvent, moduleActivity, finishExecutionScene } from '../../shared/executionScene.js';
import { observeTool } from '../../tools/executionObservation.js';
import { readCodexSseResponse } from '../../providers/streams.js';
import { renderExecutionDetail } from '../../../desktop-ui/executionDetails.js';

test('each model round retains public summaries, never raw reasoning; cancellation closes it', async () => {
  const scene = createExecutionScene({runId:'summaries'});
  const call = observeModelReplies(async o => {
    await o.onReasoningDelta({eventType:'response.reasoning_text.delta', text:'PRIVATE'});
    await o.onReasoningDelta({eventType:'response.reasoning_summary_text.delta',text:'核对条件'});
    if(o.signal?.aborted) throw Object.assign(new Error('stop'), {name:'AbortError'});
    return 'answer';
  },(_,e)=>applyExecutionEvent(scene,e));
  await call({model:'first'}); await call({model:'second'});
  await assert.rejects(call({signal:AbortSignal.abort()}));
  assert.equal(moduleActivity(scene,'compute').operations.length,3);
  assert.equal(moduleActivity(scene,'tools').operations.length,0);
  assert.equal(scene.pipeline.at(-1).status,'cancelled');
  assert.doesNotMatch(JSON.stringify(scene),/PRIVATE/);
  finishExecutionScene(scene); assert.equal(moduleActivity(scene,'compute').running.length,0);
});
test('completed-only response recovers explicit summary, raw reasoning event is ignored', async () => {
  const chunks=[];
  const events=[{type:'response.reasoning_text.delta',delta:'PRIVATE'}, {type:'response.completed',response:{output:[{type:'reasoning',summary:[{type:'summary_text',text:'公开概述'}]},{type:'message',content:[{type:'output_text',text:'done'}]}]}}];
  await readCodexSseResponse(new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')), {onReasoningDelta:c=>chunks.push(c)});
  assert.deepEqual(chunks.map(c=>c.text),['公开概述']);
});
test('only applied edits get a difference, checks retain command and actual exit code with escaped output',()=>{
  const args={path:'a.js',old_string:'secret',new_string:'new'};
  assert.equal(observeTool({id:'a',name:'file_edit',args,status:'waiting'}).change,undefined);
  const op=observeTool({id:'a',name:'file_edit',args,result:{ok:true,meta:{change:{path:'a.js',kind:'replacement',before:'<script>',after:'const n=2'}}}});
  const html=renderExecutionDetail(op,'已完成'); assert.match(html,/&lt;script&gt;/); assert.doesNotMatch(html,/<script>/);
  const check=observeTool({id:'b',name:'bash',args:{command:'npm test'},result:{ok:false,output:'2 tests failed',meta:{exitCode:1}}});
  assert.equal(check.status,'failed'); assert.equal(check.exitCode,1); assert.equal(check.verification,'实际检查命令');
  assert.match(renderExecutionDetail(check,'失败'),/退出码 1/);
});
