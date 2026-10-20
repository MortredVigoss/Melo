import {normalizeCapabilities,intersectCapabilities,toolCapabilityAllowed,filterToolsByCapabilities} from './capabilities.js';
import {requestableCapabilities} from './capabilityElevation.js';

const freezeCaps=capabilities=>{
  if (capabilities) {
    for (const key of ['mcpServers','skills','connectors']) Object.freeze(capabilities[key]);
    Object.freeze(capabilities);
  }
  return capabilities;
};
// Capability elevation (2026-10-20, domain/agent/capabilityElevation.js): who
// the scope belongs to, its own settings (`ceiling`), the parent it was
// narrowed by (members only), the grant-free `base` the executor re-evaluates
// live grants against on every call, and whether an interactive surface can
// ask the user. Missing on legacy scopes and hand-built test scopes.
function freezeElevation(value,capabilities) {
  if (!value || typeof value!=='object' || !capabilities) return null;
  const ceiling=normalizeCapabilities(value.ceiling);
  if (!ceiling) return null;
  const parent=normalizeCapabilities(value.parent);
  const base=normalizeCapabilities(value.base) || capabilities;
  return Object.freeze({ceiling:freezeCaps(ceiling),parent:freezeCaps(parent),parentAgentId:parent?String(value.parentAgentId || ''):null,
    base:freezeCaps(normalizeCapabilities(base)),surface:value.surface===true});
}
function freezeScope(value) {
  const capabilities=normalizeCapabilities(value?.capabilities);
  if (!value?.agentId || (!capabilities && value.legacy!==true)) return null;
  freezeCaps(capabilities);
  return Object.freeze({agentId:value.agentId,capabilities,legacy:!capabilities && value.legacy===true,
    source:value.source || 'turn',allowedToolIds:Array.isArray(value.allowedToolIds)?Object.freeze([...new Set(value.allowedToolIds)]):null,
    elevation:freezeElevation(value.elevation,capabilities)});
}
export const normalizeCapabilityScope=freezeScope;
export const capabilityScopeForProfile=(profile,source='turn')=>{
  const capabilities=normalizeCapabilities(profile?.capabilities);
  return freezeScope({agentId:profile?.id,capabilities:profile?.capabilities,legacy:!!profile && !capabilities,source,
    elevation:capabilities?{ceiling:capabilities,parent:null,base:capabilities,surface:false}:null});
};
/**
 * Narrow a scope. Same Agent (skills, plain sub-agents, teams): capabilities,
 * base and tool whitelist are intersected; ceiling and parent stay. A switch to
 * another Agent (delegation / team member) passes `member: {ceiling, parent,
 * parentAgentId}`; its base starts from the given capabilities, never from the
 * parent's grants.
 */
export function narrowCapabilityScope(scope,{capabilities,allowedToolIds,agentId,source,member}={}) {
  scope=freezeScope(scope);
  if (!scope) return null;
  // A member never inherits the grants its parent's ambient scope carries.
  const narrowed=intersectCapabilities(member && scope.elevation ? scope.elevation.base : scope.capabilities,capabilities);
  const ids=Array.isArray(allowedToolIds)
    ? (scope.allowedToolIds?scope.allowedToolIds.filter(id=>allowedToolIds.includes(id)):allowedToolIds)
    : scope.allowedToolIds;
  const elevation=member
    ? {ceiling:member.ceiling,parent:member.parent,parentAgentId:member.parentAgentId,base:narrowed,surface:scope.elevation?.surface===true}
    : scope.elevation && {...scope.elevation,base:intersectCapabilities(scope.elevation.base,capabilities)};
  return freezeScope({...scope,agentId:agentId || scope.agentId,source:source || scope.source,capabilities:narrowed,legacy:scope.legacy && !narrowed,allowedToolIds:ids,elevation});
}
/** The turn's interactive surface (desktop SSE stream) decides whether prompts can be shown. */
export function withElevationSurface(scope,surface) {
  scope=freezeScope(scope);
  if (!scope?.elevation) return scope;
  return freezeScope({...scope,elevation:{...scope.elevation,surface:surface===true}});
}
/** Grant-free view the executor evaluates live grants against (revocation takes effect on the next call). */
export function liveCapabilityScope(scope) {
  scope=freezeScope(scope);
  if (!scope?.elevation) return scope;
  return freezeScope({...scope,capabilities:intersectCapabilities(scope.capabilities,scope.elevation.base)});
}
/** Ambient scope for one tool call that a grant allowed; `base` stays grant-free. */
export function elevatedCapabilityScope(scope,capabilities) {
  scope=freezeScope(scope);
  if (!scope?.elevation || !normalizeCapabilities(capabilities)) return scope;
  return freezeScope({...scope,capabilities});
}
// `tool` is either a tool id (legacy id tables decide) or the tool object, whose
// self-declared `capability` takes precedence over the tables.
export function scopeAllowsTool(scope,tool,args) {
  const id=typeof tool==='string'?tool:tool?.id;
  const object=typeof tool==='object'&&tool?tool:undefined;
  return !!scope && typeof id==='string' && (!scope.allowedToolIds || scope.allowedToolIds.includes(id)) &&
    (scope.legacy===true || !!scope.capabilities && toolCapabilityAllowed(id,scope.capabilities,args,object));
}
/** Capabilities whose tools the Agent sees: held ones plus, with a surface, the ones it could ask for. */
export const visibleCapabilities=scope=>scope?.elevation
  ? requestableCapabilities({capabilities:scope.capabilities,ceiling:scope.elevation.ceiling,surface:scope.elevation.surface})
  : scope?.capabilities ?? null;
export const toolsForCapabilityScope=(tools,scope)=>{
  if (!scope) return [];
  const visible=scope.elevation?{...scope,capabilities:visibleCapabilities(scope)}:scope;
  return filterToolsByCapabilities(tools,visible.capabilities).filter(t=>scopeAllowsTool(visible,t));
};
export const nativeFeaturesForScope=scope=>({nativeWebSearchEnabled:scopeAllowsTool(scope,'web_search'),nativeImageGenerationEnabled:scopeAllowsTool(scope,'image',{action:'generate'})});
export const missingCapabilityScope=()=>({ok:false,error:'CAPABILITY_SCOPE_MISSING',output:'Cannot determine the executing Agent capability scope.',meta:{denied:true,executionStarted:false}});
