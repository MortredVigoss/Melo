import { parseMcpToolId } from '../../mcp/toolId.js';

export const CAPABILITY_LABELS = Object.freeze({readFiles:'读取文件',writeFiles:'修改文件',runCommands:'运行命令',network:'联网',knowledgeMemory:'知识与记忆',generateMedia:'生成媒体',delegate:'委派'});
const list = value => [...new Set(Array.isArray(value) ? value.filter(v=>typeof v==='string' && v.length<=200 && v.trim()).map(v=>v.trim()) : [])].sort();
export function normalizeCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {version:1,...Object.fromEntries(Object.keys(CAPABILITY_LABELS).map(key=>[key,value[key]===true])),mcpServers:list(value.mcpServers),skills:list(value.skills),connectors:list(value.connectors)};
}
export const emptyCapabilities = () => normalizeCapabilities({});
export function recommendedCapabilities(id) {
  return normalizeCapabilities({readFiles:true,writeFiles:['main','builder'].includes(id),runCommands:['main','builder'].includes(id),network:true,knowledgeMemory:true,generateMedia:id==='main',delegate:id==='main'});
}
export function intersectCapabilities(a,b) {
  a=normalizeCapabilities(a);b=normalizeCapabilities(b);
  if (!a) return b;if (!b) return a;
  return normalizeCapabilities({...Object.fromEntries(Object.keys(CAPABILITY_LABELS).map(k=>[k,a[k]&&b[k]])),...Object.fromEntries(['mcpServers','skills','connectors'].map(k=>[k,a[k].filter(id=>b[k].includes(id))]))});
}
export function hasCapability(capabilities, key) { return !capabilities || capabilities[key]===true; }
export function normalizeCollaboration(value={}) {
  const bounded=(v,f,max)=>Number.isInteger(v)&&v>=1?Math.min(v,max):f;
  return {canDelegate:value.canDelegate===true,delegateTargets:list(value.delegateTargets),maxDelegationDepth:bounded(value.maxDelegationDepth,1,3),maxIterations:bounded(value.maxIterations,8,20),maxTokens:bounded(value.maxTokens,32000,200000),timeoutMs:bounded(value.timeoutMs,180000,900000)};
}
const READ=new Set(['file_read','glob','grep','media_info']);
const WRITE=new Set(['file_write','file_edit','file_delete','file_move','file_mkdir','xlsx']);
const NETWORK=new Set(['web_search','fetch_url','media_api','translate','browser_open','browser_snapshot','browser_click','browser_fill','browser_wait_for','browser_close']);
export function toolCapabilityAllowed(id, capabilities, args) {
  const c=normalizeCapabilities(capabilities);
  if (!c) return true; // Existing profiles stay unchanged until the user accepts the migration preview.
  if (id.startsWith('mcp:')) { const parsed=parseMcpToolId(id);return !!parsed&&c.mcpServers.includes(parsed.server); }
  if (id.startsWith('skill:')) return c.skills.includes(id.slice(6));
  if (READ.has(id)) return c.readFiles;
  if (WRITE.has(id)) return c.writeFiles;
  if (NETWORK.has(id)) return c.network;
  if (id==='bash') return c.runCommands;
  if (id==='agent'||id==='delegate') return c.delegate;
  if (id==='calculator') return true;
  if (id==='search_history'||id==='reminder') return c.knowledgeMemory;
  if (id==='knowledge') return c.knowledgeMemory && (!args||args.action!=='index'||c.readFiles);
  if (id==='clipboard') return args ? (args.action==='read'?c.readFiles:c.writeFiles) : c.readFiles||c.writeFiles;
  if (id==='pdf') {
    if (!args) return c.readFiles||c.writeFiles;
    const read=args.action==='read';
    const remote=Object.values(args).some(v=>typeof v==='string'&&/^https?:\/\//i.test(v));
    return (read?c.readFiles:c.writeFiles) && (!remote||c.network) && (read||['write','structured','from_spec'].includes(args.action)||c.readFiles);
  }
  if (id==='image') {
    if (!args) return c.readFiles||c.generateMedia;
    return ['info','ocr'].includes(args.action)?c.readFiles: c.generateMedia && (!args.output||c.writeFiles) && (args.action!=='process'||c.readFiles&&c.writeFiles);
  }
  return false; // New/plugin tool identifiers need an explicit mapping, never trust self-declared permissions.
}
export const filterToolsByCapabilities = (tools,capabilities) => tools.filter(t=>toolCapabilityAllowed(t.id,capabilities));
export function migrateLegacyCapabilities(profile, {skills=[],connectors=[]}={}) {
  const tools=new Set(profile.tools || []), local=tools.has('local-files');
  return normalizeCapabilities({readFiles:local,writeFiles:local,runCommands:tools.has('local-command'),network:tools.has('search'),knowledgeMemory:tools.has('artifacts')||tools.has('search'),
    mcpServers:tools.has('external-connectors')?profile.enabledMcpServerIds:[],
    connectors:tools.has('external-connectors')?connectors.filter(c=>!Array.isArray(profile.enabledConnectorIds)||profile.enabledConnectorIds.includes(c.id)).map(c=>c.id):[],
    skills:tools.has('skills')?skills.filter(s=>(!Array.isArray(profile.enabledSkillIds)||profile.enabledSkillIds.includes(s.id))&&(!s.allowedAgentIds?.length||s.allowedAgentIds.includes(profile.id))).map(s=>s.id):[]});
}
