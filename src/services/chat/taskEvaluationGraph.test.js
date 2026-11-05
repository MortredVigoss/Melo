import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home=mkdtempSync(join(tmpdir(),'melo-evaluation-graph-'));
const oldHome=process.env.MELO_HOME,oldCalling=process.env.MELO_FUNCTION_CALLING;
process.env.MELO_HOME=home;process.env.MELO_FUNCTION_CALLING='legacy';
after(()=>{rmSync(home,{recursive:true,force:true});if(oldHome===undefined)delete process.env.MELO_HOME;else process.env.MELO_HOME=oldHome;if(oldCalling===undefined)delete process.env.MELO_FUNCTION_CALLING;else process.env.MELO_FUNCTION_CALLING=oldCalling;});
const {runChatAgentExecutionGraph}=await import('./chatExecutionRunner.js');
const {saveState}=await import('../../state/stateStore.js');
const {bootstrapBuiltinTools,registerTool,unregisterTool}=await import('../../tools/registry.js');bootstrapBuiltinTools();
const call=(name,args,id)=>'<tool_call>'+JSON.stringify({id,name,arguments:args})+'</tool_call>';
for(const count of [8,20])await test(`full graph: ${count}/20 products, real reads vs coordinator control calls`,async()=>{
 let executions=0,lead=0,checks=0;const events=[];
 const items=Array.from({length:count},(_,i)=>{
  const quote=`Catalog model ${i}: Model ${i}, price 100 AUD, region AU, available now.`;
  return {fields:Object.fromEntries(Object.entries({name:'Catalog model '+i,model:'Model '+i,price:100,currency:'AUD',region:'AU',availability:'available'}).map(([k,value])=>[k,{value,evidence:[{id:'catalog-read',quote}]}])),match:35,diversity:8,reason:'Meets the user catalog request.',conflicts:[],tags:[]};
 });
 const tool='evaluation_catalog_read';
 registerTool({id:tool,name:tool,description:'Read the local test product catalog',effect:'read',capability:null,requiresPermission:false,parametersSchema:{type:'object',properties:{}},run:async()=>{executions++;return {ok:true,output:items.map(i=>i.fields.name.evidence[0].quote).join('\n')};}});
 try{
 const goal='Find 20 products from the local catalog with verified prices and availability.';
 const chat={id:'evaluation-'+count,title:'fixture',mode:'chat',projectId:null,agentId:'main',messages:[{id:'u',role:'user',content:goal}],sessionMemory:[]};
 const state={projects:[],chats:[chat],tasks:[],approvals:[],artifacts:[],commandRuns:[],externalConnectors:[],agentProfiles:{main:{id:'main',name:'Fixture',model:'opaque',tools:['local-files'],skills:[],channels:{},evaluationMode:'quick',collaboration:{canDelegate:false}}},projectAgentOverrides:{},settings:{selectedProjectId:null,selectedChatId:chat.id,selectedAgentId:'main',activeMode:'chat',promptHistory:[]}};
 await saveState(state);
 const result=await runChatAgentExecutionGraph({config:{replyLanguage:'en',authMode:'unset',apiKey:'',baseUrl:'',model:'opaque',toolCalling:'legacy'},state,chat,workspace:{rootPath:home,exists:true,entries:[],filePaths:[],fileCount:0,commandTemplates:[],commandRuns:[]},connectors:[],skills:[],latestUserMessage:goal,agentId:'main',sseEmitter:(type,event)=>events.push({type,...event}),_dependencies:{getEmbedding:async()=>null,createReply:async request=>{
  if(request.systemPrompt.startsWith("You are Melo's task completion checker")){checks++;return JSON.stringify({decision:'complete',evaluationValid:true,reason:'Reported items checked',requirements:[{text:'20 products',kind:'external_fact',status:'met',evidenceIds:['catalog-read']}]});}
  lead++;
  if(lead===1)return call('task_progress',{action:'contract',data:JSON.stringify({category:'products',explicitCount:{value:20,quote:'20 products'},mode:'deep'})},'contract');
  if(lead===2)return call(tool,{},'catalog-read');
  if(lead===3)return call('task_progress',{action:'batch',data:JSON.stringify({items,gaps:[]})},'batch');
  return `Found ${count} catalog products. ${count<20?'12 are still missing.':''}`;
 }}});
 const receipt=result.normalizedReply.completion;
 assert.equal(executions,1,'bookkeeping is never dispatched as a physical tool');
 assert.ok(checks>0,'final no-tool checker ran');assert.equal(receipt.task.evaluation.contract.mode,'quick','host preference wins over model');
 assert.equal(receipt.task.evaluation.summary.verified,count);
 assert.equal(receipt.outcome,count===20?'completed':'partial');
 assert.ok(events.some(event=>event.id?.startsWith('task-evaluation:')&&event.output.includes(`${count}/20`)));
 // Plan C: each evaluation stage carries the bounded ledger view, built after
 // the update and never dispatched as a tool (executions stays 1 above).
 const snapshots=events.filter(event=>event.id?.startsWith('task-evaluation:')).map(event=>event.evaluation);
 assert.equal(snapshots.length,2);assert.ok(snapshots.every(Boolean),'every evaluation stage carries a snapshot');
 assert.equal(snapshots[0].contract.explicit.value,20);assert.equal(snapshots[0].summary.discovered,0);
 const last=snapshots.at(-1);assert.equal(last.summary.verified,count);assert.equal(last.summary.discovered,count);
 assert.equal(last.candidates.length,Math.min(count,24));assert.equal(last.summary.omitted,0);
 assert.equal(last.summary.stop,count===20?'ready_for_review':'continue');
 assert.ok(last.candidates.every(row=>Object.values(row.fields).every(value=>value==='verified')));
 assert.ok(!JSON.stringify(last).includes('price 100 AUD, region AU'),'no evidence text in the scene view');
 }finally{unregisterTool(tool);}
});
