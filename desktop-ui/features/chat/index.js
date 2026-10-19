// Chat feature entry (architecture plan P2c, 2026-10-19): the only module
// app.js imports for the chat page and the composer. installChatFeature(context)
// returns what app.js composes: the action/form tables for the registry, the
// listener entry points called at their original positions, the render()
// hooks, the few questions app.js asks about the chat (isSending,
// composerText, …) and the renderers.
import {
  installChatController,
  chatActions,
  chatForms,
  handleChatFilesToggle,
  handleComposerInput,
  handleComposerFileChange,
  handleComposerDragOver,
  handleComposerDragLeave,
  handleComposerDrop,
  handleComposerDragEnd,
  handleAgentSelectorKeydown,
  handleComposerKeydown,
  handleVoiceBridgeEvent,
  stopVoiceCaptureIfNeeded,
  voiceCaptureActive,
  resetComposerForNewChatHome,
  focusComposerSoon,
  handleCreateChat,
  handleSendMessage,
  takeComposerDraft,
  restoreComposerDraft,
  retryMissingImages,
  prepareThreadNavigation,
  clearHighlightedMessage,
  updateThreadAutoFollow,
  syncThreadViewport,
  _positionAgentDropdown,
  captureComposerBeforeRender,
  captureThreadBeforeRender,
  restoreThreadScrollAfterRender,
  restoreComposerAfterRender,
  restoreVizAnchorAfterRender,
  restorePendingVizAnchor,
  closeAgentSelector,
  closeAgentSelectorOnOutsideClick,
  closeAttachmentMenu,
  closeAttachmentMenuOnOutsideClick,
  composerText,
  setComposerText,
  composerAttachments,
  isSending,
  getState,
} from './controller.js';
import { renderRegularChatPage, renderMessageList, renderThreadArtifactStrip, syncVizBlocks } from './viewThread.js';
import { renderComposerCard, renderAgentSelectorDropdown, thinkingLabel } from './viewComposer.js';

export function installChatFeature(context) {
  installChatController(context);
  return {
    actions: chatActions,
    forms: chatForms,
    // 'click', before the action dispatch: outside clicks close the attachment
    // menu (true when it closed it) and the Agent picker; the chat files
    // <summary> (true when handled).
    closeAttachmentMenuOnOutsideClick,
    closeAgentSelectorOnOutsideClick,
    handleChatFilesToggle,
    // 'input': the composer textarea. Returns true when handled.
    handleComposerInput,
    // 'change' (inside its try): the composer file input. Returns false or the pending upload.
    handleComposerFileChange,
    // 'dragover' / 'dragleave' / 'drop' / 'dragend' listener bodies.
    handleComposerDragOver,
    handleComposerDragLeave,
    handleComposerDrop,
    handleComposerDragEnd,
    // 'keydown': the Agent picker (true when handled), then the composer
    // (false, true or the pending send).
    handleAgentSelectorKeydown,
    handleComposerKeydown,
    // 'melo-voice' bridge events; navigation / page hide stop a running capture.
    handleVoiceBridgeEvent,
    stopVoiceCapture: stopVoiceCaptureIfNeeded,
    voiceCaptureActive,
    // handleOpenNewChatHome (new-chat navigation).
    resetComposerForNewChatHome,
    focusComposerSoon,
    // New chats (palette, projects) and sends started outside the composer
    // (tasks keep the user's draft around their run).
    createChat: handleCreateChat,
    sendMessage: handleSendMessage,
    takeComposerDraft,
    restoreComposerDraft,
    // syncExecutionPanel's image retry.
    retryMissingImages,
    // Navigation (open-chat, search hits) resets the thread viewport; other
    // navigation drops the highlighted hit.
    prepareThreadNavigation,
    clearHighlightedMessage,
    // The thread scroller's scroll listener (bindContentScrollbar).
    updateThreadAutoFollow,
    // render() hooks, at the positions of the former inline code (see the
    // hook map in ./controller.js).
    captureComposerBeforeRender,
    captureThreadBeforeRender,
    restoreThreadScrollAfterRender,
    syncThreadViewport,
    restoreComposerAfterRender,
    positionAgentDropdown: _positionAgentDropdown,
    syncVizBlocks,
    restoreVizAnchorAfterRender,
    closeAgentSelector,
    // 'melo:viz:hydrated'.
    restorePendingVizAnchor,
    // What app.js asks about the chat: the running reply (render, task panel,
    // 1 s timer), the composer draft (slash commands, command catalog, the
    // neural composer sync) and its attachments (image task controls).
    isSending,
    thinkingLabel,
    composerText,
    setComposerText,
    composerAttachments,
    closeAttachmentMenu,
    renderPage: renderRegularChatPage,
    renderComposer: renderComposerCard,
    renderAgentSelectorDropdown,
    // The code page (chat in code mode) composes the same thread pieces.
    renderMessageList,
    renderThreadArtifactStrip,
    getState,
  };
}
