import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvePermission} from './permissions.js';
import {createRequestContext} from '../runtime/requestContext.js';
import {executeTool} from './executor.js';
import {runWithRequestContext} from '../runtime/requestScope.js';
import {emptyCapabilities,recommendedCapabilities} from '../domain/agent/capabilities.js';

const scope = (capabilities=emptyCapabilities(),legacy=false) => Object.freeze({agentId:'research',capabilities,legacy,source:'turn'});
const context = capabilityScope => ({...createRequestContext({home:'/tmp/melo-capability-scope-fixture',chatId:'chat'}),turnBinding:{role:'research',project:null},capabilityScope});
async function probe(requestContext,options={}) {
 let executed=0,permissions=0;
 const tool={id:'file_write',requiresPermission:true,run:async()=>{executed++;return{ok:true,output:'executed'};}};
 const call=()=>executeTool(tool,{path:'test.txt',content:'test'},{workspacePath:'/tmp/melo-capability-scope-fixture',...options,sseEmitter:(type,payload)=>{if(type==='tool_permission'){permissions++;resolvePermission(payload.requestId,true);}}});
 const result=await (requestContext?runWithRequestContext(requestContext,call):call());
 return {result,executed,permissions};
}
test('executor uses turn capabilities when caller omits capabilities',async()=>{
 const {result,executed,permissions}=await probe(context(scope()));
 assert.equal(result.error,'CAPABILITY_DENIED');assert.equal(result.meta.executionStarted,false);assert.equal(executed,0);assert.equal(permissions,0);
});
test('caller capabilities and replacement context cannot widen an active scope',async()=>{
 const {result,executed,permissions}=await probe(context(scope()),{capabilities:recommendedCapabilities('main'),requestContext:context(scope(null,true)),scopeResolved:true});
 assert.equal(result.error,'CAPABILITY_DENIED');assert.equal(executed,0);assert.equal(permissions,0);
});
test('unidentified execution fails closed even if caller supplies broad capabilities',async()=>{
 const {result,executed,permissions}=await probe(null,{capabilities:recommendedCapabilities('main'),agentId:'main'});
 assert.equal(result.error,'CAPABILITY_SCOPE_MISSING');assert.equal(result.meta.executionStarted,false);assert.equal(executed,0);assert.equal(permissions,0);
});
test('explicit legacy turn scope preserves the previous tool behavior',async()=>{
 const {result,executed}=await probe(context(scope(null,true)));
 assert.equal(result.ok,true);assert.equal(executed,1);
});

test('member scopes intersect both directions and cannot widen via a nested executor call',async()=>{
 const {runConfiguredMember}=await import('../agents/delegate.js');
 for (const [parentCaps,memberCaps] of [[emptyCapabilities(),recommendedCapabilities('builder')],[recommendedCapabilities('main'),emptyCapabilities()]]) {
  let runs=0,permissions=0;
  const result=await runWithRequestContext(context(scope(parentCaps)),()=>runConfiguredMember({profile:{id:'builder',name:'Builder',capabilities:memberCaps},parentCapabilities:recommendedCapabilities('main'),config:{},task:'try',run:async()=>{
   const result=await executeTool({id:'file_write',run:()=>{runs++;}},{},{sseEmitter:()=>permissions++});
   assert.equal(result.error,'CAPABILITY_DENIED');return result;
  }}));
  assert.equal(result.ok,false);assert.equal(runs,0);assert.equal(permissions,0);
 }
});
test('turn captures a frozen profile in the start transaction and remains restrictive after a settings edit',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {updateStateAtomically}=await import('../state/stateStore.js');const {beginChatRun}=await import('../services/chat/turnLedger.js');
 const home=await mkdtemp(join(tmpdir(),'melo-scope-turn-'));t.after(()=>rm(home,{recursive:true,force:true}));
 await updateStateAtomically(s=>{s.agentProfiles.research.capabilities=emptyCapabilities();s.chats.push({id:'chat',agentId:'research',projectId:null,messages:[]});},{home});
 const initial=createRequestContext({home,chatId:'chat',requestId:'request'});
 const {turnBinding}=await beginChatRun({chatId:'chat',content:'test'},initial);
 assert.equal(Object.isFrozen(turnBinding.capabilityScope.capabilities),true);
 await updateStateAtomically(s=>{s.agentProfiles.research.capabilities=recommendedCapabilities('main');},{home});
 const {result,executed}=await probe({...initial,turnBinding});assert.equal(result.error,'CAPABILITY_DENIED');assert.equal(executed,0);
 const fallback=await probe({...initial,turnBinding:{role:'missing-agent',project:null}});assert.equal(fallback.result.error,'CAPABILITY_SCOPE_MISSING');assert.equal(fallback.executed,0);
});
test('skill allowlist reaches ambient context; omitted nested options and native features cannot bypass it',async()=>{
 const {runSkill}=await import('../agents/skillExecutor.js');const {registerTool,unregisterTool}=await import('./registryCore.js');
 let nested=0,permissions=0,seen,skillTools=0;
 registerTool({id:'calculator',name:'Calculator fixture',description:'Test fixture',parametersSchema:{type:'object',properties:{}},requiresPermission:false,run:async()=>{
  skillTools++;const denied=await executeTool({id:'file_write',run:()=>{nested++;}},{},{sseEmitter:()=>permissions++});assert.equal(denied.error,'CAPABILITY_DENIED');return {ok:true,output:'checked'};
 }});
 try {
  let count=0;
  await runWithRequestContext(context(scope(recommendedCapabilities('main'))),()=>runSkill({skill:{id:'fixture',type:'executable',name:'fixture',systemPrompt:'test',toolWhitelist:['calculator'],maxIterations:3},config:{model:'fixture'},replyFn:async request=>{seen=request;return count++===0?'<tool_call>{"name":"calculator","arguments":{}}</tool_call>':'done';}}));
  assert.equal(seen.nativeWebSearchEnabled,false);assert.equal(seen.nativeImageGenerationEnabled,false);assert.equal(nested,0);assert.equal(permissions,0);assert.equal(skillTools,1);
 } finally {unregisterTool('calculator');}
});

test('explicit user tool/network restrictions refuse execution before permissions or grants',async()=>{
 const {getRequestNetworkPolicy}=await import('../../shared/agent/retrieval/requestPolicy.js');
 for(const [text,id] of [['不要使用工具','calculator'],['不要联网','fetch_url'],['不要搜索','web_search']]) {
  let runs=0,permissions=0;
  const ctx={...context(scope(null,true)),requestToolPolicy:getRequestNetworkPolicy(text)};
  const result=await runWithRequestContext(ctx,()=>executeTool({id,requiresPermission:true,run:()=>{runs++;return {ok:true,output:'bad'};}},{},{sseEmitter:()=>permissions++}));
  assert.equal(result.error,'REQUEST_TOOL_DENIED');assert.equal(result.meta.executionStarted,false);
  assert.equal(runs,0);assert.equal(permissions,0);
 }
 const {requestAllowsTool}=await import('../../shared/agent/retrieval/requestPolicy.js');
 assert.equal(requestAllowsTool('calculator',getRequestNetworkPolicy('不要联网，算 17*19')),true);
 assert.equal(requestAllowsTool('fetch_url',getRequestNetworkPolicy('不要搜索，读取链接')),true);
});
