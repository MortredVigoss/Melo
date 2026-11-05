import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { evaluate } from './index.js';
import { taskEvaluationSummary, updateTaskEvaluation } from './taskEvaluation.js';
import { startGoal, goalCandidate, reviewGoal, goalOperation, goalReviewRequest, GOAL_LIMITS } from './goal.js';
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/task-evaluation.json',import.meta.url)));
const context=vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});
vm.runInContext(readFileSync(new URL('./dist/agent-core.js',import.meta.url),'utf8'),context);
for(const fixture of fixtures)test('B shared policy: '+fixture.name,()=>{
 let state, bundled;
 for(const step of fixture.steps){
  const input={version:1,op:'taskEvaluation',...step,state};
  const result=evaluate(input); assert.equal(result.ok,true);state=result.value;
  context.input=JSON.stringify({...input,state:bundled});bundled=JSON.parse(vm.runInContext('MeloAgent.evaluate(input)',context)).value;
  assert.deepEqual(bundled,state,'Node and packaged phone core must match');
 }
 for(const [key,value]of Object.entries(fixture.expected||{}))assert.deepEqual(taskEvaluationSummary(state)?.[key],value,key);
 if(fixture.expectedError)assert.ok(state.error?.includes(fixture.expectedError),state.error);else assert.equal(state.error,null);
});

test('independent checker cannot approve an unmet explicit quantity, even with valid evidence and a high score',()=>{
 const f=fixtures.find(f=>f.name.includes('exact 20 does not'));
 let state;for(const step of f.steps)state=updateTaskEvaluation(state,step.args,step.context);
 const obs=f.steps[1].context.observations;
 let goal={...startGoal(f.steps[0].context.goal),evaluation:state};
 goal=goalCandidate(goal,{reply:'Eight products found.',tools:['fetch_url'],observations:obs});
 const checked=reviewGoal(goal,JSON.stringify({decision:'complete',evaluationValid:true,reason:'done',requirements:[{text:'20 products',status:'met',kind:'external_fact',evidenceIds:['s1']}]}),obs);
 assert.equal(checked.decision,'continue');assert.ok(checked.feedback.includes('12 still missing'));
 goal=goalOperation({action:'amend',state:goal,amendment:'Also keep within a 100 AUD total budget.'});assert.equal(goal.evaluation.stale,true);
});

test('member allocation preserves lead and delivery reserves without granting extra root resources',()=>{
 const budget={maxInputTokens:100000,used:{inputTokens:20000},delivery:{inputTokens:65536},maxToolCalls:200};
 const before=JSON.stringify(budget);const result=evaluate({version:1,op:'taskEvaluation',action:'allocation',budget}).value;
 assert.equal(result.allowed,false);assert.equal(result.maxInputTokens,0);assert.equal(JSON.stringify(budget),before);
});

test('diminishing returns needs two real batches and cannot lower an explicit count',()=>{
 const f=fixtures[1]; let state;for(const step of f.steps)state=updateTaskEvaluation(state,step.args,step.context);
 const original=f.steps[1].context.observations[0], seed=JSON.parse(f.steps[1].args.data).items[0];
 const observed=[original];
 for(let batch=0;batch<2;batch++){
  const items=Array.from({length:5},(_,i)=>{
   const n=batch*5+i;const row=structuredClone(seed);row.fields.name.value='Private event '+n;row.fields.participation.value='private';
   const id='read-'+n;observed.push({...original,id});for(const field of Object.values(row.fields))field.evidence[0].id=id;return row;
  });
  state=updateTaskEvaluation(state,{action:'batch',data:JSON.stringify({items,gaps:[],adjustment:{reason:'Narrow public scope; inspected alternatives are private.',evidence:[{id:original.id,quote:original.text}]}})},{revision:1,observations:observed});
 }
 assert.equal(state.summary.diminishing,true);assert.equal(state.summary.adjusted,true);assert.equal(state.summary.stop,'ready_for_review');
 state={...state,contract:{...state.contract,explicitCount:{value:20,quote:'20'},target:{minimum:20,maximum:20,initial:30}}};
 assert.equal(taskEvaluationSummary(state).adjusted,false);assert.equal(taskEvaluationSummary(state).stop,'continue');
 const repeated=updateTaskEvaluation(state,{action:'batch',data:JSON.stringify({items:[seed,seed,seed,seed,seed],gaps:[]})},{revision:1,observations:observed});
 assert.equal(repeated.batches.at(-1).inspected,0,'duplicates cannot manufacture five inspected entities');
});

test('short exact currency references and compact row evidence count without repeated quote payloads',()=>{
 const f=fixtures.find(f=>f.name.includes('distinct models'));let state=updateTaskEvaluation(null,f.steps[0].args,f.steps[0].context);
 const item=JSON.parse(f.steps[1].args.data).items[0];
 item.fields.currency.evidence[0].quote='AUD';
 let updated=updateTaskEvaluation(state,{action:'batch',data:JSON.stringify({items:[item],gaps:[]})},f.steps[1].context);
 assert.equal(updated.summary.verified,1);
 const compact={...item,fields:Object.fromEntries(Object.entries(item.fields).map(([k,v])=>[k,v.value])),evidence:item.fields.name.evidence};
 updated=updateTaskEvaluation(state,{action:'batch',data:JSON.stringify({items:[compact],gaps:[]})},f.steps[1].context);
 assert.equal(updated.summary.verified,1);
 item.fields.currency.evidence[0].quote='A';updated=updateTaskEvaluation(state,{action:'batch',data:JSON.stringify({items:[item],gaps:[]})},f.steps[1].context);
 assert.equal(updated.summary.verified,0,'a short unrelated fragment cannot prove a currency');
});
test('invalid coordinator updates are bounded independently of tool rounds',()=>{
 let state;for(let i=0;i<3;i++)state=updateTaskEvaluation(state,{action:'batch',data:'{}'},{revision:1});
 assert.equal(state.closed,true);assert.equal(state.invalidUpdates,3);
 state=updateTaskEvaluation(state,{action:'contract',data:'{"category":"events"}'},{revision:1});assert.equal(state.closed,true);assert.equal(state.contract,undefined);
});

test('final reviewer retains actual late-page candidate evidence beyond the generic 2000-character preview',()=>{
 const quote='Model F20 is available in AU for 119 AUD including delivery.';
 const body='Unrelated catalog preface. '.repeat(180)+quote+' End of complete catalog.';
 const observation={id:'catalog',type:'tool',name:'catalog_read',ok:true,executed:true,text:body};
 const goal={...startGoal('Find 20 products'),evaluation:{items:[{fields:{model:{evidence:[{id:'catalog',quote}]}}}]}};
 for(const limitDelivery of [false,true]) {
  const request=JSON.parse(goalReviewRequest({...goal,limitDelivery},[observation]).messages[0].content);
  assert.ok(request.observations[0].text.includes(quote));
  assert.ok(request.observations.reduce((sum,row)=>sum+row.text.length,0)<=GOAL_LIMITS.evidenceChars);
  assert.ok(request.observations[0].text.includes('End of complete catalog.'));
 }
 const malicious=structuredClone(goal);malicious.evaluation.items[0].fields.model.evidence[0].quote='Made up stock';
 const request=JSON.parse(goalReviewRequest(malicious,[observation]).messages[0].content);
 assert.ok(!request.observations.some(row=>row.text.includes('Made up stock')),'stored ledger text never manufactures host evidence');
});

test('C3: a member slice follows its round allowance plus the delivery reserve',async()=>{
 const {memberDeadlineMs,TASK_EVALUATION_POLICY:p}=await import('./taskEvaluation.js');
 assert.equal(memberDeadlineMs(4),4*p.member.roundMilliseconds+p.member.deliveryReserveMs);
 assert.equal(memberDeadlineMs(2),2*p.member.roundMilliseconds+p.member.deliveryReserveMs);
 assert.equal(memberDeadlineMs(undefined),p.member.initialRounds*p.member.roundMilliseconds+p.member.deliveryReserveMs);
 assert.equal(memberDeadlineMs(99),p.member.maxRounds*p.member.roundMilliseconds+p.member.deliveryReserveMs,'never beyond the cumulative round cap');
 assert.ok(memberDeadlineMs(1)>=60000+p.member.deliveryReserveMs,'one round covers a full tool timeout');
 const budget={maxInputTokens:400000,used:{inputTokens:0},delivery:{inputTokens:65536},maxToolCalls:200};
 assert.equal(evaluate({version:1,op:'taskEvaluation',action:'allocation',budget,rounds:2}).value.deadlineMs,memberDeadlineMs(2));
 assert.equal(evaluate({version:1,op:'taskEvaluation',action:'allocation',budget}).value.deadlineMs,memberDeadlineMs());
});
