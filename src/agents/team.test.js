import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentTeam,validateTeamPlan } from './team.js';
import { summarizeUsage } from '../runtime/usage.js';
test('bounded concurrency, isolated role failures and reported cost',async()=>{
  let running=0, peak=0;
  const team=await runAgentTeam({plan:{roles:['research','reviewer'],concurrency:99},task:'fixture',config:{model:'fixture',modelPricing:{fixture:{input:1,output:2,cached:0.5,cacheWrite:1}}},run:async({roleId,onProviderResponse})=>{
    running++;peak=Math.max(peak,running); await new Promise(r=>setTimeout(r,10));running--;
    onProviderResponse({requestedModel:'fixture',usage:{input:100,output:20,cached:0,cacheWrite:0}});
    if(roleId==='reviewer') throw new Error('fixture failure'); return {ok:true,output:'evidence'};
  }});
  assert.equal(peak,2); assert.equal(team.ok,false);assert.equal(team.results[0].ok,true);assert.match(team.results[1].output,/fixture failure/);assert.ok(team.usage.estimatedCost>0);
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
