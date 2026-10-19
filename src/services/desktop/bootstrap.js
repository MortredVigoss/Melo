import {projectWorkspaceStatus} from '../workspace/workspacePolicy.js';
import { isAgentChannelAvailable } from '../../shared/channelAvailability.js';
import {projectText} from '../../domain/project/projectService.js';
import {capabilityMigrationPreview,migrationOptions} from '../agent/capabilityMigration.js';
import {CAPABILITY_LABELS} from '../../domain/agent/capabilities.js';
import { pendingPersonaRecords } from '../chat/portableWorkspace.js';
import { startStage } from '../../runtime/performanceTrace.js';
import { imageSettings as resolvedImageSettings } from '../../images/imageSettings.js';
import { publicExtraFast } from '../../judge/fastJudge.js';
import { publicLlmConnections } from '../../shared/llmProviders.js';
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
import { titleCase, formatUpdatedAt, truncateText } from '../../shared/helpers.js';
import {
  DEFAULT_CONFIG,
  DEFAULT_MODEL_CATALOGS,
  getResolvedConfig,
  getMeloHome,
  normalizeModelCatalogs,
} from '../../config.js';
import { loadState } from '../../state/stateStore.js';
import { ensureSelectedEntities } from '../../state/stateSelections.js';
import { sortChats, summarizeChat } from '../../state/conversation.js';
import { findProjectById } from '../../state/stateLookups.js';
import { buildWorkspaceSnapshot } from '../workspace/workspaceSnapshot.js';
import { buildConnectors } from '../connector/connectorRollup.js';
import { getBuiltinMcpPresets } from '../../mcp/manager.js';
import { isValidMcpServerId } from '../../mcp/toolId.js';
import {
  allAgentIdsFromProfiles,
  AGENT_PRESETS,
  MOOD_OPTIONS,
  moodOptionById,
} from '../../domain/agent/agentLibrary.js';
import { createAgentMarkdownFileHelpers } from '../../persistence/agentMarkdownFiles.js';
import {
  AGENT_TOOL_OPTIONS,
  normalizeAgentTools,
  summarizeAgentTools,
} from '../../domain/agent/agentTools.js';
import { normalizeAgentChannels } from '../../domain/agent/agentChannels.js';
import {
  effectiveAgentProfile,
  normalizeAgentProfile,
  projectAgentOverrideFor,
} from '../../state/agentProfiles.js';
import { MODE_DEFS } from '../../domain/chat/modeDefs.js';
import { MAX_RECENT_CHATS } from '../../state/chatPruning.js';
import { buildSkills } from '../../domain/skill/skillService.js';
import { defaultSkillProposalStore } from '../../agents/skillProposals.js';
import { summarizeArtifact, visibleArtifacts } from '../../domain/artifact/artifactService.js';
import { summarizeProject } from '../../domain/project/projectService.js';
import { summarizeTask } from '../../domain/task/taskService.js';
import { summarizeApproval } from '../../domain/approval/approvalService.js';
import { buildSearchResults } from '../search/searchResultsBuilder.js';

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
    archived: !isAgentChannelAvailable(channel.id),
    statusLabel:
      !isAgentChannelAvailable(channel.id) ? 'Archived' : channel.lastStatus === 'error'
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
      !isAgentChannelAvailable(channel.id) ? 'Archived' : channel.lastStatus === 'error'
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
      capabilityLabels: CAPABILITY_LABELS,
      pendingCapabilityChange: Object.values(state.agentSettingsPending||{}).find(p=>p.agentId===agentId&&p.projectId===(editingScope==='project'?projectId:null))||null,
      capabilityMigration: profile.capabilities ? null : capabilityMigrationPreview(profile,migrationOptions(state)),
      capabilityOptions: migrationOptions(state).skills.map(s=>({id:s.id,name:s.name})),
      identityPath: paths.identityPath,
      soulPath: paths.soulPath,
      editingScope,
    };
  });
}

function buildProfile(settings = {}) {
  const rawName = settings.localProfile?.name || titleCase(userInfo().username || 'Melo User');
  return {
    name: rawName,
    avatarData: settings.localProfile?.avatarData || '',
    plan: '本机个人资料',
    initial: rawName.slice(0, 1).toUpperCase() || 'M',
  };
}

export async function getDesktopBootstrap(query = '', { skipModelNormalize = false } = {}) {
  // `skipModelNormalize` is the catalog-only opt-out forwarded to
  // `getResolvedConfig` so that `refreshModelCatalog` can return a
  // bootstrap whose `settings.config.model` is the user's saved
  // model verbatim, even when the freshly-discovered catalog
  // doesn't include it. Without this the API/UI surface would
  // silently fold the model back to catalog[0] on every "Read
  // available models" click. Default false keeps normal startup /
  // save-driven bootstraps strict so a stale on-disk model still
  // gets safely folded. Codex audit 2026-04-29.
  //
  // CLAUDE.md §6: capture the ctx synchronously before any await so a
  // mid-bootstrap MELO_HOME flip can't desync the state we loaded from
  // the paths we report (Codex caught the original lazy form).
  const finishTiming = startStage('bootstrap.build');
  try {
  const ctx = captureBootstrapContext();
  const [config, rawState] = await Promise.all([
    getResolvedConfig({ skipModelNormalize }),
    loadState({ home: ctx.home }),
  ]);
  const state = ensureSelectedEntities(rawState);
  const chats = sortChats(state.chats);
  const selectedChat = chats.find(chat => chat.id === state.settings.selectedChatId) || null;
  const activeProject = findProjectById(state, state.settings.selectedProjectId);
  const workspace = await buildWorkspaceSnapshot(state, selectedChat ? findProjectById(state, selectedChat.projectId) : activeProject, {chat:selectedChat,home:ctx.home});
  const connectors = buildConnectors(state.settings.enabledConnectorIds, config, workspace, state, activeProject);

  if (state.settings.selectedFilePath !== workspace.selectedFilePath) {
    state.settings.selectedFilePath = workspace.selectedFilePath;
  }

  if (!connectors.some(connector => connector.id === state.settings.selectedConnectorId)) {
    state.settings.selectedConnectorId = connectors[0]?.id || null;
  }

  if (!allAgentIdsFromProfiles(state.agentProfiles).includes(state.settings.selectedAgentId)) {
    state.settings.selectedAgentId = 'main';
  }

  if (state.settings.selectedAgentScope === 'project' && !activeProject) {
    state.settings.selectedAgentScope = 'global';
  }

  const skills = buildSkills(state.settings.enabledSkillIds, state.settings.customSkills);
  const activeAgentScope =
    state.settings.selectedAgentScope === 'project' && activeProject ? 'project' : 'global';
  const agents = buildAgentProfiles(
    state,
    { projectId: activeProject?.id || null, scope: activeAgentScope },
    ctx.getAgentMarkdownPaths,
  );
  // Soft-deleted artifacts (deletedAt set by `deleteArtifact`) stay in
  // state.json so the undo path + GC can find them, but they must not
  // appear in any UI surface.  visibleArtifacts() funnels every reader
  // (here + searchResultsBuilder + connectorRollup + dynamicContext +
  // applyArtifactToWorkspaceFile + updateArtifact) through the same
  // predicate so a tombstoned row can't leak via a missed call site.
  const visibleArtifactRows = visibleArtifacts(state.artifacts);

  const projectArtifacts = visibleArtifactRows.filter(a=>a.kind!=='result')
    .filter(artifact => activeProject && (artifact.projectId === activeProject.id || activeProject.knowledgeIds?.includes(artifact.id)))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .map(summarizeArtifact);
  const activeChatArtifacts = visibleArtifactRows
    .filter(artifact => artifact.chatId === selectedChat?.id)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .map(summarizeArtifact);

  return {
    stateRevision: Number(state._revision) || 0,
    profile: buildProfile(state.settings),
    // Presentation must use the same project overrides as execution, not the
    // scope currently open in the Agent settings editor. Draft chats can pick
    // a project without changing the editor or the active persisted chat.
    conversationProfiles: {
      global: allAgentIdsFromProfiles(state.agentProfiles).map(id => summarizeAgentProfile(effectiveAgentProfile(state, id))),
      projects: Object.fromEntries(Object.keys(state.projectAgentOverrides || {}).map(projectId => [
        projectId,
        allAgentIdsFromProfiles(state.agentProfiles).map(id => summarizeAgentProfile(effectiveAgentProfile(state, id, projectId))),
      ])),
    },
    modes: MODE_DEFS,
    settings: {
      ...state.settings,
      config: {
        provider: config.provider,
        imageSettings: resolvedImageSettings(config),
        llmConnections: publicLlmConnections(config),
        extraFast: publicExtraFast(config),
        apiProtocol: config.apiProtocol || 'chat-completions',
        baseUrl: config.baseUrl,
        model: config.model,
        modelPricing: config.modelPricing?.[config.model] || null,
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
        // MiniMax T2A V2 — surfaced so the UI can render a config block
        // alongside Whisper. Mirrors the masked-key pattern: never expose
        // raw secrets to the client; UI sees the prefix...suffix mask plus
        // a hasMinimaxKey boolean for indicator copy.
        hasMinimaxKey: Boolean(config.minimaxApiKey),
        maskedMinimaxApiKey: config.minimaxApiKey
          ? `${config.minimaxApiKey.slice(0, 4)}...${config.minimaxApiKey.slice(-4)}`
          : '(not set)',
        minimaxGroupId: config.minimaxGroupId || '',
        minimaxVoiceId: config.minimaxVoiceId || '',
        ttsSpeed: config.ttsSpeed ?? DEFAULT_CONFIG.ttsSpeed,
        ttsPitch: config.ttsPitch ?? DEFAULT_CONFIG.ttsPitch,
        ttsVol: config.ttsVol ?? DEFAULT_CONFIG.ttsVol,
        codexAuth: config.codexAuth || null,
        availableModels: availableModelsForConfig(config),
        modelCatalogs: normalizeModelCatalogs(config.modelCatalogs || DEFAULT_MODEL_CATALOGS),
        // Retained for older frontends; startup no longer asks for consent.
        productivityMcpsConsented: Boolean(config.productivityMcpsConsented),
      },
    },
    recents: chats.slice(0, MAX_RECENT_CHATS).map(summarizeChat),
    chats: chats.map(summarizeChat),
    activeChat: selectedChat,
    syncPendingPersonas: pendingPersonaRecords(state),
    agentPersonaRecoveries: state.agentPersonaRecoveries || [],
    projectMemoryConflicts: (state.projectMemorySync?.records || []).filter(r=>r.versions.length>1),
    agentSettingsConflicts: (state.agentSettingsSync?.records || []).filter(r=>r.versions.length>1),
    syncConflicts: (state.mobileWorkspaceSync?.records || []).filter(r=>r.versions.length>1),
    projects: state.projects.map(project => summarizeProject(project, chats, visibleArtifactRows)),
    activeProject:activeProject?{...activeProject,summary:projectText(activeProject.summary),instructions:projectText(activeProject.instructions),workspaceNeedsConfirmation:(await projectWorkspaceStatus(activeProject)).requiresConfirmation===true}:null,
    results: visibleArtifactRows.filter(a=>a.kind==='result').map(summarizeArtifact),
    artifacts: visibleArtifactRows.filter(a=>a.kind!=='result')
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
      // Built-in stdio MCP presets (browser + chart + md→pdf) so the
      // Advanced page can render one toggle per server without bouncing
      // through `/api/mcp/...`. Each entry carries `enabled` derived
      // from the corresponding `enableXxxMcp` config flag.
      mcpPresets: getBuiltinMcpPresets().map(preset => ({
        id: preset.id,
        command: preset.command,
        args: preset.args,
        description: preset.description,
        flag: preset.flag,
        enabled: Boolean(config[preset.flag]),
        // Codex 三轮 audit 2026-04-29: forward `unpinned` so the
        // Advanced page can disable that toggle and show a hint.
        // Without this, browserless looks toggle-able but
        // connectMcpServer would refuse to spawn it ("假启用").
        unpinned: Boolean(preset.unpinned),
      })),
      // Per-agent authorisation surface — union of built-in presets and
      // any servers the user added under `config.mcpServers`.  Both kinds
      // funnel through the same agent-whitelist check (filterMcpToolsFor-
      // Agent), so the customize → agents UI must offer chips for both.
      // Preset entries have a `flag`; user entries don't (their "global
      // enable" is just being present in config). De-duped by id with the
      // user entry winning when ids collide (matches buildEffective-
      // McpServers's user-overrides-preset semantics).
      mcpAuthSurface: (() => {
        const seen = new Map();
        for (const preset of getBuiltinMcpPresets()) {
          seen.set(preset.id, {
            id: preset.id,
            source: 'preset',
            enabled: Boolean(config[preset.flag]),
            description: preset.description,
            command: preset.command,
            args: preset.args,
            flag: preset.flag,
            // Codex 四轮 audit 2026-04-29: forward `unpinned` so
            // the agent-authorisation UI shows "unavailable" for
            // browserless even when the user's legacy config
            // still has enableBrowserlessMcp:true. Without this,
            // the chip-row in customize → agents would say "OK to
            // authorise" while the runtime refuses to spawn the
            // server — same 假启用 hole the toggle-page just
            // closed, but on the per-agent surface.
            unpinned: Boolean(preset.unpinned),
          });
        }
        const userServers = (config.mcpServers && typeof config.mcpServers === 'object')
          ? config.mcpServers
          : {};
        for (const [id, cfg] of Object.entries(userServers)) {
          if (!id) continue;
          // Skip user-configured servers whose id violates the
          // [A-Za-z0-9_-]+ contract — they're rejected at connect
          // time too, so surfacing them in the auth UI would let a
          // user "authorise" a server that can never actually run.
          // Codex 2026-04-28 audit.
          if (!isValidMcpServerId(id)) continue;
          // User-configured server is "enabled" iff it isn't explicitly
          // disabled in the user's own config block.  Preset toggles
          // don't apply.
          seen.set(id, {
            id,
            source: 'user',
            enabled: !cfg?.disabled,
            description: 'User-configured stdio MCP server',
            command: cfg?.command || '',
            args: Array.isArray(cfg?.args) ? cfg.args : [],
            flag: null,
            unpinned: false, // user-supplied servers are not subject to the preset pin map
          });
        }
        return [...seen.values()];
      })(),
    },
    workspace,
    search: await buildSearchResults(query, state, workspace, connectors, skills),
  };
  } finally { finishTiming(); }
}
