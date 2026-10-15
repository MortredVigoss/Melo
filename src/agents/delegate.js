import {resolveCapabilityContext} from '../services/agent/capabilityContext.js';
import {narrowCapabilityScope,missingCapabilityScope,scopeAllowsTool} from '../domain/agent/capabilityScope.js';
import {randomUUID} from 'node:crypto';
import {runSubAgent} from './subAgent.js';
import {toolCapabilityAllowed,normalizeCapabilities,intersectCapabilities,normalizeCollaboration,filterToolsByCapabilities,emptyCapabilities} from '../domain/agent/capabilities.js';
import {getAllTools} from '../tools/registryCore.js';
import {currentRequestContext,runWithRequestContext} from '../runtime/requestScope.js';
import {summarizePricedUsage} from '../runtime/usage.js';
import {withWorkspaceWriter} from './workspaceScheduling.js';
import {createHandoff,HANDOFF_INSTRUCTION} from './handoff.js';

export async function runConfiguredMember({profile,parentCapabilities,allowedToolIds,config,task,instructions='',workspacePath,signal,sseEmitter,chatId,depth=1,agentProfiles,ancestry=[],maxDepth=1,extraTools=[],run=runSubAgent}) {
 if(!normalizeCapabilities(profile.capabilities))return {ok:false,error:'AGENT_MIGRATION_REQUIRED',output:`请先在桌面完成 Agent「${profile.name||profile.id}」的能力迁移，再启动协作。`};
 const parent=await resolveCapabilityContext(currentRequestContext());
 if(!parent)return missingCapabilityScope();
 const capabilityScope=narrowCapabilityScope(parent.capabilityScope,{capabilities:intersectCapabilities(profile.capabilities,parentCapabilities),allowedToolIds,agentId:profile.id,source:'member'});
 const capabilities=capabilityScope.capabilities;
 const settings=normalizeCollaboration(profile.collaboration);
 extraTools=extraTools.filter(t=>!t.allowedAgentIds?.length||t.allowedAgentIds.includes(profile.id));
 const toolIds=(Array.isArray(allowedToolIds)?allowedToolIds:[...getAllTools(),...extraTools].map(t=>t.id)).filter(id=>toolCapabilityAllowed(id,capabilities));
 const controller=new AbortController();const abort=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const timer=setTimeout(()=>controller.abort(Object.assign(new Error('Member time budget exhausted'),{code:'MEMBER_TIMEOUT'})),settings.timeoutMs);
 const receipts=[], started=Date.now(), memberId=randomUUID();
 const emit=(type,event)=>sseEmitter?.(type,type==='execution_event'?{...event,id:`member:${memberId}:${event.id}`,name:`${profile.name} · ${event.name || ''}`}:{...event,agentId:profile.id});
 const invoke=()=>run({extraTools,task,instructions,agentProfile:profile,config:{...config,model:profile.model || config.model,modelResolvedForTurn:true},workspacePath,signal:controller.signal,sseEmitter:emit,chatId,depth,allowedToolIds:toolIds,capabilities,roleId:profile.id,agentProfiles,collaboration:settings,ancestry:[...ancestry,profile.id],maxDepth,maxIterations:settings.maxIterations,maxTokens:settings.maxTokens,onProviderResponse:r=>{if(!controller.signal.aborted)receipts.push(r);}});
 const scoped=()=>parent?runWithRequestContext(Object.freeze({...parent,agentId:profile.id,capabilityScope}),invoke):invoke();
 const writer=capabilities.writeFiles||capabilities.runCommands||capabilities.generateMedia||capabilities.mcpServers.length>0||capabilities.connectors.length>0;
 emit('execution_event',{kind:'pipeline',id:'handoff',name:'成员执行',module:'compute',status:'running',input:task});
 let outcome, stopWaiting;
 const cancelled=new Promise((_,reject)=>{stopWaiting=()=>reject(controller.signal.reason || Object.assign(new Error('Member cancelled'),{code:'ABORTED'}));controller.signal.addEventListener('abort',stopWaiting,{once:true});});
 try {
  if(controller.signal.aborted)throw controller.signal.reason || new Error('Member cancelled');
  // Keep a writer lease until its underlying work settles, even if the caller stops waiting.
  outcome=await Promise.race([writer?withWorkspaceWriter(workspacePath,controller.signal,scoped):scoped(),cancelled]);
 }
 catch(error){outcome={ok:false,output:error.message,meta:{aborted:controller.signal.aborted}};}
 finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',stopWaiting);}
 if(controller.signal.aborted) outcome={...outcome,ok:false,meta:{...outcome.meta,aborted:true}};
 const usage=summarizePricedUsage(receipts,config.modelPricing || {}),handoff=createHandoff(task,outcome,usage);
 const result={...outcome,role:profile.id,agentId:profile.id,name:profile.name,memberId,receipts,usage,handoff,cancelled:controller.signal.aborted,durationMs:Date.now()-started};
 emit('execution_event',{kind:'pipeline',id:'handoff',name:'交接记录',module:'compute',status:result.cancelled?'cancelled':result.ok?'completed':'failed',output:JSON.stringify(handoff),handoff,agentId:profile.id,memberId});
 return result;
}
export async function delegateTask(args,context={}) {
 const resolved=await resolveCapabilityContext(currentRequestContext() || context.requestContext);
 const settings=normalizeCollaboration(context.collaboration), target=context.agentProfiles?.[args.agentId];
 const depth=(context.agentDepth || 0)+1, maxDepth=Math.min(context.maxDelegationDepth ?? settings.maxDelegationDepth,settings.maxDelegationDepth);
 if(!settings.canDelegate || !scopeAllowsTool(narrowCapabilityScope(resolved?.capabilityScope,{capabilities:context.capabilities}),'delegate') || !settings.delegateTargets.includes(args.agentId) || !target || depth>maxDepth || (context.ancestry || [context.agentId]).includes(args.agentId)) return {ok:false,error:'DELEGATION_DENIED',output:'目标 Agent 未授权、已在调用链中或超过委派深度。'};
 const result=await runConfiguredMember({extraTools:context.extraTools,profile:target,parentCapabilities:context.capabilities,allowedToolIds:context.allowedToolIds,config:context.config,task:args.task,instructions:args.instructions,workspacePath:context.workspacePath,signal:context.signal,sseEmitter:context.sseEmitter,chatId:context.chatId,depth,maxDepth,agentProfiles:context.agentProfiles,ancestry:context.ancestry || [context.agentId]});
 if(result.error)return result;
 return {...result,output:JSON.stringify(result.handoff),meta:{...result.meta,handoff:result.handoff,member:{agentId:result.agentId,name:result.name,memberId:result.memberId,durationMs:result.durationMs},receipts:result.receipts}};
}
export const delegateTool={id:'delegate',name:'Delegate',description:'Delegate a focused task to an authorized configured Agent. The member uses its own persona/model and the intersection of both capability sets. Returns a structured handoff.',category:'agent',examples:[{agentId:'research',task:'Inspect relevant sources and return findings with evidence.'}],requiresPermission:false,isConcurrencySafe:false,timeout:920000,parametersSchema:{type:'object',properties:{agentId:{type:'string'},task:{type:'string'},instructions:{type:'string'}},required:['agentId','task']},run:delegateTask};
