import {normalizeCapabilities,intersectCapabilities,toolCapabilityAllowed,filterToolsByCapabilities} from './capabilities.js';

function freezeScope(value) {
  const capabilities=normalizeCapabilities(value?.capabilities);
  if (!value?.agentId || (!capabilities && value.legacy!==true)) return null;
  if (capabilities) {
    for (const key of ['mcpServers','skills','connectors']) Object.freeze(capabilities[key]);
    Object.freeze(capabilities);
  }
  return Object.freeze({agentId:value.agentId,capabilities,legacy:!capabilities && value.legacy===true,
    source:value.source || 'turn',allowedToolIds:Array.isArray(value.allowedToolIds)?Object.freeze([...new Set(value.allowedToolIds)]):null});
}
export const normalizeCapabilityScope=freezeScope;
export const capabilityScopeForProfile=(profile,source='turn')=>freezeScope({agentId:profile?.id,capabilities:profile?.capabilities,legacy:!!profile && !normalizeCapabilities(profile.capabilities),source});
export function narrowCapabilityScope(scope,{capabilities,allowedToolIds,agentId,source}={}) {
  scope=freezeScope(scope);
  if (!scope) return null;
  const narrowed=intersectCapabilities(scope.capabilities,capabilities);
  const ids=Array.isArray(allowedToolIds)
    ? (scope.allowedToolIds?scope.allowedToolIds.filter(id=>allowedToolIds.includes(id)):allowedToolIds)
    : scope.allowedToolIds;
  return freezeScope({...scope,agentId:agentId || scope.agentId,source:source || scope.source,capabilities:narrowed,legacy:scope.legacy && !narrowed,allowedToolIds:ids});
}
export function scopeAllowsTool(scope,id,args) {
  return !!scope && (!scope.allowedToolIds || scope.allowedToolIds.includes(id)) &&
    (scope.legacy===true || !!scope.capabilities && toolCapabilityAllowed(id,scope.capabilities,args));
}
export const toolsForCapabilityScope=(tools,scope)=>scope?filterToolsByCapabilities(tools,scope.capabilities).filter(t=>scopeAllowsTool(scope,t.id)):[];
export const nativeFeaturesForScope=scope=>({nativeWebSearchEnabled:scopeAllowsTool(scope,'web_search'),nativeImageGenerationEnabled:scopeAllowsTool(scope,'image',{action:'generate'})});
export const missingCapabilityScope=()=>({ok:false,error:'CAPABILITY_SCOPE_MISSING',output:'Cannot determine the executing Agent capability scope.',meta:{denied:true,executionStarted:false}});
