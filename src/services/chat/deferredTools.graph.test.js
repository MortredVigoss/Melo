import {mkdtempSync,rmSync} from 'node:fs';import {test} from 'node:test';import assert from 'node:assert/strict';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
// One parent test owns the fixture home and the fixture MCP server (see src/runtime/testIsolation.test.js).
await test('deferred tool definitions through the graph stay inside their fixture home',async t=>{
// 2026-11-10 latency audit L4, through the real execution graph on a native
// tool protocol: the lead's first request carries no MCP definition, a
// load_tools call adds exactly the named one to the next request, and the
// loaded tool then runs once. The model and the MCP server are fixtures.
const root=process.cwd();const home=mkdtempSync(join(tmpdir(),'melo-deferred-tools-'));
const oldHome=process.env.MELO_HOME, oldCalling=process.env.MELO_FUNCTION_CALLING;process.env.MELO_HOME=home;process.env.MELO_FUNCTION_CALLING='native';
const get=p=>import(pathToFileURL(join(root,p)));
const {runChatAgentExecutionGraph}=await get('src/services/chat/chatExecutionRunner.js');
const {saveState}=await get('src/state/stateStore.js');
const {bootstrapBuiltinTools}=await get('src/tools/registry.js');bootstrapBuiltinTools();
const {registerMcpTools,unregisterMcpServer}=await get('src/tools/mcpRegistry.js');
let charts=0;
registerMcpTools(Array.from({length:8},(_,index)=>({id:'mcp:fixturecharts:chart_'+index,name:'chart '+index,description:'Draw fixture chart '+index+' from rows of data. More detail follows here.',requiresPermission:false,readOnly:true,
 parametersSchema:{type:'object',properties:{rows:{type:'array',items:{type:'object',properties:{label:{type:'string'},value:{type:'number'}}},description:'Rows of the chart. '+'detail '.repeat(400)}},required:['rows']},
 run:async()=>{charts++;return {ok:true,output:'chart '+index+' drawn as chart-'+index+'.png'};}})));
t.after(()=>{try{unregisterMcpServer('fixturecharts');}catch{}rmSync(home,{recursive:true,force:true});if(oldHome===undefined)delete process.env.MELO_HOME;else process.env.MELO_HOME=oldHome;if(oldCalling===undefined)delete process.env.MELO_FUNCTION_CALLING;else process.env.MELO_FUNCTION_CALLING=oldCalling;});
const base={replyLanguage:'en',authMode:'unset',apiKey:'',baseUrl:'',model:'opaque',toolCalling:'native'};
const calls=list=>({protocol:'chat-completions',text:'',message:{role:'assistant',content:'',tool_calls:list.map(([id,name,args])=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}}))}});
const say=text=>({protocol:'chat-completions',text,message:{role:'assistant',content:text}});
const names=o=>(o.functionTools||[]).map(tool=>tool.function?.name||tool.name);
async function turn(mode,config=base){
 assert.equal(process.env.MELO_HOME,home,'this test still runs inside its fixture home');
 charts=0;const requests=[];
 const goal='Summarise the fixture rows A=3, B=5, C=2 with the fixture tool.';
 const chat={id:'deferred-'+mode,title:'fixture',mode:'chat',projectId:null,agentId:'main',messages:[{id:'user-'+mode,role:'user',content:goal}],sessionMemory:[]};
 const state={projects:[],chats:[chat],tasks:[],approvals:[],artifacts:[],commandRuns:[],externalConnectors:[],agentProfiles:{main:{id:'main',name:'Fixture',model:'opaque',tools:['local-command','external-connectors'],enabledMcpServerIds:['fixturecharts'],skills:[],channels:{},collaboration:{canDelegate:false}}},projectAgentOverrides:{},settings:{selectedProjectId:null,selectedChatId:chat.id,selectedAgentId:'main',activeMode:'chat',promptHistory:[]}};
 await saveState(state);
 const result=await runChatAgentExecutionGraph({config,state,chat,workspace:{rootPath:home,exists:true,entries:[],filePaths:[],fileCount:0,commandTemplates:[],commandRuns:[]},connectors:[],skills:[],latestUserMessage:goal,agentId:'main',_dependencies:{turnTimeoutMs:20*60000,getEmbedding:async()=>null,createReply:async o=>{
  if(o.purpose==='routing-judge')return JSON.stringify({complexity:1,risk:'low',needs:{tools:true}});
  if(String(o.systemPrompt).startsWith("You are Melo's task completion checker"))return JSON.stringify({decision:'partial',evaluationValid:true,needsEvaluation:false,reasonType:'unavailable',reason:'fixture',requirements:[{text:'chart',kind:'external_effect',status:'unavailable',evidenceIds:[]}]});
  requests.push({tools:names(o),loader:(o.functionTools||[]).find(tool=>(tool.function?.name||tool.name)==='load_tools'),messages:JSON.stringify(o.messages)});
  const step=requests.length;
  if(mode==='load'){if(step===1)return calls([['load-1','load_tools',{names:['mcp__fixturecharts__chart_2']}]]);if(step===2)return calls([['chart-1','mcp__fixturecharts__chart_2',{rows:[{label:'A',value:3}]}]]);}
  if(mode==='unloaded'&&step===1)return calls([['chart-1','mcp__fixturecharts__chart_2',{rows:[{label:'A',value:3}]}]]);
  if(mode==='off'&&step===1)return calls([['chart-1','mcp__fixturecharts__chart_2',{rows:[{label:'A',value:3}]}]]);
  return say('Chart done.');
 }}});
 return {requests,result};
}
const fixtureNames=list=>list.filter(name=>name.startsWith('mcp__fixturecharts__'));
await t.test('the lead loads one MCP definition on demand and then runs the tool once',async()=>{
 const {requests}=await turn('load');
 assert.equal(requests.length,3);
 assert.deepEqual(fixtureNames(requests[0].tools),[],'no MCP definition in the first request');
 assert.ok(requests[0].tools.includes('load_tools'));
 const description=requests[0].loader.function?.description||requests[0].loader.description;
 for(let index=0;index<8;index++)assert.match(description,new RegExp('- mcp__fixturecharts__chart_'+index+': Draw fixture chart '+index+' from rows of data\\.'));
 assert.deepEqual(fixtureNames(requests[1].tools),['mcp__fixturecharts__chart_2'],'exactly the loaded definition is added');
 assert.deepEqual(requests[1].tools.slice(0,requests[0].tools.length),requests[0].tools,'the earlier definitions keep their order, so the request prefix stays cacheable');
 assert.match(requests[1].messages,/now callable/);
 assert.equal(charts,1,'the loaded tool ran once');
 assert.match(requests[2].messages,/chart 2 drawn/);
 assert.deepEqual(fixtureNames(requests[2].tools),['mcp__fixturecharts__chart_2']);
});
await t.test('a listed tool called before loading does not run and the lead is told how to load it',async()=>{
 const {requests}=await turn('unloaded');
 assert.equal(charts,0);
 assert.match(requests[1].messages,/TOOL_NOT_LOADED/);assert.match(requests[1].messages,/is not loaded\. Call load_tools with/);
});
await t.test('with deferring switched off every definition is sent as before',async()=>{
 const {requests}=await turn('off',{...base,deferredTools:false});
 assert.equal(fixtureNames(requests[0].tools).length,8);
 assert.equal(requests[0].tools.includes('load_tools'),false);
 assert.equal(charts,1);
});
});
