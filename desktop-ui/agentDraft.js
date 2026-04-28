// Pure profile-to-draft helper for the Customize → Agents workbench.
//
// `app.js::agentDraftFor(agent)` used to build this draft inline, but the
// MCP audit (Codex 2026-04-28) caught it silently dropping
// `enabledMcpServerIds` — the chip-row would render every MCP as
// unselected even when the agent already had authorisations, the
// hidden form input would submit as an empty string, and the
// /api/agents/update payload would silently clear the per-agent
// whitelist on save.
//
// Lifting the body of that helper here lets node:test exercise the
// contract end-to-end (profile → draft → chip-row state → submit
// payload) without a jsdom harness.  app.js still owns the per-key
// caching layer because that depends on the live `uiState.agentDrafts`
// map.

/**
 * Defensive deep-clone for the channels map.  Falls back to JSON
 * round-trip when `structuredClone` is unavailable (older browsers /
 * the test runtime).  Mirrors the original inline behaviour so the
 * extracted helper is byte-identical from the caller's perspective.
 */
function cloneChannel(channel) {
  if (!channel || typeof channel !== 'object') return channel;
  if (typeof structuredClone === 'function') return structuredClone(channel);
  return JSON.parse(JSON.stringify(channel));
}

/**
 * Normalise the `channels` field of an agent profile into the shape
 * the form expects: `{ [channelId]: channelConfig }`.  Drops empty /
 * malformed entries.  Pure — no DOM, no global state.
 */
export function normalizeChannelsForDraft(rawChannels) {
  if (!rawChannels) return {};
  const entries = Array.isArray(rawChannels)
    ? rawChannels
        .filter(channel => channel && typeof channel === 'object' && typeof channel.id === 'string')
        .map(channel => [channel.id, channel])
    : Object.entries(rawChannels);
  const out = {};
  for (const [id, channel] of entries) {
    if (!channel || typeof channel !== 'object') continue;
    out[id] = cloneChannel(channel);
  }
  return out;
}

/**
 * Build a fresh edit-form draft from a normalised agent profile.
 *
 * Whitelist semantics:
 *   - `enabledSkillIds`     → null = no per-agent restriction (allow all)
 *   - `enabledConnectorIds` → null = no per-agent restriction (allow all)
 *   - `enabledMcpServerIds` → ALWAYS an array, never null. MCP defaults
 *     to deny-all per agent, so a missing or non-array value collapses
 *     to `[]`. This matches `agentTools.normalizeMcpServerWhitelist`
 *     on the server side; the asymmetry vs the other two whitelists
 *     is intentional (Codex 2026-04-27 audit: stdio MCPs run arbitrary
 *     local processes, no implicit trust).
 *
 * Pure function. Returns a fresh object every call so the caller is
 * free to mutate the returned draft.
 *
 * @param {Object|null|undefined} agent
 * @returns {Object} draft
 */
export function agentDraftFromProfile(agent) {
  const identity = agent?.identity || agent?.identify || '';
  const toolIds = Array.isArray(agent?.toolIds)
    ? [...agent.toolIds]
    : Array.isArray(agent?.tools)
      ? agent.tools.map(tool => tool?.id).filter(Boolean)
      : [];
  return {
    name: agent?.name || '',
    laneLabel: agent?.laneLabel || '',
    description: agent?.description || '',
    identity,
    identify: identity,
    'soul.md': agent?.soulMd,
    mood: agent?.mood,
    tools: toolIds,
    model: agent?.model || '',
    systemPrompt: agent?.systemPrompt || '',
    voiceReplyMode: typeof agent?.voiceReplyMode === 'string' ? agent.voiceReplyMode : 'summary',
    edgeTtsVoice: typeof agent?.edgeTtsVoice === 'string' ? agent.edgeTtsVoice : '',
    voicePersonality: typeof agent?.voicePersonality === 'string' ? agent.voicePersonality : '',
    channels: normalizeChannelsForDraft(agent?.channels),
    enabledSkillIds: Array.isArray(agent?.enabledSkillIds) ? [...agent.enabledSkillIds] : null,
    enabledConnectorIds: Array.isArray(agent?.enabledConnectorIds) ? [...agent.enabledConnectorIds] : null,
    enabledMcpServerIds: Array.isArray(agent?.enabledMcpServerIds) ? [...agent.enabledMcpServerIds] : [],
  };
}
