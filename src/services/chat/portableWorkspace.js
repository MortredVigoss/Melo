import { withoutDeletedChatContext } from '../../../mobile-sync/protocol.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { portableAgent, portableModel, portableScene, putWorkspace, validateWorkspace, stableJSON } from '../../../mobile-sync/workspaceProtocol.js';
import { effectiveAgentProfile, normalizeAgentProfile } from '../../state/agentProfiles.js';
import { allAgentIdsFromProfiles } from '../../domain/agent/agentLibrary.js';
import { createExecutionScene } from '../../shared/executionScene.js';

export const connectionBase = value => String(value || '').replace(/\/(?:chat\/completions|messages)\/?$/, '').replace(/\/+$/, '');
function agentValue(profile) {
  return portableAgent({name:profile.name,subtitle:profile.description,instructions:profile.rolePrompt,symbol:profile.symbol || 'person.crop.square',avatarData:profile.avatarData?.split(',')[1] || '',identity:profile.identity,soul:profile.soulMd,systemPrompt:profile.systemPrompt,mood:profile.mood,model:profile.model});
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
export function refreshPortableWorkspace(state,{config={},scenes=new Map()}={}) {
  const device=state.mobileWorkspaceDevice ||= randomUUID();
  const workspace=validateWorkspace(withoutDeletedChatContext(state.mobileWorkspaceSync, state.mobileDeletedChats)) || {version:1,records:[]};
  for(const id of allAgentIdsFromProfiles(state.agentProfiles || {}))putWorkspace(workspace,'agent',id,agentValue(effectiveAgentProfile(state,id)),device);
  for(const project of state.projects || []) {
    const agentOverrides={};for(const id of Object.keys(state.projectAgentOverrides?.[project.id] || {}))agentOverrides[id]=agentValue(effectiveAgentProfile(state,id,project.id));
    putWorkspace(workspace,'project',project.id,{name:project.name,goal:project.summary,instructions:project.instructions,archived:project.archived,knowledgeIds:project.knowledgeIds,agentOverrides},device);
  }
  for(const note of state.artifacts || []) {
    if(typeof note.content!=='string')continue;
    putWorkspace(workspace,'knowledge',note.id,{title:note.title,content:note.content,deleted:!!note.deletedAt,kind:note.kind,language:note.language,projectId:note.projectId},device);
  }
  for(const chat of state.chats.filter(c=>!c.externalThreadKey)) {
    putWorkspace(workspace,'conversation',chat.id,{agentId:chat.agentId || 'main',projectId:chat.projectId,knowledgeIds:chat.contextArtifactIds,model:exportModelSelection(chat.modelSelection,config)},device);
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
  return normalizeAgentProfile(id,{...(old || {tools:['projects','artifacts'],enabledConnectorIds:[],enabledSkillIds:[],enabledMcpServerIds:[]}),portableIdentity:true,name:value.name,description:value.subtitle,rolePrompt:value.instructions,avatarData:value.avatarData?'data:image/jpeg;base64,'+value.avatarData:'',identity:value.identity,soulMd:value.soul,systemPrompt:value.systemPrompt,mood:value.mood,model:value.model,symbol:value.symbol});
}
export function sceneFromPortable(value,chatId,messageId) {
  if(!value)return null;
  return {...createExecutionScene({runId:value.runId,chatId,query:value.query,startedAt:value.startedAt}),...value,artifacts:[],previews:[],events:[],messageId,observationVersion:2,observationNote:'跨设备同步的真实执行与来源记录；本机未重新执行。'};
}
export function applyPortableWorkspace(state,workspace,{config={},home}={}) {
  workspace=validateWorkspace(workspace);
  if(!workspace)return state;
  state.agentProfiles ||= {};state.projects ||= [];state.artifacts ||= [];state.projectAgentOverrides ||= {};
  const records=workspace.records.filter(r=>r.versions.length===1),now=new Date().toISOString();
  for(const r of records) {const v=r.versions[0].value;
    if(r.kind==='agent')state.agentProfiles[r.id]=importedAgent(r.id,v,state.agentProfiles[r.id]);
    if(r.kind==='project') {
      let p=state.projects.find(p=>p.id===r.id);
      if(!p){p={id:r.id,tag:'项目',workspacePath:home?join(home,'workspaces',r.id):'',createdAt:now};state.projects.push(p);}
      const update={name:v.name,summary:v.goal,instructions:v.instructions,archived:v.archived,knowledgeIds:v.knowledgeIds};
      if(stableJSON(Object.fromEntries(Object.keys(update).map(key=>[key,p[key]])))!==stableJSON(update))p.updatedAt=now;
      Object.assign(p,update);
      state.projectAgentOverrides[r.id]=Object.fromEntries(Object.entries(v.agentOverrides).map(([id,a])=>[id,{...state.projectAgentOverrides[r.id]?.[id],portableIdentity:true,name:a.name,description:a.subtitle,rolePrompt:a.instructions,identity:a.identity,soulMd:a.soul,systemPrompt:a.systemPrompt,mood:a.mood,model:a.model,symbol:a.symbol,avatarData:a.avatarData?'data:image/jpeg;base64,'+a.avatarData:''}]));
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
