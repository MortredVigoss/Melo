// Optional extension: old v1 clients keep syncing chats without having to
// accept a memory whose source is a project rather than a conversation.
import {createHash} from 'node:crypto';
import {syncSchema} from './syncContract.generated.js';
import {validateSchema} from './schemaValidator.js';
import {validateWorkspace,stableJSON} from './workspaceProtocol.js';
export function projectMemoryPayload(envelope) {
  if(envelope.kind!=='project-memory-v1'||envelope.deleted||envelope.projectId!==null)throw new Error('Invalid project memory envelope');
  const value=JSON.parse(envelope.content);
  validateSchema(value,syncSchema.$defs.projectMemory,syncSchema);
  if(value.id!=='memory_'+createHash('sha256').update(value.memoryID).digest('hex')||!Number.isFinite(Date.parse(value.updatedAt)))throw new Error('Invalid project memory identity/date');
  if(value.validTo!=null&&!Number.isFinite(Date.parse(value.validTo)))throw new Error('Invalid project memory validity');
  return value;
}
export function projectMemoryEnvelope(value) {
  return {title:'Project memory',content:stableJSON(value),kind:'project-memory-v1',language:'json',projectId:null,deleted:false};
}
export function validateProjectMemory(workspace) {
  const result=validateWorkspace(workspace);
  if(!result)throw new Error('Missing project memory workspace');
  for(const row of result.records)for(const version of row.versions) {
    if(row.kind!=='knowledge'||projectMemoryPayload(version.value).id!==row.id)throw new Error('Project memory identity mismatch');
  }
  return result;
}
