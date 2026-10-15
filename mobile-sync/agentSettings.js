// Desktop projection: the sync credential transports proposals, never authority.
import {randomUUID,createHash} from 'node:crypto';
import {putWorkspace,stableJSON} from './workspaceProtocol.js';
import {normalizeCapabilities,normalizeCollaboration,intersectCapabilities,intersectCollaboration} from '../src/domain/agent/capabilities.js';
import {settingsID,settingsPayload,validateAgentSettings} from './agentSettingsProtocol.js';
export {settingsID,settingsPayload,validateAgentSettings} from './agentSettingsProtocol.js';
const contexts=value=>Object.fromEntries(['projects','knowledge','memory'].map(k=>[k,value?.[k]!==false]));
const permissions=profile=>({capabilities:normalizeCapabilities(profile.capabilities),collaboration:normalizeCollaboration(profile.collaboration),contextSources:contexts(profile.contextSources)});
const own=(object,key)=>Object.hasOwn(object||{},key)?object[key]:null;
function targetFor(state,projectId,agentId) {
 return projectId?own(own(state.projectAgentOverrides,projectId),agentId):own(state.agentProfiles,agentId);
}
function baselineFor(state,p,target) {
 return {current:permissions(target),global:p.projectId?permissions(state.agentProfiles?.[p.agentId]||{}):null};
}
const fingerprint=value=>createHash('sha256').update(stableJSON(value)).digest('hex');
export function refreshAgentSettings(state) {
 const workspace=validateAgentSettings(state.agentSettingsSync||{version:1,records:[]});
 state.mobileWorkspaceDevice ||= randomUUID();
 const put=(projectId,agentId,profile)=>{
  if(!profile.capabilities)return;
  const id=settingsID(projectId,agentId),pending=state.agentSettingsPending?.[id];
  const p={agentId,projectId,...permissions(profile)};
  // Keep the unapproved remote version intact while its local restriction is
  // effective. An explicit desktop edit supersedes that proposal.
  if(pending&&stableJSON(pending.baseline)===stableJSON(baselineFor(state,p,profile)))return;
  if(pending)delete state.agentSettingsPending[id];
  settingsPayload(p);
  putWorkspace(workspace,'knowledge',id,{title:`${projectId||'global'} / ${agentId}`,content:stableJSON(p),kind:'agent-settings-v1',language:'json',projectId:null,deleted:false},state.mobileWorkspaceDevice);
 };
 for(const [id,profile] of Object.entries(state.agentProfiles||{}))put(null,id,profile);
 for(const [projectId,profiles] of Object.entries(state.projectAgentOverrides||{}))for(const [id,profile] of Object.entries(profiles))put(projectId,id,profile);
 for(const [id,pending] of Object.entries(state.agentSettingsPending||{}))if(!targetFor(state,pending.projectId,pending.agentId))delete state.agentSettingsPending[id];
 state.agentSettingsSync=validateAgentSettings(workspace);return state.agentSettingsSync;
}
export function applyAgentSettings(state,workspace) {
 workspace=validateAgentSettings(workspace);
 state.agentSettingsPending ||= {};
 for(const row of workspace.records) {
  if(row.versions.length!==1){delete state.agentSettingsPending[row.id];continue;}
  const p=JSON.parse(row.versions[0].value.content),target=targetFor(state,p.projectId,p.agentId);
  if(!target){delete state.agentSettingsPending[row.id];continue;}
  const before=permissions(target);
  const base=p.projectId?permissions(state.agentProfiles?.[p.agentId]||{}):before;
  // Legacy profiles must first complete the desktop migration preview. A sync
  // packet must neither authorize delegation nor silently migrate those users.
  if(before.capabilities&&base.capabilities) {
   const capabilities=intersectCapabilities(intersectCapabilities(before.capabilities,base.capabilities),p.capabilities);
   const collaboration=intersectCollaboration(intersectCollaboration(before.collaboration,base.collaboration),p.collaboration);
   const contextSources=Object.fromEntries(Object.keys(before.contextSources).map(k=>[k,before.contextSources[k]&&p.contextSources[k]]));
   Object.assign(target,{capabilities,collaboration,contextSources});
  }
  if(stableJSON(permissions(target))!==stableJSON(permissions(p))) {
   const pending={id:row.id,agentId:p.agentId,projectId:p.projectId,requested:permissions(p),baseline:baselineFor(state,p,target),version:row.versions[0]};
   state.agentSettingsPending[row.id]={...pending,fingerprint:fingerprint(pending)};
  }else delete state.agentSettingsPending[row.id];
 }
 state.agentSettingsSync=workspace;
}
export function confirmAgentSettings(state,{id,expected,accept}) {
 const pending=state.agentSettingsPending?.[id];
 const target=pending&&targetFor(state,pending.projectId,pending.agentId);
 const row=state.agentSettingsSync?.records.find(r=>r.id===id);
 if(!pending||!target||pending.fingerprint!==expected||row?.versions.length!==1||stableJSON(row.versions[0])!==stableJSON(pending.version)||stableJSON(baselineFor(state,pending,target))!==stableJSON(pending.baseline)) {
  throw Object.assign(new Error('待确认的能力设置已变化，请刷新后重新核对。'),{statusCode:409});
 }
 if(typeof accept!=='boolean')throw Object.assign(new Error('需要明确接受或拒绝。'),{statusCode:400});
 if(accept) {
  if(!target.capabilities||pending.projectId&&!state.agentProfiles?.[pending.agentId]?.capabilities)throw Object.assign(new Error('请先在桌面完成此 Agent 的全局能力迁移。'),{statusCode:409});
  const requested=structuredClone(pending.requested);
  if(pending.projectId) {
   const global=permissions(state.agentProfiles[pending.agentId]);
   requested.capabilities=intersectCapabilities(global.capabilities,requested.capabilities);
   requested.collaboration=intersectCollaboration(global.collaboration,requested.collaboration);
  }
  Object.assign(target,requested);
 }
 delete state.agentSettingsPending[id];
 refreshAgentSettings(state);
 return state;
}
