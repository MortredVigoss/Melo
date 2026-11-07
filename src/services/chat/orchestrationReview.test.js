import {mkdtempSync,rmSync} from 'node:fs';import {test,after} from 'node:test';import assert from 'node:assert/strict';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const root=process.cwd();const home=mkdtempSync(join(tmpdir(),'melo-graph-review-'));
const oldHome=process.env.MELO_HOME, oldCalling=process.env.MELO_FUNCTION_CALLING;process.env.MELO_HOME=home;process.env.MELO_FUNCTION_CALLING='legacy';after(()=>{rmSync(home,{recursive:true,force:true});if(oldHome===undefined)delete process.env.MELO_HOME;else process.env.MELO_HOME=oldHome;if(oldCalling===undefined)delete process.env.MELO_FUNCTION_CALLING;else process.env.MELO_FUNCTION_CALLING=oldCalling;});
const get=p=>import(pathToFileURL(join(root,p)));
const {runChatAgentExecutionGraph}=await get('src/services/chat/chatExecutionRunner.js');
const {currentRequestContext}=await get('src/runtime/requestScope.js');
const {saveState}=await get('src/state/stateStore.js');
const {bootstrapBuiltinTools,registerTool,unregisterTool}=await get('src/tools/registry.js');bootstrapBuiltinTools();
const id='audit_effect';let writes=0;
registerTool({id,name:id,description:'Local counter fixture only',effect:'write',capability:null,requiresPermission:false,isConcurrencySafe:false,parametersSchema:{type:'object',properties:{value:{type:'string'}}},run:async()=>{writes++;return {ok:true,output:'Counter committed'};}});
const call=(name,args,id)=>'<tool_call>'+JSON.stringify({id,name,arguments:args})+'</tool_call>';
const base={replyLanguage:'en',authMode:'unset',apiKey:'',baseUrl:'',model:'opaque',toolCalling:'legacy'};
const report=evidence=>JSON.stringify({decision:'complete',reasonType:'fulfilled',requirements:[{text:'requested outcome',kind:'external_effect',status:'met',evidenceIds:[evidence]}]});
const results={};
for(const mode of ['duplicate','lostReceipt','mainThenMember','legacySmartFixed','unverifiedReport'])await test('review regression: '+mode,async()=>{
 writes=0;let lead=0,member=0,judgments=0;const models=[];const budgetChecks=[];let evidence=mode==='unverifiedReport'?'job-1:report':'job-1:write';
 const chat={id:'audit-'+mode,title:'fixture',mode:'chat',projectId:null,agentId:'main',messages:[],sessionMemory:[]};
 const goal=mode==='legacySmartFixed'?'Read three files and summarize the results.':'Create one fixture record then verify it.';chat.messages=[{id:'user-'+mode,role:'user',content:goal}];
 const state={projects:[],chats:[chat],tasks:[],approvals:[],artifacts:[],commandRuns:[],externalConnectors:[],agentProfiles:{main:{id:'main',name:'Audit',model:mode==='legacySmartFixed'?'':'opaque',tools:['local-command','external-connectors'],skills:[],channels:{},collaboration:{canDelegate:false,...(mode==='legacySmartFixed'?{jobModels:{execute:'fixture'}}:{})}}},projectAgentOverrides:{},settings:{selectedProjectId:null,selectedChatId:chat.id,selectedAgentId:'main',activeMode:'chat',promptHistory:[]}};
 await saveState(state);
 const choice=model=>({connectionId:'fixture',model});
 const config=mode==='legacySmartFixed'?{...base,activeLlmProfileId:'fixture',authMode:'api-key',apiKey:'fixture',baseUrl:'http://127.0.0.1:1',model:'lower',llmProfiles:{fixture:{authMode:'api-key',apiKey:'fixture',baseUrl:'http://127.0.0.1:1',model:'lower',models:['lower','higher']}},smartRouting:{defaultMode:'smart',allowEscalation:true,tiers:{light:[choice('lower')],standard:[choice('higher')],strong:[choice('higher')]}}}:base;
 const r=await runChatAgentExecutionGraph({config,state,chat,workspace:{rootPath:home,exists:true,entries:[],filePaths:[],fileCount:0,commandTemplates:[],commandRuns:[]},connectors:[],skills:[],latestUserMessage:goal,agentId:'main',_dependencies:{turnTimeoutMs:20*60000,getEmbedding:async()=>null,createReply:async o=>{
  const activeBudget=currentRequestContext()?.budget;if(Number.isFinite(activeBudget?.hardDeadlineAt))budgetChecks.push(activeBudget.deadlineAt<=activeBudget.hardDeadlineAt);
  if(o.purpose==='routing-judge'){judgments++;return JSON.stringify({complexity:1,risk:'low',needs:{tools:true}});}
  const isMember=o.systemPrompt.includes('You are the internal execute specialist');
  models.push({model:o.model,phase:isMember?'member':o.systemPrompt.startsWith("You are Melo's task completion checker")?'check':'lead'});
  if(o.systemPrompt.startsWith("You are Melo's task completion checker")){const json=JSON.stringify(o.messages);if(mode==='unverifiedReport'&&!json.includes('job-1:report'))return JSON.stringify({decision:'partial',reasonType:'unavailable',requirements:[{text:'record created',kind:'external_effect',status:'missing',evidenceIds:[]}]});return report(json.includes('job-')?evidence:'write');}
  if(isMember){member++;if(mode==='unverifiedReport')return 'Record created, but I have no receipt.';if(mode==='lostReceipt'&&member===2)throw new Error('Simulated disconnect after write');return member%2===1?call(id,{value:'same'},'write'):'Record created.';}
  lead++;
  if(mode==='mainThenMember'&&lead===1)return call(id,{value:'same'},'lead-write');
  if(lead===1 || ['legacySmartFixed','mainThenMember'].includes(mode)&&lead===2)return call('route_task',{role:'execute',task:'Create the single requested fixture record.'},'route1');
  if(mode==='duplicate'&&lead===2){evidence='job-2:write';return call('route_task',{role:'execute',task:'Finish and verify the requested record.'},'route2');}
  if(mode==='lostReceipt'&&lead===2){evidence='retry-write';return call(id,{value:'same'},'retry-write');}
  return 'The requested record is created.';
 }}});
 assert.ok(budgetChecks.length&&budgetChecks.every(Boolean),'the exposed budget may not exceed the host hard deadline');
 results[mode]={writes,models,outcome:r.normalizedReply?.completion?.outcome};
 if(['duplicate','lostReceipt','mainThenMember'].includes(mode))assert.equal(writes,1,'same effect must execute only once across the complete turn');
 if(mode==='legacySmartFixed'){assert.equal(writes,1,'the selected model executes the effect only once');assert.equal(judgments,0,'legacy smart settings must not send a model judgment');assert.ok(models.some(r=>r.phase==='member'),'the assignment must actually execute');assert.ok(models.every(r=>r.model==='lower'),'lead, member and completion check must keep the explicitly selected model');}
 if(mode==='unverifiedReport'){assert.equal(writes,0);assert.notEqual(r.normalizedReply?.completion?.outcome,'completed','member prose cannot prove execution');}
});
await test('member cancellation after a successful effect preserves its receipt and starts no further tool',async()=>{
 const {runSubAgent}=await get('src/testSupport/directAgentFixture.js');
 writes=0;let requests=0;const controller=new AbortController();
 const result=await runSubAgent({task:'Create one record.',allowedToolIds:[id],config:base,workspacePath:home,signal:controller.signal,
  replyFn:async()=>{requests++;if(requests===1)return call(id,{value:'cancel'},'written');controller.abort(new Error('user cancelled'));throw controller.signal.reason;}});
 assert.equal(writes,1);assert.equal(requests,2);assert.equal(result.ok,false);assert.equal(result.meta.aborted,true);
 assert.equal(result.meta.effects.successful.length,1);assert.ok(result.meta.observations.some(row=>row.id==='written'&&row.ok&&row.executed));
});
unregisterTool(id);
