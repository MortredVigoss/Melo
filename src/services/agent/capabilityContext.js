import {loadState} from '../../state/stateStore.js';
import {effectiveAgentProfile} from '../../state/agentProfiles.js';
import {capabilityScopeForProfile,normalizeCapabilityScope} from '../../domain/agent/capabilityScope.js';

// Snapshot the local profile at the turn boundary. Never infer authority from
// UI selection, a caller-supplied capability bag, or an unknown Agent id.
export function capabilityScopeFromState(state,binding) {
  const id=binding?.role;
  if (!id || !Object.hasOwn(state.agentProfiles || {},id)) return null;
  return capabilityScopeForProfile(effectiveAgentProfile(state,id,binding.project));
}
export async function resolveCapabilityContext(context,{state,chat,agentId}={}) {
  if (!context) return null;
  const captured=context.capabilityScope || context.turnBinding?.capabilityScope;
  if (captured) {
    const capabilityScope=normalizeCapabilityScope(captured);
    return capabilityScope?Object.freeze({...context,capabilityScope}):null;
  }
  if (!context.home) return null;
  state ||= await loadState({home:context.home});
  chat ||= state.chats?.find(c=>c.id===context.chatId);
  const turnBinding=context.turnBinding || (chat?{role:agentId || chat.agentId || 'main',project:chat.projectId || null,
    taskId:state.tasks?.find(t=>t.execution?.runId===context.runId && t.execution.status==='running')?.id || null}:null);
  const capabilityScope=capabilityScopeFromState(state,turnBinding);
  return capabilityScope?Object.freeze({...context,turnBinding:Object.freeze({...turnBinding,capabilityScope}),capabilityScope}):null;
}
