// Optional capability wire validation; deployable with mobile-sync alone.
import {createHash} from 'node:crypto';
import {syncSchema} from './syncContract.generated.js';
import {validateSchema} from './schemaValidator.js';
import {stableJSON,validateWorkspace} from './workspaceProtocol.js';
export const settingsID=(projectId,agentId)=>'settings-'+createHash('sha256').update(JSON.stringify([projectId||null,agentId])).digest('hex');
export function settingsPayload(value) {validateSchema(value,syncSchema.$defs.agentSettings,syncSchema);return value;}
// Connection IDs refer to credentials on this device, not portable permissions.
export function portableCollaboration(value = {}) { const {jobModels, ...portable} = value; return portable; }
const LOCAL_ROUTING_REVISION = 'agent-settings-local-routing-v1';
export function validateAgentSettings(workspace) {
 const result=validateWorkspace(workspace);if(!result)throw new Error('Missing Agent settings');
 for(const row of result.records)for(const version of row.versions){
  const v=version.value;
  if(row.kind!=='knowledge'||v.kind!=='agent-settings-v1'||v.deleted||v.projectId!==null)throw new Error('Invalid Agent settings envelope');
  const payload=settingsPayload(JSON.parse(v.content));
  if(row.id!==settingsID(payload.projectId,payload.agentId))throw new Error('Agent settings identity mismatch');
  if(Object.hasOwn(payload.collaboration,'jobModels')) {
   // Version the compatibility projection. Never alter bytes at the old causal
   // clock or collapse independent permission conflicts. Idempotent on replay.
   payload.collaboration=portableCollaboration(payload.collaboration);
   v.content=stableJSON(payload);
   version.clock[LOCAL_ROUTING_REVISION]=(version.clock[LOCAL_ROUTING_REVISION]||0)+1;
  }
 }
 return validateWorkspace(result);
}
