// Chat feature context (architecture plan P2c, 2026-10-19). Transitional live
// bindings: the names the byte-for-byte moved bodies use, bound once by app.js
// through installChatController(). The follow-up commit replaces them with a
// narrow, checked context (features/featureContext.js) and feature state.
// executionPanel.js, localSettings.js and /shared/*.js functions arrive here
// so the feature stays importable from node tests.
export let uiState, app, api, render, bgRender, showError, applyBootstrap, applyBootstrapPreservingDrafts, loadBootstrap, activeChat, activeChatAgentProfile, allChatAgentProfiles, composerTeamPlan, escapeHtml, truncate, icon, memoryFeature, renderTextBlock, renderWorkspaceExplorer, renderTtsVoicePanel, modelOptionsForAuthMode, handleComposerCommand, handleSpeakMessage, handleDeleteChat, captureThreadAnchor, restoreThreadAnchor, stopCurrentTts, _isTtsActive, _streamTts, _streamTtsStart, _streamTtsPushChunk, _streamTtsOnToolCall, _streamTtsReset, _streamTtsFlush, notifyLocalCompletion, shouldSendOnEnter, extractTextUrls, promoteTextUrlsToAttachments, renderExecutionPanel, receiveExecutionScene, liveSceneFor, cancelLiveScene, renderSceneReplay, selectedMessagePresentation;

export function bindChatContext(context) {
  ({ uiState, app, api, render, bgRender, showError, applyBootstrap, applyBootstrapPreservingDrafts, loadBootstrap, activeChat, activeChatAgentProfile, allChatAgentProfiles, composerTeamPlan, escapeHtml, truncate, icon, memoryFeature, renderTextBlock, renderWorkspaceExplorer, renderTtsVoicePanel, modelOptionsForAuthMode, handleComposerCommand, handleSpeakMessage, handleDeleteChat, captureThreadAnchor, restoreThreadAnchor, stopCurrentTts, _isTtsActive, _streamTts, _streamTtsStart, _streamTtsPushChunk, _streamTtsOnToolCall, _streamTtsReset, _streamTtsFlush, notifyLocalCompletion, shouldSendOnEnter, extractTextUrls, promoteTextUrlsToAttachments, renderExecutionPanel, receiveExecutionScene, liveSceneFor, cancelLiveScene, renderSceneReplay, selectedMessagePresentation } = context);
}
