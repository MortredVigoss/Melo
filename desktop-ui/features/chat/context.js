// The narrow context app.js hands the chat feature (architecture plan P2c,
// features/README.md). No uiState: page data is read through getBootstrap()
// and changed only through app.js callbacks (applyBootstrap*,
// refreshBootstrap, and setBootstrap for the optimistic user message and the
// restore after a failed send, which never rendered by themselves). Shared
// state that stays in app.js is reached by name: the overview flag
// (isOverview / leaveOverview), the new-chat selection (newChatSelection /
// selectNewChatAgent), the model picker (modelPicker / closeModelPicker), the
// tool permission queue the approval dialog answers (toolPermissions /
// setToolPermissions), the command palette, the voice language and the TTS
// state (speakingState and the stream helpers). executionPanel.js,
// localSettings.js and /shared/*.js functions arrive here too, so the feature
// stays importable from node tests. Bound once by installChatController(); the
// feature's modules import these names (ES module live bindings).
import { checkFeatureContext } from '../featureContext.js';
import { createChatApi } from './api.js';

export const CHAT_CONTEXT = Object.freeze([
  'getBootstrap', 'setBootstrap', 'app', 'api', 'render', 'bgRender', 'showError',
  'applyBootstrap', 'applyBootstrapPreservingDrafts', 'refreshBootstrap',
  'activeChat', 'isOverview', 'leaveOverview', 'newChatSelection', 'selectNewChatAgent',
  'activeChatAgentProfile', 'allChatAgentProfiles', 'composerTeamPlan',
  'modelPicker', 'closeModelPicker', 'toolPermissions', 'setToolPermissions', 'commandPaletteOpen', 'voiceLanguage',
  'handleComposerCommand', 'handleSpeakMessage', 'handleDeleteChat', 'speakingState', 'stopCurrentTts',
  '_isTtsActive', '_streamTtsStart', '_streamTtsPushChunk', 'setStreamTtsBuffer', '_streamTtsOnToolCall', '_streamTtsReset', '_streamTtsFlush',
  'notifyLocalCompletion', 'shouldSendOnEnter', 'extractTextUrls', 'promoteTextUrlsToAttachments',
  'renderExecutionPanel', 'receiveExecutionScene', 'liveSceneFor', 'cancelLiveScene', 'renderSceneReplay', 'selectedMessagePresentation',
  'renderMessageRefs', 'renderTextBlock', 'renderWorkspaceExplorer', 'renderTtsVoicePanel', 'modelOptionsForAuthMode',
  'captureThreadAnchor', 'restoreThreadAnchor', 'escapeHtml', 'truncate', 'icon',
]);

export let getBootstrap, setBootstrap, app, render, bgRender, showError, applyBootstrap, applyBootstrapPreservingDrafts, refreshBootstrap, activeChat, isOverview, leaveOverview, newChatSelection, selectNewChatAgent, activeChatAgentProfile, allChatAgentProfiles, composerTeamPlan, modelPicker, closeModelPicker, toolPermissions, setToolPermissions, commandPaletteOpen, voiceLanguage, handleComposerCommand, handleSpeakMessage, handleDeleteChat, speakingState, stopCurrentTts, _isTtsActive, _streamTtsStart, _streamTtsPushChunk, setStreamTtsBuffer, _streamTtsOnToolCall, _streamTtsReset, _streamTtsFlush, notifyLocalCompletion, shouldSendOnEnter, extractTextUrls, promoteTextUrlsToAttachments, renderExecutionPanel, receiveExecutionScene, liveSceneFor, cancelLiveScene, renderSceneReplay, selectedMessagePresentation, renderMessageRefs, renderTextBlock, renderWorkspaceExplorer, renderTtsVoicePanel, modelOptionsForAuthMode, captureThreadAnchor, restoreThreadAnchor, escapeHtml, truncate, icon, chatApi;

export function bindChatContext(context) {
  checkFeatureContext('chat', context, CHAT_CONTEXT);
  ({ getBootstrap, setBootstrap, app, render, bgRender, showError, applyBootstrap, applyBootstrapPreservingDrafts, refreshBootstrap, activeChat, isOverview, leaveOverview, newChatSelection, selectNewChatAgent, activeChatAgentProfile, allChatAgentProfiles, composerTeamPlan, modelPicker, closeModelPicker, toolPermissions, setToolPermissions, commandPaletteOpen, voiceLanguage, handleComposerCommand, handleSpeakMessage, handleDeleteChat, speakingState, stopCurrentTts, _isTtsActive, _streamTtsStart, _streamTtsPushChunk, setStreamTtsBuffer, _streamTtsOnToolCall, _streamTtsReset, _streamTtsFlush, notifyLocalCompletion, shouldSendOnEnter, extractTextUrls, promoteTextUrlsToAttachments, renderExecutionPanel, receiveExecutionScene, liveSceneFor, cancelLiveScene, renderSceneReplay, selectedMessagePresentation, renderMessageRefs, renderTextBlock, renderWorkspaceExplorer, renderTtsVoicePanel, modelOptionsForAuthMode, captureThreadAnchor, restoreThreadAnchor, escapeHtml, truncate, icon } = context);
  chatApi = createChatApi(context.api);
}
