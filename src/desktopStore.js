import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  dirname,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DEFAULT_CONFIG,
  DEFAULT_MODEL_CATALOGS,
  getMeloHome,
  getResolvedConfig,
  loadConfig,
  normalizeModelCatalogs,
  saveConfig,
} from './config.js';
import { discoverAvailableModels } from './openai.js';
import {
  normalizeConversationSnippet,
  normalizeComparablePhrase,
  isLikelyClarificationPrompt,
  isLikelyContextDependentReply,
  extractClarificationOptions,
  findClarificationOptionMatch,
} from './memory/heuristics.js';
import { renderConversationContinuityContext as renderStructuredConversationContinuityContext } from './memory/threadContext.js';
import { bootstrapBuiltinTools } from './tools/registry.js';
import {
  defaultSkillProposalStore,
  proposeSkillsFromActivity,
} from './agents/skillProposals.js';
import { draftSkillFromConversation } from './agents/skillDrafting.js';
import {
  loadSkillsFromDisk,
  saveSkillToDisk,
  removeSkillFromDisk,
  skillToMarkdown,
  skillFromMarkdown,
  parseSkillMarkdown,
  SKILLS_DISK_ROOT,
} from './agents/skillsDisk.js';
import { bootstrapMcpServers } from './mcp/manager.js';
import {
  streamSearchFileGroups as streamSearchFileGroupsService,
  streamSearchFileHits as streamSearchFileHitsService,
} from './services/search/searchService.js';
import { enrichMessageWithMediaContext } from './media/index.js';
import { modelSupportsVision } from './media/visionCapability.js';
import {
  isBacklogPollCycle,
  recentChatHasBotContext,
  passesOfflineBacklogFilter,
  OFFLINE_BACKLOG_THRESHOLD_MS,
  BACKLOG_CONTEXT_LOOKBACK,
} from './services/remote/offlineBacklogFilter.js';
import {
  FOLLOW_UP_WINDOW_MS,
  computeFollowUpScore,
  isLikelyTelegramFollowUpToBot,
  detectImplicitAddress,
} from './services/remote/replyScoreSignals.js';
import {
  telegramApiRequest,
  sendTelegramAudioReply,
  sendTelegramPhotoReply,
  pingTelegramChannel,
  fetchTelegramUpdates as fetchTelegramUpdatesFromApi,
} from './services/remote/telegramApi.js';
import {
  stripTelegramBotMention,
  hasTelegramInvokePrefix,
  escapeTelegramAliasRegex,
  collectTelegramBotAliases,
  containsTelegramBotAlias,
} from './services/remote/telegramAddressHelpers.js';
import {
  nowIso,
  normalizeAgentStorageId,
  normalizeMessageAttachments,
  coerceIso,
  formatUpdatedAt,
  normalizeMarkdownContent,
  titleCase,
  truncateText,
} from './shared/helpers.js';
import {
  resolveTelegramFileAttachment,
  extractTelegramAttachments,
  buildTelegramThreadKey,
  latestProcessableTelegramText,
} from './services/remote/telegramParsing.js';
import {
  TELEGRAM_SIGNAL_WEIGHTS,
  REPLY_SCORE_THRESHOLD,
  GRAY_ZONE_MIN,
  buildTelegramReplyScore,
} from './services/remote/telegramReplyScore.js';
import {
  discordApiBase,
  buildDiscordUrl,
  discordApiRequest,
  sendDiscordMediaReply,
  pingDiscordChannel,
  fetchDiscordUpdates as fetchDiscordUpdatesFromApi,
} from './services/remote/discordApi.js';
import { loadAttachmentBytes } from './services/remote/attachmentBytes.js';
import {
  buildDiscordThreadKey,
  normalizeDiscordAttachmentKind,
  extractDiscordAttachments,
  isDiscordMessageFromBot,
  latestProcessableDiscordMessage,
  hasDiscordInvokePrefix,
  collectDiscordBotAliases,
} from './services/remote/discordParsing.js';
import {
  DISCORD_SIGNAL_WEIGHTS,
  buildDiscordReplyScore,
} from './services/remote/discordReplyScore.js';
import { getDiscordVoiceRuntime } from './services/remote/discordVoiceRuntime.js';
import {
  classifyGroupMessageAddressal,
} from './services/remote/groupAddressalClassifier.js';
import {
  MAX_TREE_ENTRIES,
  MAX_WORKSPACE_INDEXED_FILES,
  MAX_FILE_PREVIEW_CHARS,
  IGNORED_DIR_NAMES,
  sanitizeWorkspacePath as sanitizeWorkspacePathRaw,
  toRelativePath,
  resolveWorkspaceFilePath,
  extensionToLanguage,
  readWorkspaceFile,
  writeWorkspaceFile,
  listWorkspaceEntries,
} from './services/workspace/workspaceFiles.js';
import {
  readWorkspaceFilePreview as readWorkspaceFilePreviewService,
  saveWorkspaceFileContent as saveWorkspaceFileContentService,
  applyArtifactContentToWorkspace as applyArtifactContentToWorkspaceService,
} from './services/workspace/workspaceService.js';
import {
  normalizeArtifact,
  summarizeArtifact,
  extractArtifacts,
} from './services/artifact/artifactService.js';
import {
  TASK_OWNERS,
  TASK_STATUSES,
  MAX_TASKS,
  normalizeTask,
  normalizeTasks,
  summarizeTask,
} from './services/task/taskService.js';
import {
  APPROVAL_STATUSES,
  MAX_APPROVALS,
  normalizeApproval,
  normalizeApprovals,
  summarizeApproval,
} from './services/approval/approvalService.js';
import {
  MAX_COMMAND_RUNS,
  MAX_EXTERNAL_TOOL_RUNS,
  MAX_PROMPT_HISTORY,
  normalizeCommandRuns,
  normalizeExternalToolRuns,
  normalizePromptHistory,
} from './services/activity/activityLog.js';
import { summarizeProject } from './services/project/projectService.js';
import {
  parseMessageBlocksFromContent,
  normalizeMessageBlock,
  normalizeMessageBlocks,
  stripMarkdownDecoratorsForConversation,
  aggressivelyStripMarkdownForPlainText,
  stripMarkdownLinksForPlainText,
  stripAllMarkdownForTelegram,
  normalizeConversationTextBlockForStorage,
  serializeMessageBlocks,
  normalizeAssistantReplyForConversation,
  normalizePreviewPlainText,
  visibleTextFromBlocks,
  messageVisibleText,
} from './services/message/messageBlocks.js';
import {
  attachmentSearchText,
  extractedMediaPromptText,
  stripInvisibleSearchDecorators,
  messageSearchText,
} from './services/message/messageSearch.js';
import {
  updateGroupRelationshipGraph,
  buildGroupRelationshipSummary,
  collectBystanderContext,
  collectKnownTelegramParticipants,
} from './services/remote/groupRelationship.js';
import {
  generateChatTitle,
  summarizeProviderFailureDetails,
  formatProviderFailureMessage,
} from './services/chat/providerErrors.js';
export { formatProviderFailureMessage } from './services/chat/providerErrors.js';
// Phase 7d-1 re-export: server.js imports buildModelMessagesFromChat from
// desktopStore. Keep the surface stable by re-exporting the service entry.
export { buildModelMessagesFromChat } from './services/chat/messageBuilder.js';
import { summarizeAttachmentsForPrompt } from './services/chat/messageBuilder.js';
// Phase 7d-2: system-prompt assembly moved to a dedicated service. The
// three symbols re-imported here are the ones desktopStore still calls
// directly (summarizeAgentPrompt at the chat-record builder site, plus
// buildReActSystemPrompt + buildLanguageConstraint inside the chat /
// task execution graphs). buildConversationFormattingRules /
// buildOutputHardConstraints / detectInputLanguage have no remaining
// in-module callers and are not re-imported.
import {
  summarizeAgentPrompt,
  buildLanguageConstraint,
  buildReActSystemPrompt,
} from './services/chat/systemPrompt.js';
// Phase 7d-5β leaf extractions: pure helpers with zero desktopStore-local
// dependencies. byte-for-byte ports (CLAUDE.md §5).
import { buildMatcherContextFromChat } from './services/chat/matcherContext.js';
import { formatModelMessageForVisionDebug } from './services/chat/visionDebug.js';
// Phase 7d-5β commit 3: dynamic-context assembly extracted to a leaf
// module — its three upstream deps were already external.
import { buildDynamicContext } from './services/chat/dynamicContext.js';
// Phase 7d-5γ commit 1: COMMAND_TEMPLATES static registry +
// commandTemplateDescriptor shaper extracted as a self-contained leaf.
// 6 callers across desktopStore (workspace snapshot UI builders, command
// runner lookup, tool-routing prompt) now reach them via this import.
import {
  COMMAND_TEMPLATES,
  commandTemplateDescriptor,
} from './services/command/commandTemplates.js';
// Phase 7d-5γ commit 2: tool-routing prompt block extracted to a leaf
// (its two upstream deps — `agentUsesTool` and `COMMAND_TEMPLATES` —
// are already in service modules).
// Phase 7d-5γ commit 3: channel-route system-prompt block extracted to a
// leaf. All five helpers it touches (normalizeAgentChannels, the three
// groupRelationship helpers, normalizeConversationSnippet) are already
// in service modules — true zero-LOCAL extraction.
// Phase 7d-5γ commit 4: agent memory-context system-prompt block + its
// 5-line `latestUserMessageRecord` private helper extracted together to
// a single leaf module. All other upstream deps were already in service
// or memory modules.
import { buildAgentMemoryNodeContext } from './services/agent/agentMemoryContext.js';
// Phase 7d-5δ commit 1: chat-graph action planner cluster (7 functions —
// the two planners, their cluster-private helpers, the entry, and the
// approval-response composer) extracted to a self-contained leaf. Only
// `planChatGraphAction` and `buildApprovalResponse` are exported because
// only they have callers outside the cluster.
import {
  planChatGraphAction,
  buildApprovalResponse,
} from './services/chat/chatActionPlanning.js';
import {
  DEFAULT_SKILL_TASK_SCHEMA,
  BUILTIN_SKILLS,
  SUSPICIOUS_SKILL_PROMPT_PATTERN,
  normalizeSkillParametersSchema,
  normalizeBuiltinSkill,
  normalizeCustomSkill,
  buildSkills,
  listExecutableSkills,
} from './services/skill/skillService.js';
export {
  normalizeCustomSkill,
  buildSkills,
  listExecutableSkills,
} from './services/skill/skillService.js';
// Phase 7d-5β: skill prompt summarization moved to a dedicated leaf module.
// byte-for-byte port (CLAUDE.md §5). The export from desktopStore is
// preserved as a back-compat re-export so callers still importing
// `summarizeSkillsPrompts` from this file keep working — the test was
// updated to point at the new path as the canonical location, but the
// public surface stays identical.
import { summarizeSkillsPrompts } from './services/skill/skillPrompts.js';
export { summarizeSkillsPrompts } from './services/skill/skillPrompts.js';
import {
  extractVoiceSummary,
  rewriteForVoice,
} from './services/media/voiceRewrite.js';
import {
  normalizeEndpointBase,
  normalizeConnectorPath,
  maskSecret,
  normalizeManifestEntries,
  normalizeExternalConnectorManifest,
  normalizeExternalConnector,
  externalConnectorUrl,
  requestExternalConnectorJson,
  refreshExternalConnectorStatus,
  fetchExternalConnectorContext,
  readExternalConnectorResourcePayload,
  readExternalConnectorPromptPayload,
} from './services/connector/externalConnector.js';
// Phase 7d-5β: connector prompt summarization moved to a dedicated leaf
// module. byte-for-byte port (CLAUDE.md §5).
import { summarizeConnectorPrompts } from './services/connector/connectorPrompts.js';
// Phase 7d-5β commit 2: project-context block extracted to a leaf module.
// Single dependency `agentUsesTool` is now resolved inside the leaf.
import { buildProjectContextSection } from './services/project/projectContext.js';
import { createAgentMarkdownFileHelpers } from './services/agent/markdownFiles.js';
import {
  AGENT_TOOL_OPTIONS,
  DEFAULT_AGENT_TOOL_IDS,
  AGENT_TOOL_IDS,
  normalizeAgentTools,
  summarizeAgentTools,
  agentUsesTool,
  normalizeIdWhitelist,
  filterConnectorsForAgent,
  filterSkillsForAgent,
  fingerprintSkillList,
} from './services/agent/agentTools.js';
import {
  AGENT_CHANNEL_IDS,
  CHANNEL_RUNTIME_FIELDS,
  normalizeAgentChannel,
  normalizeAgentChannels,
  mergeChannelRuntimeFields,
} from './services/agent/agentChannels.js';
import {
  WORKER_PROMPTS,
  MOOD_OPTIONS,
  MOOD_OPTION_IDS,
  AGENT_LIBRARY,
  AGENT_IDS,
  AGENT_PRESETS,
  customAgentDefinition,
  agentDefinitionFor,
  allAgentIdsFromProfiles,
  nextCustomAgentId,
  moodOptionById,
  agentPresetById,
} from './services/agent/agentLibrary.js';
import {
  normalizeAgentUpdatePatch,
  mergeChannelsWithStaleDraftGuard,
  buildNewCustomAgent,
} from './services/agent/agentProfileService.js';
import {
  readAgentIdentityValue,
  readAgentSoulValue,
  withLegacyAgentAliases,
  normalizeAgentProfile,
  normalizeAgentProfiles,
  normalizeAgentOverride,
  normalizeProjectAgentOverrides,
  dedupeAgentChannelTokenOwners,
  projectAgentOverrideFor,
  effectiveAgentProfile,
} from './state/agentProfiles.js';
import {
  recoverLeadingJsonObject,
  parseStatePayload,
} from './state/statePayload.js';
import {
  sortChats,
  summarizeChat,
  summarizeMessagePreview,
  describeChatForLimit,
} from './state/conversation.js';
import {
  MAX_RECENT_CHATS,
  oldestUnlockedChat,
  pruneExcessChats,
  assertCanCreateChat,
} from './state/chatPruning.js';
// Phase 7d-5δ commit 2: trivial state-entity finders extracted to a leaf
// module so the chat / task execution graph runners can move out without
// import cycles. Same packaging pattern as Phase 7d-5γ commit 1.
import {
  findProjectById,
  findExternalConnectorById,
  findTaskById,
  findApprovalById,
} from './state/stateLookups.js';
// Phase 7d-5δ commit 8a: selection-coercion helper extracted (last big
// LOCAL helper still blocking sendChatMessage extraction). 58 in-module
// callers continue to call by the same name via this import.
import { ensureSelectedEntities } from './state/stateSelections.js';
// Phase 7d-5δ commit 8c: buildConnectors moved to its own service-domain
// leaf. byte-for-byte port. (refreshChatMemorySummary moved alongside
// it but is appended to the existing chatThreadContext import block
// below to keep imports tidy.)
import { buildConnectors } from './services/connector/connectorRollup.js';
// Phase 7d-5δ commit 8d: search-results builder cluster (8 LOCAL helpers
// including buildSearchResults itself + MAX_SEARCH_RESULTS const) extracted
// to a self-contained leaf. Only the entry-point is exported; the rest are
// cluster-private. Same packaging pattern as commit 1's chat-action planner.
import { buildSearchResults } from './services/search/searchResultsBuilder.js';
// Phase 7d-5δ commit 8e: desktop-bootstrap entry + 4 cluster-private
// helpers (availableModelsForConfig, summarizeAgentProfile,
// buildAgentProfiles, buildProfile) extracted to a self-contained
// state-domain leaf. 37 in-module callers go through the import below;
// the re-export keeps server.js + the test files that do `import * as
// store from './desktopStore.js'` working without code changes.
import { getDesktopBootstrap } from './state/desktopBootstrap.js';
export { getDesktopBootstrap } from './state/desktopBootstrap.js';
// Phase 7d-5δ commit 8f (path B finale): sendChatMessage extracted to
// services/chat/sendChatMessage.js along with its two private helpers
// (extractUrlAttachmentsFromText + isAbortError). The skill-proposal
// background scan moved to state/skillProposalScan.js so the chat send
// path no longer carries a cluster of unrelated I/O orchestration.
// Both re-exported from desktopStore for back-compat with server.js +
// scanSkillProposals.test.js.
import { sendChatMessage } from './services/chat/sendChatMessage.js';
export { sendChatMessage } from './services/chat/sendChatMessage.js';
import { scanRecentChatsForSkillProposals } from './state/skillProposalScan.js';
export { scanRecentChatsForSkillProposals } from './state/skillProposalScan.js';
// Phase 7d-5ε commit 1: external-connector CRUD mutations extracted to
// a sibling module. Server.js imports these by name; re-export keeps
// the existing surface stable.
export {
  createExternalConnector,
  updateExternalConnector,
  removeExternalConnector,
  pingExternalConnector,
  readExternalConnectorResource,
  previewExternalConnectorPrompt,
  invokeExternalConnectorTool,
} from './services/connector/externalConnectorMutations.js';
// Phase 7d-5ε commit 2: skill CRUD + scanner application moved to a
// sibling. Server.js + tests import these by name; re-export preserves
// the existing import paths.
export {
  toggleSkill,
  createCustomSkill,
  updateCustomSkill,
  removeCustomSkill,
  exportSkillAsMarkdown,
  importSkillFromMarkdown,
  promoteSkillToDisk,
  reloadDiskSkills,
  applySkillProposal,
  draftSkillFromChat,
} from './services/skill/skillMutations.js';
// Phase 7d-5ε commit 3: project + task + workspace + approval mutation
// clusters extracted to four sibling leaf modules. Each is a pure
// state-machine CRUD orchestrator that shares the same pattern (load,
// mutate, persist, return getDesktopBootstrap()). Re-exported here for
// server.js's named-import block.
export {
  createProject,
  updateProject,
} from './services/project/projectMutations.js';
export {
  createTask,
  updateTask,
  runTask,
  runTaskLane,
} from './services/task/taskMutations.js';
export {
  selectWorkspaceFile,
  readWorkspaceFilePreview,
  saveWorkspaceFile,
  createArtifact,
  applyArtifactToWorkspaceFile,
  runLocalCommand,
} from './services/workspace/workspaceMutations.js';
export {
  createApproval,
  rejectApproval,
  executeApproval,
} from './services/approval/approvalMutations.js';
// Phase 7d-5δ commit 3: workspace snapshot builder extracted. The new
// module computes its own APP_ROOT via a deeper dirname chain (same
// pattern as Phase 7d-5α-A1 commit 7's stateHydration.js) and keeps a
// local 1-arg `sanitizeWorkspacePath` wrapper identical to the one
// retained here. desktopStore's wrapper stays put because there is still
// one in-module caller (line ~5956) outside the snapshot path.
import { buildWorkspaceSnapshot } from './services/workspace/workspaceSnapshot.js';
// Phase 7d-5δ commit 4: task-execution prompt builder extracted. Single
// dependency `agentUsesTool` is already in a leaf module.
import { taskExecutionPrompt } from './services/task/taskPrompt.js';
// Phase 7d-5δ commit 6: task-side agent execution graph runner extracted.
// All 12 of its upstream dependencies were prepared by commits 1-5 of
// this phase, so the runner moves cleanly with no import cycle.
import { runTaskAgentExecutionGraph } from './services/chat/taskExecutionRunner.js';
// Phase 7d-5δ commit 7a: chat mode catalogue extracted to a leaf so the
// upcoming runChatAgentExecutionGraph (commit 7b) can import it without
// reimporting desktopStore.
import { MODE_DEFS } from './services/chat/modeDefs.js';
// Phase 7d-5δ commit 7b: chat-side agent execution graph runner extracted
// — the elephant. Every helper this 520-line function depends on now
// lives in a dedicated leaf module (commits 7d-5β through 7d-5δ-7a were
// the prep). The previously module-private `getSharedSkillIndex`
// singleton ships co-located inside the runner module since this was
// always its sole caller.
import { runChatAgentExecutionGraph } from './services/chat/chatExecutionRunner.js';
import {
  serializeChatForPersistence,
  persistChatThreads,
} from './state/chatPersistence.js';
import {
  MAX_CONTEXT_MEMORY_ITEMS,
  messageTextForContext,
  setChatThreadContextCache,
  buildThreadContextForChat,
  ensureChatThreadContext,
  buildThreadCheckpointPayload,
  refreshChatMemorySummary,
} from './state/chatThreadContext.js';
import {
  buildSpeakerMemoryNamespace,
  syncMemoryStoreSnapshot,
} from './state/memorySnapshot.js';
import { mergeDiskSkillsIntoState } from './state/diskSkills.js';
import {
  BUILTIN_CONNECTORS,
  normalizeProject,
  normalizeChat,
  createDefaultState,
  hydrateState,
  hydrateChatThreads,
} from './state/stateHydration.js';
import {
  importAgentMarkdownFiles,
  queueAgentMarkdownPrime,
} from './state/markdownSync.js';
import {
  loadState,
  saveState,
  persistStateAtomically,
  readStateSnapshot,
  updateStateAtomically,
} from './state/stateStore.js';

const execFile = promisify(execFileCallback);
const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DESKTOP_DIR = join(getMeloHome(), 'desktop');
// STATE_PATH moved to src/state/stateStore.js in Phase 7d-5α-A1 commit 9 as a
// lazy `statePath()` getter (private to that module). desktopStore no longer
// references the path directly; all state I/O goes through the imported
// loadState / saveState / persistStateAtomically / readStateSnapshot entries.

const AGENTS_DIR = join(DESKTOP_DIR, 'agents');

// Bind the agent markdown file helpers to our AGENTS_DIR once. The helpers
// own FS I/O for IDENTITY.md / SOUL.md on each agent profile, scoped either
// globally or per-project. See src/services/agent/markdownFiles.js.
const {
  getAgentMarkdownPaths,
  readTextIfExists,
  ensureMarkdownFile,
  writeMarkdownFile,
} = createAgentMarkdownFileHelpers({ agentsDir: AGENTS_DIR });

// Always-on Discord diagnostic log. Writes to $MELO_HOME/desktop/discord-debug.log
// so the user can share a single file when their bot silently fails to reply.
// Auto-rotates the file at 256 KB to keep it bounded. Previously the same lines
// were gated behind MELO_DC_DEBUG=1 which required the user to set an env var
// before launching Melo — too much friction when debugging a running install.
const DISCORD_DEBUG_LOG_PATH = join(DESKTOP_DIR, 'discord-debug.log');
const DISCORD_DEBUG_LOG_MAX_BYTES = 256 * 1024;
let discordDebugLogDirReady = false;

function writeDiscordDebugLine(line) {
  try {
    if (!discordDebugLogDirReady) {
      mkdirSync(DESKTOP_DIR, { recursive: true });
      discordDebugLogDirReady = true;
    }
    try {
      const info = statSync(DISCORD_DEBUG_LOG_PATH);
      if (info.size > DISCORD_DEBUG_LOG_MAX_BYTES) {
        renameSync(DISCORD_DEBUG_LOG_PATH, `${DISCORD_DEBUG_LOG_PATH}.old`);
      }
    } catch {
      // File doesn't exist yet, that's fine.
    }
    const stamp = new Date().toISOString();
    appendFileSync(DISCORD_DEBUG_LOG_PATH, `${stamp} ${line}\n`, 'utf8');
  } catch {
    // Never let logging errors bubble into the polling loop.
  }
  if (process.env.MELO_DC_DEBUG === '1') {
    // Keep the old stdout mirror for developers who want live output.
    try {
      process.stdout.write(`${line}\n`);
    } catch {}
  }
}

// MAX_TREE_ENTRIES / MAX_WORKSPACE_INDEXED_FILES / MAX_FILE_PREVIEW_CHARS /
// IGNORED_DIR_NAMES were extracted to
// `src/services/workspace/workspaceFiles.js` in Phase 7a and re-imported above.
// MAX_COMMAND_RUNS / MAX_EXTERNAL_TOOL_RUNS / MAX_PROMPT_HISTORY live in
// `src/services/activity/activityLog.js` and are re-imported above. Likewise
// MAX_TASKS / MAX_APPROVALS live in the task / approval service modules —
// keeping the caps co-located with their normalizers avoids drift with
// TASK_OWNERS / TASK_STATUSES / APPROVAL_STATUSES when the list of valid
// values changes.
// MAX_RECENT_CHATS moved to src/state/chatPruning.js in Phase 7d-5α-A1.
// Re-imported at the top of this file alongside the prune helpers.
const MAX_SEARCH_FILE_CONTENT_MATCHES = 18;
// MAX_SEARCH_FILE_GROUPS / MAX_LINES_PER_FILE_GROUP moved to
// src/services/search/searchService.js in Phase 7a.
// MAX_SEARCH_RESULTS moved to `src/services/search/searchResultsBuilder.js`
// in Phase 7d-5δ commit 8d (was a module-private const, only used by
// the search results builder cluster).
// MAX_CONTEXT_RECENT_MESSAGES / MAX_CONTEXT_MEMORY_MESSAGES /
// MAX_CONTEXT_MEMORY_ITEMS moved to src/state/chatThreadContext.js in
// Phase 7d-5α-A1 (commit 3/9). MAX_CONTEXT_MEMORY_ITEMS is re-imported
// here for the one remaining caller (uniqueMemoryLines); the other two
// are only consumed inside buildThreadContextForChat which moved with
// them.
// ONE_DAY_MS moved alongside defaultProjectTime to src/state/stateHydration.js (commit 7/9). No remaining caller in this module.

const TELEGRAM_POLL_LIMIT = 12;

// ─── Offline backlog filter ──────────────────────────────────────────────────
// Implementation moved to `./services/remote/offlineBacklogFilter.js` in the
// Phase 1 refactor (see _refactor-backup/REFACTOR_PLAN.md). Symbols are
// re-imported here so the rest of this file + existing tests (which read
// `__offlineBacklogTesting` from this module) keep working unchanged.
//
// When migrating callers to the new path, prefer importing directly from
// `./services/remote/offlineBacklogFilter.js`.

// Bootstrap built-in tools at module load time (idempotent).
bootstrapBuiltinTools();

// stateWriteQueue moved to src/state/stateStore.js in Phase 7d-5α-A1 commit 9.

// markdownSynced moved to src/state/stateStore.js in Phase 7d-5α-A1 commit 9.

// markdownPrimeQueued moved alongside queueAgentMarkdownPrime to src/state/markdownSync.js in Phase 7d-5α-A1 commit 8.

// IGNORED_DIR_NAMES lives in `src/services/workspace/workspaceFiles.js`
// (re-imported above).

// availableModelsForConfig moved to `src/state/desktopBootstrap.js`
// in Phase 7d-5δ commit 8e (cluster-private helper for getDesktopBootstrap).

// MODE_DEFS moved to `src/services/chat/modeDefs.js` in Phase 7d-5δ
// commit 7a. Re-imported at the top of this file.

// DEFAULT_SKILL_TASK_SCHEMA and BUILTIN_SKILLS were extracted to
// `src/services/skill/skillService.js` in Phase 9b and are imported at the
// top of this file.

// Phase 3.4.2: per-archetype skill preset. When a new agent is created or
// has no explicit enabledSkillIds, this map seeds sensible defaults based
// on its role. Reviewer-type agents lean on review/test skills; builders
// lean on planner/connector; research has only a subset; main has all.
// Keys are agent ids (AGENT_LIBRARY keys). Missing key = "all enabled".
const AGENT_ARCHETYPE_SKILL_PRESET = {
  main: ['skill-creator', 'project-planner', 'connector-builder', 'artifact-curator'],
  research: ['project-planner', 'artifact-curator'],
  builder: ['skill-creator', 'project-planner', 'connector-builder'],
  reviewer: ['project-planner', 'artifact-curator'],
};

// COMMAND_TEMPLATES moved to `src/services/command/commandTemplates.js`
// in Phase 7d-5γ. Re-imported at the top of this file alongside
// commandTemplateDescriptor.

// BUILTIN_CONNECTORS moved to src/state/stateHydration.js in Phase 7d-5α-A1 (commit 7/9). Re-imported at the top of this file.


// TASK_OWNERS / TASK_STATUSES / APPROVAL_STATUSES live in the task /
// approval service modules and are re-imported above.
// WORKER_PROMPTS / MOOD_OPTIONS / MOOD_OPTION_IDS / AGENT_LIBRARY /
// AGENT_IDS / AGENT_PRESETS moved to `src/services/agent/agentLibrary.js`
// in Phase 9m. Re-imported at the top of this file.
// AGENT_TOOL_OPTIONS / DEFAULT_AGENT_TOOL_IDS / AGENT_TOOL_IDS moved to
// `src/services/agent/agentTools.js` in Phase 9k. Re-imported at top of
// this file so existing references in desktopStore still resolve.

// defaultProjectTime moved to src/state/stateHydration.js in Phase 7d-5α-A1 (commit 7/9).


// ID + name signature of the legacy auto-seeded example project. Earlier
// versions of Melo shipped with a "How to use Melo" sample whose
// workspacePath defaulted to the Melo install directory — that leaked the
// source path and showed up for every brand-new install. The seed is gone
// now (empty projects list on first boot), and hydrateState() drops any
// persisted copy that is still in its pristine form. A user who renamed the
// example keeps it, because then it has become their own.
// LEGACY_EXAMPLE_PROJECT_ID + LEGACY_EXAMPLE_PROJECT_NAME moved to src/state/stateHydration.js in Phase 7d-5α-A1 (commit 7/9).


// nowIso / normalizeAgentStorageId / normalizeMessageAttachments were
// extracted to `src/shared/helpers.js` in Phase 5c — see import block above.

// normalizeMarkdownContent was moved to `src/shared/helpers.js` in Phase 9i.

// customAgentDefinition / agentDefinitionFor / allAgentIdsFromProfiles /
// nextCustomAgentId moved to `src/services/agent/agentLibrary.js` in Phase 9m.
// Re-imported at the top of this file.

// normalizeAgentChannel / normalizeAgentChannels / mergeChannelRuntimeFields
// (plus the CHANNEL_RUNTIME_FIELDS allow-list) moved to
// `src/services/agent/agentChannels.js` in Phase 9l. Re-imported at the
// top of this file.

// getAgentMarkdownPaths / readTextIfExists / ensureMarkdownFile /
// writeMarkdownFile were moved to `src/services/agent/markdownFiles.js` in
// Phase 9j. They are bound to AGENTS_DIR via the factory above and
// re-exposed at module scope so the rest of desktopStore can keep using
// them with their original signatures.

// titleCase and truncateText were moved to `src/shared/helpers.js` in
// Phase 9i. Imported from the shared helpers module at the top of this file.

// formatUpdatedAt / coerceIso were moved to `src/shared/helpers.js` so the
// artifact / connector / task service modules can share the same date
// normalization without re-implementing it. Re-imported above.

// normalizeEndpointBase / normalizeConnectorPath / maskSecret /
// normalizeManifestEntries / normalizeExternalConnectorManifest were
// extracted to `src/services/connector/externalConnector.js` in Phase 3 of
// the desktopStore refactor. See _refactor-backup/REFACTOR_PLAN.md.

// sanitizeWorkspacePath / toRelativePath / resolveWorkspaceFilePath /
// extensionToLanguage were extracted to
// `src/services/workspace/workspaceFiles.js` in Phase 7a. The local
// wrapper below binds APP_ROOT as the default fallback root, so the
// original one-arg signature used throughout this file keeps working.
function sanitizeWorkspacePath(rawPath) {
  return sanitizeWorkspacePathRaw(rawPath, APP_ROOT);
}

// normalizeCommandRuns was extracted to 'src/services/activity/activityLog.js'
// in Phase 9a and is now imported at the top of this file.

// normalizeProject was extracted to `src/services/project/projectService.js`
// in Phase 9c. The local wrapper binds APP_ROOT / sanitizeWorkspacePath /
// defaultProjectTime so the original one-arg signature keeps working.
// normalizeProject (local wrapper) moved to src/state/stateHydration.js in Phase 7d-5α-A1 (commit 7/9).


// Message block helpers (parseMessageBlocksFromContent, normalizeMessageBlock,
// normalizeMessageBlocks, stripMarkdownDecoratorsForConversation,
// aggressivelyStripMarkdownForPlainText, stripMarkdownLinksForPlainText,
// stripAllMarkdownForTelegram, normalizeConversationTextBlockForStorage,
// serializeMessageBlocks, normalizeAssistantReplyForConversation,
// normalizePreviewPlainText, visibleTextFromBlocks, messageVisibleText) were
// extracted to `src/services/message/messageBlocks.js` in Phase 9d of the
// desktopStore refactor. See _refactor-backup/REFACTOR_PLAN.md. Consumers
// continue to use the imports near the top of this file. Pure string/regex
// module — no external state.

// Voice rewrite (extractVoiceSummary / rewriteForVoice / writeVoiceDebugLine)
// was extracted to `src/services/media/voiceRewrite.js` in Phase 2 of the
// desktopStore refactor. See _refactor-backup/REFACTOR_PLAN.md. Consumers
// continue to use the imports near the top of this file. The rewriter uses
// the 'fast' provider profile so it finishes while the text reply is still
// being sent, and falls back to the Phase-1 extraction on any error.

// Dedicated debug log for Telegram send-side traffic. Used to diagnose cases
// where a single inbound update appears to produce two outbound replies.
// Records one line per cycle start, per update, per text send, per voice send,
// and per cycle end — so we can see exactly how many times each step fires.
const TELEGRAM_DEBUG_LOG_PATH = join(DESKTOP_DIR, 'telegram-debug.log');
const TELEGRAM_DEBUG_LOG_MAX_BYTES = 256 * 1024;
let telegramDebugLogDirReady = false;
let _telegramCycleCounter = 0;
function nextTelegramCycleId() {
  _telegramCycleCounter = (_telegramCycleCounter + 1) % 1_000_000;
  return `${process.pid}-${_telegramCycleCounter}`;
}
function writeTelegramDebugLine(line) {
  try {
    if (!telegramDebugLogDirReady) {
      mkdirSync(DESKTOP_DIR, { recursive: true });
      telegramDebugLogDirReady = true;
    }
    try {
      const info = statSync(TELEGRAM_DEBUG_LOG_PATH);
      if (info.size > TELEGRAM_DEBUG_LOG_MAX_BYTES) {
        renameSync(TELEGRAM_DEBUG_LOG_PATH, `${TELEGRAM_DEBUG_LOG_PATH}.old`);
      }
    } catch {
      // File doesn't exist yet — first write will create it.
    }
    appendFileSync(TELEGRAM_DEBUG_LOG_PATH, `${nowIso()} ${line}\n`, 'utf8');
  } catch {
    // Never let logging errors break polling.
  }
}

function renderTelegramTransportText(message) {
  if (!message) {
    return '';
  }

  const serialized = serializeMessageBlocks(
    normalizeMessageBlocks(message?.blocks, message?.content || ''),
  );

  return stripAllMarkdownForTelegram(
    aggressivelyStripMarkdownForPlainText(serialized || message?.content || ''),
  );
}

// normalizeChat moved to src/state/stateHydration.js in Phase 7d-5α-A1 (commit 7/9).


// readAgentIdentityValue / readAgentSoulValue / withLegacyAgentAliases moved
// to `src/state/agentProfiles.js` in Phase 10a. Re-imported at the top of
// this file.

// setChatThreadContextCache / getChatThreadContextCache / buildThreadContextForChat
// moved to src/state/chatThreadContext.js in Phase 7d-5α-A1 (commit 3/9).
// Re-imported at the top of this file alongside the rest of the bundle.

// threadCheckpointMatches moved to src/state/stateHydration.js in Phase 7d-5α-A1 (commit 7/9).


// ensureChatThreadContext / buildThreadCheckpointPayload moved to
// src/state/chatThreadContext.js in Phase 7d-5α-A1 (commit 3/9).

// hydrateChatThreads moved to src/state/stateHydration.js in Phase 7d-5α-A1 (commit 7/9).


// serializeChatForPersistence moved to src/state/chatPersistence.js in
// Phase 7d-5α-A1 (commit 2/9). Re-imported at the top of this file.

// persistChatThreads moved to src/state/chatPersistence.js in
// Phase 7d-5α-A1 (commit 4/9). Re-imported at the top of this file
// alongside serializeChatForPersistence.

// buildSpeakerMemoryNamespace moved to src/state/memorySnapshot.js in
// Phase 7d-5α-A1 (commit 5/9). Re-imported at the top alongside
// syncMemoryStoreSnapshot for the 3 remaining callers in this file
// (inside buildAgentMemoryNodeContext).


// latestUserMessageRecord moved to
// `src/services/agent/agentMemoryContext.js` in Phase 7d-5γ (it was a
// private 5-line helper used only by buildAgentMemoryNodeContext, so
// they ship together).

// buildMemoryStoreEntries + syncMemoryStoreSnapshot moved to
// src/state/memorySnapshot.js in Phase 7d-5α-A1 (commit 5/9).


// normalizeMessageAttachments was extracted to `src/shared/helpers.js` in
// Phase 5c — see import block at top of file.

// attachmentSearchText / extractedMediaPromptText /
// stripInvisibleSearchDecorators / messageSearchText were extracted to
// `src/services/message/messageSearch.js` in Phase 9e of the desktopStore
// refactor. See _refactor-backup/REFACTOR_PLAN.md. Consumers continue to
// use the imports near the top of this file.

// normalizeArtifact was extracted to
// `src/services/artifact/artifactService.js` in Phase 7b.

// normalizeExternalConnector now imported from services/connector/externalConnector.js

// normalizeTask / normalizeTasks were extracted to
// `src/services/task/taskService.js` in Phase 8.

// moodOptionById moved to `src/services/agent/agentLibrary.js` in Phase 9m.
// Re-imported at the top of this file.

// normalizeAgentTools / summarizeAgentTools / agentUsesTool /
// normalizeIdWhitelist / filterConnectorsForAgent / filterSkillsForAgent /
// fingerprintSkillList were moved to `src/services/agent/agentTools.js`
// in Phase 9k and are re-imported at the top of this file.
//
// getSharedSkillIndex(skills) — moved to
// `src/services/chat/chatExecutionRunner.js` in Phase 7d-5δ commit 7b.
// It was always module-private and only used by the chat runner, so
// when the runner moved out the singleton went with it.

// buildMatcherContextFromChat moved to
// `src/services/chat/matcherContext.js` in Phase 7d-5β. Re-imported at
// the top of this file.

// normalizeAgentProfile moved to `src/state/agentProfiles.js` in Phase 10a.
// Re-imported at the top of this file.

async function syncAgentMarkdownFiles(state) {
  state.agentProfiles = normalizeAgentProfiles(state.agentProfiles);

  for (const agentId of allAgentIdsFromProfiles(state.agentProfiles)) {
    const profile = normalizeAgentProfile(agentId, state.agentProfiles?.[agentId]);
    const paths = getAgentMarkdownPaths(agentId, { scope: 'global' });
    const identity = await ensureMarkdownFile(paths.identityPath, profile.identity);
    const soulMd = await ensureMarkdownFile(paths.soulPath, profile.soulMd);
    state.agentProfiles[agentId] = normalizeAgentProfile(agentId, {
      ...profile,
      identity,
      identify: identity,
      soulMd,
      'soul.md': soulMd,
    });
  }

  state.projectAgentOverrides = normalizeProjectAgentOverrides(
    state.projectAgentOverrides,
    state.agentProfiles,
  );
  for (const [projectId, overrides] of Object.entries(state.projectAgentOverrides)) {
    for (const agentId of allAgentIdsFromProfiles(state.agentProfiles)) {
      const override = overrides?.[agentId];
      if (!override) {
        continue;
      }

      const profile = normalizeAgentProfile(agentId, override);
      const paths = getAgentMarkdownPaths(agentId, { scope: 'project', projectId });
      const identity = await ensureMarkdownFile(paths.identityPath, profile.identity);
      const soulMd = await ensureMarkdownFile(paths.soulPath, profile.soulMd);
      const normalizedOverride = normalizeAgentOverride(agentId, {
        ...profile,
        identity,
        identify: identity,
        soulMd,
        'soul.md': soulMd,
      });
      if (normalizedOverride) {
        state.projectAgentOverrides[projectId][agentId] = normalizedOverride;
      }
    }
  }

  const selectedProjectId = state.settings?.selectedProjectId || null;
  const selectedScope =
    state.settings?.selectedAgentScope === 'project' && selectedProjectId ? 'project' : 'global';
  if (selectedScope === 'project' && selectedProjectId) {
    for (const agentId of allAgentIdsFromProfiles(state.agentProfiles)) {
      const effective = effectiveAgentProfile(state, agentId, selectedProjectId);
      const paths = getAgentMarkdownPaths(agentId, {
        scope: 'project',
        projectId: selectedProjectId,
      });
      await ensureMarkdownFile(paths.identityPath, effective.identity);
      await ensureMarkdownFile(paths.soulPath, effective.soulMd);
    }
  }

  return state;
}

// importAgentMarkdownFiles moved to src/state/markdownSync.js in Phase 7d-5α-A1 commit 8.


// primeAgentMarkdownFiles moved to src/state/markdownSync.js in Phase 7d-5α-A1 commit 8 (private helper).


// queueAgentMarkdownPrime moved to src/state/markdownSync.js in Phase 7d-5α-A1 commit 8.



// normalizeAgentProfiles / dedupeAgentChannelTokenOwners / normalizeAgentOverride /
// normalizeProjectAgentOverrides moved to `src/state/agentProfiles.js` in
// Phase 10a. Re-imported at the top of this file.

// agentPresetById moved to `src/services/agent/agentLibrary.js` in Phase 9m.
// Re-imported at the top of this file.

// normalizeApproval / normalizeApprovals were extracted to
// `src/services/approval/approvalService.js` in Phase 8.

// normalizeExternalToolRuns and normalizePromptHistory were extracted to
// `src/services/activity/activityLog.js` in Phase 9a.

// createDefaultState moved to src/state/stateHydration.js in Phase 7d-5α-A1 (commit 7/9).


// ensureParentDir moved to `src/services/agent/markdownFiles.js` in Phase 9j
// as a private helper — its only callers (ensureMarkdownFile, writeMarkdownFile)
// were extracted alongside it.

// recoverLeadingJsonObject / parseStatePayload moved to
// `src/state/statePayload.js` in Phase 10b. Re-imported at the top of
// this file.

// hydrateState moved to src/state/stateHydration.js in Phase 7d-5α-A1 (commit 7/9).


/**
 * Merge disk-resident skills (~/.melo/desktop/skills/<id>/SKILL.md) into
 * state.settings.customSkills. Disk is authoritative: if an id collides
 * with a JSON-persisted skill, the disk copy wins and `origin` is flipped
 * to 'disk' so UI can render a "managed on disk" affordance. Disk read
 * failures are swallowed (we log once per load) so a broken SKILL.md can
 * never brick desktop startup.
 */
// mergeDiskSkillsIntoState moved to src/state/diskSkills.js in
// Phase 7d-5α-A1 (commit 6/9). Re-imported at the top of this file.

// readStateSnapshot moved to src/state/stateStore.js in Phase 7d-5α-A1 commit 9.


// Phase 7d-5α: exposed for the future chatGraphRunner extraction.
// The body is unchanged — only the `export` keyword was added so other
// modules can call into the state machine without circular imports
// through desktopStore. See CLAUDE.md §5 (byte-for-byte rule).
// loadState moved to src/state/stateStore.js in Phase 7d-5α-A1 commit 9.



// persistStateAtomically moved to src/state/stateStore.js in Phase 7d-5α-A1 commit 9.



// Phase 7d-5α: exposed for the future chatGraphRunner extraction. Body
// unchanged.
// saveState moved to src/state/stateStore.js in Phase 7d-5α-A1 commit 9.


// updateStateAtomically moved to `src/state/stateStore.js` in Phase
// 7d-5δ commit 8b. The §5 carve-out (it lived here because it called
// ensureSelectedEntities, which had 58 callers) was retired by commit
// 8a moving ensureSelectedEntities out. Re-imported above.


// sortChats / summarizeChat / summarizeMessagePreview / describeChatForLimit
// moved to `src/state/conversation.js` in Phase 10c. Re-imported at the top
// of this file.

// summarizeAttachmentsForPrompt moved to src/services/chat/messageBuilder.js
// in Phase 7d-1 and re-imported at the top. Kept in the import block
// (not the local function table) so both messageTextForContext here and
// messageToModelContent in the service can share one implementation.

// messageTextForContext moved to src/state/chatThreadContext.js in
// Phase 7d-5α-A1 (commit 3/9). Re-imported at the top of this file.

function uniqueMemoryLines(values = [], limit = MAX_CONTEXT_MEMORY_ITEMS) {
  const seen = new Set();
  const lines = [];

  for (const value of values) {
    const normalized = normalizeConversationSnippet(value, 220);
    const comparable = normalizeComparablePhrase(normalized);
    if (!normalized || !comparable || seen.has(comparable)) {
      continue;
    }

    seen.add(comparable);
    lines.push(normalized);
    if (lines.length >= limit) {
      break;
    }
  }

  return lines;
}

function findLatestClarificationState(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.role !== 'assistant') {
      continue;
    }

    const assistantText = normalizeConversationSnippet(messageTextForContext(candidate), 360);
    if (!isLikelyClarificationPrompt(assistantText)) {
      continue;
    }

    const sourceUser = [...messages.slice(0, index)]
      .reverse()
      .find(message => message.role === 'user');

    return {
      assistantText,
      sourceText: normalizeConversationSnippet(messageTextForContext(sourceUser), 220),
      options: extractClarificationOptions(messageTextForContext(candidate)),
    };
  }

  return null;
}

// normalizeConversationSnippet / normalizeComparablePhrase /
// isLikelyClarificationPrompt / isLikelyContextDependentReply /
// extractClarificationOptions / findClarificationOptionMatch — pass-through
// wrappers removed in Phase 9g. All six functions are now imported directly
// from `./memory/heuristics.js` near the top of this file; their signatures
// and default-argument values match, so removing the wrappers is a no-op.

// buildThreadMemorySummary moved to src/state/stateHydration.js in Phase 7d-5α-A1 (commit 7/9).


// refreshChatMemorySummary moved to `src/state/chatThreadContext.js` in
// Phase 7d-5δ commit 8c (byte-for-byte append to the same module that
// already housed its two upstream deps).

export function buildConversationContinuityContext(chat, latestUserMessage = '') {
  return renderStructuredConversationContinuityContext(
    ensureChatThreadContext(chat, latestUserMessage),
  );
}


// messageToModelContent moved to src/services/chat/messageBuilder.js in
// Phase 7d-1. summarizeAttachmentsForPrompt moved with it (kept as a
// re-imported symbol above so messageTextForContext still compiles).

// summarizeArtifact was extracted to
// `src/services/artifact/artifactService.js` in Phase 7b.

// summarizeProject was extracted to `src/services/project/projectService.js`
// in Phase 9c and is imported at the top of this file.

// summarizeTask / summarizeApproval were extracted to the task / approval
// service modules in Phase 8.

// summarizeAgentProfile moved to `src/state/desktopBootstrap.js`
// in Phase 7d-5δ commit 8e (cluster-private helper for getDesktopBootstrap).

// buildAgentProfiles moved to `src/state/desktopBootstrap.js`
// in Phase 7d-5δ commit 8e (cluster-private helper for getDesktopBootstrap).

// summarizeAgentPrompt moved to src/services/chat/systemPrompt.js in Phase 7d-2.


// projectAgentOverrideFor + effectiveAgentProfile moved to
// `src/state/agentProfiles.js` in Phase 7d-5δ commit 5. Re-imported at
// the top of this file alongside normalizeAgentProfile.

// MAX_SKILL_* caps, SUSPICIOUS_SKILL_PROMPT_PATTERN, normalizeCustomSkill,
// normalizeSkillParametersSchema, normalizeBuiltinSkill, buildSkills, and
// listExecutableSkills were extracted to
// `src/services/skill/skillService.js` in Phase 9b. They are imported at
// the top of this file and the three public names (normalizeCustomSkill,
// buildSkills, listExecutableSkills) are re-exported there so existing
// consumers that still import from desktopStore keep working.

// commandTemplateDescriptor moved to
// `src/services/command/commandTemplates.js` in Phase 7d-5γ. Re-imported
// at the top of this file.

// Phase 7d-5α-A1 commit 9 cleanup: cec12c3 had added `export` here under
// the assumption a future chatGraphRunner would import findProjectById
// directly from desktopStore. Codex review C-grade established that
// pattern would re-introduce a cycle (desktopStore → runner → desktopStore).
// Removed the keyword; if/when the runner moves, findProjectById should
// either be passed via deps or moved to a state module first.
// findProjectById / findExternalConnectorById / findTaskById /
// findApprovalById moved to `src/state/stateLookups.js` in Phase 7d-5δ
// commit 2. Re-imported at the top of this file alongside the other
// state-machine helpers.

// externalConnectorUrl / requestExternalConnectorJson /
// refreshExternalConnectorStatus / fetchExternalConnectorContext /
// readExternalConnectorResourcePayload / readExternalConnectorPromptPayload
// were extracted to `src/services/connector/externalConnector.js` in Phase 3.

// readWorkspaceFile / writeWorkspaceFile / listWorkspaceEntries were
// extracted to `src/services/workspace/workspaceFiles.js` in Phase 7a.

// buildWorkspaceSnapshot moved to
// `src/services/workspace/workspaceSnapshot.js` in Phase 7d-5δ commit 3.
// Re-imported at the top of this file. The local sanitizeWorkspacePath
// wrapper above is intentionally kept (still has another in-module
// caller); the new module has its own byte-identical wrapper.

// taskExecutionPrompt moved to `src/services/task/taskPrompt.js` in
// Phase 7d-5δ commit 4. Re-imported at the top of this file.

// task-domain mutations moved to a sibling leaf in Phase 7d-5ε
// commit 3. Re-exported above.


// buildConnectors moved to `src/services/connector/connectorRollup.js`
// in Phase 7d-5δ commit 8c. APP_ROOT is recomputed inside the new
// module via deeper dirname (same precedent as workspaceSnapshot.js).

// buildProfile moved to `src/state/desktopBootstrap.js`
// in Phase 7d-5δ commit 8e (cluster-private helper for getDesktopBootstrap).

// generateChatTitle / summarizeProviderFailureDetails /
// formatProviderFailureMessage were extracted to
// `src/services/chat/providerErrors.js` in Phase 9h of the desktopStore
// refactor. See _refactor-backup/REFACTOR_PLAN.md. Consumers continue to
// use the imports near the top of this file; the re-export of
// formatProviderFailureMessage keeps the existing test import working.

// Phase 7d-5α-A1 commit 9 cleanup: same as findProjectById above —
// cec12c3 added `export` here for the future runner; Codex review made
// clear that doesn't break the cycle. Removed.
// ensureSelectedEntities moved to `src/state/stateSelections.js` in
// Phase 7d-5δ commit 8a. Re-imported at the top of this file.

// sortSearchItems / buildFeatureSearchEntries / buildRecentSearchSuggestions
// / buildChatThreadSearchEntry / buildChatMessageSearchEntry /
// buildMemorySearchItem / buildSearchResults all moved to
// `src/services/search/searchResultsBuilder.js` in Phase 7d-5δ
// commit 8d. Only buildSearchResults is exported (re-imported above);
// the others were cluster-private and shipped together.

// Search orchestration was extracted to src/services/search/searchService.js
// in Phase 7a. The wrappers below only inject the project/workspace resolver
// (which still needs desktopStore's state cache); all search logic — caps,
// ENOENT handling, the back-compat line-level adapter — lives in the service.
// New callers outside desktopStore should import from the service directly.
async function resolveWorkspaceForSearch(projectId) {
  const state = ensureSelectedEntities(await loadState());
  const project = findProjectById(state, projectId || state.settings.selectedProjectId);
  const workspace = await buildWorkspaceSnapshot(state, project);
  return { project, workspace };
}

export async function streamSearchFileGroups(
  query = '',
  projectId = '',
  onGroup = async () => {},
) {
  return streamSearchFileGroupsService(query, projectId, onGroup, {
    resolveWorkspace: resolveWorkspaceForSearch,
  });
}

export async function streamSearchFileHits(
  query = '',
  projectId = '',
  onHit = async () => {},
) {
  return streamSearchFileHitsService(query, projectId, onHit, {
    resolveWorkspace: resolveWorkspaceForSearch,
  });
}

function createChatRecord({ mode, projectId, agentId }) {
  const timestamp = nowIso();
  return {
    id: randomUUID(),
    title: 'New chat',
    mode,
    projectId: projectId || null,
    agentId: agentId ? normalizeAgentStorageId(agentId) : 'main',
    source: 'desktop',
    externalThreadKey: '',
    locked: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    memorySummary: '',
    messages: [],
  };
}

// resolveTelegramFileAttachment / extractTelegramAttachments /
// buildTelegramThreadKey / latestProcessableTelegramText were extracted to
// `src/services/remote/telegramParsing.js` in Phase 5c.

// stripTelegramBotMention / hasTelegramInvokePrefix / escapeTelegramAliasRegex
// / collectTelegramBotAliases / containsTelegramBotAlias were extracted to
// `src/services/remote/telegramAddressHelpers.js` in Phase 5b.
//
// FOLLOW_UP_WINDOW_MS / computeFollowUpScore / isLikelyTelegramFollowUpToBot
// / detectImplicitAddress / IMPLICIT_{REQUEST,IMPERATIVE,AT_OTHERS}_RE were
// extracted to `src/services/remote/replyScoreSignals.js` in Phase 4.

// TELEGRAM_SIGNAL_WEIGHTS / REPLY_SCORE_THRESHOLD / GRAY_ZONE_MIN /
// buildTelegramReplyScore were extracted to
// `src/services/remote/telegramReplyScore.js` in Phase 5d.

// classifyGroupMessageAddressal was extracted to
// `src/services/remote/groupAddressalClassifier.js` in Phase 6d.

/**
 * Async routing gate — replaces the previous sync version.
 *
 * Score tiers:
 *   ≥ 0.55  → reply (pass)
 *   0.30–0.55 → LLM classifier (gray zone)
 *   < 0.30  → no reply (reject)
 */
async function shouldReplyToTelegramMessage(incoming, telegramChannel, profile, recentChat, config) {
  if (
    !incoming?.chatId ||
    (!String(incoming?.text || '').trim() && !normalizeMessageAttachments(incoming?.attachments).length)
  ) {
    return false;
  }

  if (incoming.chatType === 'private') {
    return true;
  }

  const { signals, totalScore } = buildTelegramReplyScore(
    incoming, telegramChannel, profile, recentChat,
  );

  let decision;
  let method = 'score';

  if (totalScore >= REPLY_SCORE_THRESHOLD) {
    decision = true;
  } else if (totalScore < GRAY_ZONE_MIN) {
    decision = false;
  } else {
    // Gray zone: call LLM classifier
    method = 'llm';
    decision = await classifyGroupMessageAddressal(incoming, recentChat, config, profile);
  }

  if (process.env.MELO_TG_DEBUG === '1') {
    process.stdout.write(
      `[tg-route] sender=${incoming?.senderName || 'unknown'} ` +
      `text="${String(incoming?.text || '').slice(0, 60)}" ` +
      `score=${totalScore.toFixed(2)} method=${method} reply=${decision} ` +
      `signals=${JSON.stringify(signals)}\n`,
    );
  }

  return decision;
}

async function ensureTelegramChatRecord(agentId, incoming) {
  const state = ensureSelectedEntities(await loadState());
  const externalThreadKey = buildTelegramThreadKey(
    agentId,
    incoming?.chatId,
    incoming?.messageThreadId,
  );
  const existingChat = state.chats.find(chat => chat.externalThreadKey === externalThreadKey);
  if (existingChat) {
    let needsSave = false;
    if (existingChat.chatType !== (incoming?.chatType || existingChat.chatType)) {
      existingChat.chatType = incoming?.chatType || existingChat.chatType;
      needsSave = true;
    }
    if ((incoming?.chatTitle || '') !== existingChat.chatTitle) {
      existingChat.chatTitle = incoming?.chatTitle || '';
      needsSave = true;
    }
    if (
      (incoming?.messageThreadId || null) !==
      (existingChat.messageThreadId || null)
    ) {
      existingChat.messageThreadId = incoming?.messageThreadId || null;
      needsSave = true;
    }
    if (needsSave) {
      existingChat.updatedAt = nowIso();
      await saveState(state);
    }
    return existingChat;
  }

  const chat = {
    ...createChatRecord({
      mode: 'chat',
      projectId: null,
    }),
    title: generateChatTitle(incoming?.text || ''),
    agentId: normalizeAgentStorageId(agentId),
    source: 'telegram',
    chatType: incoming?.chatType || 'private',
    chatTitle: incoming?.chatTitle || '',
    messageThreadId: incoming?.messageThreadId || null,
    externalThreadKey,
  };
  state.chats.unshift(chat);
  await saveState(state);
  return chat;
}

async function recordTelegramMessageWithoutReply(agentId, incoming, existingChat = null) {
  const [config, rawState] = await Promise.all([getResolvedConfig(), loadState()]);
  const state = ensureSelectedEntities(rawState);
  const chat = normalizeChat(existingChat || (await ensureTelegramChatRecord(agentId, incoming)));
  const currentChat = state.chats.find(entry => entry.id === chat.id);
  if (!currentChat) {
    return null;
  }

  const userMessage = {
    id: randomUUID(),
    role: 'user',
    content: incoming?.text || '',
    blocks: normalizeMessageBlocks([], incoming?.text || ''),
    attachments: normalizeMessageAttachments(incoming?.attachments),
    extractedMedia: [],
    createdAt: incoming?.receivedAt || nowIso(),
    senderId: incoming?.senderId || null,
    senderName: incoming?.senderName || null,
    senderUsername: incoming?.senderUsername || null,
    // Tag as bystander so system prompt builder can inject group context
    meta: { bystanderMessage: true },
  };
  await enrichMessageWithMediaContext(userMessage, {
    config,
    modelSupportsVision: false,
  });
  currentChat.messages.push(userMessage);
  currentChat.updatedAt = nowIso();
  currentChat.chatType = incoming?.chatType || currentChat.chatType;
  currentChat.chatTitle = incoming?.chatTitle || currentChat.chatTitle;
  currentChat.messageThreadId = incoming?.messageThreadId || currentChat.messageThreadId || null;
  if (!currentChat.title || currentChat.title === 'New chat') {
    currentChat.title = generateChatTitle(incoming?.text || summarizeMessagePreview(userMessage));
  }

  // Update group relationship graph — this person is NOT addressing the bot
  updateGroupRelationshipGraph(currentChat, incoming, false);

  refreshChatMemorySummary(currentChat);
  await saveState(state);
  return currentChat;
}

// ─── Group relationship graph (Plan C) ───────────────────────────────────────

/**
 * Update the lightweight group relationship graph stored on the chat object.
 * Called whenever a group message arrives, regardless of whether the bot replies.
 *
 * chat.groupGraph shape:
 * {
 *   [senderId]: {
 *     name: string,
 *     username: string,
 *     messageCount: number,
 *     botAddressCount: number,   // messages that triggered a bot reply
 *     otherAddressCount: number, // messages that did NOT trigger a bot reply
 *     lastSeenAt: iso string,
 *     recentTopics: string[],    // last 5 short topic snippets (first 60 chars)
 *     frequentPartners: string[] // up to 3 other senderIds this person interacts with
 *   }
 * }
 *
 * @param {Object} chat           - chat record (mutated in place)
 * @param {Object} incoming       - incoming Telegram message metadata
 * @param {boolean} addressedToBot - whether this message triggered a bot reply
 */
// updateGroupRelationshipGraph / buildGroupRelationshipSummary /
// collectBystanderContext / collectKnownTelegramParticipants were extracted
// to `src/services/remote/groupRelationship.js` in Phase 9f of the
// desktopStore refactor. See _refactor-backup/REFACTOR_PLAN.md. Consumers
// continue to use the imports near the top of this file.

export async function testAgentChannelConnection(agentId, channelId, patch = {}, options = {}) {
  const state = ensureSelectedEntities(await loadState());
  const normalizedAgentId = normalizeAgentStorageId(agentId) || 'main';
  const scope = options.scope === 'project' && options.projectId ? 'project' : 'global';
  const profile = effectiveAgentProfile(
    state,
    normalizedAgentId,
    scope === 'project' ? options.projectId : null,
  );
  const currentChannel = normalizeAgentChannels(profile.channels)?.[channelId];
  if (!currentChannel) {
    throw new Error(`Unknown channel: ${channelId}`);
  }

  // Sanitize the incoming patch: for secret/ID fields (botToken, botUsername,
  // guildId, channelId, chatId, nicknames), treat a blank string the same as
  // "not provided" — i.e. keep the current value. The UI's "Test connection"
  // button may post a partially-filled form (user only pasted the new token
  // and left other fields empty); without this guard the test would overwrite
  // the persisted guildId / channelId with empty strings. See
  // feedback_preserve_user_config.md.
  const SECRET_LIKE_KEYS = [
    'botToken',
    'botUsername',
    'guildId',
    'channelId',
    'chatId',
    'nicknames',
  ];
  const safePatch = { ...patch };
  for (const key of SECRET_LIKE_KEYS) {
    const v = safePatch[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !v.trim()) {
      delete safePatch[key];
    }
  }

  const nextChannel = normalizeAgentChannel(channelId, {
    ...currentChannel,
    ...safePatch,
    enabled:
      typeof safePatch?.enabled === 'boolean' ? safePatch.enabled : currentChannel.enabled,
  });
  const checkedAt = nowIso();
  let runtimeChannel = {
    ...nextChannel,
    lastCheckedAt: checkedAt,
  };

  try {
    if (channelId === 'telegram') {
      const result = await pingTelegramChannel(nextChannel);
      runtimeChannel = {
        ...runtimeChannel,
        botUsername:
          typeof result?.result?.username === 'string' && result.result.username.trim()
            ? result.result.username.trim()
            : nextChannel.botUsername,
        lastStatus: 'connected',
        lastError: '',
      };
    } else if (channelId === 'discord') {
      const result = await pingDiscordChannel(nextChannel);
      runtimeChannel = {
        ...runtimeChannel,
        botUsername:
          typeof result?.username === 'string' && result.username.trim()
            ? result.username.trim()
            : nextChannel.botUsername,
        lastStatus: 'connected',
        lastError: '',
      };
    } else {
      runtimeChannel = {
        ...runtimeChannel,
        lastStatus: nextChannel.enabled ? 'connected' : 'idle',
        lastError: '',
      };
    }
  } catch (error) {
    runtimeChannel = {
      ...runtimeChannel,
      lastStatus: 'error',
      lastError: error.message || String(error),
    };
  }

  return updateAgentProfile(
    normalizedAgentId,
    {
      channels: {
        ...profile.channels,
        [channelId]: runtimeChannel,
      },
    },
    {
      scope,
      projectId: options.projectId,
      activeView: 'agent',
    },
  );
}

export async function processTelegramPollingCycle() {
  const state = ensureSelectedEntities(await loadState());
  const agentIds = allAgentIdsFromProfiles(state.agentProfiles);
  let hasActiveChannel = false;
  let processedUpdateCount = 0;
  let encounteredError = false;
  const cycleId = nextTelegramCycleId();

  for (const agentId of agentIds) {
    const profile = normalizeAgentProfile(agentId, state.agentProfiles?.[agentId]);
    const telegramChannel = normalizeAgentChannels(profile.channels)?.telegram;
    if (!telegramChannel?.enabled || !telegramChannel.botToken) {
      continue;
    }
    hasActiveChannel = true;
    // Offline-backlog detection must run BEFORE we stamp a fresh lastPolledAt
    // onto runtimeChannel — otherwise the comparison would always be ~0ms.
    const isBacklogCycle = isBacklogPollCycle(telegramChannel);
    writeTelegramDebugLine(
      `[tg-cycle] start cycle=${cycleId} agent=${agentId} username=${telegramChannel.botUsername || ''} ` +
        `persistedLastUpdateId=${telegramChannel.lastUpdateId || 0} ` +
        `backlogCycle=${isBacklogCycle}`,
    );

    const runtimeChannel = {
      ...telegramChannel,
      lastCheckedAt: nowIso(),
      lastPolledAt: nowIso(),
    };

    // Ensure botUsername is populated (needed for @mention detection in groups)
    if (!runtimeChannel.botUsername) {
      try {
        const meResult = await pingTelegramChannel(telegramChannel);
        if (meResult?.result?.username) {
          runtimeChannel.botUsername = meResult.result.username.trim();
        }
      } catch {}
    }

    try {
      const updatePayload = await fetchTelegramUpdatesFromApi(telegramChannel, TELEGRAM_POLL_LIMIT);
      const updates = Array.isArray(updatePayload?.result) ? updatePayload.result : [];
      writeTelegramDebugLine(
        `[tg-cycle] fetched cycle=${cycleId} agent=${agentId} count=${updates.length} ` +
          `update_ids=${updates.map(u => u?.update_id).join(',')}`,
      );
      runtimeChannel.lastStatus = 'connected';
      runtimeChannel.lastError = '';
      if (updates.length) {
        runtimeChannel.lastUpdateId = Math.max(
          Number(runtimeChannel.lastUpdateId || 0),
          ...updates.map(update => Number(update?.update_id || 0)),
        );
      }
      processedUpdateCount += updates.length;

      for (const update of updates) {
        const incoming = await latestProcessableTelegramText(update, telegramChannel);
        if (
          !incoming?.chatId ||
          (!String(incoming?.text || '').trim() &&
            !normalizeMessageAttachments(incoming?.attachments).length)
        ) {
          continue;
        }

        runtimeChannel.lastIncomingAt = incoming.receivedAt || nowIso();
        runtimeChannel.lastIncomingPreview =
          incoming.text ||
          summarizeMessagePreview({
            attachments: incoming.attachments,
            blocks: [],
            content: '',
          });
        runtimeChannel.lastRemoteChatId = incoming.chatId;
        const recentChat = await ensureTelegramChatRecord(agentId, incoming);

        // Offline backlog filter — see OFFLINE_BACKLOG_THRESHOLD_MS doc. Only
        // runs when the runtime was offline long enough that the fetched
        // updates look like a catch-up sweep rather than live traffic.
        if (isBacklogCycle) {
          const tgBotUsernameLower = String(telegramChannel?.botUsername || '')
            .trim().replace(/^@+/, '').toLowerCase();
          const passes = passesOfflineBacklogFilter({
            incoming,
            recentChat,
            mentionPredicate: msg => {
              if (!tgBotUsernameLower) return false;
              return String(msg?.text || '')
                .toLowerCase()
                .includes(`@${tgBotUsernameLower}`);
            },
          });
          if (!passes) {
            writeTelegramDebugLine(
              `[tg-cycle] backlog-skip cycle=${cycleId} agent=${agentId} ` +
                `update_id=${update?.update_id} chat_id=${incoming.chatId} ` +
                `sender=${incoming.senderName || 'unknown'} ` +
                `reason=no-mention-no-reply-no-recent-bot-context`,
            );
            await recordTelegramMessageWithoutReply(agentId, incoming, recentChat);
            continue;
          }
        }

        // shouldReplyToTelegramMessage is now async (may call LLM gray-zone classifier)
        const config = await getResolvedConfig();
        const shouldReply = await shouldReplyToTelegramMessage(
          incoming,
          telegramChannel,
          profile,
          recentChat,
          config,
        );

        if (!shouldReply) {
          await recordTelegramMessageWithoutReply(agentId, incoming, recentChat);
          continue;
        }

        await telegramApiRequest(telegramChannel, 'sendChatAction', {
          body: {
            chat_id: incoming.chatId,
            action: 'typing',
          },
          timeoutMs: 10000,
        }).catch(() => null);

        const result = await sendChatMessage({
          chatId: recentChat.id,
          content: incoming.text,
          mode: recentChat.mode,
          attachments: incoming.attachments || [],
          background: true,
          skipBootstrap: true,
          channelContext: {
            channelId: 'telegram',
            remoteChatId: incoming.chatId,
            chatType: incoming.chatType,
            senderId: incoming.senderId,
            senderName: incoming.senderName,
            senderUsername: incoming.senderUsername,
            isReplyToBot: incoming.isReplyToBot,
            repliedToText: incoming.repliedToText,
          },
        });

        // Update group relationship graph — this person WAS addressing the bot
        if (incoming.chatType === 'group' || incoming.chatType === 'supergroup') {
          await updateStateAtomically(s => {
            const targetChat = s.chats?.find(c => c.id === recentChat.id);
            if (targetChat) updateGroupRelationshipGraph(targetChat, incoming, true);
          });
        }

        const replyText = renderTelegramTransportText(result?.assistantMessage);
        if (!replyText) {
          continue;
        }

        // Determine voice reply eligibility early so we can start rewrite in parallel
        const ttsConfig = await getResolvedConfig();
        const agentVoiceMode = profile?.voiceReplyMode || 'summary';
        const shouldVoiceReply =
          agentVoiceMode !== 'off' && (telegramChannel.voiceReply || incoming.wasVoiceMessage);

        // Fire off voice rewrite in parallel — it runs while the text reply is being sent.
        // 'summary' mode: concise oral summary; 'full' mode: read original text as-is.
        const voiceRewritePromise = shouldVoiceReply
          ? (agentVoiceMode === 'full'
              ? Promise.resolve(replyText)
              : rewriteForVoice(replyText, ttsConfig, profile?.voicePersonality || '', incoming?.senderName || '').catch(() => replyText))
          : null;

        writeTelegramDebugLine(
          `[tg-send] text-begin cycle=${cycleId} agent=${agentId} update_id=${update?.update_id} ` +
            `chat_id=${incoming.chatId} reply_to=${incoming.messageId || ''} len=${replyText.length}`,
        );
        let sentText = null;
        try {
          sentText = await telegramApiRequest(telegramChannel, 'sendMessage', {
            body: {
              chat_id: incoming.chatId,
              text: replyText,
              message_thread_id: incoming.messageThreadId || undefined,
              reply_to_message_id: incoming.messageId || undefined,
            },
          });
          writeTelegramDebugLine(
            `[tg-send] text-ok cycle=${cycleId} agent=${agentId} update_id=${update?.update_id} ` +
              `chat_id=${incoming.chatId} out_message_id=${sentText?.result?.message_id || ''}`,
          );
        } catch (sendErr) {
          writeTelegramDebugLine(
            `[tg-send] text-error cycle=${cycleId} agent=${agentId} update_id=${update?.update_id} ` +
              `message=${String(sendErr?.message || sendErr).slice(0, 180)}`,
          );
          throw sendErr;
        }
        runtimeChannel.lastReplyAt = nowIso();
        runtimeChannel.lastReplyPreview = replyText;

        // Image attachments: forward any image the assistant embedded in its
        // reply (e.g. from the image-generation tool). We already sent the
        // text portion above; the photos arrive as separate sendPhoto calls
        // so we don't hit Telegram's 1024-char caption limit.
        //
        // Each attachment is loaded via attachmentBytes.js — that module takes
        // the fast path (signed workspace URL → local readFile) when the URL
        // was minted by this same process, or falls back to HTTP fetch. We
        // swallow per-attachment errors so a single bad URL doesn't bork the
        // whole poll cycle.
        const imageAttachments = Array.isArray(result?.assistantMessage?.attachments)
          ? result.assistantMessage.attachments.filter(a => a && a.kind === 'image' && a.url)
          : [];
        for (const attachment of imageAttachments) {
          try {
            const bytes = await loadAttachmentBytes(attachment, { timeoutMs: 30_000 });
            if (!bytes) continue;
            writeTelegramDebugLine(
              `[tg-send] photo-begin cycle=${cycleId} agent=${agentId} update_id=${update?.update_id} ` +
                `chat_id=${incoming.chatId} bytes=${bytes.buffer?.length || 0} mime=${bytes.mimeType}`,
            );
            const sentPhoto = await sendTelegramPhotoReply(telegramChannel, incoming, bytes.buffer, {
              mimeType: bytes.mimeType,
              fileName: bytes.fileName,
            });
            writeTelegramDebugLine(
              `[tg-send] photo-ok cycle=${cycleId} agent=${agentId} update_id=${update?.update_id} ` +
                `chat_id=${incoming.chatId} out_message_id=${sentPhoto?.result?.message_id || ''}`,
            );
          } catch (imgErr) {
            process.stderr.write(`[tg-photo-reply] error: ${imgErr?.message || imgErr}\n`);
            writeTelegramDebugLine(
              `[tg-send] photo-error cycle=${cycleId} agent=${agentId} update_id=${update?.update_id} ` +
                `url=${String(attachment.url).slice(0, 120)} message=${String(imgErr?.message || imgErr).slice(0, 180)}`,
            );
          }
        }

        // Voice reply: synthesize TTS with the rewritten spoken-form text.
        if (shouldVoiceReply) {
          try {
            const voiceText = await voiceRewritePromise;
            process.stderr.write(`[tg-voice] voiceText="${String(voiceText||'').slice(0,120)}"\n`);
            const { synthesizeSpeech } = await import('./tts.js');
            const agentVoiceId = profile?.minimaxVoiceId || '';
            const agentEdgeVoice = profile?.edgeTtsVoice || '';
            const agentTtsConfig = { ...ttsConfig };
            if (agentVoiceId) agentTtsConfig.minimaxVoiceId = agentVoiceId;
            if (agentEdgeVoice) agentTtsConfig.ttsEdgeVoice = agentEdgeVoice;
            if (profile?.ttsSpeed != null) agentTtsConfig.ttsSpeed = profile.ttsSpeed;
            if (profile?.ttsPitch != null) agentTtsConfig.ttsPitch = profile.ttsPitch;
            if (profile?.ttsVol != null) agentTtsConfig.ttsVol = profile.ttsVol;
            const ttsResult = await synthesizeSpeech(
              voiceText,
              agentTtsConfig,
            );
            if (ttsResult?.buffer) {
              writeTelegramDebugLine(
                `[tg-send] voice-begin cycle=${cycleId} agent=${agentId} update_id=${update?.update_id} ` +
                  `chat_id=${incoming.chatId} voice_text_len=${String(voiceText || '').length}`,
              );
              const sentVoice = await sendTelegramAudioReply(telegramChannel, incoming, ttsResult.buffer, ttsResult.mimeType);
              writeTelegramDebugLine(
                `[tg-send] voice-ok cycle=${cycleId} agent=${agentId} update_id=${update?.update_id} ` +
                  `chat_id=${incoming.chatId} out_message_id=${sentVoice?.result?.message_id || ''}`,
              );
            } else {
              process.stderr.write('[tg-voice-reply] TTS synthesis returned null — check TTS config\n');
              writeTelegramDebugLine(
                `[tg-send] voice-skip-null cycle=${cycleId} agent=${agentId} update_id=${update?.update_id}`,
              );
            }
          } catch (e) {
            process.stderr.write(`[tg-voice-reply] error: ${e?.message || e}\n`);
            writeTelegramDebugLine(
              `[tg-send] voice-error cycle=${cycleId} agent=${agentId} update_id=${update?.update_id} ` +
                `message=${String(e?.message || e).slice(0, 180)}`,
            );
          }
        }
      }
    } catch (error) {
      encounteredError = true;
      runtimeChannel.lastStatus = 'error';
      runtimeChannel.lastError = error.message || String(error);
    }

    await updateStateAtomically(latestState => {
      const latestProfile = normalizeAgentProfile(agentId, latestState.agentProfiles?.[agentId]);
      // Preserve whatever the UI may have written into this channel while
      // the poll cycle was in flight (token / guildId / voiceReply edits).
      // Only the runtime fields (lastStatus, lastUpdateId, lastIncoming*,
      // lastReply*) may ride on top of the persisted channel. See
      // feedback_preserve_user_config.md + regression tests in
      // desktopStore.updateAgentProfile.test.js.
      const persistedTelegram =
        normalizeAgentChannels(latestProfile.channels)?.telegram;
      const mergedTelegram = mergeChannelRuntimeFields(
        persistedTelegram,
        runtimeChannel,
      );
      latestState.agentProfiles = normalizeAgentProfiles({
        ...latestState.agentProfiles,
        [agentId]: {
          ...latestProfile,
          channels: {
            ...latestProfile.channels,
            telegram: mergedTelegram,
          },
        },
      });
      return latestState;
    });
    writeTelegramDebugLine(
      `[tg-cycle] end cycle=${cycleId} agent=${agentId} newLastUpdateId=${runtimeChannel.lastUpdateId || 0} ` +
        `error=${Boolean(encounteredError)}`,
    );
  }

  return {
    hasActiveChannel,
    processedUpdateCount,
    encounteredError,
  };
}

// ─── Discord runtime ──────────────────────────────────────────────────────────
// Mirrors the Telegram surface above: REST API helpers, message extraction,
// routing decision, and processDiscordPollingCycle. The scoring heuristics
// (alias match, follow-up, implicit address) reuse the same signal helpers
// where they are platform-agnostic (containsTelegramBotAlias, computeFollowUpScore,
// detectImplicitAddress, updateGroupRelationshipGraph, etc.) to keep parity.

const DISCORD_POLL_LIMIT = 50;

// discordApiBase / buildDiscordUrl / discordApiRequest / pingDiscordChannel
// / fetchDiscordUpdates were extracted to `src/services/remote/discordApi.js`
// in Phase 6a. DISCORD_API_VERSION moved with them (it was internal to the
// HTTP base URL, not used elsewhere).

// buildDiscordThreadKey / normalizeDiscordAttachmentKind /
// extractDiscordAttachments / isDiscordMessageFromBot /
// latestProcessableDiscordMessage / hasDiscordInvokePrefix /
// collectDiscordBotAliases were extracted to
// `src/services/remote/discordParsing.js` in Phase 6b.

// DISCORD_SIGNAL_WEIGHTS / buildDiscordReplyScore were extracted to
// `src/services/remote/discordReplyScore.js` in Phase 6c.

async function shouldReplyToDiscordMessage(
  incoming,
  discordChannel,
  profile,
  recentChat,
  config,
  botUserId = '',
) {
  if (
    !incoming?.chatId ||
    (!String(incoming?.text || '').trim() && !normalizeMessageAttachments(incoming?.attachments).length)
  ) {
    return false;
  }

  if (incoming.chatType === 'private') {
    return true;
  }

  const { signals, totalScore } = buildDiscordReplyScore(
    incoming,
    discordChannel,
    profile,
    recentChat,
    botUserId,
  );

  let decision;
  let method = 'score';

  if (totalScore >= REPLY_SCORE_THRESHOLD) {
    decision = true;
  } else if (totalScore < GRAY_ZONE_MIN) {
    decision = false;
  } else {
    method = 'llm';
    decision = await classifyGroupMessageAddressal(incoming, recentChat, config, profile);
  }

  writeDiscordDebugLine(
    `[dc-route] sender=${incoming?.senderName || 'unknown'} ` +
      `chatType=${incoming?.chatType || 'unknown'} ` +
      `text="${String(incoming?.text || '').slice(0, 60)}" ` +
      `score=${totalScore.toFixed(2)} method=${method} reply=${decision} ` +
      `signals=${JSON.stringify(signals)}`,
  );

  return decision;
}

async function ensureDiscordChatRecord(agentId, incoming) {
  const state = ensureSelectedEntities(await loadState());
  const externalThreadKey = buildDiscordThreadKey(
    agentId,
    incoming?.guildId,
    incoming?.chatId,
  );
  const existingChat = state.chats.find(chat => chat.externalThreadKey === externalThreadKey);
  if (existingChat) {
    let needsSave = false;
    if (existingChat.chatType !== (incoming?.chatType || existingChat.chatType)) {
      existingChat.chatType = incoming?.chatType || existingChat.chatType;
      needsSave = true;
    }
    if ((incoming?.chatTitle || '') !== existingChat.chatTitle) {
      existingChat.chatTitle = incoming?.chatTitle || '';
      needsSave = true;
    }
    if (needsSave) {
      existingChat.updatedAt = nowIso();
      await saveState(state);
    }
    return existingChat;
  }

  const chat = {
    ...createChatRecord({
      mode: 'chat',
      projectId: null,
    }),
    title: generateChatTitle(incoming?.text || ''),
    agentId: normalizeAgentStorageId(agentId),
    source: 'discord',
    chatType: incoming?.chatType || 'private',
    chatTitle: incoming?.chatTitle || '',
    messageThreadId: null,
    externalThreadKey,
  };
  state.chats.unshift(chat);
  await saveState(state);
  return chat;
}

async function recordDiscordMessageWithoutReply(agentId, incoming, existingChat = null) {
  const [config, rawState] = await Promise.all([getResolvedConfig(), loadState()]);
  const state = ensureSelectedEntities(rawState);
  const chat = normalizeChat(existingChat || (await ensureDiscordChatRecord(agentId, incoming)));
  const currentChat = state.chats.find(entry => entry.id === chat.id);
  if (!currentChat) {
    return null;
  }

  const userMessage = {
    id: randomUUID(),
    role: 'user',
    content: incoming?.text || '',
    blocks: normalizeMessageBlocks([], incoming?.text || ''),
    attachments: normalizeMessageAttachments(incoming?.attachments),
    extractedMedia: [],
    createdAt: incoming?.receivedAt || nowIso(),
    senderId: incoming?.senderId || null,
    senderName: incoming?.senderName || null,
    senderUsername: incoming?.senderUsername || null,
    meta: { bystanderMessage: true },
  };
  await enrichMessageWithMediaContext(userMessage, {
    config,
    modelSupportsVision: false,
  });
  currentChat.messages.push(userMessage);
  currentChat.updatedAt = nowIso();
  currentChat.chatType = incoming?.chatType || currentChat.chatType;
  currentChat.chatTitle = incoming?.chatTitle || currentChat.chatTitle;
  if (!currentChat.title || currentChat.title === 'New chat') {
    currentChat.title = generateChatTitle(incoming?.text || summarizeMessagePreview(userMessage));
  }

  updateGroupRelationshipGraph(currentChat, incoming, false);

  refreshChatMemorySummary(currentChat);
  await saveState(state);
  return currentChat;
}

async function sendDiscordReply(channel, incoming, text) {
  const targetChannelId = String(incoming?.chatId || channel?.channelId || '').trim();
  if (!targetChannelId) {
    throw new Error('Discord reply is missing a channelId.');
  }

  const body = { content: String(text || '').slice(0, 2000) };
  if (incoming?.messageId) {
    // Reply semantics — Discord uses message_reference rather than reply_to_message_id.
    body.message_reference = {
      message_id: String(incoming.messageId),
      channel_id: targetChannelId,
      fail_if_not_exists: false,
    };
  }

  return discordApiRequest(channel, `/channels/${encodeURIComponent(targetChannelId)}/messages`, {
    method: 'POST',
    body,
  });
}

/**
 * Send TTS audio as a Discord message attachment.
 *
 * Discord's API accepts audio files as standard attachments via multipart
 * upload — no special "voice message" endpoint is needed for bots on v10
 * because voice-message flag (IS_VOICE_MESSAGE = 1 << 13) is reserved for
 * official clients, so a plain MP3 attachment renders as an in-line audio
 * player for the user, which is what Telegram's sendVoice effectively is
 * on the receiving side. We keep the mime as-is (no ffmpeg transcode — Discord
 * supports MP3/OGG/WAV natively for attachments), matching what the TTS
 * layer already returned.
 */
async function sendDiscordAudioReply(channel, incoming, audioBuffer, mimeType = 'audio/mpeg') {
  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'mp3';
  // Thin wrapper over sendDiscordMediaReply — the multipart convention is
  // shared across audio / image / document, so the heavy lifting lives in
  // the Discord API layer. Error shape (err.status, err.bodyPreview) is
  // preserved by sendDiscordMediaReply.
  return sendDiscordMediaReply(channel, incoming, audioBuffer, {
    mimeType,
    fileName: `reply.${ext}`,
  });
}

export async function processDiscordPollingCycle() {
  const state = ensureSelectedEntities(await loadState());
  const agentIds = allAgentIdsFromProfiles(state.agentProfiles);
  let hasActiveChannel = false;
  let processedUpdateCount = 0;
  let encounteredError = false;
  for (const agentId of agentIds) {
    const profile = normalizeAgentProfile(agentId, state.agentProfiles?.[agentId]);
    const discordChannel = normalizeAgentChannels(profile.channels)?.discord;
    if (
      !discordChannel?.enabled ||
      !discordChannel.botToken ||
      !discordChannel.channelId
    ) {
      // Emit a debug line so the user can tell whether the poller is silently
      // skipping their agent because the config didn't persist. Common root
      // cause: the UI form's channels draft hadn't been saved (fixed in
      // desktop-ui/app.js normalizeChannelsForDraft). Without this log the
      // user sees "no reply" with no clue whether the poll even started.
      writeDiscordDebugLine(
        `[dc-poll] skip agent=${agentId} ` +
          `enabled=${Boolean(discordChannel?.enabled)} ` +
          `hasToken=${Boolean(discordChannel?.botToken)} ` +
          `hasChannelId=${Boolean(discordChannel?.channelId)}`,
      );
      continue;
    }
    hasActiveChannel = true;
    // Offline-backlog detection must run BEFORE we refresh lastPolledAt on
    // the runtimeChannel. See OFFLINE_BACKLOG_THRESHOLD_MS doc.
    const isBacklogCycle = isBacklogPollCycle(discordChannel);
    writeDiscordDebugLine(
      `[dc-poll] start agent=${agentId} channelId=${discordChannel.channelId} ` +
        `lastUpdateId=${discordChannel.lastUpdateId || '(none)'} ` +
        `backlogCycle=${isBacklogCycle}`,
    );

    const runtimeChannel = {
      ...discordChannel,
      lastCheckedAt: nowIso(),
      lastPolledAt: nowIso(),
    };

    // Resolve bot identity once — needed for @mention detection.
    let botUserId = '';
    if (!runtimeChannel.botUsername) {
      try {
        const me = await pingDiscordChannel(discordChannel);
        if (me?.username) {
          runtimeChannel.botUsername = String(me.username).trim();
        }
        if (me?.id) {
          botUserId = String(me.id);
        }
      } catch {}
    } else {
      // Still ping once per cycle to get the id if we haven't cached it.
      try {
        const me = await pingDiscordChannel(discordChannel);
        if (me?.id) {
          botUserId = String(me.id);
        }
      } catch {}
    }

    try {
      const messages = await fetchDiscordUpdatesFromApi(runtimeChannel, DISCORD_POLL_LIMIT);
      runtimeChannel.lastStatus = 'connected';
      runtimeChannel.lastError = '';

      writeDiscordDebugLine(
        `[dc-poll] fetched agent=${agentId} count=${messages.length}`,
      );

      if (messages.length) {
        // Discord message IDs are snowflakes (monotonic strings). Track the highest seen.
        const latestId = messages
          .map(m => String(m?.id || ''))
          .filter(Boolean)
          .reduce((a, b) => (snowflakeGt(b, a) ? b : a), String(runtimeChannel.lastUpdateId || ''));
        if (latestId) {
          runtimeChannel.lastUpdateId = latestId;
        }
      }
      processedUpdateCount += messages.length;

      for (const rawMessage of messages) {
        // Pre-normalization diagnostics. If content is empty on every message,
        // the bot almost certainly lacks the MESSAGE_CONTENT privileged intent
        // (Discord Developer Portal → Bot → Privileged Gateway Intents).
        // Without it the REST API returns content="" for any message the bot
        // wasn't @mentioned in, and Melo silently drops them below.
        {
          const rawContent = String(rawMessage?.content || '');
          writeDiscordDebugLine(
            `[dc-msg] raw id=${rawMessage?.id || '?'} ` +
              `author=${rawMessage?.author?.username || '?'} ` +
              `isBot=${Boolean(rawMessage?.author?.bot)} ` +
              `contentLen=${rawContent.length} ` +
              `attach=${Array.isArray(rawMessage?.attachments) ? rawMessage.attachments.length : 0}`,
          );
        }
        const incoming = await latestProcessableDiscordMessage(rawMessage, runtimeChannel);
        if (
          !incoming?.chatId ||
          (!String(incoming?.text || '').trim() &&
            !normalizeMessageAttachments(incoming?.attachments).length)
        ) {
          writeDiscordDebugLine(
            `[dc-msg] dropped reason=${!incoming ? 'from-bot-or-missing' : 'empty-content'} id=${rawMessage?.id || '?'}`,
          );
          continue;
        }

        runtimeChannel.lastIncomingAt = incoming.receivedAt || nowIso();
        runtimeChannel.lastIncomingPreview =
          incoming.text ||
          summarizeMessagePreview({
            attachments: incoming.attachments,
            blocks: [],
            content: '',
          });
        runtimeChannel.lastRemoteChatId = incoming.chatId;

        const recentChat = await ensureDiscordChatRecord(agentId, incoming);

        // Offline backlog filter — mirror of the Telegram branch. Discord uses
        // message.mentions[] array for @-mention detection instead of raw
        // "@username" text, so the mentionPredicate resolves botUserId against
        // incoming.mentionIds that latestProcessableDiscordMessage captured.
        if (isBacklogCycle) {
          const passes = passesOfflineBacklogFilter({
            incoming,
            recentChat,
            mentionPredicate: msg => {
              if (!botUserId) return false;
              const ids = Array.isArray(msg?.mentionIds) ? msg.mentionIds : [];
              return ids.includes(String(botUserId));
            },
          });
          if (!passes) {
            writeDiscordDebugLine(
              `[dc-poll] backlog-skip agent=${agentId} ` +
                `id=${incoming.messageId || '?'} chat_id=${incoming.chatId} ` +
                `sender=${incoming.senderName || 'unknown'} ` +
                `reason=no-mention-no-reply-no-recent-bot-context`,
            );
            await recordDiscordMessageWithoutReply(agentId, incoming, recentChat);
            continue;
          }
        }

        const config = await getResolvedConfig();

        // ── Voice-channel control commands ────────────────────────────────
        // Short-circuit /join, /leave, 加入语音, 离开语音 etc. before the normal
        // reply pipeline. The voice runtime owns the discord.js Gateway client
        // lifecycle and voice-session mapping; we just hand it the incoming
        // envelope and echo back its short text reply. This path only fires
        // for messages that (a) passed addressal scoring (via buildDiscord
        // ReplyScore — e.g. @mention or invoke prefix) and (b) are a voice
        // command, so random users in group channels can't hijack the bot.
        try {
          const prelimScore = buildDiscordReplyScore(
            incoming, discordChannel, profile, recentChat, botUserId,
          );
          const isBotAddressed =
            prelimScore?.signals?.isReplyToBot ||
            prelimScore?.signals?.mentionUsername ||
            prelimScore?.signals?.invokePrefix ||
            prelimScore?.signals?.aliasMatch ||
            incoming.chatType === 'dm';
          if (isBotAddressed) {
            const voiceRuntime = getDiscordVoiceRuntime();
            const voiceCmd = await voiceRuntime.handleTextCommand({
              incoming, agentId, profile, discordChannel,
              botUserId,
              resolveConfig: getResolvedConfig,
            });
            if (voiceCmd.handled) {
              await sendDiscordReply(runtimeChannel, incoming, voiceCmd.reply || '');
              await recordDiscordMessageWithoutReply(agentId, incoming, recentChat);
              continue; // skip the LLM pipeline for this message
            }
          }
        } catch (voiceCmdErr) {
          writeDiscordDebugLine(
            `[dc-voice] command handler error agent=${agentId} msg=${(voiceCmdErr?.message || String(voiceCmdErr)).slice(0, 200)}`,
          );
        }

        const shouldReply = await shouldReplyToDiscordMessage(
          incoming,
          discordChannel,
          profile,
          recentChat,
          config,
          botUserId,
        );

        if (!shouldReply) {
          await recordDiscordMessageWithoutReply(agentId, incoming, recentChat);
          continue;
        }

        // Typing indicator — Discord supports POST /channels/{id}/typing.
        await discordApiRequest(
          runtimeChannel,
          `/channels/${encodeURIComponent(incoming.chatId)}/typing`,
          { method: 'POST', timeoutMs: 10000 },
        ).catch(() => null);

        const result = await sendChatMessage({
          chatId: recentChat.id,
          content: incoming.text,
          mode: recentChat.mode,
          attachments: incoming.attachments || [],
          background: true,
          skipBootstrap: true,
          channelContext: {
            channelId: 'discord',
            remoteChatId: incoming.chatId,
            chatType: incoming.chatType,
            senderId: incoming.senderId,
            senderName: incoming.senderName,
            senderUsername: incoming.senderUsername,
            isReplyToBot: incoming.isReplyToBot,
            repliedToText: incoming.repliedToText,
          },
        });

        if (incoming.chatType === 'group' || incoming.chatType === 'supergroup') {
          await updateStateAtomically(s => {
            const targetChat = s.chats?.find(c => c.id === recentChat.id);
            if (targetChat) updateGroupRelationshipGraph(targetChat, incoming, true);
          });
        }

        const replyText = renderTelegramTransportText(result?.assistantMessage);
        if (!replyText) {
          continue;
        }

        // Voice reply eligibility — mirrors the Telegram branch:
        //   • triggers when the agent's voiceReplyMode !== 'off' AND
        //     (channel has the voiceReply tick ON) OR (the user's inbound
        //     message was itself a voice/audio payload).
        //   • 'full' mode reads the reply text verbatim; 'summary' rewrites it
        //     into a concise spoken form via rewriteForVoice.
        // Running the rewrite in parallel with the text reply keeps the
        // end-to-end latency close to the pure-text path.
        const discordTtsConfig = await getResolvedConfig();
        const discordVoiceMode = profile?.voiceReplyMode || 'summary';
        const shouldDiscordVoiceReply =
          discordVoiceMode !== 'off' && (runtimeChannel.voiceReply || incoming.wasVoiceMessage);

        // Unconditional decision log — fires on every Discord reply regardless
        // of outcome so the user can diagnose why voice reply did (or did not)
        // fire. Without this line, a "no voice came through" report has no
        // actionable signal: we can't tell whether the checkbox failed to
        // persist, the agent's voice mode is 'off', or the inbound wasn't
        // detected as a voice message.
        writeDiscordDebugLine(
          `[dc-voice-decision] agent=${agentId} ` +
            `voiceReplyMode=${discordVoiceMode} ` +
            `channelVoiceTick=${Boolean(runtimeChannel.voiceReply)} ` +
            `wasVoiceMessage=${Boolean(incoming.wasVoiceMessage)} ` +
            `minimaxVoiceId=${profile?.minimaxVoiceId ? 'set' : 'empty'} ` +
            `edgeTtsVoice=${profile?.edgeTtsVoice ? 'set' : 'empty'} ` +
            `willVoice=${shouldDiscordVoiceReply}`,
        );

        const discordVoiceRewritePromise = shouldDiscordVoiceReply
          ? (discordVoiceMode === 'full'
              ? Promise.resolve(replyText)
              : rewriteForVoice(
                  replyText,
                  discordTtsConfig,
                  profile?.voicePersonality || '',
                  incoming?.senderName || '',
                ).catch(err => {
                  writeDiscordDebugLine(
                    `[dc-voice] rewrite-failed agent=${agentId} fallback=raw ` +
                      `message=${(err?.message || String(err)).slice(0, 200)}`,
                  );
                  return replyText;
                }))
          : null;

        await sendDiscordReply(runtimeChannel, incoming, replyText);
        runtimeChannel.lastReplyAt = nowIso();
        runtimeChannel.lastReplyPreview = replyText;

        // Image attachments — mirror of the Telegram branch: for every image
        // kind on the assistant message, resolve URL → bytes and upload via
        // multipart. Discord renders image attachments inline; no caption
        // needed because the text reply already went out above. Per-
        // attachment errors are logged and swallowed so one bad URL doesn't
        // break the poll cycle.
        const imageAttachments = Array.isArray(result?.assistantMessage?.attachments)
          ? result.assistantMessage.attachments.filter(a => a && a.kind === 'image' && a.url)
          : [];
        for (const attachment of imageAttachments) {
          try {
            const bytes = await loadAttachmentBytes(attachment, { timeoutMs: 30_000 });
            if (!bytes) continue;
            writeDiscordDebugLine(
              `[dc-send] photo-begin agent=${agentId} chat_id=${incoming.chatId} ` +
                `bytes=${bytes.buffer?.length || 0} mime=${bytes.mimeType}`,
            );
            await sendDiscordMediaReply(runtimeChannel, incoming, bytes.buffer, {
              mimeType: bytes.mimeType,
              fileName: bytes.fileName,
            });
            writeDiscordDebugLine(
              `[dc-send] photo-ok agent=${agentId} chat_id=${incoming.chatId} ` +
                `bytes=${bytes.buffer?.length || 0}`,
            );
          } catch (imgErr) {
            process.stderr.write(`[dc-photo-reply] error: ${imgErr?.message || imgErr}\n`);
            writeDiscordDebugLine(
              `[dc-send] photo-error agent=${agentId} chat_id=${incoming.chatId} ` +
                `status=${imgErr?.status || '?'} ` +
                `url=${String(attachment.url).slice(0, 120)} ` +
                `message=${(imgErr?.message || String(imgErr)).slice(0, 200)} ` +
                `body=${(imgErr?.bodyPreview || '').slice(0, 200)}`,
            );
          }
        }

        if (shouldDiscordVoiceReply) {
          try {
            const voiceText = await discordVoiceRewritePromise;
            writeDiscordDebugLine(
              `[dc-voice] agent=${agentId} mode=${discordVoiceMode} ` +
                `trigger=${runtimeChannel.voiceReply ? 'channel-tick' : 'inbound-voice'} ` +
                `textLen=${String(voiceText || '').length} ` +
                `text="${String(voiceText || '').slice(0, 80)}"`,
            );
            const { synthesizeSpeech } = await import('./tts.js');
            const agentVoiceId = profile?.minimaxVoiceId || '';
            const agentEdgeVoice = profile?.edgeTtsVoice || '';
            const agentTtsConfig = { ...discordTtsConfig };
            if (agentVoiceId) agentTtsConfig.minimaxVoiceId = agentVoiceId;
            if (agentEdgeVoice) agentTtsConfig.ttsEdgeVoice = agentEdgeVoice;
            if (profile?.ttsSpeed != null) agentTtsConfig.ttsSpeed = profile.ttsSpeed;
            if (profile?.ttsPitch != null) agentTtsConfig.ttsPitch = profile.ttsPitch;
            if (profile?.ttsVol != null) agentTtsConfig.ttsVol = profile.ttsVol;
            // Surface which TTS backend will actually run — helps distinguish
            // "TTS not configured" from "TTS configured but upload failed".
            const ttsBackend = agentTtsConfig.ttsProvider || agentTtsConfig.ttsBackend || 'default';
            writeDiscordDebugLine(
              `[dc-voice] tts-start agent=${agentId} backend=${ttsBackend} ` +
                `minimaxVoiceId=${agentVoiceId ? 'set' : 'empty'} ` +
                `edgeVoice=${agentEdgeVoice ? 'set' : 'empty'}`,
            );
            const ttsResult = await synthesizeSpeech(voiceText, agentTtsConfig);
            if (ttsResult?.buffer) {
              writeDiscordDebugLine(
                `[dc-voice] tts-ok agent=${agentId} bytes=${ttsResult.buffer?.length || 0} ` +
                  `mime=${ttsResult.mimeType || 'audio/mpeg'}`,
              );
              try {
                await sendDiscordAudioReply(
                  runtimeChannel,
                  incoming,
                  ttsResult.buffer,
                  ttsResult.mimeType,
                );
                writeDiscordDebugLine(
                  `[dc-voice] sent agent=${agentId} bytes=${ttsResult.buffer?.length || 0} ` +
                    `chatId=${incoming.chatId}`,
                );
              } catch (sendErr) {
                // Distinguish upload failures from TTS failures. Include the
                // HTTP status (set by sendDiscordAudioReply) so the user can
                // see 403 vs 404 vs 50035 without hunting through logs.
                writeDiscordDebugLine(
                  `[dc-voice] send-failed agent=${agentId} ` +
                    `status=${sendErr?.status || '?'} ` +
                    `message=${(sendErr?.message || String(sendErr)).slice(0, 200)} ` +
                    `body=${(sendErr?.bodyPreview || '').slice(0, 200)}`,
                );
              }
            } else {
              writeDiscordDebugLine(
                `[dc-voice] tts-null agent=${agentId} — check TTS config ` +
                  `(backend=${ttsBackend}, textLen=${String(voiceText || '').length})`,
              );
            }
          } catch (voiceErr) {
            writeDiscordDebugLine(
              `[dc-voice] error agent=${agentId} message=${(voiceErr?.message || String(voiceErr)).slice(0, 200)}`,
            );
          }
        }
      }
    } catch (error) {
      encounteredError = true;
      runtimeChannel.lastStatus = 'error';
      runtimeChannel.lastError = error.message || String(error);
      // Surface the underlying error so the user can tell "no reply" apart
      // from "invalid token / forbidden channel / network hiccup". Common
      // cases: 401 (bad token), 403 (bot not in guild / missing Read Message
      // History on this channel), 404 (wrong channelId — often a voice
      // channel ID instead of the text channel).
      writeDiscordDebugLine(
        `[dc-poll] error agent=${agentId} message=${(error?.message || String(error)).slice(0, 200)}`,
      );
    }

    await updateStateAtomically(latestState => {
      const latestProfile = normalizeAgentProfile(agentId, latestState.agentProfiles?.[agentId]);
      // Same story as the Telegram writeback above — don't let the poll
      // clobber a UI edit that raced with the cycle. Merge runtime-only
      // fields onto the latest persisted channel.
      const persistedDiscord =
        normalizeAgentChannels(latestProfile.channels)?.discord;
      const mergedDiscord = mergeChannelRuntimeFields(
        persistedDiscord,
        runtimeChannel,
      );
      latestState.agentProfiles = normalizeAgentProfiles({
        ...latestState.agentProfiles,
        [agentId]: {
          ...latestProfile,
          channels: {
            ...latestProfile.channels,
            discord: mergedDiscord,
          },
        },
      });
      return latestState;
    });
  }

  return {
    hasActiveChannel,
    processedUpdateCount,
    encounteredError,
  };
}

// Discord snowflake comparison: numeric string compare works for equal-length
// strings, but snowflakes grow over time — longer string = larger value.
function snowflakeGt(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (!sa) return false;
  if (!sb) return true;
  if (sa.length !== sb.length) return sa.length > sb.length;
  return sa > sb;
}

// Test-only export bundle — keeps the public API clean while letting unit
// tests reach into the pure helpers that don't touch global state.
export const __discordTesting = {
  snowflakeGt,
  hasDiscordInvokePrefix,
  extractDiscordAttachments,
  normalizeDiscordAttachmentKind,
  buildDiscordThreadKey,
  buildDiscordReplyScore,
  collectDiscordBotAliases,
  latestProcessableDiscordMessage,
  isDiscordMessageFromBot,
};

// Offline-backlog filter helpers — shared between Telegram and Discord pollers.
// Exported for direct unit testing (without spinning up a real polling cycle).
export const __offlineBacklogTesting = {
  isBacklogPollCycle,
  recentChatHasBotContext,
  passesOfflineBacklogFilter,
  OFFLINE_BACKLOG_THRESHOLD_MS,
  BACKLOG_CONTEXT_LOOKBACK,
};

// oldestUnlockedChat / pruneExcessChats / assertCanCreateChat moved to
// src/state/chatPruning.js in Phase 7d-5α-A1. Re-imported at the top of
// this file alongside MAX_RECENT_CHATS.

// extractArtifacts was extracted to
// `src/services/artifact/artifactService.js` in Phase 7b.

// summarizeConnectorPrompts moved to
// `src/services/connector/connectorPrompts.js` in Phase 7d-5β.
// summarizeSkillsPrompts moved to `src/services/skill/skillPrompts.js`
// (also re-exported from this file for back-compat). Both byte-for-byte
// ports — see CLAUDE.md §5.

// buildProjectContextSection moved to
// `src/services/project/projectContext.js` in Phase 7d-5β. Re-imported
// at the top of this file.

// summarizeAgentPrompt + buildConversationFormattingRules +
// buildOutputHardConstraints + detectInputLanguage +
// buildLanguageConstraint + buildReActSystemPrompt all moved to
// src/services/chat/systemPrompt.js in Phase 7d-2 (byte-for-byte port,
// CLAUDE.md §5). Imported back at the top of this file for in-module
// callers.


// MODEL_* attachment patterns, RICH_MEDIA_ATTACHMENT_KINDS,
// *_FOLLOW_UP_PATTERN regexes, modelRichMediaAttachments,
// followUpPatternForSourceMessage, shouldCarryForwardRecentMedia,
// mergeRichMediaContextIntoMessage, stripHistoricalRichMediaFromMessage,
// and the buildModelMessagesFromChat entry point all moved to
// src/services/chat/messageBuilder.js in Phase 7d-1. The export is
// re-surfaced from desktopStore through the import alias below so
// server.js and other callers see an identical public API.
// The dead helper `modelImageAttachments` (unused since 2026-02) was
// dropped as part of the same move.


// formatModelMessageForVisionDebug moved to
// `src/services/chat/visionDebug.js` in Phase 7d-5β. Re-imported at the
// top of this file.

// Phase 7d-5δ commit 1: chat-graph action planner cluster — 7 LOCAL
// functions (normalizeGraphNeedle, extractSearchQueryFromMessage,
// planCommandAction, extractConnectorToolInput,
// planExternalConnectorAction, planChatGraphAction, buildApprovalResponse)
// moved to `src/services/chat/chatActionPlanning.js`. Only the two
// cluster-external symbols (planChatGraphAction + buildApprovalResponse)
// are re-imported at the top of this file.

// runChatAgentExecutionGraph moved to
// `src/services/chat/chatExecutionRunner.js` in Phase 7d-5δ commit 7b.
// Re-imported at the top of this file.

// runTaskAgentExecutionGraph moved to
// `src/services/chat/taskExecutionRunner.js` in Phase 7d-5δ commit 6.
// Re-imported at the top of this file.

// buildDynamicContext moved to `src/services/chat/dynamicContext.js` in
// Phase 7d-5β. Re-imported at the top of this file.


// getDesktopBootstrap moved to `src/state/desktopBootstrap.js`
// in Phase 7d-5δ commit 8e (cluster-private helper for getDesktopBootstrap).

/**
 * Initialise MCP servers from user config.
 * Called once at server startup after other systems are ready.
 * Safe to call multiple times (reconnects any disconnected servers).
 */
export async function initMcpServers() {
  try {
    const config = await getResolvedConfig();
    const mcpServers = config.mcpServers || {};
    const flags = {
      enablePlaywrightMcp:  Boolean(config.enablePlaywrightMcp),
      enableBrowserlessMcp: Boolean(config.enableBrowserlessMcp),
    };
    const hasServers = Object.keys(mcpServers).length || flags.enablePlaywrightMcp || flags.enableBrowserlessMcp;
    if (hasServers) {
      const results = await bootstrapMcpServers(mcpServers, flags);
      const connected = Object.entries(results)
        .filter(([, r]) => r.connected)
        .map(([name, r]) => `${name}(${r.toolCount} tools)`)
        .join(', ');
      if (connected) {
        process.stderr.write(`[mcp] Connected: ${connected}\n`);
      }
      const errors = Object.entries(results)
        .filter(([, r]) => !r.connected && r.error !== 'disabled')
        .map(([name, r]) => `${name}: ${r.error}`)
        .join(', ');
      if (errors) {
        process.stderr.write(`[mcp] Failed to connect: ${errors}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`[mcp] Init error: ${err.message}\n`);
  }
}

export async function prepareDesktopLaunchState() {
  const state = ensureSelectedEntities(await loadState());
  state.settings = {
    ...state.settings,
    activeView: 'chat',
    activeMode: 'chat',
    selectedChatId: null,
    selectedFilePath: null,
  };
  await saveState(state);
}

export async function createChat({ mode, projectId, agentId }) {
  const state = ensureSelectedEntities(await loadState());
  assertCanCreateChat(state);
  const chat = createChatRecord({
    mode: mode || state.settings.activeMode,
    projectId: projectId ?? state.settings.selectedProjectId,
    agentId: agentId || null,
  });

  state.chats.unshift(chat);
  state.settings.selectedChatId = chat.id;
  state.settings.activeView = 'chat';
  state.settings.activeMode = chat.mode;
  await saveState(state);

  return getDesktopBootstrap();
}

export async function updateChat(chatId, patch = {}) {
  const state = ensureSelectedEntities(await loadState());
  const chatIndex = state.chats.findIndex(chat => chat.id === chatId);
  if (chatIndex < 0) {
    throw new Error('Chat not found.');
  }

  const currentChat = state.chats[chatIndex];
  state.chats[chatIndex] = {
    ...currentChat,
    locked:
      typeof patch.locked === 'boolean'
        ? patch.locked
        : Boolean(currentChat.locked),
  };

  await saveState(state);
  return getDesktopBootstrap();
}

export async function deleteChat(chatId) {
  const state = ensureSelectedEntities(await loadState());
  const existingChat = state.chats.find(chat => chat.id === chatId);
  if (!existingChat) {
    throw new Error('Chat not found.');
  }

  state.chats = state.chats.filter(chat => chat.id !== chatId);
  if (state.settings.selectedChatId === chatId) {
    state.settings.selectedChatId = null;
  }

  await saveState(state);
  return getDesktopBootstrap();
}

export async function updateDesktopSettings(patch) {
  const state = ensureSelectedEntities(await loadState());
  state.settings = {
    ...state.settings,
    ...patch,
    ...(patch?.promptHistory
      ? { promptHistory: normalizePromptHistory(patch.promptHistory) }
      : {}),
  };
  await saveState(state);
  return getDesktopBootstrap();
}

export async function updateModelConfig(patch = {}) {
  const current = await loadConfig();

  // Protect secret-like settings: a blank string on the inbound patch must be
  // interpreted as "user didn't provide this field" rather than "user wants
  // this cleared". The old behaviour silently wiped apiKey / baseUrl / TTS
  // credentials any time the UI posted a partial form (e.g. MiniMax voice
  // toggle). Explicit clearing still works by passing the authMode that
  // implies the clear (e.g. authMode='codex' clears apiKey). See
  // feedback_preserve_user_config.md.
  const keepIfBlank = (patchVal, currentVal) =>
    typeof patchVal === 'string' && patchVal.trim()
      ? patchVal
      : currentVal;

  const safePatch = { ...patch };
  const SECRET_LIKE_CONFIG_KEYS = [
    'apiKey',
    'baseUrl',
    'whisperApiKey',
    'whisperBaseUrl',
    'minimaxApiKey',
    'minimaxGroupId',
    'minimaxBaseUrl',
    'ttsApiKey',
    'ttsBaseUrl',
    'elevenLabsApiKey',
  ];
  for (const key of SECRET_LIKE_CONFIG_KEYS) {
    if (!(key in safePatch)) continue;
    const v = safePatch[key];
    if (typeof v !== 'string' || !v.trim()) {
      delete safePatch[key];
    }
  }

  await saveConfig({
    ...current,
    ...safePatch,
    modelCatalogs: normalizeModelCatalogs(safePatch.modelCatalogs || current.modelCatalogs || DEFAULT_MODEL_CATALOGS),
    apiKey:
      patch.authMode === 'codex'
        ? ''
        : keepIfBlank(safePatch.apiKey, current.apiKey),
    // Preserve existing whisper key when blank string is submitted (user left field empty)
    whisperApiKey: keepIfBlank(patch.whisperApiKey, current.whisperApiKey),
    whisperBaseUrl:
      typeof patch.whisperBaseUrl === 'string' && patch.whisperBaseUrl.trim()
        ? patch.whisperBaseUrl.trim()
        : current.whisperBaseUrl,
  });
  return getDesktopBootstrap();
}

export async function updateAgentProfile(agentId, patch = {}, options = {}) {
  const normalizedAgentId = normalizeAgentStorageId(agentId) || 'main';
  const scope =
    options.scope === 'project' && options.projectId ? 'project' : 'global';

  // Normalize identity/soul aliases and extract the raw channels draft. The
  // stale-draft channel merge happens inside the atomic block below against
  // the freshest persisted state. See src/services/agent/agentProfileService.js
  // and feedback_preserve_user_config.md for why both halves live behind
  // service helpers: minimal patches (e.g. only `minimaxVoiceId`) used to
  // wipe user-configured tokens via `undefined` spread-merges.
  const { nextPatch, incomingChannelsRaw } = normalizeAgentUpdatePatch(patch);

  // Wrap the whole read-modify-write in updateStateAtomically so that two
  // concurrent updateAgentProfile calls (for example the poller writing a
  // runtime field and the UI writing a token at the same moment) cannot
  // lose each other's update. updateStateAtomically re-reads the latest
  // state inside the write queue, applies the mutator, and then persists
  // — all serialized with every other saveState / updateStateAtomically.
  await updateStateAtomically(async latestState => {
    const state = ensureSelectedEntities(latestState);
    if (scope === 'project') {
      const projectId = options.projectId;
      const currentProjectOverrides = normalizeProjectAgentOverrides(state.projectAgentOverrides);

      if (options.clearProjectOverride) {
        if (currentProjectOverrides[projectId]) {
          delete currentProjectOverrides[projectId][normalizedAgentId];
          if (!Object.keys(currentProjectOverrides[projectId]).length) {
            delete currentProjectOverrides[projectId];
          }
        }
        state.projectAgentOverrides = currentProjectOverrides;
        const effective = effectiveAgentProfile(state, normalizedAgentId, projectId);
        await writeMarkdownFile(
          getAgentMarkdownPaths(normalizedAgentId, {
            scope: 'project',
            projectId,
          }).identityPath,
          effective.identity,
        );
        await writeMarkdownFile(
          getAgentMarkdownPaths(normalizedAgentId, {
            scope: 'project',
            projectId,
          }).soulPath,
          effective.soulMd,
        );
      } else {
        // For project scope: prefer the project-override's persisted channels
        // if present, otherwise fall back to the agent's global channels so the
        // guard still catches a stale-draft wipe at the project level.
        const persistedForProject =
          currentProjectOverrides?.[projectId]?.[normalizedAgentId]?.channels
          || state.agentProfiles?.[normalizedAgentId]?.channels
          || {};
        const mergedProjectChannels = mergeChannelsWithStaleDraftGuard(
          incomingChannelsRaw,
          persistedForProject,
        );
        if (mergedProjectChannels) {
          nextPatch.channels = mergedProjectChannels;
        }
        const normalizedOverride = normalizeAgentOverride(normalizedAgentId, nextPatch);
        if (!normalizedOverride) {
          throw new Error('Project agent override is empty.');
        }
        state.projectAgentOverrides = {
          ...currentProjectOverrides,
          [projectId]: {
            ...(currentProjectOverrides[projectId] || {}),
            [normalizedAgentId]: normalizedOverride,
          },
        };
        const paths = getAgentMarkdownPaths(normalizedAgentId, {
          scope: 'project',
          projectId,
        });
        const identity = await writeMarkdownFile(paths.identityPath, normalizedOverride.identity);
        const soulMd = await writeMarkdownFile(paths.soulPath, normalizedOverride.soulMd);
        state.projectAgentOverrides[projectId][normalizedAgentId] = normalizeAgentOverride(
          normalizedAgentId,
          {
            ...normalizedOverride,
            identity,
            identify: identity,
            soulMd,
            'soul.md': soulMd,
          },
        );
      }
    } else {
      // Apply the stale-draft channel guard for the global scope against the
      // freshest persisted channels. If the UI posted both channels but one of
      // them looks empty relative to persisted, preserve persisted instead of
      // letting the incoming shell wipe a real config.
      const mergedGlobalChannels = mergeChannelsWithStaleDraftGuard(
        incomingChannelsRaw,
        state.agentProfiles?.[normalizedAgentId]?.channels || {},
      );
      if (mergedGlobalChannels) {
        nextPatch.channels = mergedGlobalChannels;
      }
      let nextAgentProfiles = normalizeAgentProfiles({
        ...state.agentProfiles,
        [normalizedAgentId]: {
          ...state.agentProfiles?.[normalizedAgentId],
          ...nextPatch,
        },
      });

      for (const channelId of AGENT_CHANNEL_IDS) {
        const nextChannel = normalizeAgentChannels(nextAgentProfiles?.[normalizedAgentId]?.channels)?.[channelId];
        if (!nextChannel?.enabled || !nextChannel?.botToken) {
          continue;
        }

        nextAgentProfiles = dedupeAgentChannelTokenOwners(
          nextAgentProfiles,
          normalizedAgentId,
          channelId,
          nextChannel.botToken,
        );
      }

      state.agentProfiles = normalizeAgentProfiles(nextAgentProfiles);
      const currentProfile = normalizeAgentProfile(normalizedAgentId, state.agentProfiles[normalizedAgentId]);
      const paths = getAgentMarkdownPaths(normalizedAgentId, { scope: 'global' });
      const identity = await writeMarkdownFile(paths.identityPath, currentProfile.identity);
      const soulMd = await writeMarkdownFile(paths.soulPath, currentProfile.soulMd);
      state.agentProfiles[normalizedAgentId] = normalizeAgentProfile(normalizedAgentId, {
        ...currentProfile,
        identity,
        identify: identity,
        soulMd,
        'soul.md': soulMd,
      });
    }

    state.settings.selectedCustomizeSection = 'agents';
    state.settings.selectedAgentScope = scope;
    if (scope === 'project' && options.projectId) {
      state.settings.selectedProjectId = options.projectId;
    }
    state.settings.selectedAgentId = normalizedAgentId;
    state.settings.activeView =
      options.activeView || (state.settings.activeView === 'agent' ? 'agent' : 'customize');

    return state;
  });

  return getDesktopBootstrap();
}

export async function createCustomAgent() {
  const state = ensureSelectedEntities(await loadState());
  // Default profile construction (id allocation + seed identity / soul /
  // tools) is pure logic — lifted into agentProfileService in Phase 7c.
  // desktopStore still owns the splice into state + markdown-file sync +
  // saveState side-effects.
  const { agentId, profile } = buildNewCustomAgent(state.agentProfiles);

  state.agentProfiles = {
    ...state.agentProfiles,
    [agentId]: profile,
  };
  state.settings.selectedCustomizeSection = 'agents';
  state.settings.selectedAgentId = agentId;
  state.settings.activeView = 'agent';
  await syncAgentMarkdownFiles(state);
  await saveState(state);
  return getDesktopBootstrap();
}

export async function refreshModelCatalog(patch = {}) {
  const current = await loadConfig();
  const authMode =
    typeof patch.authMode === 'string' &&
    ['local', 'api-key', 'codex'].includes(patch.authMode.trim())
      ? patch.authMode.trim()
      : current.authMode || DEFAULT_CONFIG.authMode;
  const baseUrl =
    typeof patch.baseUrl === 'string' && patch.baseUrl.trim()
      ? patch.baseUrl.trim()
      : current.baseUrl || DEFAULT_CONFIG.baseUrl;
  const model =
    typeof patch.model === 'string' && patch.model.trim()
      ? patch.model.trim()
      : current.model || DEFAULT_CONFIG.model;
  const apiKey =
    typeof patch.apiKey === 'string' && patch.apiKey.trim()
      ? patch.apiKey.trim()
      : current.apiKey || '';
  const systemPrompt =
    typeof patch.systemPrompt === 'string' && patch.systemPrompt.trim()
      ? patch.systemPrompt.trim()
      : current.systemPrompt || DEFAULT_CONFIG.systemPrompt;

  const discovered = await discoverAvailableModels({
    authMode,
    apiKey,
    baseUrl,
    model,
  });

  await saveConfig({
    ...current,
    authMode,
    baseUrl,
    model,
    apiKey: authMode === 'api-key' || authMode === 'local' ? apiKey : current.apiKey,
    systemPrompt,
    modelCatalogs: {
      ...normalizeModelCatalogs(current.modelCatalogs || DEFAULT_MODEL_CATALOGS),
      [authMode]: discovered,
    },
  });

  return getDesktopBootstrap();
}

// Skill CRUD + proposal-application + chat-draft moved to
// `src/services/skill/skillMutations.js` in Phase 7d-5ε commit 2.
// Re-exported above.

export async function toggleConnector(connectorId) {
  const state = ensureSelectedEntities(await loadState());
  const enabled = new Set(state.settings.enabledConnectorIds);

  if (enabled.has(connectorId)) {
    enabled.delete(connectorId);
  } else {
    enabled.add(connectorId);
  }

  state.settings.enabledConnectorIds = [...enabled];
  state.settings.selectedConnectorId = connectorId;
  await saveState(state);
  return getDesktopBootstrap();
}




/**
 * Phase 3.1.3: return a skill's SKILL.md rendering so the UI / CLI can copy
 * or download it. Works for both built-in and custom skills, but for
 * built-ins it re-normalizes so the frontmatter reflects the canonical
 * runtime shape (tags, triggers, etc.) rather than raw constant literals.
 */

/**
 * Phase 3.1.3: import a skill from SKILL.md text. If {writeToDisk:true}
 * the skill is also written to ~/.melo/desktop/skills/<id>/SKILL.md so
 * future loads pick it up from disk. Otherwise it's stored JSON-only.
 */

/**
 * Phase 3.1.3: "promote to disk" — take an existing JSON skill and mirror
 * it to ~/.melo/desktop/skills/<id>/SKILL.md, flipping its origin. Idempotent.
 */

/**
 * Phase 3.1.3: force-reload disk skills (used by UI "Refresh disk skills"
 * button). Returns the refreshed bootstrap envelope.
 */

export { SKILLS_DISK_ROOT };

/**
 * UI-side entry point for "Save chat as skill" (Phase 5C).
 *
 * Loads the active chat's messages + resolved config, then hands off to
 * `draftSkillFromConversation`. The UI uses the returned draft to pre-fill
 * the Customize → Skills create form — we deliberately do NOT auto-persist
 * the draft, matching the REPL / Telegram flow where the user confirms via
 * typing or voice before it's written to disk.
 *
 * `_draftFn`, `_loadStateFn`, `_configFn` are test-only DI seams so unit
 * tests can skip the real disk/model round-trip.
 */
/**
 * Phase 3.4.1 — scan recent chats and push candidate skills into the
 * in-memory proposal store. The store dedupes by seedId, so calling this
 * repeatedly is cheap.
 *
 * The scan is conservative by design:
 *   - Only the `limit` most recent chats are considered.
 *   - `proposeSkillsFromActivity` enforces the "≥3 tool calls AND
 *     (connector OR file-write)" gate, so pure chat is ignored.
 *
 * Returns `{ scanned, proposed, added }` so tests and the debug endpoint
 * can verify the pipeline is working end-to-end.
 */
// scanRecentChatsForSkillProposals moved to
// `src/state/skillProposalScan.js` in Phase 7d-5δ commit 8f.
// Re-imported + re-exported above for the test that imports it
// from desktopStore.

/**
 * Phase 3.4.2 — apply a queued skill-proposal to the store.
 *
 * Today this handles the `upgrade` kind only: merge new triggers, append
 * the systemPromptAppendix to the target skill's systemPrompt (idempotent
 * — skipped if the exact appendix is already present), and write the
 * referenceDraft to `~/.melo/desktop/skills/<id>/references/<date>.md`.
 * The create path goes through the existing `draftSkillFromChat` →
 * manual approval flow and isn't touched here.
 *
 * Built-in skills are intentionally rejected — their definitions live in
 * source and can't be edited in place. Upgrade proposals targeting a
 * built-in will almost never be produced because built-ins have low
 * trigger overlap with captured workflow patterns, but we guard anyway.
 *
 * The proposal is dismissed on successful apply so the scanner doesn't
 * keep suggesting it.
 */


// External-connector CRUD (createExternalConnector / updateExternalConnector
// / removeExternalConnector / pingExternalConnector /
// readExternalConnectorResource / previewExternalConnectorPrompt /
// invokeExternalConnectorTool) moved to
// `src/services/connector/externalConnectorMutations.js` in
// Phase 7d-5ε commit 1. Re-exported above.







// project-domain mutations moved to a sibling leaf in Phase 7d-5ε
// commit 3. Re-exported above.






// approval-domain mutations moved to a sibling leaf in Phase 7d-5ε
// commit 3. Re-exported above.



// workspace-domain mutations moved to a sibling leaf in Phase 7d-5ε
// commit 3. Re-exported above.

// Workspace I/O orchestration moved to src/services/workspace/workspaceService.js
// in Phase 7b. These wrappers load state once, pass a state-backed resolver
// into the service, then apply UI state side-effects (selectedFilePath,
// activeMode/View, project.updatedAt) on the same snapshot before persisting.
// selectWorkspaceFile stays below as-is — it's pure state mutation, not I/O.

/**
 * Read a workspace file for read-only preview (citation side viewer).
 * Does NOT mutate state — the NotebookLM-style citation drawer opens
 * files without kicking the user out of chat view or swapping
 * selectedFilePath.
 */





// extractUrlAttachmentsFromText shipped with sendChatMessage in
// Phase 7d-5δ commit 8f (was a sendChatMessage-private helper).

// isAbortError shipped with sendChatMessage in Phase 7d-5δ commit
// 8f (was a sendChatMessage-private helper).

// sendChatMessage moved to `src/services/chat/sendChatMessage.js`
// in Phase 7d-5δ commit 8f (path B finale). Two private helpers
// (isAbortError + extractUrlAttachmentsFromText) shipped with it.
// Re-imported and re-exported at the top of this file for
// server.js / test compatibility.
