// Host-side classification of the visible tools into internal routing jobs
// (phase A1, 2026-11-04). The shared catalog keeps its static whitelists and
// its deny list; this only suggests a job for tools those lists do not
// mention, from the tool's own declarations: the capability it consumes
// (declared, or the legacy id table), the shared effect classification and
// the MCP read-only annotation. A suggestion never grants anything: approvals,
// capability scope and request policy still apply inside the member.
import { toolEffect } from '../../../../shared/agent/toolEffects.js';
import { declaredCapabilityRequirement, legacyCapabilityRequirement } from '../../../domain/agent/capabilities.js';

const NEVER = new Set(['route_task', 'delegate', 'agent', 'melo_escalate', 'development_job', 'fake']);
const BROWSER_READ = new Set(['browser_open', 'browser_snapshot', 'browser_wait_for', 'browser_close']);
const BROWSER_ACT = new Set(['browser_click', 'browser_fill']);
// Network tools that read a fact about this device rather than a web source.
const LOCAL_FACTS = new Set(['device_location']);
const EXECUTE_KEYS = ['writeFiles', 'runCommands', 'generateMedia', 'dynamic'];

function requirementKeys(tool) {
  if (typeof tool.capability === 'function') return ['dynamic'];
  const declared = declaredCapabilityRequirement(tool);
  const requirement = declared === undefined ? legacyCapabilityRequirement(tool.id) : declared;
  if (requirement == null) return [];
  if (typeof requirement === 'string') return [requirement];
  if (Array.isArray(requirement)) return requirement.filter(key => typeof key === 'string');
  return Array.isArray(requirement.anyOf) ? requirement.anyOf.filter(key => typeof key === 'string') : ['dynamic'];
}

export function suggestInternalRole(tool) {
  const id = typeof tool?.id === 'string' ? tool.id : '';
  if (!id || NEVER.has(id) || id.startsWith('skill:')) return null;
  // MCP tools carry no capability declaration; the read-only annotation is a
  // presentation hint, so everything else is treated as an action.
  if (id.startsWith('mcp:')) return tool.readOnly === true ? 'research' : 'execute';
  const effect = toolEffect(id, {}, tool);
  const keys = requirementKeys(tool);
  if (effect === 'compute') return 'calculate';
  if (BROWSER_ACT.has(id) || effect === 'write' || keys.some(key => EXECUTE_KEYS.includes(key))) return 'execute';
  if (keys.includes('network')) {
    if (effect === 'read' || tool.uiModule === 'search' || tool.readOnly === true || BROWSER_READ.has(id)) return 'research';
    return LOCAL_FACTS.has(id) ? 'lookup' : null;
  }
  if (effect === 'read' && (!keys.length || keys.some(key => ['readFiles', 'knowledgeMemory'].includes(key)))) return 'lookup';
  return null;
}

export function internalRoleSuggestions(tools = []) {
  const suggestions = {};
  for (const tool of Array.isArray(tools) ? tools : []) {
    const role = suggestInternalRole(tool);
    if (role) suggestions[tool.id] = role;
  }
  return suggestions;
}
