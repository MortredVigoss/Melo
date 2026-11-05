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
test('delivery evidence gives verified reads the body budget, keeps the ledger and dedupes repeated URLs', async () => {
  const { deliveryEvidence } = await import('./evidence.js');
  const page = 'P'.repeat(5000), nav = 'N'.repeat(5000);
  const rows = [
    { id: 'nav', type: 'source', name: 'fetch_url', ok: true, executed: true, url: 'https://a.example/x', text: page },
    { id: 'full', type: 'source', name: 'fetch_url', ok: true, executed: true, url: 'https://a.example/x', text: page },
    { id: 'failed', type: 'tool', name: 'web_search', ok: false, executed: true, output: 'F'.repeat(3000) },
    ...Array.from({ length: 40 }, (_, i) => ({ id: 'skip' + i, type: 'tool', name: 'fetch_url', ok: false, executed: false, output: 'S'.repeat(2000) })),
    { id: 'other', type: 'source', name: 'fetch_url', ok: true, executed: true, url: 'https://b.example/', text: page },
  ];
  const out = deliveryEvidence(rows, 24000);
  assert.deepEqual(out.map(r => r.id), rows.map(r => r.id), 'every observation keeps its place');
  const by = Object.fromEntries(out.map(r => [r.id, r]));
  assert.ok(by.nav.text.length >= 3000 && by.other.text.length >= 3000, 'verified pages keep real bodies');
  assert.ok(by.full.text.length <= 160 && by.failed.text.length <= 160 && by.skip0.text.length <= 160, 'duplicates and failures keep short bodies');
  assert.ok(out.reduce((n, r) => n + r.text.length, 0) <= 24000 + 2 * 4000, 'bounded');
  assert.ok(by.full.truncated && !by.nav.ok === false);
  const tiny = deliveryEvidence(Array.from({ length: 2000 }, (_, i) => ({ id: 'r' + i, type: 'tool', ok: false, executed: false, output: 'x'.repeat(100) })), 24000);
  assert.ok(tiny.every(r => r.text.length <= 24), 'a huge failed ledger still fits');
});

test('different windows of the same URL keep their own dated facts and original truncation state',async()=>{
 const {deliveryEvidence}=await import('./evidence.js');
 const rows=['OCT31 activity','NOV01 activity'].map((fact,i)=>({id:'page-'+i,type:'source',name:'fetch_url',url:'https://fixture.invalid/events',ok:true,executed:true,reading:'partial',truncated:true,text:'navigation '.repeat(30)+fact}));
 const result=deliveryEvidence(rows,48000);
 assert.match(result[0].text,/OCT31 activity/);assert.match(result[1].text,/NOV01 activity/);
 assert.ok(result.every(r=>r.truncated&&r.reading==='partial'));
});

test('a hard timeout during delivery remains a deadline stop and never requests a checker',async()=>{
 const controller=new AbortController();let calls=0;
 const result=await runLimitDelivery({task:goal,observations,reason:'BUDGET_EXHAUSTED',fallback:'Continue later.',budget:reserveDelivery(createRunBudget()),signal:controller.signal,options:{},locale:'en',
  createReply:async()=>{calls++;controller.abort(new DOMException('hard deadline','TimeoutError'));throw controller.signal.reason;}});
 assert.equal(calls,1);assert.equal(result.terminalReason,'DEADLINE_EXCEEDED');assert.match(result.reply,/Continue later/);
});
