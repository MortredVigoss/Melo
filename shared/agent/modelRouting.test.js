import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRouting, escalateRouting, parseRoutingJudgment } from './modelRouting.js';
import { startTurn, advanceTurn } from './turn.js';
import { evaluate } from './index.js';
const candidates = ['one','two','three'].map(model=>({connectionId:'local',model,capabilities:{vision:true,tools:true}}));
const policy={allowEscalation:true,tiers:Object.fromEntries(['light','standard','strong'].map((t,i)=>[t,[candidates[i]]]))};
const base={mode:'smart',connectionId:'local',defaultModel:'one',policy,candidates};
test('opaque model IDs, fixed selection and rule minimums are shared through the bridge',()=>{
 for(const [text,tier] of [['你好','light'],['2+3?','light'],['换图片背景','standard'],['投资建议','strong'],['deep research','strong']]) {
  const result=selectRouting({...base,text});assert.equal(result.tier,tier);assert.equal(result.judge,null);
  assert.deepEqual(evaluate({version:1,op:'modelRouting',routing:{...base,text}}).value,result);
 }
 assert.equal(selectRouting({...base,text:'medical advice',fixedModel:'one'}).model,'one');
 assert.equal(selectRouting({...base,text:'你好',context:[{role:'user',content:'你好'}]}).judge,null);
 assert.equal(selectRouting({...base,text:'好的',context:[{role:'user',content:'投资建议'}]}).tier,'strong');
});
test('modality and connection scope precede tiers, no silent lower-tier fallback',()=>{
 const foreign={connectionId:'cloud',model:'foreign',capabilities:{vision:true}};
 const input={...base,text:'投资建议',policy:{...policy,tiers:{...policy.tiers,strong:[foreign]}},candidates:[...candidates,foreign]};
 assert.throws(()=>selectRouting(input),{code:'ROUTING_MODEL_UNAVAILABLE'});
 assert.equal(selectRouting({...input,policy:{...input.policy,allowCrossConnection:true}}).model,'foreign');
 assert.throws(()=>selectRouting({...base,text:'看图',attachments:[{kind:'image'}],candidates:candidates.map(c=>({...c,capabilities:{vision:false}}))}),{code:'ROUTING_MODEL_UNAVAILABLE'});
});
test('single model and fixed mode never spend a judgment call',()=>{
 const p={...policy,tiers:{light:[candidates[0]],standard:[candidates[0]],strong:[candidates[0]]}};
 const value=selectRouting({...base,text:'分析几个角度',policy:p});assert.equal(value.equivalentFixed,true);assert.equal(value.judge,null);
 assert.equal(selectRouting({...base,text:'分析几个角度',mode:'fixed'}).judge,null);
 assert.equal(selectRouting({...base,text:'分析几个角度'}).judge.model,'one');
});
test('bad JSON falls back to standard, high risk and attachments cannot downgrade',()=>{
 assert.equal(parseRoutingJudgment('{"complexity":9}'),null);
 assert.equal(selectRouting({...base,text:'分析几个角度',judgmentAttempted:true,judgment:'bad'}).tier,'standard');
 const judgment={complexity:1,risk:'low',needs:{}};
 assert.equal(selectRouting({...base,text:'投资建议',judgment}).tier,'strong');
 assert.equal(selectRouting({...base,text:'请看附件',attachments:[{kind:'file'}],judgment}).tier,'standard');
});
test('escalation is one level, once, and never reopens a stopped turn',()=>{
 const previous=selectRouting({...base,text:'你好'});
 const input={...base,text:'你好',previous,requested:true};
 const next=escalateRouting(input);assert.equal(next.tier,'standard');assert.equal(next.escalations,1);
 assert.equal(escalateRouting({...input,previous:next}),null);
 assert.equal(escalateRouting({...input,stopped:true}),null);
 assert.equal(escalateRouting({...input,pendingEffects:true}),null);
});
test('rerouting retains successful side effects, failure counters and the original deadline',()=>{
 let s=startTurn({runId:'r',turnId:'t',now:0,allowedTools:['file_write'],hostToolSchemas:true});
 const step=(type,fields={})=>s=advanceTurn(s,{type,runId:'r',turnId:'t',...fields},1);
 step('request');step('calls',{calls:[{id:'a',name:'file_write',arguments:{path:'a',content:'x'}}]});
 step('result',{callId:'a',ok:true});const deadline=s.deadline;step('reroute');
 assert.equal(s.deadline,deadline);assert.equal(s.rounds,1);step('request');step('calls',{calls:[{id:'b',name:'file_write',arguments:{path:'a',content:'x'}}]});
 assert.equal(s.permitted.length,0);assert.equal(s.rejections.b,'ALREADY_EXECUTED');
});

import { readFileSync } from 'node:fs';
test('cross-platform routing fixtures keep opaque model identities and task floors',()=>{
 for(const row of JSON.parse(readFileSync(new URL('./fixtures/model-routing.json',import.meta.url)))) { const selected=selectRouting(row.input); assert.equal(selected.model,row.expected.model,row.name); assert.equal(selected.tier,row.expected.tier,row.name); }
});

test('side-effect minimum can promote a single model without losing its identity or allowing repeated upgrades',()=>{
 const p={...policy,tiers:Object.fromEntries(['light','standard','strong'].map(t=>[t,[candidates[0]]]))};
 const input={...base,policy:p,text:'你好'};const previous=selectRouting(input);
 const next=escalateRouting({...input,previous,requested:true,sideEffects:true});
 assert.equal(next.tier,'strong');assert.equal(next.model,previous.model);assert.equal(next.escalations,1);
 assert.equal(escalateRouting({...input,previous:next,requested:true,sideEffects:true}),null);
});


test('new tasks clear historical risk while continuations and an active goal retain it',()=>{
 const context=[{role:'user',content:'请分析这项投资和相关法律诉讼风险'},{role:'assistant',content:'分析已完成。'}];
 for(const text of ['hello','2 + 3?','换个话题，帮我比较两篇小说的写作风格','Please compare the narrative style of these two novels']) {
   const value=selectRouting({...base,text,context}); assert.notEqual(value.tier,'strong',text);
 }
 for(const text of ['好的','那继续呢','what about that?','50呢？']) assert.equal(selectRouting({...base,text,context}).tier,'strong',text);
 assert.equal(selectRouting({...base,text:'hello',goal:'继续分析投资风险',context}).tier,'strong');
 const moved=[...context,{role:'user',content:'换个话题，帮我比较两篇小说的写作风格'},{role:'assistant',content:'小说叙事分析'}];
 assert.notEqual(selectRouting({...base,text:'继续比较',context:moved}).tier,'strong');
});
