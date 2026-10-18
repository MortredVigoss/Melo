import {emptyCapabilities} from '../../domain/agent/capabilities.js';
import { encodeV1Persona, decodeV1Persona } from '../../../mobile-sync/agentCompatibility.js';
import { withoutDeletedChatContext } from '../../../mobile-sync/protocol.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { portableAgent, portableValue, portableModel, portableScene, putWorkspace, validateWorkspace, stableJSON, mergeWorkspaces, portableCompact, preferCompact, compactAdvances, COMPACT_SUMMARY_LIMIT, COMPACT_CARD_SUMMARY_LIMIT, COMPACT_CARDS_LIMIT } from '../../../mobile-sync/workspaceProtocol.js';
import { normalizeCompactCards, renderCompactLedger, compactCardsEqual, LEDGER_MAX_TOKENS } from '../../memory/compactLedger.js';
import { effectiveAgentProfile, normalizeAgentProfile } from '../../state/agentProfiles.js';
import { allAgentIdsFromProfiles } from '../../domain/agent/agentLibrary.js';
import { createExecutionScene } from '../../shared/executionScene.js';

export const connectionBase = value => String(value || '').replace(/\/(?:chat\/completions|messages)\/?$/, '').replace(/\/+$/, '');
function previousValue(state, kind, id) {
  const row = state.mobileWorkspaceSync?.records.find(row => row.kind === kind && row.id === id);
  return row?.versions.length === 1 ? row.versions[0].value : null;
}
function agentValue(profile, previous) {
  const fields = encodeV1Persona(profile.instructions, previous);
  if (!fields) return null;
  return portableAgent({name:profile.name,subtitle:profile.description,...fields,symbol:profile.symbol || 'person.crop.square',avatarData:profile.avatarData?.split(',')[1] || '',mood:profile.mood,model:profile.model});
}
export function pendingPersonaRecords(state) {
  const pending = [];
  const available = (kind, id) => !!previousValue(state,kind,id);
  const hold = (kind,id,name) => pending.push({kind,id,name});
  for (const id of allAgentIdsFromProfiles(state.agentProfiles || {})) {
    const profile = effectiveAgentProfile(state,id);
    if (!agentValue(profile,previousValue(state,'agent',id))) hold('agent',id,profile.name);
  }
  for (const project of state.projects || []) {
    const previous = previousValue(state,'project',project.id);
    if (Object.keys(state.projectAgentOverrides?.[project.id] || {}).some(id =>
      !agentValue(effectiveAgentProfile(state,id,project.id),previous?.agentOverrides?.[id]))) hold('project',project.id,project.name);
  }
  for (const chat of state.chats || []) {
    if (chat.externalThreadKey) continue;
    if (pending.some(item => !available(item.kind,item.id) &&
      (item.kind === 'agent' && item.id === (chat.agentId || 'main') || item.kind === 'project' && item.id === chat.projectId))) hold('conversation',chat.id,chat.title);
  }
  for (const [key, hold] of Object.entries(state.mobilePersonaSyncHolds || {})) {
    if (!pending.some(row => `${row.kind}:${row.id}` === key)) pending.push({kind:hold.kind,id:hold.id,name:hold.name});
  }
  return pending;
}

export function exportModelSelection(choice, config) {
  if(!choice)return null;
  if(choice.portable)return portableModel(choice.portable);
  const profile=choice.profileId?config.llmProfiles?.[choice.profileId]:config;
  return portableModel({connectionID:choice.profileId || '',name:profile?.name || '',model:choice.model,authMode:profile?.authMode || choice.authMode,baseURL:connectionBase(profile?.baseUrl || choice.baseUrl),apiProtocol:profile?.apiProtocol});
}
export function importModelSelection(value, config) {
  if(!value)return null;
  const model=portableModel(value), candidates=Object.entries(config.llmProfiles || {}).filter(([,p])=>p.authMode===model.authMode && (model.authMode==='codex'||connectionBase(p.baseUrl)===connectionBase(model.baseURL)) && (p.apiProtocol || 'chat-completions')===model.apiProtocol);
  const match=candidates.find(([id])=>id===model.connectionID) || (candidates.length===1?candidates[0]:null);
  if(match)return {profileId:match[0],model:model.model,authMode:model.authMode,baseUrl:match[1].baseUrl,portable:model};
  if(config.authMode===model.authMode && (model.authMode==='codex'||connectionBase(config.baseUrl)===connectionBase(model.baseURL)) && (config.apiProtocol || 'chat-completions')===model.apiProtocol) return {profileId:'',model:model.model,authMode:config.authMode,baseUrl:config.baseUrl,portable:model};
  return {profileId:'unconnected-sync',model:model.model,authMode:model.authMode,baseUrl:model.baseURL,portable:model};
}
// Desktop compact state → `conversation.compact` (design 2026-10-17 手机对齐).
// Desktop is the primary summariser; the previous synced record is kept when
// it is ahead (a phone-side local summary the desktop has not applied yet).
const clip = (value, limit) => {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= limit) return text;
  // Never split a surrogate pair: the phone decodes JSON strictly.
  const code = text.charCodeAt(limit - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit);
};
// The phone prepends `summary` to its instructions and clips it at
// COMPACT_SUMMARY_LIMIT *bytes*; the desktop ledger is a 6000-token
// rendering, oldest card first. Clipping that text used to keep the oldest
// cards and drop the newest (audit L9). The phone gets its own rendering:
// the ledger re-rendered at a shrinking token budget (oldest cards collapse
// to a title line first, the newest always stays in full) until it fits the
// byte limit; only a single oversized card is ever cut mid-text.
export function renderPhoneLedger(cards, { maxBytes = COMPACT_SUMMARY_LIMIT } = {}) {
  const list = normalizeCompactCards(cards);
  if (!list.length) return '';
  let maxTokens = LEDGER_MAX_TOKENS;
  let text = renderCompactLedger(list, { maxTokens });
  while (Buffer.byteLength(text, 'utf8') > maxBytes && maxTokens > 256) {
    maxTokens = Math.floor(maxTokens * 0.8);
    text = renderCompactLedger(list, { maxTokens });
  }
  return clipBytes(text, maxBytes);
}
// Byte-bounded clip on a character boundary (never inside a surrogate pair).
function clipBytes(value, maxBytes) {
  const text = typeof value === 'string' ? value : '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end -= Math.max(1, Math.ceil((Buffer.byteLength(text.slice(0, end), 'utf8') - maxBytes) / 4));
  const code = text.charCodeAt(end - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
}
export function exportCompact(chat, previous = null) {
  const count = Number(chat?.compactedMessageCount) || 0;
  const boundary = typeof chat?.compactBoundaryMessageId === 'string' ? chat.compactBoundaryMessageId : '';
  let current = null;
  if (count > 0 && boundary && chat.messages?.some(message => message.id === boundary)) {
    const ledger = normalizeCompactCards(chat.compactCards);
    const cards = ledger.slice(-COMPACT_CARDS_LIMIT).map(card => ({
      id: card.id, title: clip(card.title, 200), summary: clip(card.summary, COMPACT_CARD_SUMMARY_LIMIT),
      fromMessageId: card.fromMessageId, toMessageId: card.toMessageId, messageCount: card.messageCount, at: card.at, source: card.source,
    }));
    // The desktop rendering travels as-is while it fits the phone's byte
    // limit; past that the ledger is re-rendered for the phone (newest card
    // kept), and a bare legacy summary is clipped on a byte boundary.
    const desktop = typeof chat.compactSummary === 'string' ? chat.compactSummary : '';
    const summary = Buffer.byteLength(desktop, 'utf8') <= COMPACT_SUMMARY_LIMIT ? desktop
      : ledger.length ? renderPhoneLedger(ledger) : clipBytes(desktop, COMPACT_SUMMARY_LIMIT);
    try {
      current = portableCompact({
        boundaryMessageId: boundary, compactedCount: count,
        source: ['cloud','local','rule'].includes(chat.compactSummarySource) ? chat.compactSummarySource : 'cloud',
        at: Number.isFinite(Date.parse(chat.compactedAt)) ? chat.compactedAt : new Date(0).toISOString(),
        summary, cards,
      });
    } catch { current = null; }
  }
  return preferCompact(previous || null, current);
}
// Incoming compact → chat fields, only when it advances (larger count, or a
// later `at` at the same count). The caller runs inside the state update, so
// the assignment is persisted with the rest of the import.
export function applyCompact(chat, incoming) {
  if (!chat || !incoming) return false;
  const current = exportCompact(chat);
  if (!compactAdvances(current, incoming)) return false;
  if (!chat.messages?.some(message => message.id === incoming.boundaryMessageId)) return false;
  // Cards already held locally keep their local text (the wire copy is
  // clipped to 2 KB per card): an incoming card only lands when its id is
  // new (audit L9). When a local card was preserved over a differing wire
  // copy, the summary is re-rendered from the merged ledger instead of
  // taking the phone-sized text.
  const local = new Map(normalizeCompactCards(chat.compactCards).map(card => [card.id, card]));
  let preserved = false;
  const cards = normalizeCompactCards(incoming.cards).map(card => {
    const mine = local.get(card.id);
    if (!mine) return card;
    if (!compactCardsEqual([mine], [card])) preserved = true;
    return mine;
  });
  chat.compactBoundaryMessageId = incoming.boundaryMessageId;
  chat.compactedMessageCount = incoming.compactedCount;
  chat.compactSummary = preserved ? renderCompactLedger(cards) : incoming.summary;
  chat.compactSummarySource = incoming.source;
  chat.compactedAt = incoming.at;
  chat.compactCards = cards;
  chat.compactFailures = 0;
  chat.compactUpgradeAttempts = 0;
  return true;
}
export function refreshPortableWorkspace(state,{config={},scenes=new Map()}={}) {
  const device=state.mobileWorkspaceDevice ||= randomUUID();
  const workspace=validateWorkspace(withoutDeletedChatContext(state.mobileWorkspaceSync, state.mobileDeletedChats)) || {version:1,records:[]};
  const holds = state.mobilePersonaSyncHolds ||= {};
  const liveChats = new Set((state.chats || []).filter(chat=>!chat.externalThreadKey).map(chat=>chat.id));
  for (const [key,held] of Object.entries(holds)) if (held.kind === 'conversation' && !liveChats.has(held.id)) delete holds[key];
  function hold(kind,id,name) {
    const key = `${kind}:${id}`;
    holds[key] ||= {kind,id,name,base:structuredClone(workspace.records.find(row=>row.kind===kind&&row.id===id) || null)};
  }
  function put(kind,id,value) {
    const key = `${kind}:${id}`, held = holds[key];
    if (!held) { putWorkspace(workspace,kind,id,value,device); return; }
    // A withheld edit branches from the last observed record, not from a
    // remote update that arrived while the local document could not sync.
    const clocks = (held.base?.versions || []).map(version=>version.clock);
    const clock = {};
    for (const key of new Set(clocks.flatMap(clock=>Object.keys(clock)))) {
      const count = Math.min(...clocks.map(clock=>clock[key] || 0));
      if (count) clock[key] = count;
    }
    clock[device] = Math.max(0,...clocks.map(clock=>clock[device] || 0)) + 1;
    const candidate = {version:1,records:[{kind,id,versions:[{clock,value:portableValue(kind,value)}]}]};
    workspace.records = mergeWorkspaces(workspace,candidate).records;
    delete holds[key];
  }
  const unavailableAgents = new Set(), unavailableProjects = new Set();
  for(const id of allAgentIdsFromProfiles(state.agentProfiles || {})) {
    const profile = effectiveAgentProfile(state,id);
    const value = agentValue(profile,previousValue(state,'agent',id));
    if (value) put('agent',id,value);
    else { hold('agent',id,profile.name); if (!previousValue(state,'agent',id)) unavailableAgents.add(id); }
  }
  for(const project of state.projects || []) {
    const previous = previousValue(state,'project',project.id), agentOverrides={};
    for(const id of Object.keys(state.projectAgentOverrides?.[project.id] || {})) agentOverrides[id]=agentValue(effectiveAgentProfile(state,id,project.id),previous?.agentOverrides?.[id]);
    if (Object.values(agentOverrides).some(value=>!value)) {
      hold('project',project.id,project.name);
      if (!previous) unavailableProjects.add(project.id);
    } else put('project',project.id,{name:project.name,goal:project.summary,instructions:project.instructions,archived:project.archived,knowledgeIds:project.knowledgeIds,agentOverrides});
  }
  for(const note of state.artifacts || []) {
    if(typeof note.content!=='string')continue;
    putWorkspace(workspace,'knowledge',note.id,{title:note.title,content:note.content,deleted:!!note.deletedAt,kind:note.kind,language:note.language,projectId:note.projectId},device);
  }
  for(const chat of state.chats.filter(c=>!c.externalThreadKey)) {
    if (unavailableAgents.has(chat.agentId || 'main') || unavailableProjects.has(chat.projectId)) hold('conversation',chat.id,chat.title);
    else put('conversation',chat.id,{agentId:chat.agentId || 'main',projectId:chat.projectId,knowledgeIds:chat.contextArtifactIds,model:exportModelSelection(chat.modelSelection,config),compact:exportCompact(chat,previousValue(state,'conversation',chat.id)?.compact)});
    for(const message of chat.messages.filter(m=>m.role==='assistant'&&!m.pending)) {
      const previous = workspace.records.find(r => r.kind === 'message' && r.id === message.id);
      const preserved = previous?.versions.length === 1 ? previous.versions[0].value.scene : null;
      const scene=scenes.get(message.metadata?.runId) || preserved || message.metadata?.syncedExecutionScene;
      const finalScene=scene && ['completed','failed','cancelled','interrupted'].includes(scene.status)?portableScene({...scene,sourceDevice:scene.sourceDevice || device}):null;
      const models=(message.metadata?.modelResponses || []).map(m=>({requestedModel:m.requestedModel,reportedModel:m.reportedModel,simulated:m.simulated,...(m.purpose ? {purpose:m.purpose} : {})}));
      putWorkspace(workspace,'message',message.id,{chatId:chat.id,agent:message.metadata?.agent?{agentID:message.metadata.agent.id,name:message.metadata.agent.name,symbol:message.metadata.agent.symbol}:null,models,scene:finalScene},device);
    }
  }
  state.mobileWorkspaceSync=validateWorkspace(workspace);
  return state.mobileWorkspaceSync;
}
function importedAgent(id,value,old) {
  return normalizeAgentProfile(id,{...(old || {capabilities:emptyCapabilities(),tools:['projects','artifacts'],enabledConnectorIds:[],enabledSkillIds:[],enabledMcpServerIds:[]}),portableIdentity:true,name:value.name,description:value.subtitle,instructions:decodeV1Persona(value),avatarData:value.avatarData?'data:image/jpeg;base64,'+value.avatarData:'',identity:value.identity,soulMd:value.soul,systemPrompt:value.systemPrompt,mood:value.mood,model:value.model,symbol:value.symbol});
}
export function sceneFromPortable(value,chatId,messageId) {
  if(!value)return null;
  return {...createExecutionScene({runId:value.runId,chatId,query:value.query,startedAt:value.startedAt}),...value,artifacts:[],previews:[],events:[],messageId,observationVersion:2,observationNote:'跨设备同步的真实执行与来源记录；本机未重新执行。'};
}
export function applyPortableWorkspace(state,workspace,{config={},home,resolvedKeys=[]}={}) {
  workspace=validateWorkspace(workspace);
  if(!workspace)return state;
  state.agentProfiles ||= {};state.projects ||= [];state.artifacts ||= [];state.projectAgentOverrides ||= {};
  const held = new Set(pendingPersonaRecords(state).map(row => `${row.kind}:${row.id}`));
  for (const key of resolvedKeys) {
    const row = workspace.records.find(row => `${row.kind}:${row.id}` === key && row.versions.length === 1);
    if (!row || !held.has(key)) continue;
    const persona = profile => Object.fromEntries(['name','description','instructions','symbol','avatarData','mood','model'].map(field=>[field,profile[field] ?? '']));
    const agents = row.kind === 'agent' ? {[row.id]:persona(effectiveAgentProfile(state,row.id))} : row.kind === 'project' ? Object.fromEntries(Object.keys(state.projectAgentOverrides[row.id] || {}).map(id=>[id,persona(effectiveAgentProfile(state,id,row.id))])) : {};
    if (Object.keys(agents).length) (state.agentPersonaRecoveries ||= []).push({id:randomUUID(),key,createdAt:new Date().toISOString(),agents});
    delete state.mobilePersonaSyncHolds?.[key];
    held.delete(key);
  }
  const records=workspace.records.filter(r=>r.versions.length===1 && !held.has(`${r.kind}:${r.id}`)),now=new Date().toISOString();
  for(const r of records) {const v=r.versions[0].value;
    if(r.kind==='agent')state.agentProfiles[r.id]=importedAgent(r.id,v,state.agentProfiles[r.id]);
    if(r.kind==='project') {
      let p=state.projects.find(p=>p.id===r.id);
      if(!p){p={id:r.id,tag:'项目',workspacePath:home?join(home,'workspaces',r.id):'',createdAt:now};state.projects.push(p);}
      const update={name:v.name,summary:v.goal,instructions:v.instructions,archived:v.archived,knowledgeIds:v.knowledgeIds};
      if(stableJSON(Object.fromEntries(Object.keys(update).map(key=>[key,p[key]])))!==stableJSON(update))p.updatedAt=now;
      Object.assign(p,update);
      // Persona synchronization cannot remove a desktop capability restriction
      // merely by omitting its Agent from the remote override list.
      const restrictions=Object.fromEntries(Object.entries(state.projectAgentOverrides[r.id]||{}).map(([id,profile])=>[id,Object.fromEntries(['capabilities','collaboration','contextSources'].filter(key=>Object.hasOwn(profile,key)).map(key=>[key,profile[key]]))]).filter(([,profile])=>Object.keys(profile).length));
      state.projectAgentOverrides[r.id]={...restrictions,...Object.fromEntries(Object.entries(v.agentOverrides).map(([id,a])=>[id,{...state.projectAgentOverrides[r.id]?.[id],portableIdentity:true,name:a.name,description:a.subtitle,instructions:decodeV1Persona(a),identity:a.identity,soulMd:a.soul,systemPrompt:a.systemPrompt,mood:a.mood,model:a.model,symbol:a.symbol,avatarData:a.avatarData?'data:image/jpeg;base64,'+a.avatarData:''}]))};
    }
    if(r.kind==='knowledge') {
      let note=state.artifacts.find(n=>n.id===r.id);
      if(!note){note={id:r.id,chatId:null,createdAt:now};state.artifacts.push(note);}
      Object.assign(note,{title:v.title,content:v.content,kind:v.kind,language:v.language,projectId:v.projectId});
      if(v.deleted)note.deletedAt ||= now;else delete note.deletedAt;
    }
  }
  for(const r of records){const v=r.versions[0].value;
    if(r.kind==='conversation') {
      const chat=state.chats.find(c=>c.id===r.id&&!c.externalThreadKey);if(!chat)continue;
      Object.assign(chat,{agentId:v.agentId,projectId:v.projectId,contextArtifactIds:v.knowledgeIds,modelSelection:importModelSelection(v.model,config)});
      if(v.compact)applyCompact(chat,v.compact);
    }
    if(r.kind==='message') {
      const chat=state.chats.find(c=>c.id===v.chatId&&!c.externalThreadKey),message=chat?.messages.find(m=>m.id===r.id&&m.role==='assistant');if(!message)continue;
      message.metadata ||= {};
      if(v.agent)message.metadata.agent={id:v.agent.agentID,name:v.agent.name,symbol:v.agent.symbol};
      if(v.models.length)message.metadata.modelResponses=v.models;
      if(v.scene){message.metadata.syncedExecutionScene=sceneFromPortable(v.scene,chat.id,message.id);message.metadata.runId ||= v.scene.runId;}
    }
  }
  state.mobileWorkspaceSync=workspace;
  return state;
}
