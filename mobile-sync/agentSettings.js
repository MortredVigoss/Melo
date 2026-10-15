// Optional transport, separate from v1 workspace/persona and user knowledge.
// Reuse its multi-value registers; payloads have their own strict shared schema.
import {createHash,randomUUID} from 'node:crypto';
import {syncSchema} from './syncContract.generated.js';
import {validateSchema} from './schemaValidator.js';
import {validateWorkspace,putWorkspace,stableJSON} from './workspaceProtocol.js';
import {normalizeCapabilities,normalizeCollaboration} from '../src/domain/agent/capabilities.js';
export const settingsID=(projectId,agentId)=>'settings-'+createHash('sha256').update(JSON.stringify([projectId||null,agentId])).digest('hex');
export function settingsPayload(value) {validateSchema(value,syncSchema.$defs.agentSettings,syncSchema);return value;}
export function validateAgentSettings(workspace) {
 const result=validateWorkspace(workspace);if(!result)throw new Error('Missing Agent settings');
 for(const row of result.records)for(const version of row.versions){
  const v=version.value;
  if(row.kind!=='knowledge'||v.kind!=='agent-settings-v1'||v.deleted||v.projectId!==null)throw new Error('Invalid Agent settings envelope');
  const payload=settingsPayload(JSON.parse(v.content));
  if(row.id!==settingsID(payload.projectId,payload.agentId))throw new Error('Agent settings identity mismatch');
 }
 return result;
}
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
