import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutingSession, clearRoutingCache } from './routing.js';
const candidate=model=>({connectionId:'c',model});
const config={activeLlmProfileId:'c',authMode:'api-key',baseUrl:'https://fixture.invalid',apiKey:'secret',model:'one',llmProfiles:{c:{authMode:'api-key',apiKey:'secret',baseUrl:'https://fixture.invalid',model:'one',models:['one','two','three']}},smartRouting:{defaultMode:'smart',allowEscalation:true,tiers:{light:[candidate('one')],standard:[candidate('two')],strong:[candidate('three')]}}};
const answer=JSON.stringify({complexity:3,risk:'low',needs:{tools:true},domain:'general',reason:'multiple steps'});
test('routing uses the selected connection, one bounded judgment and isolated contextual cache',async()=>{
 clearRoutingCache();let calls=0;
 const run=(home='a',messages=[])=>createRoutingSession({config,home,messages,text:'分析几个角度',createReply:async options=>{calls++;assert.equal(options.model,'one');assert.equal(options.apiKey,'secret');assert.equal(options.nativeWebSearchEnabled,false);assert.equal(options.maxTokens,512);return answer;}});
 assert.equal((await run()).current.model,'two');await run();assert.equal(calls,1);
 await run('b');await run('a',[{role:'user',content:'不同背景'}]);assert.equal(calls,3);
});
test('fixed, pinned, simple and single candidates have zero classifier requests',async()=>{
 let calls=0;const run=(changes={},text='分析几个角度',agent=null)=>createRoutingSession({config:{...config,...changes},agent,text,home:'a',createReply:async()=>{calls++;return answer;}});
 await run({conversationModelSelected:true,conversationModelMode:'fixed'});await run({},'你好');await run({},'分析几个角度',{model:'three'});
 await run({smartRouting:{defaultMode:'smart',tiers:{light:[candidate('one')],standard:[candidate('one')],strong:[candidate('one')]}}});
 assert.equal(calls,0);
});
test('invalid judgment falls back and cancellation never starts a second model',async()=>{
 const r=await createRoutingSession({config,home:'c',text:'分析几个角度',createReply:async()=>'{bad'});assert.equal(r.current.model,'two');assert.equal(r.current.judgmentSource,'fallback');
 const abort=new AbortController();abort.abort();let calls=0;
 await assert.rejects(createRoutingSession({config,home:'d',signal:abort.signal,text:'分析几个角度',createReply:async()=>{calls++;abort.signal.throwIfAborted();}}));
 assert.equal(calls,0);
});
test('judgment deadline aborts its transport and cancellation never becomes a fallback answer',async()=>{
 clearRoutingCache();let aborted=0;
 const route=await createRoutingSession({config,home:'deadline',text:'比较几种架构方案',createReply:options=>new Promise((resolve,reject)=>{
  options.signal.addEventListener('abort',()=>{aborted++;reject(options.signal.reason);},{once:true});
 })});
 assert.equal(aborted,1);assert.equal(route.current.model,'two');assert.equal(route.current.judgmentSource,'fallback');
 const controller=new AbortController();let calls=0;
 await assert.rejects(createRoutingSession({config,home:'cancel-inflight',text:'比较几种架构方案',signal:controller.signal,createReply:options=>new Promise((resolve,reject)=>{
  calls++;options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});controller.abort(new Error('user cancelled'));
 })}),/user cancelled/);assert.equal(calls,1);
});


test('routing judgment only sees the current task, and rerouted connections own their capabilities',async()=>{
 clearRoutingCache();let payload;
 const text='换个话题，比较两篇小说的叙述方式';
 const route=await createRoutingSession({config,home:'task-scope',text,messages:[{role:'user',content:'法律诉讼风险'},{role:'assistant',content:'已完成'}],createReply:async options=>{payload=JSON.parse(options.messages[0].content);return answer;}});
 assert.deepEqual(payload.context,[]);assert.equal(payload.text,text);assert.equal(route.current.model,'two');
 const {routeConnection}=await import('./routing.js');const {connectionForModel,resolvedModelCapabilities}=await import('../../../shared/agent/modelCapabilities.js');
 const one={id:'a',baseUrl:'https://same.invalid/v1',apiKey:'a',authMode:'api-key',modelCapabilities:{opaque:{vision:false}}};
 const two={...one,id:'b',apiKey:'b',modelCapabilities:{opaque:{vision:true}}};
 const selected=routeConnection({...one,activeLlmProfileId:'a',llmProfiles:{a:one,b:two}},{connectionId:'b',model:'opaque'});
 assert.equal(resolvedModelCapabilities(connectionForModel(selected),'opaque').vision,true);
 assert.equal(selected.apiKey,'b');
});
