// Chat feature context (architecture plan P2c, 2026-10-19). Transitional live
// bindings: the names the byte-for-byte moved bodies use, bound once by app.js
// through installChatController(). The follow-up commit replaces them with a
// narrow, checked context (features/featureContext.js) and feature state.
export let uiState, app, api, render, showError, applyBootstrap, activeChat, activeChatAgentProfile, escapeHtml, truncate, icon, memoryFeature, renderTextBlock, renderComposerCard, renderWorkspaceExplorer, attachmentLabel, isPdfAttachment, extractTextUrls, liveSceneFor, renderSceneReplay, selectedMessagePresentation, handleSpeakMessage, handleDeleteChat, captureThreadAnchor, restoreThreadAnchor;

export function bindChatContext(context) {
  ({ uiState, app, api, render, showError, applyBootstrap, activeChat, activeChatAgentProfile, escapeHtml, truncate, icon, memoryFeature, renderTextBlock, renderComposerCard, renderWorkspaceExplorer, attachmentLabel, isPdfAttachment, extractTextUrls, liveSceneFor, renderSceneReplay, selectedMessagePresentation, handleSpeakMessage, handleDeleteChat, captureThreadAnchor, restoreThreadAnchor } = context);
}
