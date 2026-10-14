// Public desktop application facade. Implementations live in domain services.
export { buildConversationContinuityContext } from './services/chat/conversationContinuity.js';
export { streamSearchFileGroups, streamSearchFileHits } from './services/search/workspaceSearch.js';
export { testAgentChannelConnection } from './services/agent/channelConnection.js';
export { updateAgentProfile, createCustomAgent } from './services/agent/agentMutations.js';
export { updateModelConfig, refreshModelCatalog } from './services/settings/modelSettings.js';
export { prepareDesktopLaunchState, updateDesktopSettings, toggleConnector } from './services/settings/desktopSettings.js';
export { createChat, updateChat, deleteChat } from './services/chat/chatMutations.js';
import { bootstrapBuiltinTools } from './tools/registry.js';
import { SKILLS_DISK_ROOT } from './agents/skillsDisk.js';
import {
  isBacklogPollCycle,
  recentChatHasBotContext,
  passesOfflineBacklogFilter,
  OFFLINE_BACKLOG_THRESHOLD_MS,
  BACKLOG_CONTEXT_LOOKBACK,
} from './services/remote/offlineBacklogFilter.js';
import {
  buildDiscordThreadKey,
  normalizeDiscordAttachmentKind,
  extractDiscordAttachments,
  isDiscordMessageFromBot,
  latestProcessableDiscordMessage,
  hasDiscordInvokePrefix,
  collectDiscordBotAliases,
} from './services/remote/discordParsing.js';
import { buildDiscordReplyScore } from './services/remote/discordReplyScore.js';
export { formatProviderFailureMessage } from './services/chat/providerErrors.js';
export { buildModelMessagesFromChat } from './services/chat/messageBuilder.js';
export {
  normalizeCustomSkill,
  buildSkills,
  listExecutableSkills,
} from './domain/skill/skillService.js';
export { summarizeSkillsPrompts } from './services/skill/skillPrompts.js';
export { getDesktopBootstrap } from './services/desktop/bootstrap.js';
export { sendChatMessage } from './services/chat/sendChatMessage.js';
export { scanRecentChatsForSkillProposals } from './services/skill/proposalScan.js';
export {
  createExternalConnector,
  updateExternalConnector,
  removeExternalConnector,
  pingExternalConnector,
  readExternalConnectorResource,
  previewExternalConnectorPrompt,
  invokeExternalConnectorTool,
} from './services/connector/externalConnectorMutations.js';
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
  updateArtifact,
  deleteArtifact,
  restoreArtifact,
  purgeStaleSoftDeletes,
  applyArtifactToWorkspaceFile,
  runLocalCommand,
} from './services/workspace/workspaceMutations.js';
export {
  createApproval,
  rejectApproval,
  executeApproval,
} from './services/approval/approvalMutations.js';
export { processTelegramPollingCycle } from './services/remote/telegramPolling.js';
export { processDiscordPollingCycle } from './services/remote/discordPolling.js';
import { snowflakeGt } from './services/remote/discordPolling.js';

bootstrapBuiltinTools();

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

export const __offlineBacklogTesting = {
  isBacklogPollCycle,
  recentChatHasBotContext,
  passesOfflineBacklogFilter,
  OFFLINE_BACKLOG_THRESHOLD_MS,
  BACKLOG_CONTEXT_LOOKBACK,
};

export { initMcpServers } from './mcp/init.js';

export { SKILLS_DISK_ROOT };
