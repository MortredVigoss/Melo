/**
 * Resolve which MiniMax voice id to activate when the user clicks the
 * TTS panel's "自定义语音" radio.
 *
 * Pure function — no I/O, no DOM. Browser code in desktop-ui/app.js
 * imports it via /shared/minimaxVoiceResolver.js (the static route in
 * src/server.js mirrors the urlDetector pattern); a node:test unit
 * test imports it directly. Single source of truth keeps the four
 * resolution cases — cache valid / cache stale / saved default fallback
 * / nothing configured — locked across runtimes.
 *
 * Codex C-grade history that produced this design:
 *   - C #14 (silent wipe): activating with empty voiceId overwrote the
 *     connector's saved Default Voice ID. Fixed by adding savedDefault
 *     to the priority chain + refusing to activate when nothing is
 *     resolvable.
 *   - C #15 (stale cache wins): localStorage might point to a voice id
 *     that's no longer in any agent profile and isn't the current saved
 *     default — using it would silently revert the user's recent save.
 *     Fixed here: cache is only honoured when it appears in the current
 *     valid set (agent voices ∪ saved default); otherwise dropped.
 *
 * @param {object} input
 * @param {string} [input.cachedId]      - voiceId remembered in localStorage
 * @param {string[]} [input.agentVoiceIds] - voiceIds bound to current agents
 * @param {string} [input.savedDefault]  - connector's saved Default Voice ID
 * @returns {{ voiceId: string, droppedStaleCache: boolean }}
 *   voiceId is '' when nothing can be resolved; the caller refuses
 *   activation in that case. droppedStaleCache=true tells the caller
 *   to clear localStorage so a stale entry doesn't haunt the next run.
 */
export function resolveActiveMinimaxVoiceId({
  cachedId = '',
  agentVoiceIds = [],
  savedDefault = '',
} = {}) {
  const cached = String(cachedId || '').trim();
  const def = String(savedDefault || '').trim();
  const agents = (Array.isArray(agentVoiceIds) ? agentVoiceIds : [])
    .map(v => String(v || '').trim())
    .filter(Boolean);

  // Build the set of voice ids that "really exist" right now.
  const validSet = new Set([...agents, def].filter(Boolean));

  // Priority 1: cached value, but ONLY if it's still in the valid set.
  if (cached && validSet.has(cached)) {
    return { voiceId: cached, droppedStaleCache: false };
  }

  // Priority 2: connector's saved Default Voice ID.
  if (def) {
    return {
      voiceId: def,
      // If we held a cache and it didn't match the current valid set,
      // tell the caller to clear localStorage so we don't carry the
      // stale value forward.
      droppedStaleCache: Boolean(cached) && cached !== def,
    };
  }

  // Priority 3: first available agent voice.
  if (agents.length > 0) {
    return {
      voiceId: agents[0],
      droppedStaleCache: Boolean(cached) && cached !== agents[0],
    };
  }

  // Priority 4: nothing configured. Caller should refuse activation.
  return {
    voiceId: '',
    droppedStaleCache: Boolean(cached),
  };
}
