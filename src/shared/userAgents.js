// Agents people see and talk to (user decision, 2026-11-07): Melo's one
// default Agent plus the Agents the user creates. The built-in specialist
// lanes of the first desktop (research / builder / reviewer) stay stored, so
// old chats and settings keep working, but they are no longer offered:
// division of labor happens inside every Agent through internal routing
// (shared/agent/internalRouting.js), which no list shows as Agents.
export const RETIRED_AGENT_IDS = Object.freeze(['research', 'builder', 'reviewer']);

export const isUserFacingAgent = agent => typeof agent?.id === 'string' && !!agent.id && !RETIRED_AGENT_IDS.includes(agent.id);

export const isRetiredAgentId = id => RETIRED_AGENT_IDS.includes(String(id || ''));

/**
 * The Agents a list may offer, default first. `keepId` keeps the one already
 * in use (a chat or project that still points at a retired lane) so the
 * current choice stays visible instead of disappearing from its own picker.
 */
export function userFacingAgents(agents = [], { keepId = '' } = {}) {
  const list = (Array.isArray(agents) ? agents : []).filter(agent => isUserFacingAgent(agent) || (keepId && agent?.id === keepId));
  return list.sort((a, b) => (a.id === 'main' ? -1 : b.id === 'main' ? 1 : 0));
}
