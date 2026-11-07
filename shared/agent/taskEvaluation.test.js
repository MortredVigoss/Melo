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

// 2026-11-07 review P1-1: quick by default, only the user's count is fixed,
// one entry per entity with its first source, and repeats end a soft search.
test('plan A: the quick target is the default on every path that leaves the mode unset',()=>{
 const f=fixtures.find(f=>f.name.includes('three eligible entities suffice'));
 const viaGoal=goalOperation({action:'progress',state:startGoal(f.steps[0].context.goal),progress:f.steps[0].args});
 assert.deepEqual(viaGoal.evaluation.contract.target,{minimum:3,maximum:5,initial:8});assert.equal(viaGoal.evaluation.contract.mode,'quick');
 for(const mode of [undefined,null,'','bogus'])assert.equal(updateTaskEvaluation(null,f.steps[0].args,{...f.steps[0].context,mode}).contract.mode,'quick',String(mode));
 assert.equal(updateTaskEvaluation(null,f.steps[0].args,{...f.steps[0].context,mode:'deep'}).contract.target.minimum,8,'an Agent setting still chooses a deeper search');
});

test('plan A: a repeat from another site keeps the first verified source and only fills missing fields',()=>{
 const f=fixtures.find(f=>f.name.includes('only repeat a known entity'));const [contract,first,second]=f.steps;
 let state=updateTaskEvaluation(updateTaskEvaluation(null,contract.args,contract.context),first.args,first.context);
 const repeat=JSON.parse(second.args.data).items[0];
 repeat.fields.price.value=5;repeat.fields.access={value:'Public entry available',evidence:repeat.fields.name.evidence};
 state=updateTaskEvaluation(state,{action:'batch',data:JSON.stringify({items:[repeat],gaps:[]})},second.context);
 assert.equal(state.error,null);assert.equal(state.items.length,1,'one entry per entity');
 const row=state.items[0];
 assert.equal(row.fields.price.value,0);assert.deepEqual(row.fields.price.evidence.map(ref=>ref.id),['s0'],'a later site never replaces a verified field');
 assert.deepEqual(row.fields.name.evidence.map(ref=>ref.id),['s0'],'the first verified source is kept');
 assert.deepEqual(row.fields.access.evidence.map(ref=>ref.id),['s1'],'a later site fills a field that was missing');
 assert.deepEqual(state.batches.at(-1),{inspected:0,fresh:1,newQualified:0},'a repeat read from a new page is a sample, not a new entity');
});

test('plan A: a repeat cited twice from the same page is read once',()=>{
 const f=fixtures.find(f=>f.name.includes('only repeat a known entity'));const [contract,first,second]=f.steps;
 let state=updateTaskEvaluation(updateTaskEvaluation(null,contract.args,contract.context),first.args,first.context);
 state=updateTaskEvaluation(state,second.args,second.context);assert.equal(state.batches.at(-1).fresh,1);
 state=updateTaskEvaluation(state,second.args,second.context);assert.equal(state.batches.at(-1).fresh,0,'the same repeat page is no new read');
 assert.equal(state.summary.diminishing,false);assert.equal(state.summary.stop,'continue');
});

test('plan A: the same page read again under another call or member is one page; other pages and changed bodies are new',()=>{
 const f=fixtures.find(f=>f.name.includes('only repeat a known entity'));const [contract,first]=f.steps;
 const base=first.context.observations[0];
 const reread=(id,url,text=base.text)=>({...base,id,url,text});
 const observations=[...first.context.observations,reread('job-2:again','HTTPS://Fixture.example/s0/?utm_source=feed&utm_campaign=n#top'),reread('job-3:again','https://fixture.example/s0?utm_medium=a&utm_source=b&utm_term=c')];
 const via=id=>{const data=JSON.parse(first.args.data);for(const field of Object.values(data.items[0].fields))field.evidence=[{id,quote:base.text}];return {action:'batch',data:JSON.stringify(data)};};
 let state=updateTaskEvaluation(null,contract.args,contract.context);
 state=updateTaskEvaluation(state,via('s0'),{...first.context,observations});
 state=updateTaskEvaluation(state,via('job-2:again'),{...first.context,observations});assert.equal(state.batches.at(-1).fresh,0,'tracking, fragment, slash and case do not make a new page');
 state=updateTaskEvaluation(state,via('job-3:again'),{...first.context,observations});assert.equal(state.batches.at(-1).fresh,0);
 assert.equal(state.summary.diminishing,false);assert.equal(state.summary.stop,'continue','re-reading one page cannot end the search');
 const more=[...observations,reread('page-2','https://fixture.example/s0?page=2&utm_source=x',base.text+' Second page of results.'),reread('updated','https://fixture.example/s0',base.text+' Updated listing.'),reread('same-2','https://fixture.example/s0?utm_source=y&page=2',base.text+' Second page of results.')];
 const paged=updateTaskEvaluation(state,via('page-2'),{...first.context,observations:more});assert.equal(paged.batches.at(-1).fresh,1,'another result page is a new read');
 assert.equal(updateTaskEvaluation(paged,via('same-2'),{...first.context,observations:more}).batches.at(-1).fresh,0,'the business query stays, tracking order does not matter');
 const changed=updateTaskEvaluation(state,via('updated'),{...first.context,observations:more});assert.equal(changed.batches.at(-1).fresh,1,'a changed body is a new read');
});

test('plan A: a same-turn revision may only add requirements',()=>{
 const f=fixtures.find(f=>f.name.includes('three eligible entities suffice'));const [contract,batch]=f.steps;
 const withField={action:'contract',data:JSON.stringify({category:'events',unit:'events',requiredFields:['ticketUrl'],coverage:['outdoor']})};
 let state=updateTaskEvaluation(updateTaskEvaluation(null,withField,contract.context),batch.args,batch.context);
 assert.equal(state.summary.verified,0,'no candidate proves the ticket URL');
 for(const [name,data] of [['drops a field',{category:'events',unit:'events',coverage:['outdoor']}],['drops coverage',{category:'events',unit:'events',requiredFields:['ticketUrl']}],['changes category',{category:'other',unit:'events',requiredFields:['ticketUrl'],coverage:['outdoor']}]]){
  const next=updateTaskEvaluation(state,{action:'contract',data:JSON.stringify(data)},contract.context);
  assert.match(next.error,/may only add requirements/,name);assert.equal(next.summary.verified,0,name);assert.deepEqual(next.contract.requiredFields,state.contract.requiredFields,name);
 }
 const added=updateTaskEvaluation(state,{action:'contract',data:JSON.stringify({category:'events',unit:'events',requiredFields:['ticketUrl','organizer'],coverage:['outdoor','music']})},contract.context);
 assert.equal(added.error,null);assert.ok(added.contract.requiredFields.includes('organizer')&&added.contract.coverage.includes('music'));
 // Even a stricter category changes how entities are identified, so it stays fixed within the turn.
 const loose=updateTaskEvaluation(null,{action:'contract',data:JSON.stringify({category:'other',unit:'places',requiredFields:['ticketUrl']})},contract.context);
 const recategorized=updateTaskEvaluation(loose,{action:'contract',data:JSON.stringify({category:'events',unit:'events',requiredFields:['ticketUrl']})},contract.context);
 assert.match(recategorized.error,/may only add requirements/);assert.equal(recategorized.contract.category,'other');
});

test('plan A: a provider answer of any length is never read page text',async()=>{
 const { completionObservation } = await import('./completion.js');
 const f=fixtures.find(f=>f.name.includes('three eligible entities suffice'));const [contract,batch]=f.steps;
 const pages=batch.context.observations.slice(0,3);
 const counted=(reading,pad)=>{
  const rows=completionObservation({id:'hosted:0',name:'web_search',ok:true,executed:true,output:'Provider-reported completed Search',sources:pages.map(row=>({url:row.url,...(reading?{reading}:{}),text:row.text+pad}))});
  const data=JSON.parse(batch.args.data);data.items.forEach((item,index)=>{for(const field of Object.values(item.fields))field.evidence=field.evidence.map(ref=>({...ref,id:'hosted:0:source:'+index}));});
  const state=updateTaskEvaluation(updateTaskEvaluation(null,contract.args,contract.context),{action:'batch',data:JSON.stringify(data)},{...batch.context,observations:rows});
  return [state.summary.verified,state.summary.read,state.summary.stop];
 };
 assert.deepEqual(counted('provider',''),[0,0,'continue']);
 assert.deepEqual(counted('provider',' '+'x'.repeat(17000)),[0,0,'continue'],'length alone never turns a provider answer into a read');
 assert.deepEqual(counted(undefined,' '+'x'.repeat(17000)),[3,3,'ready_for_review'],'a partially read page still counts');
});

test('plan A: two low-yield batches stop a soft search even without a verified entity, and gaps no longer block it',()=>{
 const f=fixtures.find(f=>f.name.includes('only repeat a known entity'));const [contract,first,second,third]=f.steps;
 const pending=batch=>{const data=JSON.parse(batch.args.data);data.items[0].fields.participation.value='private';return {...batch,args:{action:'batch',data:JSON.stringify(data)}};};
 let state=updateTaskEvaluation(null,contract.args,contract.context);
 for(const step of [first,second,third].map(pending))state=updateTaskEvaluation(state,step.args,step.context);
 assert.equal(state.summary.verified,0);assert.equal(state.summary.exhausted,true);assert.equal(state.summary.stop,'continue','nothing eligible cannot be delivered as complete');
 assert.equal(state.summary.nextBatch,0,'but the search stops');assert.ok(state.summary.gaps.some(gap=>gap.startsWith('Two batches in a row added nothing new')));
 let gapped=updateTaskEvaluation(null,contract.args,contract.context);
 for(const step of [first,second,third]){const data=JSON.parse(step.args.data);data.gaps=['Indoor events not found'];gapped=updateTaskEvaluation(gapped,{action:'batch',data:JSON.stringify(data)},step.context);}
 assert.equal(gapped.summary.stop,'ready_for_review','an exhausted soft search delivers what is verified and discloses gaps');assert.ok(gapped.summary.gaps.includes('Indoor events not found'));
 const early=updateTaskEvaluation(updateTaskEvaluation(null,contract.args,contract.context),{action:'batch',data:JSON.stringify({...JSON.parse(first.args.data),gaps:['Indoor events not found']})},first.context);
 assert.equal(early.summary.stop,'continue','before the search is exhausted a declared gap still blocks delivery');
});

test('plan A: an exhausted search delivers an alternative-grade entity, never an irrelevant one',()=>{
 const f=fixtures.find(f=>f.name.includes('only repeat a known entity'));const [contract,...batches]=f.steps;
 const scored=(match,step)=>{const data=JSON.parse(step.args.data);data.items[0].match=match;data.items[0].diversity=0;return {...step,args:{action:'batch',data:JSON.stringify(data)}};};
 const run=match=>batches.map(step=>scored(match,step)).reduce((state,step)=>updateTaskEvaluation(state,step.args,step.context),updateTaskEvaluation(null,contract.args,contract.context));
 const alternative=run(10);assert.equal(alternative.summary.recommended,0);assert.equal(alternative.summary.alternatives,1);
 assert.equal(alternative.summary.stop,'ready_for_review','after two empty batches the best eligible alternative is delivered');
 const irrelevant=run(0);assert.equal(irrelevant.summary.verified,1);assert.equal(irrelevant.summary.alternatives,0);
 assert.equal(irrelevant.summary.stop,'continue','an eligible but unrelated entity is not an answer');
 const three=JSON.parse(fixtures.find(f=>f.name.includes('three eligible entities suffice')).steps[1].args.data);for(const item of three.items)item.match=10;
 const unadjusted=updateTaskEvaluation(updateTaskEvaluation(null,contract.args,contract.context),{action:'batch',data:JSON.stringify(three)},batches[0].context);
 assert.equal(unadjusted.summary.verified,3);assert.equal(unadjusted.summary.stop,'continue','without exhaustion or an adjustment a primary recommendation is still required');
});

test('plan A: a cited adjustment lowers only a soft target, without waiting for low yield',()=>{
 const f=fixtures.find(f=>f.name.includes('only repeat a known entity'));const [contract,first]=f.steps;
 const obs=first.context.observations[0];const adjustment={reason:'Only one public event is listed for this date.',evidence:[{id:obs.id,quote:obs.text}]};
 const data=JSON.stringify({...JSON.parse(first.args.data),adjustment});
 const soft=updateTaskEvaluation(updateTaskEvaluation(null,contract.args,contract.context),{action:'batch',data},first.context);
 assert.equal(soft.summary.diminishing,false);assert.equal(soft.summary.adjusted,true);assert.equal(soft.summary.stop,'ready_for_review');
 const explicitContract={action:'contract',data:JSON.stringify({category:'events',unit:'events',explicitCount:{value:20,quote:'20 products'}})};
 const explicit=updateTaskEvaluation(updateTaskEvaluation(null,explicitContract,contract.context),{action:'batch',data},first.context);
 assert.equal(explicit.summary.adjusted,false);assert.equal(explicit.summary.stop,'continue');
 const unsupported=updateTaskEvaluation(updateTaskEvaluation(null,contract.args,contract.context),{action:'batch',data:JSON.stringify({...JSON.parse(first.args.data),adjustment:{reason:'Only one exists.',evidence:[{id:obs.id,quote:'invented scarcity quote'}]}})},first.context);
 assert.equal(unsupported.summary.adjusted,false,'an adjustment needs a quote that the read page really contains');
});

test('plan A: only a count in the user words is frozen',()=>{
 const f=fixtures.find(f=>f.name.includes('may be corrected but keeps every condition'));const [first,added]=f.steps;
 let state=updateTaskEvaluation(null,first.args,first.context);state=updateTaskEvaluation(state,added.args,added.context);
 assert.equal(state.error,null);assert.equal(state.contract.constraints.length,1,'a soft contract can be corrected in the same turn');
 const raised=updateTaskEvaluation(state,{action:'contract',data:JSON.stringify({category:'events',unit:'events',explicitCount:{value:20,quote:'20 products'},constraints:state.contract.constraints})},first.context);
 assert.equal(raised.error,null);assert.equal(raised.contract.target.minimum,20,'a missed user count can still be added');
 const lowered=updateTaskEvaluation(raised,first.args,first.context);assert.match(lowered.error,/frozen/);assert.equal(lowered.contract.target.minimum,20);
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
