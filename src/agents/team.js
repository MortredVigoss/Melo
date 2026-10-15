import {currentRequestContext,runWithRequestContext} from '../runtime/requestScope.js';
import {resolveCapabilityContext} from '../services/agent/capabilityContext.js';
import {narrowCapabilityScope,missingCapabilityScope} from '../domain/agent/capabilityScope.js';
import {delegatedConfig} from './delegatedConfig.js';
import {runSubAgent} from './subAgent.js';
import {runConfiguredMember} from './delegate.js';
import {summarizePricedUsage} from '../runtime/usage.js';
import {normalizeAgentProfile} from '../state/agentProfiles.js';
import {recommendedCapabilities} from '../domain/agent/capabilities.js';
export const TEAM_ROLES = Object.freeze({research:'调研',builder:'实施',reviewer:'复核'});
export const TEAM_TEMPLATES = Object.freeze([
 {id:'research-build-review',name:'调研 → 实施 → 复核',members:['research','builder','reviewer'],mode:'sequential'},
 {id:'parallel-research',name:'并行调研',members:['research','reviewer'],mode:'parallel'},
 {id:'review-loop',name:'实施 / 复核循环',members:['builder','reviewer'],mode:'review-loop',maxRounds:2},
]);
const READ_TOOLS=['file_read','glob','grep','web_search','fetch_url','calculator','media_info','search_history'];
export function validateTeamPlan(plan) {
 if(!plan)return null;
 if(typeof plan!=='object'||Array.isArray(plan))throw new Error('Invalid team plan');
 if(plan.templateId) {const template=TEAM_TEMPLATES.find(t=>t.id===plan.templateId);if(!template)throw new Error('Unknown team template');plan={...template,...plan};}
 const members=[...(plan.members || plan.roles || [])];
 if(!members.length||members.length>8||members.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(id))||new Set(members).size!==members.length)throw new Error('团队需包含 1–8 个不同的 Agent ID。');
 const mode=plan.mode || (Number(plan.concurrency)>1&&!members.includes('builder')?'parallel':'sequential');
 if(!['sequential','parallel','review-loop'].includes(mode))throw new Error('Unknown orchestration mode');
 if(mode==='review-loop'&&members.length!==2)throw new Error('复核循环需要实施和复核两个成员。');
 return {members,roles:members,mode,concurrency:mode==='parallel'?Math.max(1,Math.min(4,Math.floor(Number(plan.concurrency)||2))):1,maxRounds:Math.max(1,Math.min(5,Math.floor(Number(plan.maxRounds)||2)))};
}
export async function runAgentTeam(options) {
 const parent=await resolveCapabilityContext(currentRequestContext());
 if(!parent)throw Object.assign(new Error(missingCapabilityScope().output),{code:'CAPABILITY_SCOPE_MISSING'});
 const capabilityScope=narrowCapabilityScope(parent.capabilityScope,{capabilities:options.capabilities,allowedToolIds:options.allowedToolIds});
 return runWithRequestContext(Object.freeze({...parent,capabilityScope}),()=>runAgentTeamScoped({...options,capabilities:capabilityScope.capabilities}));
}
async function runAgentTeamScoped({plan,task,config,workspacePath,signal,sseEmitter,chatId,allowedToolIds,capabilities,agentProfiles,extraTools=[],run=runSubAgent}) {
 plan=validateTeamPlan(plan);config=delegatedConfig(config);
 if(agentProfiles&&!capabilities)throw Object.assign(new Error('请先在桌面完成主 Agent 的能力迁移，再启动团队。'),{code:'AGENT_MIGRATION_REQUIRED'});
 if(capabilities&&!capabilities.delegate)throw Object.assign(new Error('主 Agent 未开启委派能力，无法启动团队。'),{code:'CAPABILITY_DENIED'});
 const started=Date.now(), results=[];
 const profiles=agentProfiles || Object.fromEntries(plan.members.map(id=>[id,{...normalizeAgentProfile(id,{}),capabilities:recommendedCapabilities(id)}]));
 for(const id of plan.members)if(!profiles[id])throw new Error(`团队成员 Agent 不存在：${id}`);
 const unmigrated=plan.members.filter(id=>!profiles[id].capabilities);
 if(unmigrated.length)throw Object.assign(new Error(`请先在桌面完成以下 Agent 的能力迁移，再启动团队：${unmigrated.map(id=>profiles[id].name||id).join('、')}。`),{code:'AGENT_MIGRATION_REQUIRED'});
 async function member(id,prior,round=1) {
  if(signal?.aborted){const r={role:id,agentId:id,name:profiles[id].name,ok:false,output:'已取消，未启动此成员。',cancelled:true,receipts:[],durationMs:0};results.push(r);return r;}
  // Old plans without a profile map are supported for callers predating Agent definitions.
  const inherited=!agentProfiles&&id!=='builder'?READ_TOOLS.filter(id=>!Array.isArray(allowedToolIds)||allowedToolIds.includes(id)):allowedToolIds;
  const r=await runConfiguredMember({extraTools,profile:profiles[id],parentCapabilities:capabilities,allowedToolIds:inherited,config,task,instructions:prior.length?`前序交接记录（需要独立核对）：\n${JSON.stringify(prior)}`:'',workspacePath,signal,sseEmitter,chatId,depth:1,maxDepth:1,agentProfiles:profiles,run});
  r.round=round;results.push(r);return r;
 }
 let accepted=plan.mode!=='review-loop';
 if(plan.mode==='parallel') {
  let cursor=0;const ordered=new Array(plan.members.length);
  await Promise.all(Array.from({length:Math.min(plan.concurrency,plan.members.length)},async()=>{while(cursor<plan.members.length){const index=cursor++;ordered[index]=await member(plan.members[index],[]);}}));
  results.splice(0,results.length,...ordered);
 } else if(plan.mode==='review-loop') {
  let feedback=[];
  for(let round=1;round<=plan.maxRounds&&!signal?.aborted;round++) {
   const build=await member(plan.members[0],feedback,round);
   const review=await member(plan.members[1],build.handoff?[build.handoff]:[],round);
   accepted=build.ok&&review.ok&&review.handoff?.review==='approve';
   if(accepted)break;feedback=review.handoff?[review.handoff]:[];
  }
 } else {
  const prior=[];for(const id of plan.members){const r=await member(id,prior);if(r.handoff)prior.push(r.handoff);}
 }
 return {ok:!signal?.aborted&&accepted&&results.length>0&&(plan.mode==='review-loop'||results.every(r=>r.ok)),accepted,mode:plan.mode,results,durationMs:Date.now()-started,concurrency:plan.concurrency,usage:summarizePricedUsage(results.flatMap(r=>r.receipts),config.modelPricing || {})};
}
