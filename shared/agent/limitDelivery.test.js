import test from 'node:test';
import assert from 'node:assert/strict';
import { startGoal, goalReviewRequest } from './goal.js';
import { completionResult } from './completion.js';
import { deliveryRequest, deliveryCandidate, reviewDelivery, deliveryReply, hostEvidenceReply } from './limitDelivery.js';
import { runLimitDelivery } from '../../src/runtime/limitDelivery.js';
import { createRunBudget, reserveDelivery } from './runBudget.js';
const goal = startGoal('查下周演唱会所在城市当天的活动，并核实开放时间');
const observations = [
 {id:'calendar',name:'calendar_list_events',type:'tool',ok:true,executed:true,output:'2026-10-31 演唱会，Example Arena'},
 {id:'venue',name:'fetch_url',type:'source',ok:true,executed:true,url:'https://fixture.invalid/venue',reading:'extracted',text:'Example Arena is in Sydney.'},
 {id:'activities',name:'fetch_url',type:'source',ok:true,executed:true,url:'https://fixture.invalid/events',reading:'extracted',text:'Sydney 31 October: Harbour Halloween Walk at 18:00. Booking availability is not verified.'},
];
const partial = JSON.stringify({decision:'continue',reasonType:'lookup_missing',reason:'开放时间尚未核实',nextStep:'核对活动开放时间',requirements:[{text:'当天活动',status:'met',evidenceIds:['activities']},{text:'开放时间',status:'missing',evidenceIds:[]}]});
test('delivery keeps early and recent evidence, URLs and read states in both answer and checker inputs',()=>{
 const rows=[...observations,...Array.from({length:120},(_,i)=>({id:'extra'+i,type:'tool',ok:false,executed:false,output:'A'.repeat(2000)}))];
 const request=deliveryRequest(goal,rows,'ROUND_LIMIT');
 const data=JSON.parse(request.messages[0].content);
 assert.equal(data.observations.length,rows.length);assert.equal(data.observations[1].url,observations[1].url);assert.match(data.observations[2].text,/Harbour Halloween Walk/);
 const task=deliveryCandidate(goal,'已查到 Harbour Halloween Walk；开放时间未核实。',rows);
 assert.equal(JSON.parse(goalReviewRequest(task,rows).messages[0].content).observations.length,rows.length);
 const checked=reviewDelivery(task,partial,rows);assert.equal(checked.decision,'partial');
 const reply=deliveryReply(checked,task.candidate,'zh');assert.match(reply,/Harbour Halloween Walk/);assert.match(reply,/开放时间/);assert.match(reply,/继续/);
 const receipt=completionResult({goal:goal.original,reply,observations:rows,task:checked,terminalReason:'LIMIT_DELIVERED',locale:'zh'});
 assert.equal(receipt.outcome,'partial');assert.equal(receipt.reason,'LIMIT_DELIVERED');assert.match(receipt.summary,/部分完成.*轮数上限/);
});
test('delivery completion requires checked evidence; unavailable or invented evidence cannot claim completion',()=>{
 const task=deliveryCandidate(goal,'Answer',observations);
 for(const response of [null,'bad json',JSON.stringify({decision:'complete',requirements:[{text:'done',status:'met',evidenceIds:['invented']}]})]) {
  const checked=reviewDelivery(task,response,observations);
  assert.equal(completionResult({reply:'Answer',observations,task:checked,terminalReason:'LIMIT_DELIVERED'}).outcome,'unverified');
 }
 const checked=reviewDelivery(task,JSON.stringify({decision:'complete',reasonType:'fulfilled',requirements:[{text:'已确认的活动',status:'met',evidenceIds:['activities']}]}),observations);
 assert.equal(completionResult({reply:'Answer',observations,task:checked,terminalReason:'LIMIT_DELIVERED'}).outcome,'completed');
});
test('cancel and hard deadline invoke zero providers and retain host tool results',async()=>{
 for(const cancelled of [true,false]) {
  let now=0,calls=0;const budget=reserveDelivery(createRunBudget({now:()=>now}));
  const controller=new AbortController();if(cancelled)controller.abort();else now=budget.deadlineAt;
  const result=await runLimitDelivery({task:goal,observations,reason:'DEADLINE_EXCEEDED',fallback:'停止',budget,signal:controller.signal,locale:'zh',createReply:async()=>{calls++;return 'must not run';}});
  assert.equal(calls,0);assert.match(result.reply,/Harbour Halloween Walk/);assert.match(result.reply,/calendar/);
 }
});
test('delivery and check expose no ordinary or hosted tools, and checker failure keeps the answer',async()=>{
 const seen=[];const result=await runLimitDelivery({task:goal,observations,reason:'ROUND_LIMIT',fallback:'停止',budget:reserveDelivery(createRunBudget()),locale:'zh',options:{tools:[{name:'write'}],nativeImageGenerationEnabled:true},createReply:async options=>{seen.push(options);if(seen.length===1)return '已确认 Harbour Halloween Walk，开放时间待查。';throw new Error('checker unavailable');}});
 assert.equal(seen.length,2);assert.deepEqual(seen.map(r=>r.tools),[[],[]]);assert.ok(seen.every(r=>!r.nativeWebSearchEnabled&&!r.nativeImageGenerationEnabled));assert.equal(seen[0].maxTokens,8192);
 assert.equal(result.terminalReason,'LIMIT_DELIVERED');assert.match(result.reply,/Harbour Halloween Walk/);assert.equal(result.task.deliveryCheck,'unverified');
 assert.match(hostEvidenceReply('停止',observations,'zh'),/https:\/\/fixture.invalid\/events/);
});
