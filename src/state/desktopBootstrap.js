// Desktop bootstrap builder cluster — sub-phase 7d-5δ commit 8e of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// `getDesktopBootstrap` is the per-render snapshot the UI loads on
// startup and re-pulls after most state changes: it merges the latest
// disk state with derived data (sortable chat list, normalized agents,
// connector rollup, project / artifact / task / approval summaries,
// available models, plus a search payload for the current query). The
// four helpers it uses (availableModelsForConfig, summarizeAgentProfile,
// buildAgentProfiles, buildProfile) are all module-private with this
// function as their sole caller; they ship together as a self-contained
// leaf — same packaging pattern as the search-results cluster from
// commit 8d.
//
// `getDesktopBootstrap` itself has 37 in-module call sites in
// desktopStore — every endpoint that returns a fresh bootstrap on
// mutation walks through here. After this commit those 37 sites resolve
// the function via a single import statement.

import { join } from 'node:path';
import { userInfo } from 'node:os';
import { titleCase, formatUpdatedAt, truncateText } from '../shared/helpers.js';
import {
  DEFAULT_CONFIG,
  DEFAULT_MODEL_CATALOGS,
  getResolvedConfig,
  getMeloHome,
  normalizeModelCatalogs,
} from '../config.js';
import { loadState, saveState } from './stateStore.js';
import { ensureSelectedEntities } from './stateSelections.js';
import { sortChats, summarizeChat } from './conversation.js';
import { findProjectById } from './stateLookups.js';
import { buildWorkspaceSnapshot } from '../services/workspace/workspaceSnapshot.js';
import { buildConnectors } from '../services/connector/connectorRollup.js';
import {
  allAgentIdsFromProfiles,
  AGENT_PRESETS,
  MOOD_OPTIONS,
  moodOptionById,
} from '../services/agent/agentLibrary.js';
import { createAgentMarkdownFileHelpers } from '../services/agent/markdownFiles.js';
import {
  AGENT_TOOL_OPTIONS,
  normalizeAgentTools,
  summarizeAgentTools,
} from '../services/agent/agentTools.js';
import { normalizeAgentChannels } from '../services/agent/agentChannels.js';
import {
  effectiveAgentProfile,
  normalizeAgentProfile,
  projectAgentOverrideFor,
} from './agentProfiles.js';
import { MODE_DEFS } from '../services/chat/modeDefs.js';
import { MAX_RECENT_CHATS } from './chatPruning.js';
import { buildSkills } from '../services/skill/skillService.js';
import { defaultSkillProposalStore } from '../agents/skillProposals.js';
import { summarizeArtifact } from '../services/artifact/artifactService.js';
import { summarizeProject } from '../services/project/projectService.js';
import { summarizeTask } from '../services/task/taskService.js';
import { summarizeApproval } from '../services/approval/approvalService.js';
import { buildSearchResults } from '../services/search/searchResultsBuilder.js';

// CLAUDE.md §6: capture MELO_HOME synchronously at the top of every
// invocation of getDesktopBootstrap, then derive every home-rooted path
// (state.json, threads/, store.sqlite, agents/, plus a home-bound
// `getAgentMarkdownPaths`) from that single captured value. Pass it
// through to every async hop (saveState's `ctx`, buildAgentProfiles's
// path-helper arg) so an env flip mid-bootstrap can't desync the state
// we loaded from the paths we report. Same `captureLoadContext` pattern
// stateStore.js uses internally for readStateSnapshot.
function captureBootstrapContext() {
  const home = getMeloHome();
  const stateFilePath = join(home, 'desktop', 'state.json');
  const threadsDir = join(home, 'desktop', 'threads');
  const storePath = join(home, 'desktop', 'store.sqlite');
  const agentsDir = join(home, 'desktop', 'agents');
  const { getAgentMarkdownPaths } = createAgentMarkdownFileHelpers({ agentsDir });
  return { home, stateFilePath, threadsDir, storePath, getAgentMarkdownPaths };
}

function availableModelsForConfig(config) {
  const authMode = config.authMode || DEFAULT_CONFIG.authMode;
  const catalogs = normalizeModelCatalogs(config.modelCatalogs || DEFAULT_MODEL_CATALOGS);
  const discovered = catalogs[authMode] || [];
  const models = Array.from(
    new Set(
      [config.model, ...discovered]
        .map(value => String(value || '').trim())
        .filter(Boolean),
    ),
  );

  if (models.length) {
    return models;
  }

  return [DEFAULT_CONFIG.model];
}

function summarizeAgentProfile(profile) {
  const mood = moodOptionById(profile.mood);
  const toolIds = normalizeAgentTools(profile.tools);
  const tools = summarizeAgentTools(toolIds);
  const now = Date.now();
  const channels = Object.values(normalizeAgentChannels(profile.channels)).map(channel => ({
    ...channel,
    statusLabel:
      channel.lastStatus === 'error'
        ? 'Error'
        : channel.enabled &&
            channel.lastStatus === 'connected' &&
            channel.lastPolledAt &&
            now - Date.parse(channel.lastPolledAt) < 12_000
          ? 'Polling live'
          : channel.lastStatus === 'connected'
            ? 'Connected'
            : 'Not checked',
    runtimeLabel:
      channel.lastStatus === 'error'
        ? 'Attention needed'
        : channel.enabled &&
            channel.lastStatus === 'connected' &&
            channel.lastPolledAt &&
            now - Date.parse(channel.lastPolledAt) < 12_000
          ? 'Active now'
          : channel.enabled
            ? 'Configured'
            : 'Disabled',
    lastCheckedLabel: channel.lastCheckedAt ? formatUpdatedAt(channel.lastCheckedAt) : 'Never checked',
    lastPolledLabel: channel.lastPolledAt ? formatUpdatedAt(channel.lastPolledAt) : 'No recent poll',
    lastIncomingLabel: channel.lastIncomingAt ? formatUpdatedAt(channel.lastIncomingAt) : 'No incoming messages yet',
    lastReplyLabel: channel.lastReplyAt ? formatUpdatedAt(channel.lastReplyAt) : 'No replies sent yet',
    lastIncomingPreview: channel.lastIncomingPreview
      ? truncateText(channel.lastIncomingPreview.replace(/\s+/g, ' ').trim(), 160)
      : '',
    lastReplyPreview: channel.lastReplyPreview
      ? truncateText(channel.lastReplyPreview.replace(/\s+/g, ' ').trim(), 160)
      : '',
    botLabel: channel.botUsername ? `@${channel.botUsername}` : 'Unknown bot',
    hasActivity: Boolean(channel.lastIncomingAt || channel.lastReplyAt),
    hasCredentials: Boolean(
      channel.botToken &&
        (channel.id === 'telegram'
          ? true
          : channel.id === 'discord'
            ? channel.channelId || channel.guildId
            : true),
    ),
  }));
  return {
    ...profile,
    toolIds,
    moodLabel: mood.label,
    moodDescription: mood.description,
    moodPrompt: mood.prompt,
    identifyPreview: (profile.identity || profile.identify).slice(0, 180),
    soulMdPreview: profile.soulMd.slice(0, 180),
    identityPreview: (profile.identity || profile.identify).slice(0, 180),
    soulPreview: profile.soulMd.slice(0, 180),
    tools,
    toolCount: tools.length,
    toolsLabel: tools.map(tool => tool.label).join(', '),
    modelLabel: profile.model || 'Inherit global model',
    systemPromptPreview: profile.systemPrompt || '',
    channels,
    enabledChannelCount: channels.filter(channel => channel.enabled).length,
  };
}

// `getAgentMarkdownPaths` is now an explicit parameter rather than a
// module-bound singleton — see captureBootstrapContext above. This is
// the §6 fix Codex caught on commit 8e: passing the home-bound helper
// in keeps the resolved paths consistent with the state snapshot the
// bootstrap loaded, even if MELO_HOME flips during the async chain.
function buildAgentProfiles(state, { projectId = null, scope = 'global' } = {}, getAgentMarkdownPaths) {
  const editingScope = scope === 'project' && projectId ? 'project' : 'global';

  return allAgentIdsFromProfiles(state.agentProfiles).map(agentId => {
    const profile =
      scope === 'project' && projectId
        ? effectiveAgentProfile(state, agentId, projectId)
        : {
            ...normalizeAgentProfile(agentId, state.agentProfiles?.[agentId]),
            scopeSource: 'global',
            hasProjectOverride: Boolean(projectAgentOverrideFor(state, projectId, agentId)),
          };
    const paths = getAgentMarkdownPaths(agentId, {
      scope: editingScope,
      projectId: editingScope === 'project' ? projectId : null,
    });

    return {
      ...summarizeAgentProfile(profile),
      identityPath: paths.identityPath,
      soulPath: paths.soulPath,
      editingScope,
    };
  });
}

function buildProfile() {
  const rawName = userInfo().username || 'Melo User';
  return {
    name: titleCase(rawName),
    plan: 'Local Desktop',
    initial: rawName.slice(0, 1).toUpperCase() || 'M',
  };
}

export async function getDesktopBootstrap(query = '') {
  // CLAUDE.md §6: capture the ctx synchronously before any await so a
  // mid-bootstrap MELO_HOME flip can't desync the state we loaded from
  // the paths we report (Codex caught the original lazy form).
  const ctx = captureBootstrapContext();
  const [config, rawState] = await Promise.all([getResolvedConfig(), loadState()]);
  const state = ensureSelectedEntities(rawState);
  const chats = sortChats(state.chats);
  const selectedChat = chats.find(chat => chat.id === state.settings.selectedChatId) || null;
  const activeProject = findProjectById(state, state.settings.selectedProjectId);
  const workspace = await buildWorkspaceSnapshot(state, activeProject);
  const connectors = buildConnectors(state.settings.enabledConnectorIds, config, workspace, state, activeProject);
  let shouldPersistState = false;

  if (state.settings.selectedFilePath !== workspace.selectedFilePath) {
    state.settings.selectedFilePath = workspace.selectedFilePath;
    shouldPersistState = true;
  }

  if (!connectors.some(connector => connector.id === state.settings.selectedConnectorId)) {
    state.settings.selectedConnectorId = connectors[0]?.id || null;
    shouldPersistState = true;
  }

  if (!allAgentIdsFromProfiles(state.agentProfiles).includes(state.settings.selectedAgentId)) {
    state.settings.selectedAgentId = 'main';
    shouldPersistState = true;
  }

  if (state.settings.selectedAgentScope === 'project' && !activeProject) {
    state.settings.selectedAgentScope = 'global';
    shouldPersistState = true;
  }

  if (shouldPersistState) {
    // Pass the entry-captured ctx so the persisted state.json + thread
    // checkpoints + memory snapshot all land under the home we loaded
    // from, even if MELO_HOME flipped after our `loadState()`. Mirrors
    // readStateSnapshot's repair-save path.
    await saveState(state, { ctx });
  }

  const skills = buildSkills(state.settings.enabledSkillIds, state.settings.customSkills);
  const activeAgentScope =
    state.settings.selectedAgentScope === 'project' && activeProject ? 'project' : 'global';
  const agents = buildAgentProfiles(
    state,
    { projectId: activeProject?.id || null, scope: activeAgentScope },
    ctx.getAgentMarkdownPaths,
  );
  const projectArtifacts = state.artifacts
    .filter(artifact => artifact.projectId === activeProject?.id)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .map(summarizeArtifact);
  const activeChatArtifacts = state.artifacts
    .filter(artifact => artifact.chatId === selectedChat?.id)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .map(summarizeArtifact);

  return {
    profile: buildProfile(),
    modes: MODE_DEFS,
    settings: {
      ...state.settings,
      config: {
        provider: config.provider,
        baseUrl: config.baseUrl,
        model: config.model,
        systemPrompt: config.systemPrompt,
        authMode: config.authMode,
        hasApiKey: Boolean(config.apiKey),
        hasCredentials:
          config.authMode === 'codex'
            ? Boolean(config.codexAuth?.loggedIn)
            : config.authMode === 'local'
              ? Boolean(config.baseUrl && config.model)
              : Boolean(config.apiKey),
        maskedApiKey: config.apiKey
          ? `${config.apiKey.slice(0, 4)}...${config.apiKey.slice(-4)}`
          : '(not set)',
        hasWhisperKey: Boolean(config.whisperApiKey),
        maskedWhisperApiKey: config.whisperApiKey
          ? `${config.whisperApiKey.slice(0, 4)}...${config.whisperApiKey.slice(-4)}`
          : '(not set)',
        whisperBaseUrl: config.whisperBaseUrl || '',
        ttsProvider: config.ttsProvider || '',
        ttsEdgeVoice: config.ttsEdgeVoice || '',
        codexAuth: config.codexAuth || null,
        availableModels: availableModelsForConfig(config),
        modelCatalogs: normalizeModelCatalogs(config.modelCatalogs || DEFAULT_MODEL_CATALOGS),
      },
    },
    recents: chats.slice(0, MAX_RECENT_CHATS).map(summarizeChat),
    chats: chats.map(summarizeChat),
    activeChat: selectedChat,
    projects: state.projects.map(project => summarizeProject(project, chats, state.artifacts)),
    activeProject,
    artifacts: [...state.artifacts]
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .map(summarizeArtifact),
    projectArtifacts,
    activeChatArtifacts,
    tasks: state.tasks.map(summarizeTask),
    approvals: state.approvals.map(summarizeApproval),
    customize: {
      agents,
      skills,
      connectors,
      moods: MOOD_OPTIONS,
      agentPresets: AGENT_PRESETS,
      agentTools: AGENT_TOOL_OPTIONS,
      agentScope: activeAgentScope,
      agentProject: activeProject
        ? {
            id: activeProject.id,
            name: activeProject.name,
          }
        : null,
      // Background clustering proposals surfaced by Phase 3D — the UI uses
      // these to offer "save as skill" suggestions without making a
      // separate API call on every render.
      skillProposals: defaultSkillProposalStore.list(),
    },
    workspace,
    search: await buildSearchResults(query, state, workspace, connectors, skills),
  };
}
