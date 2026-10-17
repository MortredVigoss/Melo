const text=(v,n=4000)=>typeof v==='string'?v.slice(0,n):'';
const strings=(v,n=8)=>Array.isArray(v)?v.filter(s=>typeof s==='string').slice(0,n).map(s=>s.slice(0,200)):[];
export function normalizeHandoff(raw) {
 if(!raw||typeof raw!=='object')return null;
 return {subtask:text(raw.subtask,1000),conclusion:text(raw.conclusion),evidence:strings(raw.evidence),changedFiles:strings(raw.changedFiles),unfinished:strings(raw.unfinished),status:['completed','failed','cancelled','budget-exceeded'].includes(raw.status)?raw.status:'failed',review:raw.review==='approve'?'approve':raw.review==='revise'?'revise':null,usage:raw.usage&&typeof raw.usage==='object'?{input:Number.isFinite(raw.usage.input)?raw.usage.input:null,output:Number.isFinite(raw.usage.output)?raw.usage.output:null,unknown:raw.usage.requests===0?1:Number.isInteger(raw.usage.unknown)?raw.usage.unknown:1,estimatedCost:Number.isFinite(raw.usage.estimatedCost)?raw.usage.estimatedCost:null}:null};
}
export function createHandoff(task,outcome,usage) {
 let supplied={};try {supplied=JSON.parse(outcome.output.replace(/^```(?:json)?\s*|\s*```$/g,''));} catch {}
 const observed=(outcome.meta?.toolResults || []).filter(r=>r.ok&&r.path&&['file_write','file_edit','file_delete','file_move','file_mkdir','xlsx','pdf'].includes(r.toolName)).map(r=>r.path);
 // A member that reached a conclusion decides its own status ('completed' or
 // 'failed'); cancellation and budget exhaustion are facts the runner knows
 // better and always win.
 const selfReported=['completed','failed'].includes(supplied.status)?supplied.status:null;
 const status=outcome.meta?.aborted?'cancelled':outcome.meta?.budgetExceeded?'budget-exceeded':!outcome.ok?'failed':(selfReported || 'completed');
 return normalizeHandoff({subtask:task,conclusion:supplied.conclusion || outcome.output,evidence:supplied.evidence || [],changedFiles:[...new Set([...observed,...strings(supplied.changedFiles)])],unfinished:supplied.unfinished || (status==='completed'?[]:[outcome.output]),review:supplied.review,status,usage});
}
export const HANDOFF_INSTRUCTION='Return only a JSON handoff with conclusion, evidence (sources and observations; distinguish claims from verified checks), changedFiles, unfinished, and review (approve or revise only when reviewing). Do not claim verification without evidence. Do not write long-term memory.';
