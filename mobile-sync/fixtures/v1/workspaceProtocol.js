import { validMessageID } from './identifiers.js';
import { syncSchema } from './syncContract.generated.js';
import { validateSchema } from './schemaValidator.js';
// Portable user context. Credentials, machine paths and execution permissions
// are deliberately not part of this wire schema. Multi-value registers retain
// concurrent offline edits until the user selects a version.
const safeID = v => !['__proto__','prototype','constructor'].includes(v) && typeof v === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(v);
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const text = (v, limit = 12000) => {
  if (v == null) return '';
  if (typeof v !== 'string' || v.length > limit) throw new Error('Workspace text exceeds limit');
  return v;
};
const ids = v => {
  if (!Array.isArray(v || []) || (v || []).length > 1000 || (v || []).some(x=>!safeID(x))) throw new Error('Invalid workspace references');
  return [...new Set(v || [])].sort();
};
export const stableJSON = v => JSON.stringify(v, function(k,value) {
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])) : value;
});
function url(v, {endpoint=false}={}) {
  if (!v) return '';
  const parsed = new URL(text(v,4000));
  if (!['https:','http:'].includes(parsed.protocol) || parsed.username || parsed.password || (endpoint && (parsed.search || parsed.hash))) throw new Error('Invalid portable URL');
  return v;
}
export function portableAgent(v) {
  const avatarData = text(v.avatarData,500000);
  if (avatarData && !/^[A-Za-z0-9+/]+={0,2}$/.test(avatarData)) throw new Error('Invalid avatar');
  return {name:text(v.name,200),subtitle:text(v.subtitle),instructions:text(v.instructions,50000),symbol:text(v.symbol,100)||'person.crop.square',avatarData,identity:text(v.identity,50000),soul:text(v.soul,50000),systemPrompt:text(v.systemPrompt,50000),mood:text(v.mood,100)||'warm',model:text(v.model,180)};
}
export function portableModel(v) {
  if (v == null) return null;
  if (!object(v)) throw new Error('Invalid portable model');
  return {connectionID:text(v.connectionID,180),name:text(v.name,200),model:text(v.model,180),authMode:v.authMode==='codex'?'codex':v.authMode==='local'?'local':'api-key',baseURL:url(v.baseURL,{endpoint:true}),apiProtocol:v.apiProtocol==='anthropic'?'anthropic':'chat-completions'};
}
export function portableScene(v) {
  if (!object(v)) return null;
  if (!safeID(v.runId) || !['completed','failed','cancelled','interrupted'].includes(v.status)) throw new Error('Only terminal execution records can sync');
  const list = (a,n) => { if (!Array.isArray(a || []) || (a || []).length>n) throw new Error('Execution record exceeds limit'); return a || []; };
  const stage = x => ({id:text(x.id,200),module:['search','compute','files','tools','create'].includes(x.module)?x.module:'tools',name:text(x.name,200),status:['queued','running','completed','failed','cancelled','interrupted'].includes(x.status)?x.status:'interrupted',provider:text(x.provider,200),input:text(x.input,2200),output:text(x.output,12000),query:text(x.query,2200),resultSummary:text(x.resultSummary,2200),model:text(x.model,180),returnedModel:text(x.returnedModel,180),channel:text(x.channel,100),startedAt:text(x.startedAt,50),finishedAt:text(x.finishedAt,50)});
  return {runId:v.runId,status:v.status,query:text(v.query,12000),startedAt:text(v.startedAt,50),finishedAt:text(v.finishedAt,50),lastModule:text(v.lastModule,50),requestedModel:text(v.requestedModel,180),returnedModel:text(v.returnedModel,180),sourceDevice:text(v.sourceDevice,200),operations:list(v.operations,500).map(stage),pipeline:list(v.pipeline,500).map(stage),sources:list(v.sources,2000).map((s,i)=>({id:text(s.id,200)||`source-${i}`,url:url(s.url),title:text(s.title,1000),titleProvided:s.titleProvided===true,order:Number.isSafeInteger(s.order)?s.order:i,rank:Number.isSafeInteger(s.rank)?s.rank:i,reading:['unknown','snippet','partial','range-unknown','extracted','full'].includes(s.reading)?s.reading:'unknown',appeared:s.appeared===true,accessed:s.accessed===true,opened:s.opened===true,cited:s.cited===true,providers:list(s.providers,30).map(x=>text(x,200)),queries:list(s.queries,100).map(x=>text(x,2200))}))};
}
export function portableValue(kind,v) {
  if (!object(v)) throw new Error('Invalid workspace value');
  if (kind==='memory') {
    if(!safeID(v.id)||!safeID(v.chatId)||!safeID(v.agentId)||v.projectId&&!safeID(v.projectId)||!['chat','project','agent','personal'].includes(v.scope)||!['active','forgotten','historical','unconfirmed'].includes(v.status)||v.scope==='project'&&!v.projectId||!Number.isFinite(Date.parse(v.updatedAt)))throw new Error('Invalid memory context');
    if (v.validTo != null && (typeof v.validTo !== 'string' || !Number.isFinite(Date.parse(v.validTo)))) throw new Error('Invalid memory validity');
    const content=text(v.text,2000), memoryID=text(v.memoryID,180);
    if(!content.trim()||!memoryID)throw new Error('Invalid memory content');
    return {id:v.id,memoryID,text:content,originalFact:text(v.originalFact,2000),scope:v.scope,status:v.status,chatId:v.chatId,messageId:text(v.messageId,180),projectId:v.projectId || '',agentId:v.agentId,sourceText:text(v.sourceText,1600),category:text(v.category,100),updatedAt:v.updatedAt,userEdited:v.userEdited===true,...(Object.hasOwn(v,'validTo') ? {validTo:v.validTo ?? null} : {}),...(v.mergedInto ? {mergedInto:text(v.mergedInto,180)} : {})};
  }
  if (kind==='agent') return portableAgent(v);
  if (kind==='knowledge') return {title:text(v.title,500),content:text(v.content,200000),deleted:v.deleted===true,kind:text(v.kind,100)||'note',language:text(v.language,100)||'text',projectId:safeID(v.projectId)?v.projectId:null};
  if (kind==='project') {
    const agentOverrides={};
    for(const [id,agent] of Object.entries(v.agentOverrides || {})) {if(!safeID(id))throw new Error('Invalid project role');agentOverrides[id]=portableAgent(agent);}
    return {name:text(v.name,200),goal:text(v.goal),instructions:text(v.instructions),archived:v.archived===true,knowledgeIds:ids(v.knowledgeIds),agentOverrides};
  }
  if (kind==='conversation') return {agentId:safeID(v.agentId)?v.agentId:'main',projectId:safeID(v.projectId)?v.projectId:null,knowledgeIds:ids(v.knowledgeIds),model:portableModel(v.model)};
  if (kind==='message') {
    if (!safeID(v.chatId)) throw new Error('Invalid message context');
    if(!Array.isArray(v.models || []) || (v.models || []).length>200)throw new Error('Invalid model receipts');
    return {chatId:v.chatId,agent:v.agent?{agentID:text(v.agent.agentID,180),name:text(v.agent.name,200),symbol:text(v.agent.symbol,100)||'person.crop.square'}:null,models:(v.models || []).map(m=>({requestedModel:text(m.requestedModel,180),reportedModel:text(m.reportedModel,180),simulated:m.simulated===true,...(m.purpose ? {purpose:text(m.purpose,100)} : {})})),scene:portableScene(v.scene)};
  }
  throw new Error('Unknown workspace record');
}
function clock(v) {
  if (!object(v) || !Object.keys(v).length || Object.keys(v).length>100) throw new Error('Invalid revision clock');
  const result={};for(const [id,n] of Object.entries(v)) { if(!safeID(id)||!Number.isSafeInteger(n)||n<1)throw new Error('Invalid revision');result[id]=n; }return result;
}
const joinClocks = versions => Object.fromEntries([...new Set(versions.flatMap(v=>Object.keys(v.clock)))].sort().map(id=>[id,Math.max(...versions.map(v=>v.clock[id]||0))]));
const dominates = (a,b) => Object.entries(b).every(([id,n])=>(a[id]||0)>=n);
function coalesce(versions) {
  const equal=new Map();
  for(const v of versions){const key=stableJSON(v.value),old=equal.get(key);equal.set(key,old?{clock:joinClocks([old,v]),value:v.value}:v);}
  const list=[...equal.values()];
  // Equal clocks carrying different payloads are preserved as conflicts too.
  return list.filter((v,i)=>!list.some((other,j)=>j!==i&&dominates(other.clock,v.clock)&&!dominates(v.clock,other.clock))).sort((a,b)=>stableJSON(a.value).localeCompare(stableJSON(b.value)));
}
export function validateWorkspace(v) {
  if(v==null)return null;
  validateSchema(v, syncSchema.$defs.workspace, syncSchema);
  if(v.version!==1||!Array.isArray(v.records))throw new Error('Invalid workspace sync');
  const seen=new Set();
  return {version:1,records:v.records.map(r=>{
    const key=`${r.kind}:${r.id}`;
    if(!(r.kind==='message'?validMessageID(r.id):safeID(r.id))||seen.has(key)||!Array.isArray(r.versions)||!r.versions.length||r.versions.length>20)throw new Error('Invalid workspace register');
    seen.add(key);
    return {kind:r.kind,id:r.id,versions:coalesce(r.versions.map(version=>({clock:clock(version.clock),value:portableValue(r.kind,version.value)})))};
  }).sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))};
}
export function mergeWorkspaces(a,b) {
  const records=new Map();
  for(const r of [...(validateWorkspace(a)?.records||[]),...(validateWorkspace(b)?.records||[])]) {const key=`${r.kind}:${r.id}`,old=records.get(key);records.set(key,{...r,versions:coalesce([...(old?.versions||[]),...r.versions])});}
  return validateWorkspace({version:1,records:[...records.values()]});
}
export function putWorkspace(workspace,kind,id,value,device) {
  if(!safeID(device))throw new Error('Invalid device identity');
  value=portableValue(kind,value);
  const row=workspace.records.find(r=>r.kind===kind&&r.id===id);
  if(row?.versions.length>1)return; // Resolving conflicts is an explicit user action.
  if(row&&stableJSON(row.versions[0].value)===stableJSON(value))return;
  const nextClock={...(row?.versions[0].clock||{})};nextClock[device]=(nextClock[device]||0)+1;
  const next={kind,id,versions:[{clock:nextClock,value}]};
  if(row)Object.assign(row,next);else workspace.records.push(next);
}
export function resolveWorkspace(workspace,kind,id,index,device) {
  const next=validateWorkspace(workspace),row=next.records.find(r=>r.kind===kind&&r.id===id);
  if(!row||!Number.isInteger(index)||!row.versions[index])throw new Error('Conflict version is no longer available');
  const value=row.versions[index].value,nextClock=joinClocks(row.versions);nextClock[device]=(nextClock[device]||0)+1;
  row.versions=[{clock:nextClock,value}];return next;
}
