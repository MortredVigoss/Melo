// ─── Agent tool whitelist + skill/connector filter helpers ───────────────────
// Each agent profile carries an optional `tools` array (subset of the fixed
// tool options below) plus optional per-agent `enabledSkillIds` /
// `enabledConnectorIds` whitelists. These helpers translate those fields
// into "what the agent is allowed to see" for connectors, skills, and
// prompts.
//
// This module owns:
//   - AGENT_TOOL_OPTIONS / DEFAULT_AGENT_TOOL_IDS / AGENT_TOOL_IDS —
//     canonical fixed list of tool IDs an agent can opt in/out of.
//   - normalizeAgentTools(tools) — accept array or comma string, dedupe +
//     filter to known IDs, fall back to all defaults when empty/invalid.
//   - summarizeAgentTools(toolIds) — hydrate normalized IDs with
//     label/description from AGENT_TOOL_OPTIONS (UI + prompt metadata).
//   - agentUsesTool(profile, toolId) — convenience membership check.
//   - normalizeIdWhitelist(value) — null (no restriction) | string[]
//     (explicit, possibly empty) for enabledSkillIds/enabledConnectorIds.
//   - filterConnectorsForAgent(connectors, profile) — apply both the
//     tool-whitelist and the per-agent connector whitelist.
//   - filterSkillsForAgent(skills, profile) — same, but on skills; also
//     enforces the reverse skill-side `allowedAgentIds` scoping.
//   - fingerprintSkillList(skills) — cheap hash of the skill set for cache
//     invalidation on the shared inverted index.
//   - createSharedSkillIndexFactory({ buildSkillIndex }) — factory that
//     returns `getSharedSkillIndex(skills)` with its own module-scoped
//     cache. The factory pattern is used so this file doesn't have to
//     import agents/skillMatcher.js directly — avoids a circular import
//     risk with the skill service.
//
// Extracted from desktopStore.js in the Phase 9k refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — the skill-index cache
// is module-local and the factory re-creates it on import, matching the
// original behavior.

export const AGENT_TOOL_OPTIONS = [
  {
    id: 'projects',
    label: 'Projects',
    description: 'Use project summary, workspace path, and project instructions.',
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    description: 'Use saved artifacts and durable outputs from the current project.',
  },
  {
    id: 'local-files',
    label: 'Local files',
    description: 'Use selected files and workspace structure in prompts and code context.',
  },
  {
    id: 'local-command',
    label: 'Local command',
    description: 'Use recent command output and command-run context.',
  },
  {
    id: 'external-connectors',
    label: 'External connectors',
    description: 'Use runtime connector context, tools, prompts, and resources.',
  },
  {
    id: 'skills',
    label: 'Skills',
    description: 'Apply enabled Melo skills and workflow hints.',
  },
  {
    id: 'search',
    label: 'Search',
    description: 'Use search-oriented recall and retrieval behavior.',
  },
];

export const DEFAULT_AGENT_TOOL_IDS = AGENT_TOOL_OPTIONS.map(tool => tool.id);
export const AGENT_TOOL_IDS = new Set(DEFAULT_AGENT_TOOL_IDS);

export function normalizeAgentTools(tools) {
  if (Array.isArray(tools)) {
    const normalized = [...new Set(
      tools
        .map(value => String(value || '').trim())
        .filter(value => AGENT_TOOL_IDS.has(value)),
    )];
    if (normalized.length) {
      return normalized;
    }
  }

  if (typeof tools === 'string' && tools.trim()) {
    const normalized = [...new Set(
      tools
        .split(',')
        .map(value => value.trim())
        .filter(value => AGENT_TOOL_IDS.has(value)),
    )];
    if (normalized.length) {
      return normalized;
    }
  }

  return [...DEFAULT_AGENT_TOOL_IDS];
}

export function summarizeAgentTools(toolIds = []) {
  return normalizeAgentTools(toolIds).map(toolId => {
    const option = AGENT_TOOL_OPTIONS.find(item => item.id === toolId);
    return {
      id: toolId,
      label: option?.label || toolId,
      description: option?.description || '',
    };
  });
}

export function agentUsesTool(profile, toolId) {
  return normalizeAgentTools(profile?.tools).includes(toolId);
}

// Normalizes a per-agent skill/connector ID whitelist.
// Returns null (no per-agent restriction) or a string[] (explicit whitelist, may be empty).
export function normalizeIdWhitelist(value) {
  if (!Array.isArray(value)) return null;
  return value.map(v => String(v || '').trim()).filter(Boolean);
}

export function filterConnectorsForAgent(connectors, profile) {
  const allowedToolIds = new Set(normalizeAgentTools(profile?.tools));
  // Per-agent external-connector whitelist (null = allow all external connectors that pass tool check)
  const allowedConnectorIds = normalizeIdWhitelist(profile?.enabledConnectorIds);
  return connectors.filter(connector => {
    if (connector.type === 'external-mcp') {
      if (!allowedToolIds.has('external-connectors')) return false;
      if (allowedConnectorIds !== null && !allowedConnectorIds.includes(connector.id)) return false;
      return true;
    }
    if (connector.id === 'projects') {
      return allowedToolIds.has('projects');
    }
    if (connector.id === 'artifacts') {
      return allowedToolIds.has('artifacts');
    }
    if (connector.id === 'local-files') {
      return allowedToolIds.has('local-files');
    }
    if (connector.id === 'local-command') {
      return allowedToolIds.has('local-command');
    }
    return true;
  });
}

// Returns only the skills this agent is allowed to use.
// Two filter gates apply in sequence:
//   1. Agent's own enabledSkillIds — if set, skill must be in that list
//      (opt-in scoping from the agent side).
//   2. Skill's allowedAgentIds — if set, the current agent id must be in
//      that list (opt-in scoping from the skill side). A null/empty
//      allowedAgentIds means the skill is global.
export function filterSkillsForAgent(skills, profile) {
  if (!agentUsesTool(profile, 'skills')) return [];
  const profileSkillIds = normalizeIdWhitelist(profile?.enabledSkillIds);
  const agentId = profile?.id || null;
  return skills.filter(skill => {
    if (profileSkillIds !== null && !profileSkillIds.includes(skill.id)) return false;
    if (Array.isArray(skill.allowedAgentIds) && skill.allowedAgentIds.length > 0) {
      if (!agentId || !skill.allowedAgentIds.includes(agentId)) return false;
    }
    return true;
  });
}

// ── Phase 4 skill-matcher wiring ────────────────────────────────────────────
// Helpers used in the `prepare` graph node to feed richer context (multi-
// turn messages + inverted index) into matchSkillsForMessage without
// paying the index build cost on every turn.

export function fingerprintSkillList(skills) {
  if (!Array.isArray(skills)) return '';
  const parts = [];
  for (const s of skills) {
    if (!s) continue;
    parts.push(
      (s.id || '') + ':'
      + (Array.isArray(s.triggers) ? s.triggers.length : 0) + ':'
      + (Array.isArray(s.tags) ? s.tags.length : 0) + ':'
      + (s.updatedAt || s.version || '')
    );
  }
  return parts.join('|');
}

/**
 * Factory that binds `getSharedSkillIndex` to a provided
 * `buildSkillIndex` implementation. Keeps the module import graph acyclic
 * (desktopStore already imports buildSkillIndex from agents/skillMatcher,
 * so we thread the reference in here instead of importing it a second
 * time). The cache is factory-local — one cache per factory instance.
 */
export function createSharedSkillIndexFactory({ buildSkillIndex }) {
  if (typeof buildSkillIndex !== 'function') {
    throw new Error('createSharedSkillIndexFactory: buildSkillIndex is required');
  }

  // Cached inverted index, keyed by a cheap fingerprint of the skill list.
  // When any skill is added/edited/removed the fingerprint changes and we
  // rebuild. For a typical 30-skill set this is ~1ms worst case.
  let cache = { fingerprint: '', index: null };

  return function getSharedSkillIndex(skills) {
    const fingerprint = fingerprintSkillList(skills);
    if (fingerprint === cache.fingerprint && cache.index) {
      return cache.index;
    }
    const index = buildSkillIndex(skills);
    cache = { fingerprint, index };
    return index;
  };
}
