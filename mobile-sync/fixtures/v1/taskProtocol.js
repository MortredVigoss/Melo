import { validSyncID as validId } from './identifiers.js';
import { syncSchema } from './syncContract.generated.js';
import { validateSchema } from './schemaValidator.js';
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const conflict = message => Object.assign(new Error(message),{status:409});
export function validateTaskSync(value) {
  validateSchema(value,syncSchema.$defs.taskSync,syncSchema);
  const seen = new Set();
  if(!Array.isArray(value.tasks || []) || (value.tasks || []).length>500) throw new Error('Invalid task snapshot');
  const tasks=(value.tasks || []).map(t=>{
    if(!validId(t.id) || seen.has(t.id) || !validId(t.sourceDevice) || !validDate(t.updatedAt) || !Number.isSafeInteger(t.revision) || t.revision<1 || typeof t.title!=='string' || t.title.length>500 || typeof t.checkpoint!=='string' || t.checkpoint.length>12000 || !['todo','running','blocked','review','done'].includes(t.status)) throw new Error('Invalid task checkpoint');
    seen.add(t.id);
    return {id:t.id,title:t.title,status:t.status,owner:String(t.owner || 'main').slice(0,100),checkpoint:t.checkpoint,revision:t.revision,sourceDevice:t.sourceDevice,updatedAt:new Date(t.updatedAt).toISOString(),chatId:validId(t.chatId)?t.chatId:null,needsApproval:t.needsApproval===true};
  });
  const ids=new Set();
  if(!Array.isArray(value.handoffs || []) || (value.handoffs || []).length>1000) throw new Error('Invalid handoffs');
  const handoffs=(value.handoffs || []).map(h=>{
    if(!validId(h.id) || ids.has(h.id) || !validId(h.taskId) || !validId(h.fromDevice) || !validDate(h.requestedAt) || !Number.isSafeInteger(h.revision) || h.revision<1) throw new Error('Invalid handoff');
    ids.add(h.id);
    return {id:h.id,taskId:h.taskId,fromDevice:h.fromDevice,requestedAt:new Date(h.requestedAt).toISOString(),revision:h.revision};
  });
  return {tasks,handoffs};
}
export function mergeTaskSync(left,right) {
  const a=validateTaskSync(left), b=validateTaskSync(right), tasks=new Map(a.tasks.map(t=>[t.id,t])), handoffs=new Map(a.handoffs.map(h=>[h.id,h]));
  for(const next of b.tasks){const old=tasks.get(next.id);if(old && (old.sourceDevice!==next.sourceDevice || (old.revision===next.revision && JSON.stringify(old)!==JSON.stringify(next)))) throw conflict('Task checkpoint conflict; existing data preserved');if(!old || next.revision>old.revision) tasks.set(next.id,next);}
  for(const next of b.handoffs){const old=handoffs.get(next.id);if(old && JSON.stringify(old)!==JSON.stringify(next)) throw conflict('Handoff identity conflict');handoffs.set(next.id,next);}
  return {tasks:[...tasks.values()].sort((a,b)=>a.id.localeCompare(b.id)),handoffs:[...handoffs.values()].sort((a,b)=>a.id.localeCompare(b.id))};
}
