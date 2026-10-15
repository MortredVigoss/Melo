import test from 'node:test';
import assert from 'node:assert/strict';
import {runConfiguredMember,delegateTask} from './delegate.js';
import {runAgentTeam,validateTeamPlan} from './team.js';
import {emptyCapabilities,normalizeCapabilities} from '../domain/agent/capabilities.js';
import {runSubAgent} from './subAgent.js';
const caps=normalizeCapabilities({readFiles:true,writeFiles:true,runCommands:true,delegate:true});
const profile=(id,extra={})=>({id,name:id,instructions:`Identity of ${id}`,model:`model-${id}`,capabilities:caps,collaboration:{maxTokens:32000,...extra}});

test('configured member uses its own persona/model, intersection and handoff',async()=>{
 let seen;const member=await runConfiguredMember({profile:profile('builder'),parentCapabilities:emptyCapabilities(),allowedToolIds:['bash','file_write'],task:'implement',config:{model:'parent'},run:opts=>runSubAgent({...opts,replyFn:async request=>{seen=request;return JSON.stringify({conclusion:'Finished',evidence:['checked fixture'],changedFiles:[],unfinished:[]});}})});
 assert.equal(seen.model,'model-builder');assert.match(seen.systemPrompt,/Identity of builder/);assert.equal(seen.nativeWebSearchEnabled,false);assert.equal(member.handoff.conclusion,'Finished');assert.equal(member.handoff.status,'completed');assert.equal(member.usage.estimatedCost,null);
});
test('parallel teams serialize writers across separate runs while readers remain parallel',async()=>{
 let running=0,peak=0;
 const run=async()=>{running++;peak=Math.max(peak,running);await new Promise(r=>setTimeout(r,15));running--;return {ok:true,output:'checked'};};
 await Promise.all(['a','b'].map(id=>runConfiguredMember({profile:profile(id),parentCapabilities:caps,config:{},task:'write',workspacePath:'/tmp/melo-member-lock-proof',run})));
 assert.equal(peak,1);peak=0;
 await Promise.all(['a','b'].map(id=>runConfiguredMember({profile:{...profile(id),capabilities:normalizeCapabilities({readFiles:true})},parentCapabilities:caps,config:{},task:'read',workspacePath:'/tmp/melo-member-lock-proof',run})));
 assert.equal(peak,2);
});
test('review loop consumes structured handoffs and stops at a bounded approved round',async()=>{
 let reviews=0;const received=[];
 const team=await runAgentTeam({plan:{members:['maker','checker'],mode:'review-loop',maxRounds:2},task:'change',config:{},capabilities:caps,agentProfiles:{maker:profile('maker'),checker:profile('checker')},run:async opts=>{
  received.push(opts.instructions);const review=opts.roleId==='checker'?(++reviews===2?'approve':'revise'):null;
  return {ok:true,output:JSON.stringify({conclusion:'result',evidence:['test'],unfinished:[],review})};
 }});
 assert.equal(team.results.length,4);assert.equal(team.accepted,true);assert.match(received[1],/"subtask"/);assert.match(received[2],/"review":"revise"/);
 assert.equal(validateTeamPlan({members:['maker','checker'],mode:'review-loop',maxRounds:999}).maxRounds,5);
});
test('member timeout reaches running work and cancellation stops queued members',async()=>{
 const member=await runConfiguredMember({profile:profile('slow',{timeoutMs:20}),parentCapabilities:caps,config:{},task:'slow',run:async({signal})=>{await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {ok:true,output:'late'};}});
 assert.equal(member.ok,false);assert.equal(member.handoff.status,'cancelled');
 const c=new AbortController();let calls=0;
 const result=await runAgentTeam({plan:{members:['one','two']},task:'task',config:{},signal:c.signal,capabilities:caps,agentProfiles:{one:profile('one'),two:profile('two')},run:async()=>{calls++;c.abort();return {ok:true,output:'cancel'};}});
 assert.equal(calls,1);assert.ok(result.results.every(r=>r.cancelled));
});
test('forged targets, missing capability, cycle and depth cap fail without starting a member',async()=>{
 const ctx={agentId:'main',capabilities:caps,collaboration:{canDelegate:true,delegateTargets:['child'],maxDelegationDepth:1},agentProfiles:{child:profile('child')},config:{}};
 for(const [args,context] of [[{agentId:'unknown'},ctx],[{agentId:'child'},{...ctx,capabilities:emptyCapabilities()}],[{agentId:'child'},{...ctx,agentDepth:1}],[{agentId:'child'},{...ctx,ancestry:['child']}]])assert.equal((await delegateTask({...args,task:'try'},context)).error,'DELEGATION_DENIED');
});
test('token budget prevents a provider request when required context is already too large',async()=>{
 let calls=0;const result=await runSubAgent({task:'work',agentProfile:profile('member'),maxTokens:1,config:{model:'fixture'},replyFn:async()=>{calls++;return 'should not run';}});
 assert.equal(calls,0);assert.equal(result.meta.budgetExceeded,true);
});

test('a cancelled executor keeps its workspace writer lease until the real tool settles',async()=>{
 const {withWorkspaceWriter}=await import('./workspaceScheduling.js');
 const {executeTool}=await import('../tools/executor.js');
 const controller=new AbortController();let release,started,second=false;
 const ready=new Promise(resolve=>{started=resolve;});
 const work=new Promise(resolve=>{release=resolve;});
 const first=withWorkspaceWriter('/tmp/melo-writer-drain-fixture',controller.signal,()=>executeTool({id:'file_write',requiresPermission:false,run:async()=>{started();await work;return{ok:true,output:'done'};}},{},{signal:controller.signal}));
 await ready;controller.abort();
 const next=withWorkspaceWriter('/tmp/melo-writer-drain-fixture',undefined,async()=>{second=true;});
 await new Promise(resolve=>setTimeout(resolve,25));assert.equal(second,false);
 release();await Promise.all([first,next]);assert.equal(second,true);
});
