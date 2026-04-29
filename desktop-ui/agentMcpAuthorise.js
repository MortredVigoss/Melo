// Pure decision-table for the agent → MCP-server authorisation chip
// (Customize → Agents). The tile-click handler in app.js used to
// inline the rules; lifting them here lets node:test pin the
// remove-always-allowed / add-refused-when-disabled-or-unpinned
// contract without booting the UI.
//
// Inputs:
//   - currentIds: the agent's current `enabledMcpServerIds` whitelist
//   - serverId:   the chip the user just clicked
//   - presetEnabled: bootstrap.config[preset.flag] for that preset
//                    (false when the user has the global toggle off)
//   - presetUnpinned: bootstrap mcpAuthSurface[].unpinned for that
//                     preset (true when the npm package isn't yet
//                     pinned to an exact version — browserless today)
//
// Output:
//   {
//     action: 'remove' | 'add' | 'refused-disabled' | 'refused-unpinned',
//     nextIds: string[]    // unchanged on a refusal, mutated on add/remove
//     toast?: string       // user-facing message when action is a refusal
//   }
//
// Rule precedence (Codex 四轮 audit 2026-04-29):
//   1. If serverId is already authorised → REMOVE wins. Always
//      allow revoking, regardless of preset state, so a user can
//      always undo their own past clicks (stale-revoke path).
//   2. Else if preset is unpinned → REFUSE: even with a legacy
//      `enable*Mcp:true` config flag, runtime won't spawn the
//      server. Authorising would yield a green chip backed by a
//      runtime that never starts.
//   3. Else if preset is globally disabled → REFUSE: same shape,
//      different reason — user must enable on Advanced first.
//   4. Else ADD.

export function decideAgentMcpAuthAction({
  currentIds,
  serverId,
  presetEnabled,
  presetUnpinned,
}) {
  const ids = Array.isArray(currentIds) ? new Set(currentIds) : new Set();

  if (typeof serverId !== 'string' || !serverId) {
    return { action: 'refused-invalid', nextIds: [...ids], toast: `Invalid MCP server id: ${String(serverId)}` };
  }

  if (ids.has(serverId)) {
    ids.delete(serverId);
    return { action: 'remove', nextIds: [...ids] };
  }

  if (presetUnpinned) {
    return {
      action: 'refused-unpinned',
      nextIds: [...ids],
      toast: `"${serverId}" preset is unpinned — version must be locked in PINNED_VERSIONS first.`,
    };
  }

  if (!presetEnabled) {
    return {
      action: 'refused-disabled',
      nextIds: [...ids],
      toast: `"${serverId}" is disabled globally — enable in Advanced first.`,
    };
  }

  ids.add(serverId);
  return { action: 'add', nextIds: [...ids] };
}
