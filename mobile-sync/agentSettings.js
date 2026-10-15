// Desktop projection for the independent Agent capability sync channel.
import {randomUUID} from 'node:crypto';
import {putWorkspace,stableJSON} from './workspaceProtocol.js';
import {normalizeCapabilities,normalizeCollaboration} from '../src/domain/agent/capabilities.js';
import {settingsID,settingsPayload,validateAgentSettings} from './agentSettingsProtocol.js';
export {settingsID,settingsPayload,validateAgentSettings} from './agentSettingsProtocol.js';
export function refreshAgentSettings(state) {
 const workspace=validateAgentSettings(state.agentSettingsSync||{version:1,records:[]});
 state.mobileWorkspaceDevice ||= randomUUID();
 const put=(projectId,agentId,profile)=>{
  if(!profile.capabilities)return;
  const p={agentId,projectId,capabilities:normalizeCapabilities(profile.capabilities),collaboration:normalizeCollaboration(profile.collaboration),contextSources:Object.fromEntries(['projects','knowledge','memory'].map(k=>[k,profile.contextSources?.[k]!==false]))};
  settingsPayload(p);
  putWorkspace(workspace,'knowledge',settingsID(projectId,agentId),{title:`${projectId||'global'} / ${agentId}`,content:stableJSON(p),kind:'agent-settings-v1',language:'json',projectId:null,deleted:false},state.mobileWorkspaceDevice);
 };
 for(const [id,profile] of Object.entries(state.agentProfiles||{}))put(null,id,profile);
 for(const [projectId,profiles] of Object.entries(state.projectAgentOverrides||{}))for(const [id,profile] of Object.entries(profiles))put(projectId,id,profile);
 state.agentSettingsSync=validateAgentSettings(workspace);return state.agentSettingsSync;
}
export function applyAgentSettings(state,workspace) {
 workspace=validateAgentSettings(workspace);
 for(const row of workspace.records)if(row.versions.length===1){
  const p=JSON.parse(row.versions[0].value.content);
  const target=p.projectId?state.projectAgentOverrides?.[p.projectId]?.[p.agentId]:state.agentProfiles?.[p.agentId];
  // Never resurrect deleted Agents/projects from a delayed settings packet.
  if(target)Object.assign(target,{capabilities:p.capabilities,collaboration:p.collaboration,contextSources:p.contextSources});
 }
 state.agentSettingsSync=workspace;
}
