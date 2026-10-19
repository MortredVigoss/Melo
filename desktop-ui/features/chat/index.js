// Chat feature entry (architecture plan P2c, 2026-10-19): the only module
// app.js imports for the chat page. installChatFeature(context) returns what
// app.js composes: the action/form tables for the registry, the listener
// entry points called at their original positions, the thread navigation /
// viewport functions render() and navigation call, and the renderers.
import { installChatController, chatActions, chatForms, handleChatFilesToggle, prepareThreadNavigation, updateThreadAutoFollow, syncThreadViewport } from './controller.js';
import { renderRegularChatPage, renderMessageList, renderThreadArtifactStrip, renderStreamingFast, patchLiveRunSteps, syncVizBlocks } from './viewThread.js';

export function installChatFeature(context) {
  installChatController(context);
  return {
    actions: chatActions,
    forms: chatForms,
    // 'click', before the action dispatch: the chat files <summary>. Returns true when handled.
    handleChatFilesToggle,
    // Navigation (open-chat, search hits) resets the thread viewport.
    prepareThreadNavigation,
    // The thread scroller's scroll listener (bindContentScrollbar).
    updateThreadAutoFollow,
    // render(): after the DOM update.
    syncThreadViewport,
    syncVizBlocks,
    // Streaming (send pipeline, still in app.js until the next commit).
    renderStreamingFast,
    patchLiveRunSteps,
    renderPage: renderRegularChatPage,
    // The code page (chat in code mode) composes the same thread pieces.
    renderMessageList,
    renderThreadArtifactStrip,
  };
}
