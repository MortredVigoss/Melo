// Skill-proposal background scan — sub-phase 7d-5δ commit 8f-prep of
// the desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// The pure proposal heuristics live in `src/agents/skillProposals.js`
// (offline, synchronous, no I/O). This module is the I/O-bound
// orchestrator: load state, slice the most recent N chats, hand them
// to `proposeSkillsFromActivity`, and let the proposal store persist
// the result. It was originally a top-level export on desktopStore.js
// — fire-and-forget background job called from sendChatMessage and
// surfaced to the UI via the proposal-store list endpoint.

import { loadState } from '../../state/stateStore.js';
import {
  defaultSkillProposalStore,
  proposeSkillsFromActivity,
} from '../../agents/skillProposals.js';
import { BUILTIN_SKILLS } from '../../domain/skill/skillService.js';

export async function scanRecentChatsForSkillProposals({
  limit = 10,
  maxMessagesPerChat = 200,
  _loadStateFn = loadState,
  _store = defaultSkillProposalStore,
} = {}) {
  const state = await _loadStateFn();
  const chats = Array.isArray(state?.chats) ? state.chats : [];
  if (chats.length === 0) return { scanned: 0, proposed: 0, added: 0 };

  // Order by latest activity — most recently touched chats are most likely
  // to contain the workflow the user just ran.
  const byRecency = [...chats]
    .filter(chat => Array.isArray(chat?.messages) && chat.messages.length > 0)
    .sort((a, b) => {
      const ta = Date.parse(a.updatedAt || a.createdAt || '') || 0;
      const tb = Date.parse(b.updatedAt || b.createdAt || '') || 0;
      return tb - ta;
    })
    .slice(0, Math.max(1, limit));

  const activities = byRecency.map(chat => ({
    chatId: chat.id,
    chatTitle: chat.title || chat.name || '',
    // `proposeSkillsFromActivity` walks from the end of the array, so
    // trimming the oldest entries keeps its scan bounded.
    messages: (chat.messages || []).slice(-maxMessagesPerChat),
  }));

  // Phase 3.4.2: feed the proposer the set of skills that already exist,
  // so clusters that resemble an existing skill produce an upgrade
  // proposal instead of a fresh create proposal. Disk skills have
  // already been reconciled into state.settings.customSkills at startup,
  // so the union below covers built-ins + disk + json-persisted skills.
  const customSkills = Array.isArray(state?.settings?.customSkills)
    ? state.settings.customSkills
    : [];
  const existingSkills = [...BUILTIN_SKILLS, ...customSkills];

  const proposals = proposeSkillsFromActivity(activities, { existingSkills });
  const added = _store.addMany(proposals);
  return {
    scanned: activities.length,
    proposed: proposals.length,
    added,
    upgradeCount: proposals.filter(p => p?.kind === 'upgrade').length,
    createCount: proposals.filter(p => p?.kind !== 'upgrade').length,
  };
}
