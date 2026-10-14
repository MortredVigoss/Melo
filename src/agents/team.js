import { delegatedConfig } from './delegatedConfig.js';
import { runSubAgent } from './subAgent.js';
import { summarizePricedUsage } from '../runtime/usage.js';
import { currentRequestContext, runWithRequestContext } from '../runtime/requestScope.js';
export const TEAM_ROLES = Object.freeze({ research:'通过读取与检索调查事实和来源，列出证据和不确定项。', builder:'按已确认目标实施最小改动，验证结果；不要重复已完成操作。', reviewer:'通过读取与检索独立检查任务结果、已有测试记录和遗漏，明确风险和未完成项。' });
const READ_TOOLS = ['file_read', 'glob', 'grep', 'web_search', 'fetch_url', 'calculator', 'media_info', 'search_history'];
function roleToolIds(role, parentIds) {
  if (role === 'builder') return parentIds;
  return READ_TOOLS.filter(id => !Array.isArray(parentIds) || parentIds.includes(id));
}
export function validateTeamPlan(plan) {
  if(!plan) return null;
  const roles=[...new Set(plan.roles || [])];
  if(!roles.length || roles.length>3 || roles.some(r=>!TEAM_ROLES[r])) throw new Error('协作角色必须为调查、执行或复核，最多三个。');
  return {roles,concurrency:roles.includes('builder') ? 1 : Math.max(1,Math.min(2,Math.floor(Number(plan.concurrency)||1)))};
}
export async function runAgentTeam({plan,task,config,workspacePath,signal,sseEmitter,chatId,allowedToolIds,run=runSubAgent}) {
  config=delegatedConfig(config);
  plan=validateTeamPlan(plan);
  const parent=currentRequestContext();
  const started=Date.now(), results=new Array(plan.roles.length); let cursor=0;
  const prices=config.modelPricing || {};
  async function worker() {
    while(cursor<plan.roles.length) {
      const i=cursor++, role=plan.roles[i], began=Date.now();
      if(signal?.aborted) {results[i]={role,ok:false,output:'已取消，未启动此角色。',cancelled:true,durationMs:0,receipts:[]};continue;}
      const emit=(type,payload)=>sseEmitter?.(type,type==='execution_event' ? {...payload,id:`team:${role}:${payload.id}`,name:`${role} · ${payload.name}`} : payload);
      emit('execution_event',{kind:'pipeline',id:'role',name:TEAM_ROLES[role],status:'running'});
      const receipts=[];
      try {
        const invoke=()=>run({task,instructions:TEAM_ROLES[role]+(plan.concurrency===1 && i>0 ? `\n前序角色记录（需独立核对）：${results.slice(0,i).map(r=>`${r.role}: ${r.output}`).join('\n').slice(0,16000)}` : ''),config,workspacePath,signal,sseEmitter:emit,chatId,depth:1,allowedToolIds:roleToolIds(role,allowedToolIds),roleId:role,onProviderResponse:r=>receipts.push(r)});
        const outcome=parent ? await runWithRequestContext(Object.freeze({...parent,agentId:role}),invoke) : await invoke();
        results[i]={role,...outcome,receipts,durationMs:Date.now()-began,usage:summarizePricedUsage(receipts,prices)};
      } catch(error) { results[i]={role,ok:false,output:signal?.aborted?'已取消':error.message,cancelled:!!signal?.aborted,receipts,durationMs:Date.now()-began,usage:summarizePricedUsage(receipts,prices)}; }
      emit('execution_event',{kind:'pipeline',id:'role',name:TEAM_ROLES[role],status:results[i].cancelled?'cancelled':results[i].ok?'completed':'failed',output:results[i].output.slice(0,1000)});
    }
  }
  await Promise.all(Array.from({length:plan.concurrency},worker));
  return {ok:results.every(r=>r.ok),results,durationMs:Date.now()-started,concurrency:plan.concurrency,usage:summarizePricedUsage(results.flatMap(r=>r.receipts),prices)};
}
