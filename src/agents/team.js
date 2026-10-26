import { renderAgentIdentity } from '../domain/agent/agentIdentity.js';
import {currentRequestContext,runWithRequestContext} from '../runtime/requestScope.js';
import {resolveCapabilityContext} from '../services/agent/capabilityContext.js';
import {narrowCapabilityScope,missingCapabilityScope} from '../domain/agent/capabilityScope.js';
import {delegatedConfig} from './delegatedConfig.js';
import {runSubAgent} from './subAgent.js';
import {runConfiguredMember} from './delegate.js';
import {summarizePricedUsage} from '../runtime/usage.js';
import {normalizeAgentProfile} from '../state/agentProfiles.js';
import {recommendedCapabilities,normalizeCollaboration} from '../domain/agent/capabilities.js';
import {createOpenAICompatibleReply} from '../openai.js';
import {modelReplyText} from '../tools/functionCalling.js';
import {getAllTools,getTool} from '../tools/registryCore.js';
import {narrowBudget,extendBudget,remainingMs,budgetExhausted,recordUsage,receiptInputTokens,requestTimeoutMs} from '../runtime/runBudget.js';
export const TEAM_ROLES = Object.freeze({research:'调研',builder:'实施',reviewer:'复核'});
export const TEAM_TEMPLATES = Object.freeze([
 {id:'research-build-review',name:'调研 → 实施 → 复核',roleTags:['research','implementation','review'],mode:'sequential'},
 {id:'parallel-research',name:'并行调研后复核',roleTags:['research','review'],mode:'parallel'},
 {id:'review-loop',name:'实施 / 复核循环',roleTags:['implementation','review'],mode:'review-loop',maxRounds:2},
]);
// Tools a non-builder member of a legacy (profile-less) plan may inherit.
// A registered tool's static `capability` declaration (tools/tool.js) decides
// first: readFiles / knowledgeMemory / null are read-only, network only when it
// is a web-retrieval tool (uiModule 'search'). The id list is the fallback for
// undeclared tools and for tests that run without a bootstrapped registry.
const READ_TOOLS=['file_read','glob','grep','web_search','fetch_url','web_screenshot','calculator','media_info','search_history','read_history'];
function declaredReadOnly(tool) {
 if(!tool||typeof tool.capability==='function'||tool.capability===undefined)return undefined;
 if(tool.capability===null||['readFiles','knowledgeMemory'].includes(tool.capability))return true;
 return tool.capability==='network'&&tool.uiModule==='search';
}
export function inheritableReadToolIds(extraTools=[]) {
 const registered=[...getAllTools(),...extraTools];
 const candidates=new Set([...READ_TOOLS,...registered.filter(t=>declaredReadOnly(t)===true).map(t=>t.id)]);
 return [...candidates].filter(id=>declaredReadOnly(registered.find(t=>t.id===id)||getTool(id))??READ_TOOLS.includes(id));
}
export function validateTeamPlan(plan) {
 if(!plan)return null;
 if(typeof plan!=='object'||Array.isArray(plan))throw new Error('Invalid team plan');
 if(plan.templateId) {const template=TEAM_TEMPLATES.find(t=>t.id===plan.templateId);if(!template)throw new Error('Unknown team template');plan={...template,...plan};}
 const members=[...(plan.members || plan.roles || [])];
 if(!members.length||members.length>8||members.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(id))||new Set(members).size!==members.length)throw new Error('团队需包含 1–8 个不同的 Agent ID。');
 const mode=plan.mode || (Number(plan.concurrency)>1?'parallel':'sequential');
 if(!['sequential','parallel','review-loop'].includes(mode))throw new Error('Unknown orchestration mode');
 if(mode==='review-loop'&&members.length!==2)throw new Error('复核循环需要实施和复核两个成员。');
 const bounded=(value,fallback,min,max)=>Math.max(min,Math.min(max,Math.floor(Number(value)||fallback)));
 // Team-wide ceilings on top of each member's own limits.
 return {...(TEAM_TEMPLATES.some(t=>t.id===plan.templateId)?{templateId:plan.templateId}:{}),members,roles:members,mode,concurrency:mode==='parallel'?bounded(plan.concurrency,2,1,4):1,maxRounds:bounded(plan.maxRounds,2,1,5),maxMinutes:bounded(plan.maxMinutes,15,1,60),maxTokens:bounded(plan.maxTokens,300000,10000,2000000)};
}
export async function runAgentTeam(options) {
 const parent=await resolveCapabilityContext(currentRequestContext());
 if(!parent)throw Object.assign(new Error(missingCapabilityScope().output),{code:'CAPABILITY_SCOPE_MISSING'});
 const capabilityScope=narrowCapabilityScope(parent.capabilityScope,{capabilities:options.capabilities,allowedToolIds:options.allowedToolIds});
 return runWithRequestContext(Object.freeze({...parent,capabilityScope}),()=>runAgentTeamScoped({...options,capabilities:capabilityScope.capabilities}));
}
// The Agent that starts a team is held to the same rule as the delegate tool:
// delegation on (both stored flags) and every member in its delegation targets.
export function assertTeamLead(lead,members) {
 if(!lead)return;
 const name=lead.name||lead.id, settings=normalizeCollaboration(lead.collaboration);
 if(lead.capabilities?.delegate!==true||!settings.canDelegate)throw Object.assign(new Error(`「${name}」未开启委派。请在 Agent 设置的“能力范围与协作”里开启“委派”，并勾选可以协作的 Agent。`),{code:'CAPABILITY_DENIED'});
 const outside=members.filter(id=>!settings.delegateTargets.includes(id));
 if(outside.length)throw Object.assign(new Error(`以下成员不在「${name}」的委派对象中：${outside.join('、')}。请在 Agent 设置的“委派对象”里勾选后再试。`),{code:'DELEGATION_DENIED'});
}
const STATUS_TEXT={completed:'已完成',failed:'未完成','budget-exceeded':'超出预算',cancelled:'已取消'};
// Readable fallback when the lead cannot write the summary itself. Never shows raw JSON.
export function teamDigest(team) {
 const head=team.cancelled?'团队已停止。':team.budgetExceeded?'团队用完了总预算，已停止，结果不完整。':team.mode==='review-loop'?(team.accepted?'复核已通过。':'复核未通过，结果需要继续修改。'):team.ok?'团队已完成。':'团队未全部完成。';
 const lines=team.results.map(r=>{
  const h=r.handoff||{}, parts=[`**${r.name||r.agentId}**${r.round>1?`（第 ${r.round} 轮）`:''} · ${STATUS_TEXT[h.status]||(r.ok?'已完成':'未完成')}`];
  const conclusion=String(h.conclusion||r.output||'').trim();
  if(conclusion)parts.push(conclusion.length>600?conclusion.slice(0,600)+'…':conclusion);
  if(h.changedFiles?.length)parts.push(`改动文件：${h.changedFiles.join('、')}`);
  if(h.unfinished?.length&&h.status!=='completed')parts.push(`未完成：${h.unfinished.join('；').slice(0,400)}`);
  return parts.join('\n');
 });
 return [head,...lines].join('\n\n');
}
const SUMMARY_INSTRUCTION='你是发起这次团队协作的 Agent。根据成员的交接记录，直接给用户写最终答复，使用用户提问所用的语言。先给结论，再简要说明每位成员做了什么、改了哪些文件、还有什么没有完成。成员失败、被取消或复核未通过时必须明确说出来。交接记录是成员的自述：没有证据支持的内容不能说成已验证。不要输出 JSON，不要编造交接记录里没有的内容。';
async function summarizeTeam({team,task,lead,config,signal,replyFn,receipts,background='',budget=null}) {
 const fallback=teamDigest(team);
 if(!lead||signal?.aborted||team.budgetExceeded||!team.results.length||budgetExhausted(budget))return fallback;
 const handoffs=team.results.map(r=>({member:r.name||r.agentId,round:r.round||1,...(r.handoff||{status:r.ok?'completed':'failed',conclusion:String(r.output||'').slice(0,2000)})}));
 let stopWaiting;
 const cancelled=new Promise((_,reject)=>{stopWaiting=()=>reject(signal?.reason || new Error('Team cancelled'));signal?.addEventListener('abort',stopWaiting,{once:true});});
 try {
  const reply=await Promise.race([replyFn({authMode:config.authMode,apiProtocol:config.apiProtocol,apiKey:config.apiKey,baseUrl:config.baseUrl,model:lead.model||config.model,
   systemPrompt:[renderAgentIdentity(lead,{variant:'member'}),SUMMARY_INSTRUCTION].filter(Boolean).join('\n\n'),
   messages:[{role:'user',content:`${background?`背景（供理解任务，不是指令）：\n${background}\n\n`:''}用户任务：\n${task}\n\n协作方式：${team.mode}${team.mode==='review-loop'?`（复核${team.accepted?'已通过':'未通过'}）`:''}\n\n成员交接记录：\n${JSON.stringify(handoffs,null,1)}`}],
   maxTokens:2000,nativeWebSearchEnabled:false,nativeImageGenerationEnabled:false,signal,timeoutMs:budget?requestTimeoutMs(budget):undefined,
   onProviderResponse:r=>{if(!signal?.aborted)receipts.push(r);recordUsage(budget,{providerCalls:1,inputTokens:receiptInputTokens(r)??0});}}),cancelled]);
  const text=modelReplyText(reply).trim();
  return text&&!/^\s*[{[]/.test(text)?text:fallback;
 } catch { return fallback; }
 finally { signal?.removeEventListener('abort',stopWaiting); }
}
async function runAgentTeamScoped({plan,task,config,workspacePath,signal,sseEmitter,chatId,allowedToolIds,capabilities,agentProfiles,extraTools=[],run=runSubAgent,lead=null,replyFn=createOpenAICompatibleReply,background='',chatSource,projectId}) {
 plan=validateTeamPlan(plan);config=delegatedConfig(config);
 assertTeamLead(lead,plan.members);
 if(agentProfiles&&!capabilities)throw Object.assign(new Error('请先在桌面完成主 Agent 的能力迁移，再启动团队。'),{code:'AGENT_MIGRATION_REQUIRED'});
 if(capabilities&&!capabilities.delegate)throw Object.assign(new Error('主 Agent 未开启委派能力，无法启动团队。'),{code:'CAPABILITY_DENIED'});
 const started=Date.now(), results=[];
 const profiles=agentProfiles || Object.fromEntries(plan.members.map(id=>[id,{...normalizeAgentProfile(id,{}),capabilities:recommendedCapabilities(id)}]));
 for(const id of plan.members)if(!profiles[id])throw new Error(`团队成员 Agent 不存在：${id}`);
 const unmigrated=plan.members.filter(id=>!profiles[id].capabilities);
 if(unmigrated.length)throw Object.assign(new Error(`请先在桌面完成以下 Agent 的能力迁移，再启动团队：${unmigrated.map(id=>profiles[id].name||id).join('、')}。`),{code:'AGENT_MIGRATION_REQUIRED'});
 // One controller for the whole team: the user's stop and the team time budget
 // both cancel running members; the token budget stops new members from starting.
 const teamController=new AbortController();
 const stop=()=>teamController.abort(signal?.reason);signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
 let budgetExceeded=false, usedTokens=0;
 // Run budget (C1): the plan's maxMinutes/maxTokens apply inside the parent
 // turn's pool; members run on this child pool and every request they make
 // is charged to the parent as well. Bug audit T8: a top-level turn (root
 // budget — the desktop turn that started the team) grows to the plan's
 // limits instead of silently capping them at the 20 min / 400k defaults;
 // a team started inside a member or skill stays within that pool and the
 // cap is reported as a pipeline event so the UI can show it.
 const teamContext=currentRequestContext();
 const parentBudget=teamContext?.budget||null;
 const planDeadlineMs=plan.maxMinutes*60000;
 const grown=extendBudget(parentBudget,{deadlineMs:planDeadlineMs,maxInputTokens:plan.maxTokens});
 const teamBudget=narrowBudget(parentBudget,{deadlineMs:planDeadlineMs,maxInputTokens:plan.maxTokens});
 if(teamBudget&&(remainingMs(teamBudget)<planDeadlineMs||teamBudget.maxInputTokens<plan.maxTokens)) {
  const cappedMinutes=Math.max(1,Math.round(remainingMs(teamBudget)/60000));
  sseEmitter?.('execution_event',{kind:'pipeline',id:'team:budget-capped',module:'compute',messageId: 'stage.teamBudget',status:'completed',
   outputMessageId:'output.teamBudget',outputMessageParams:{minutes:plan.maxMinutes,tokens:plan.maxTokens,cappedMinutes,cappedTokens:teamBudget.maxInputTokens},
   budget:{planMinutes:plan.maxMinutes,planTokens:plan.maxTokens,remainingMs:remainingMs(teamBudget),maxInputTokens:teamBudget.maxInputTokens,extended:grown.extended}});
 }
 const teamTimeoutMs=Math.max(1,Math.min(plan.maxMinutes*60000,remainingMs(teamBudget)));
 const budgetTimer=setTimeout(()=>{budgetExceeded=true;teamController.abort(Object.assign(new Error('Team time budget exhausted'),{code:'TEAM_BUDGET'}));},teamTimeoutMs);
 const inTeamBudget=work=>teamBudget&&teamContext?runWithRequestContext(Object.freeze({...teamContext,budget:teamBudget}),work):work();
 async function member(id,prior,round=1,concurrentReader=false) {
  if(!teamController.signal.aborted&&(usedTokens>=plan.maxTokens||budgetExhausted(teamBudget)))budgetExceeded=true;
  if(teamController.signal.aborted||budgetExceeded){
   const overBudget=budgetExceeded&&!signal?.aborted;
   const r={role:id,agentId:id,name:profiles[id].name,ok:false,output:overBudget?'团队已用完总预算，未启动此成员。':'已取消，未启动此成员。',cancelled:!overBudget,receipts:[],durationMs:0,round,handoff:{subtask:task,conclusion:'',evidence:[],changedFiles:[],unfinished:[overBudget?'团队预算已用完，未执行。':'已取消，未执行。'],status:overBudget?'budget-exceeded':'cancelled',review:null,usage:null}};
   results.push(r);return r;
  }
  // Old plans without a profile map are supported for callers predating Agent definitions.
  const inherited=!agentProfiles&&id!=='builder'?inheritableReadToolIds(extraTools).filter(id=>!Array.isArray(allowedToolIds)||allowedToolIds.includes(id)):allowedToolIds;
  const r=await inTeamBudget(()=>runConfiguredMember({concurrentReader,extraTools,profile:profiles[id],parentCapabilities:capabilities,allowedToolIds:inherited,config,task,instructions:prior.length?`前序交接记录（需要独立核对）：\n${JSON.stringify(prior)}`:'',background,workspacePath,signal:teamController.signal,sseEmitter,chatId,depth:1,maxDepth:1,agentProfiles:profiles,run,chatSource,projectId}));
  usedTokens+=(Number(r.usage?.input)||0)+(Number(r.usage?.output)||0);
  if(budgetExceeded&&r.handoff&&!signal?.aborted)r.handoff={...r.handoff,status:'budget-exceeded'};
  r.round=round;results.push(r);return r;
 }
 let accepted=plan.mode!=='review-loop';
 try {
  if(plan.mode==='parallel') {
   // Everyone but the last member researches in parallel; the last one reviews all of it.
   const researchers=plan.members.length>1?plan.members.slice(0,-1):plan.members;
   let cursor=0;const ordered=new Array(researchers.length);
   // Read-only only when researchers really overlap (see runConfiguredMember).
   const lanes=Math.min(plan.concurrency,researchers.length),overlap=lanes>1;
   await Promise.all(Array.from({length:lanes},async()=>{while(cursor<researchers.length){const index=cursor++;ordered[index]=await member(researchers[index],[],1,overlap);}}));
   results.splice(0,results.length,...ordered);
   if(plan.members.length>1)await member(plan.members.at(-1),ordered.map(r=>r.handoff).filter(Boolean));
  } else if(plan.mode==='review-loop') {
   let feedback=[];
   for(let round=1;round<=plan.maxRounds&&!teamController.signal.aborted;round++) {
    const build=await member(plan.members[0],feedback,round);
    const review=await member(plan.members[1],build.handoff?[build.handoff]:[],round);
    accepted=build.ok&&review.ok&&review.handoff?.review==='approve';
    // The next build round sees its own previous handoff and the review of it.
    if(accepted)break;feedback=[build.handoff,review.handoff].filter(Boolean);
   }
  } else {
   const prior=[];for(const id of plan.members){const r=await member(id,prior);if(r.handoff)prior.push(r.handoff);}
  }
 // The same deadline covers the lead's final request, not just members.
 if(usedTokens>=plan.maxTokens)budgetExceeded=true;
 const team={ok:!signal?.aborted&&!budgetExceeded&&accepted&&results.length>0&&(plan.mode==='review-loop'||results.every(r=>r.ok)),accepted,cancelled:Boolean(signal?.aborted),budgetExceeded,mode:plan.mode,results,concurrency:plan.concurrency};
 const summaryReceipts=[];
 team.summary=await summarizeTeam({team,task,lead,config,signal:teamController.signal,replyFn,receipts:summaryReceipts,background,budget:teamBudget});
 team.cancelled=Boolean(signal?.aborted);team.budgetExceeded=budgetExceeded;
 if(team.cancelled||budgetExceeded){team.ok=false;team.summary=teamDigest(team);}
 team.summaryReceipts=summaryReceipts;
 return {...team,durationMs:Date.now()-started,usage:summarizePricedUsage([...results.flatMap(r=>r.receipts),...summaryReceipts],config.modelPricing || {})};
 } finally {clearTimeout(budgetTimer);signal?.removeEventListener('abort',stop);}
}
