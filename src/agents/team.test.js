import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTeamPlan} from './team.js';
import {runAgentTeam} from '../testSupport/directAgentFixture.js';
import { summarizeUsage } from '../runtime/usage.js';
test('bounded concurrency, isolated role failures and reported cost',async()=>{
  let running=0, peak=0;const order=[];
  const team=await runAgentTeam({plan:{roles:['research','scout','reviewer'],concurrency:99},task:'fixture',config:{model:'fixture',modelPricing:{fixture:{input:1,output:2,cached:0.5,cacheWrite:1}}},run:async({roleId,onProviderResponse,instructions})=>{
    running++;peak=Math.max(peak,running);order.push([roleId,running,instructions]); await new Promise(r=>setTimeout(r,10));running--;
    onProviderResponse({requestedModel:'fixture',usage:{input:100,output:20,cached:0,cacheWrite:0}});
    if(roleId==='scout') throw new Error('fixture failure'); return {ok:true,output:'evidence'};
  }});
  // Two researchers overlap; the reviewer starts alone, after both, with their handoffs.
  assert.equal(peak,2);assert.equal(order[2][0],'reviewer');assert.equal(order[2][1],1);assert.match(order[2][2],/evidence/);assert.match(order[2][2],/fixture failure/);
  assert.equal(team.ok,false);assert.equal(team.results[0].ok,true);assert.match(team.results[1].output,/fixture failure/);assert.ok(team.usage.estimatedCost>0);
});
test('cancellation stops queued roles and reaches running child',async()=>{
  const controller=new AbortController();let invoked=0;
  const team=await runAgentTeam({plan:{roles:['research','builder','reviewer'],concurrency:2},task:'fixture',config:{},signal:controller.signal,run:async({signal})=>{invoked++;controller.abort();assert.equal(signal.aborted,true);throw new Error('aborted');}});
  assert.equal(invoked,1);assert.equal(team.results.length,3);assert.ok(team.results.every(r=>r.cancelled));assert.equal(validateTeamPlan({roles:['builder','reviewer'],concurrency:2}).concurrency,1);
});
test('unknown usage or unknown prices never become zero cost',()=>{
 assert.equal(summarizeUsage([{}],{input:1,output:2,cached:0,cacheWrite:0}).estimatedCost,null);
 assert.equal(summarizeUsage([{usage:{input:1,output:2,cached:0,cacheWrite:0}}]).estimatedCost,null);
});
test('concurrent reading roles cannot inherit mutation tools or expand the parent whitelist', async () => {
  const allowed = ['file_read', 'bash', 'file_write', 'browser_click'];
  const seen = {};
  await runAgentTeam({plan:{roles:['research','builder','reviewer']},task:'fixture',config:{},allowedToolIds:allowed,
    run:async ({roleId,allowedToolIds}) => { seen[roleId] = allowedToolIds; return {ok:true,output:'checked'}; }});
  assert.deepEqual(seen.research,['file_read']);
  assert.deepEqual(seen.reviewer,['file_read']);
  assert.deepEqual(seen.builder,allowed);
  await runAgentTeam({plan:{roles:['research']},task:'fixture',config:{},allowedToolIds:[],
    run:async ({allowedToolIds}) => { assert.deepEqual(allowedToolIds,[]); return {ok:true,output:'checked'}; }});
});

test('serial team roles inherit one bound connection despite changing process defaults',async()=>{
 const previous=process.env.MELO_MODEL;const seen=[];
 try {
  const result=await runAgentTeam({plan:{roles:['builder','reviewer']},task:'fixture',config:{model:'selected-role-model',apiKey:'bound',modelResolvedForTurn:true},run:async({config})=>{
   seen.push(config.model);process.env.MELO_MODEL='other-request-model';assert.equal(config.apiKey,'bound');return {ok:true,output:'done'};
  }});assert.equal(result.ok,true);assert.deepEqual(seen,['selected-role-model','selected-role-model']);
 }finally{if(previous===undefined)delete process.env.MELO_MODEL;else process.env.MELO_MODEL=previous;}
});

const lead={id:'main',name:'Lead',instructions:'lead persona',model:'lead-model',capabilities:{delegate:true},collaboration:{canDelegate:true,delegateTargets:['research','reviewer']}};
const handoffOutput=conclusion=>JSON.stringify({conclusion,evidence:[],changedFiles:['a.js'],unfinished:[]});
test('the lead writes the reply from member handoffs and its request is counted in team cost',async()=>{
 const calls=[];
 const team=await runAgentTeam({plan:{members:['research','reviewer']},task:'compare',lead,config:{model:'m',modelPricing:{'lead-model':{input:1,output:1,cached:0,cacheWrite:0}}},
  run:async()=>({ok:true,output:handoffOutput('member finding')}),
  replyFn:async options=>{calls.push(options);options.onProviderResponse({requestedModel:'lead-model',usage:{input:10,output:5,cached:0,cacheWrite:0}});return 'Lead summary';}});
 assert.equal(calls.length,1);assert.equal(calls[0].model,'lead-model');assert.match(calls[0].systemPrompt,/lead persona/);
 assert.match(calls[0].messages[0].content,/member finding/);assert.equal(calls[0].nativeWebSearchEnabled,false);
 assert.equal(team.summary,'Lead summary');assert.equal(team.summaryReceipts.length,1);
});
test('a failed, JSON-shaped or cancelled summary falls back to a readable digest without raw JSON',async()=>{
 for(const replyFn of [async()=>{throw new Error('down');},async()=>'{"conclusion":"x"}']){
  const team=await runAgentTeam({plan:{members:['research']},task:'t',lead,config:{},run:async()=>({ok:true,output:handoffOutput('found it')}),replyFn});
  assert.match(team.summary,/团队已完成/);assert.match(team.summary,/found it/);assert.match(team.summary,/a\.js/);assert.doesNotMatch(team.summary,/[{}]/);
 }
 const controller=new AbortController();let summaries=0;
 const team=await runAgentTeam({plan:{members:['research']},task:'t',lead,config:{},signal:controller.signal,run:async()=>{controller.abort();throw new Error('stop');},replyFn:async()=>{summaries++;return 'x';}});
 assert.equal(summaries,0);assert.match(team.summary,/团队已停止/);
});
test('a lead without delegation or with an unchosen member starts no member',async()=>{
 let started=0;const run=async()=>{started++;return {ok:true,output:'x'};};
 await assert.rejects(runAgentTeam({plan:{members:['research','builder']},task:'t',lead,config:{},run}),/builder/);
 await assert.rejects(runAgentTeam({plan:{members:['research']},task:'t',lead:{...lead,collaboration:{...lead.collaboration,canDelegate:false}},config:{},run}),/未开启委派/);
 assert.equal(started,0);
});

test('each review-loop build round sees its own previous handoff and the review of it',async()=>{
 const seen=[];let builds=0;
 const team=await runAgentTeam({plan:{members:['builder','reviewer'],mode:'review-loop',maxRounds:2},task:'t',config:{},run:async({roleId,instructions})=>{
  seen.push([roleId,instructions]);
  if(roleId==='builder'){builds++;return {ok:true,output:JSON.stringify({conclusion:`build ${builds}`,evidence:[],changedFiles:[],unfinished:[]})};}
  return {ok:true,output:JSON.stringify({conclusion:'needs fix',evidence:[],changedFiles:[],unfinished:[],review:builds>1?'approve':'revise'})};
 }});
 assert.deepEqual(seen.map(([id])=>id),['builder','reviewer','builder','reviewer']);
 assert.equal(seen[0][1],'');assert.match(seen[2][1],/build 1/);assert.match(seen[2][1],/needs fix/);
 assert.equal(team.accepted,true);assert.equal(team.ok,true);
});
test('the team token budget stops later members from starting',async()=>{
 let started=0;
 const team=await runAgentTeam({plan:{members:['research','builder','reviewer'],maxTokens:10000},task:'t',config:{},run:async({onProviderResponse})=>{started++;onProviderResponse({requestedModel:'m',usage:{input:9000,output:2000,cached:0,cacheWrite:0}});return {ok:true,output:'x'};}});
 assert.equal(started,1);assert.equal(team.budgetExceeded,true);assert.equal(team.ok,false);
 assert.deepEqual(team.results.map(r=>r.handoff?.status),['completed','budget-exceeded','budget-exceeded']);
 assert.match(team.summary,/总预算/);
});
test('the team time budget cancels a running member and starts no more',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let started=0,sawAbort=false;
 const pending=runAgentTeam({plan:{members:['research','reviewer'],maxMinutes:1},task:'t',config:{},run:({signal})=>{started++;return new Promise(resolve=>signal.addEventListener('abort',()=>{sawAbort=true;resolve({ok:false,output:'stopped',meta:{aborted:true}});},{once:true}));}});
 await new Promise(r=>setImmediate(r));
 t.mock.timers.tick(60000);
 const team=await pending;
 assert.equal(started,1);assert.equal(sawAbort,true);assert.equal(team.budgetExceeded,true);assert.equal(team.cancelled,false);
 assert.equal(team.results[1].handoff.status,'budget-exceeded');
});

test('the original team deadline covers summary and ignores late text and receipts',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let summaries=0, summarySignal, release;
 const pending=runAgentTeam({plan:{members:['research'],maxMinutes:1},task:'t',lead,config:{},
  run:async()=>({ok:true,output:handoffOutput('verified finding')}),
  replyFn:options=>{summaries++;summarySignal=options.signal;return new Promise(resolve=>{release=()=>{options.onProviderResponse({usage:{input:5,output:5}});resolve('Late success');};});}});
 await new Promise(r=>setImmediate(r));
 assert.equal(summaries,1);t.mock.timers.tick(60001);
 const team=await pending;
 assert.equal(summarySignal.aborted,true);assert.equal(team.budgetExceeded,true);assert.equal(team.ok,false);assert.equal(team.cancelled,false);
 assert.match(team.summary,/总预算/);assert.match(team.summary,/verified finding/);
 release();await new Promise(r=>setImmediate(r));
 assert.equal(team.summaryReceipts.length,0);assert.doesNotMatch(team.summary,/Late success/);
});
test('stopping during summary cancels it and never reports a successful team',async()=>{
 const controller=new AbortController();let summaries=0,sawAbort=false;
 const pending=runAgentTeam({plan:{members:['research']},task:'t',lead,config:{},signal:controller.signal,
  run:async()=>({ok:true,output:handoffOutput('finding')}),
  replyFn:({signal})=>{summaries++;return new Promise(resolve=>signal.addEventListener('abort',()=>{sawAbort=true;resolve('Should be discarded');},{once:true}));}});
 await new Promise(r=>setImmediate(r));controller.abort();const team=await pending;
 assert.equal(summaries,1);assert.equal(sawAbort,true);assert.equal(team.cancelled,true);assert.equal(team.ok,false);assert.match(team.summary,/团队已停止/);
});
test('the final member exhausting the token budget also prevents a summary request',async()=>{
 let summaries=0;
 const team=await runAgentTeam({plan:{members:['research'],maxTokens:10000},task:'t',lead,config:{},
  run:async({onProviderResponse})=>{onProviderResponse({usage:{input:10000,output:1}});return {ok:true,output:'finding'};},
  replyFn:async()=>{summaries++;return 'summary';}});
 assert.equal(summaries,0);assert.equal(team.budgetExceeded,true);assert.equal(team.ok,false);
});
