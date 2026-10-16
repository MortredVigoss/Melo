// Selection-coercion helper — sub-phase 7d-5δ commit 8a of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// `ensureSelectedEntities` walks an already-hydrated state object and
// coerces its `settings.selectedX` fields back into a valid range:
//   • drop selections that point at entities that no longer exist
//   • clamp string-enum fields (activeView, activeMode, customizeSection)
//     to their allowed sets, with a sensible fallback
//   • respect explicit nulls (selectedProjectId == null means "Projects
//     overview", not "auto-pick the first project")
//   • bring promptHistory back into shape via normalizePromptHistory
//
// This is the pre-extraction sibling of stateHydration.js's `hydrateState`
// — hydration produces structurally-valid state from raw disk JSON;
// `ensureSelectedEntities` enforces selection invariants on that
// hydrated state. Lives in `src/state/` because every dependency it
// touches is already in a state-domain or services-domain leaf module.
//
// Used in 58 call sites across desktopStore (the chat / task / approval /
// artifact / bootstrap flows all run state through this filter before
// rendering or persisting).

import { normalizeAgentProfiles } from './agentProfiles.js';
import { sortChats } from './conversation.js';
import { BUILTIN_CONNECTORS } from './stateHydration.js';
import { allAgentIdsFromProfiles } from '../domain/agent/agentLibrary.js';
import { BUILTIN_SKILLS } from '../domain/skill/skillService.js';
import { MODE_DEFS } from '../domain/chat/modeDefs.js';
import { normalizePromptHistory } from '../domain/activity/activityLog.js';

export function ensureSelectedEntities(state) {
  const chats = sortChats(state.chats);
  const normalizedAgentProfiles = normalizeAgentProfiles(state.agentProfiles);
  const availableAgentIds = allAgentIdsFromProfiles(normalizedAgentProfiles);
  const activeView = ['chat', 'search', 'agent', 'model', 'settings', 'customize', 'chats', 'projects', 'artifacts'].includes(
    state.settings.activeView,
  )
    ? state.settings.activeView
    : 'chat';
  const activeMode = MODE_DEFS.some(mode => mode.id === state.settings.activeMode)
    ? state.settings.activeMode
    : 'chat';
  const selectedChatId =
    state.settings.selectedChatId == null
      ? null
      : chats.some(chat => chat.id === state.settings.selectedChatId)
        ? state.settings.selectedChatId
        : chats[0]?.id || null;
  // Explicit null means "no project selected" — respect it (the Projects
  // overview uses null to show the grid of cards). Only auto-pick a project
  // when selectedProjectId points to something that no longer exists.
  const persistedProjectId = state.settings.selectedProjectId;
  const selectedProjectId =
    persistedProjectId == null
      ? null
      : state.projects.some(project => project.id === persistedProjectId)
        ? persistedProjectId
        : state.projects[0]?.id || null;
  const selectedAgentScope =
    state.settings.selectedAgentScope === 'project' && selectedProjectId ? 'project' : 'global';
  const selectedCustomizeSection = [
    'skills',
    'agents',
    'connectors',
    'advanced',
    'memory',
    'safety',
    // Legacy persisted value. The desktop UI migrates this to Advanced at
    // render time so older state does not drop users back to Skills.
    'runtime',
  ].includes(
    state.settings.selectedCustomizeSection,
  )
    ? state.settings.selectedCustomizeSection
    : 'skills';
  const selectedAgentId = availableAgentIds.includes(state.settings.selectedAgentId)
    ? state.settings.selectedAgentId
    : 'main';
  const selectedSkillId = [...BUILTIN_SKILLS,...(state.settings.customSkills || [])].some(skill => skill.id === state.settings.selectedSkillId)
    ? state.settings.selectedSkillId
    : BUILTIN_SKILLS[0].id;
  const selectedConnectorId = [
    ...BUILTIN_CONNECTORS.map(connector => connector.id),
    ...state.externalConnectors.map(connector => connector.id),
  ].includes(state.settings.selectedConnectorId)
    ? state.settings.selectedConnectorId
    : BUILTIN_CONNECTORS[0].id;

  return {
    ...state,
    chats,
    agentProfiles: normalizedAgentProfiles,
    settings: {
      ...state.settings,
      activeView,
      activeMode,
      selectedChatId,
      selectedProjectId,
      selectedAgentScope,
      selectedCustomizeSection,
      selectedAgentId,
      selectedSkillId,
      selectedConnectorId,
      promptHistory: normalizePromptHistory(state.settings?.promptHistory),
    },
  };
}
