import {mkdtempSync,rmSync} from 'node:fs';import {test,after} from 'node:test';import assert from 'node:assert/strict';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
// Review C1 (2026-11-05): through the real execution graph, a member may repeat
// an unknown-effect action (browser paging) once its first run finished, while
// the lead's identical action is still not replayed by a member. Counters prove
// the physical executions; models and the action are fixtures.
const root=process.cwd();const home=mkdtempSync(join(tmpdir(),'melo-turn-effects-'));
const oldHome=process.env.MELO_HOME, oldCalling=process.env.MELO_FUNCTION_CALLING;process.env.MELO_HOME=home;process.env.MELO_FUNCTION_CALLING='legacy';
after(()=>{rmSync(home,{recursive:true,force:true});if(oldHome===undefined)delete process.env.MELO_HOME;else process.env.MELO_HOME=oldHome;if(oldCalling===undefined)delete process.env.MELO_FUNCTION_CALLING;else process.env.MELO_FUNCTION_CALLING=oldCalling;});
const get=p=>import(pathToFileURL(join(root,p)));
const {runChatAgentExecutionGraph}=await get('src/services/chat/chatExecutionRunner.js');
const {saveState}=await get('src/state/stateStore.js');
const {bootstrapBuiltinTools,registerTool,unregisterTool}=await get('src/tools/registry.js');bootstrapBuiltinTools();
const id='fixture_next_page';let clicks=0;
registerTool({id,name:id,description:'Local paging fixture with an undeclared effect',capability:'runCommands',requiresPermission:false,isConcurrencySafe:false,parametersSchema:{type:'object',properties:{target:{type:'string'}}},run:async()=>{clicks++;return {ok:true,output:'page '+clicks+' shown'};}});
const call=(name,args,id)=>'<tool_call>'+JSON.stringify({id,name,arguments:args})+'</tool_call>';
const base={replyLanguage:'en',authMode:'unset',apiKey:'',baseUrl:'',model:'opaque',toolCalling:'legacy'};
for(const mode of ['memberPages','leadThenMember'])await test('turn effects through the graph: '+mode,async()=>{
 clicks=0;let lead=0,member=0;const memberInputs=[];
 const goal='Open the next page of the listing twice and report what is shown.';
 const chat={id:'effects-'+mode,title:'fixture',mode:'chat',projectId:null,agentId:'main',messages:[{id:'user-'+mode,role:'user',content:goal}],sessionMemory:[]};
 const state={projects:[],chats:[chat],tasks:[],approvals:[],artifacts:[],commandRuns:[],externalConnectors:[],agentProfiles:{main:{id:'main',name:'Fixture',model:'opaque',tools:['local-command','external-connectors'],skills:[],channels:{},collaboration:{canDelegate:false}}},projectAgentOverrides:{},settings:{selectedProjectId:null,selectedChatId:chat.id,selectedAgentId:'main',activeMode:'chat',promptHistory:[]}};
 await saveState(state);
 await runChatAgentExecutionGraph({config:base,state,chat,workspace:{rootPath:home,exists:true,entries:[],filePaths:[],fileCount:0,commandTemplates:[],commandRuns:[]},connectors:[],skills:[],latestUserMessage:goal,agentId:'main',_dependencies:{turnTimeoutMs:20*60000,getEmbedding:async()=>null,createReply:async o=>{
  if(o.purpose==='routing-judge')return JSON.stringify({complexity:1,risk:'low',needs:{tools:true}});
  if(o.systemPrompt.startsWith("You are Melo's task completion checker"))return JSON.stringify({decision:'partial',evaluationValid:true,needsEvaluation:false,reasonType:'unavailable',reason:'fixture',requirements:[{text:'pages',kind:'external_effect',status:'unavailable',evidenceIds:[]}]});
  if(o.systemPrompt.includes('You are the internal execute specialist')){member++;memberInputs.push(JSON.stringify(o.messages));if(member<=2)return call(id,{target:'next'},'click-'+member);return 'Paging finished.';}
  lead++;
  if(mode==='leadThenMember'&&lead===1)return call(id,{target:'next'},'lead-click');
  if(lead===1||mode==='leadThenMember'&&lead===2)return call('route_task',{role:'execute',task:'Open the next page of the listing twice and report.'},'route1');
  return 'Done.';
 }}});
 assert.ok(member>=2,'the member ran at least two rounds');
 if(mode==='memberPages')assert.equal(clicks,2,'the same member may page twice with identical arguments');
 if(mode==='leadThenMember'){assert.equal(clicks,1,'a member never replays the lead\'s identical action');assert.ok(memberInputs.some(text=>text.includes('TURN_EFFECT_ALREADY_ATTEMPTED')),'the member is told the action already happened');}
});
unregisterTool(id);
