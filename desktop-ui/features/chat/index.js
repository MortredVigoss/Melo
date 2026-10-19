// Chat feature entry (architecture plan P2c, 2026-10-19): the only module
// app.js imports for the chat page and the composer. installChatFeature(context)
// returns what app.js composes: the action/form tables for the registry, the
// listener entry points called at their original positions, the functions
// render() and navigation call, and the renderers.
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
  setVoiceState,
  resetComposerHistoryNavigation,
  focusComposerSoon,
  syncComposerTextareaHeight,
  handleCreateChat,
  handleSendMessage,
  retryMissingImages,
  prepareThreadNavigation,
  updateThreadAutoFollow,
  syncThreadViewport,
  _positionAgentDropdown,
} from './controller.js';
import { renderRegularChatPage, renderMessageList, renderThreadArtifactStrip, syncVizBlocks } from './viewThread.js';
import { renderComposerCard, renderAgentSelectorDropdown, thinkingLabel } from './viewComposer.js';

export function installChatFeature(context) {
  installChatController(context);
  return {
    actions: chatActions,
    forms: chatForms,
    // 'click', before the action dispatch: the chat files <summary>. Returns true when handled.
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
    setVoiceState,
    resetComposerHistoryNavigation,
    focusComposerSoon,
    // New chats (palette, projects) and sends started outside the composer (tasks).
    createChat: handleCreateChat,
    sendMessage: handleSendMessage,
    // syncExecutionPanel's image retry.
    retryMissingImages,
    // Navigation (open-chat, search hits) resets the thread viewport.
    prepareThreadNavigation,
    // The thread scroller's scroll listener (bindContentScrollbar).
    updateThreadAutoFollow,
    // render(): after the DOM update, at their old positions.
    syncThreadViewport,
    syncComposerTextareaHeight,
    positionAgentDropdown: _positionAgentDropdown,
    syncVizBlocks,
    // The running reply's status (neural activity line, 1 s timer).
    thinkingLabel,
    renderPage: renderRegularChatPage,
    renderComposer: renderComposerCard,
    renderAgentSelectorDropdown,
    // The code page (chat in code mode) composes the same thread pieces.
    renderMessageList,
    renderThreadArtifactStrip,
  };
}
