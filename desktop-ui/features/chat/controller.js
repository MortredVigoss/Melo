// Chat feature controller (architecture plan P2c, 2026-10-19): thread
// navigation and viewport (auto-follow, scroll signature, "加载更早",
// jump-to-latest), message actions and the chat files panel. Moved out of
// desktop-ui/app.js byte-for-byte; the composer and send pipeline follow in
// the next commit. See features/README.md.
import { t } from '../../i18n.js';
import { expandThreadWindow } from '../../threadWindow.js';
import { videoExtraction, videoKnowledgeNote } from '../../videoKnowledge.js';
import { bindChatContext, uiState, api, render, showError, applyBootstrap, activeChat, handleSpeakMessage, handleDeleteChat, captureThreadAnchor, restoreThreadAnchor } from './context.js';

// Binds the context. app.js calls this once at startup (through ./index.js).
export function installChatController(context) {
  bindChatContext(context);
}

function prepareThreadNavigation({ highlightedMessageId = null, autoFollow = true } = {}) {
  uiState.highlightedMessageId = highlightedMessageId;
  uiState.lastThreadScrollSignature = '';
  uiState.lastThreadChatId = null;
  uiState.threadAutoFollow = autoFollow;
}

function updateThreadAutoFollow(scroller) {
  if (!(scroller instanceof HTMLElement)) {
    return;
  }

  if (uiState.bootstrap?.settings?.activeView !== 'chat' || !activeChat()) {
    return;
  }

  const maxScroll = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
  const distanceFromBottom = Math.max(0, maxScroll - scroller.scrollTop);
  const nextAutoFollow = distanceFromBottom <= 56;
  const autoFollowChanged = nextAutoFollow !== uiState.threadAutoFollow;
  uiState.threadAutoFollow = nextAutoFollow;
  // Always track the last known scroll position so we can restore it after re-renders
  uiState.lastKnownScrollTop = scroller.scrollTop;

  // If the auto-follow state flipped (user scrolled away from, or back to, the
  // bottom), we need a render so the "jump to latest" floating button shows or
  // hides. Skipping this render means the button only appears on the next
  // unrelated render — e.g. not until the next streaming chunk arrives — which
  // feels laggy when the user scrolls up after streaming has finished.
  //
  // Marked as `background: true` so the scroll guard above defers it past any
  // momentum-scroll in flight — jump-to-latest button visibility is allowed
  // to lag a few hundred ms, but tearing down the scroller mid-momentum kills
  // the user's swipe and is what they reported as "拉到底跳到这" on 2026-05-05.
  if (autoFollowChanged) {
    render({ background: true });
  }
}

function syncThreadViewport() {
  const chat = activeChat();
  if (
    uiState.bootstrap?.settings?.activeView !== 'chat' ||
    !chat?.messages?.length
  ) {
    uiState.lastThreadScrollSignature = '';
    uiState.lastThreadChatId = null;
    uiState.threadAutoFollow = true;
    return;
  }

  const isNewThread = uiState.lastThreadChatId !== chat.id;
  if (isNewThread) {
    uiState.lastThreadChatId = chat.id;
    uiState.threadAutoFollow = true;
  }

  const signature = `${chat.id}:${chat.messages.length}:${chat.updatedAt || ''}:${
    uiState.highlightedMessageId || ''
  }:${uiState.streamingChatId === chat.id ? uiState.streamingAssistantText.length : 0}:${
    uiState.sending && uiState.streamingChatId === chat.id ? 1 : 0
  }`;
  if (signature === uiState.lastThreadScrollSignature) {
    return;
  }

  uiState.lastThreadScrollSignature = signature;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const scroller = document.querySelector('.thread-scroll-region');
      const highlightedMessage = uiState.highlightedMessageId
        ? document.querySelector(`[data-message-id="${uiState.highlightedMessageId}"]`)
        : null;
      if (highlightedMessage instanceof HTMLElement) {
        uiState.threadAutoFollow = false;
        highlightedMessage.scrollIntoView({ block: 'center', behavior: 'auto' });
        return;
      }

      if (!uiState.threadAutoFollow) {
        // Restore the user's saved scroll position — new DOM starts at 0
        if (scroller instanceof HTMLElement && uiState.lastKnownScrollTop > 0) {
          scroller.scrollTop = uiState.lastKnownScrollTop;
        }
        return;
      }

      if (scroller instanceof HTMLElement) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    });
  });
}

// Click actions (formerly `case` branches of app.js's click dispatch),
// registered once by app.js through the feature registry.
export const chatActions = {
  'delete-active-chat': async () => {
    if(activeChat()) await handleDeleteChat(activeChat().id);
  },
  'save-video-knowledge': async ({ trigger }) => {
    const message = activeChat()?.messages?.find(m => m.id === trigger.dataset.messageId);
    const attachment = message?.attachments?.find(a => a.id === trigger.dataset.attachmentId);
    const entry = message && attachment ? videoExtraction(message, attachment) : null;
    if (!entry) { showError(t('这段视频还没有处理结果。')); return; }
    try { applyBootstrap(await api('/api/artifacts', { method: 'POST', body: { ...videoKnowledgeNote(attachment, entry), projectId: activeChat()?.projectId || null } })); (uiState.savedVideoKnowledge ||= {})[attachment.id] = true; render(); }
    catch (error) { showError(error.message); }
  },
  'thread-load-earlier': () => {
    // Long-thread render window: reveal the next 60 older messages. The
    // thread signature (chat id / length / updatedAt) does not change, so
    // render() restores the raw scrollTop — which would now point INTO
    // the freshly inserted older content. Anchor on the first visible
    // message instead (same helpers as the viz-hydration path) and shift
    // scrollTop by the height the new content added above it; fall back
    // to a plain scrollHeight delta when no anchor is available (e.g.
    // the scroller was within the auto-follow threshold of the bottom).
    const chat = activeChat();
    if (!chat) return;
    const scroller = document.querySelector('.thread-scroll-region');
    const anchor = scroller instanceof HTMLElement ? captureThreadAnchor(scroller) : null;
    const previousHeight = scroller instanceof HTMLElement ? scroller.scrollHeight : 0;
    const previousTop = scroller instanceof HTMLElement ? scroller.scrollTop : 0;
    uiState.threadWindow ||= {};
    expandThreadWindow(uiState.threadWindow, chat.id, 60);
    render();
    const nextScroller = document.querySelector('.thread-scroll-region');
    if (nextScroller instanceof HTMLElement) {
      if (!(anchor && restoreThreadAnchor(anchor))) {
        nextScroller.scrollTop = previousTop + (nextScroller.scrollHeight - previousHeight);
      }
      uiState.lastKnownScrollTop = nextScroller.scrollTop;
      // Viz cards (if any) hydrate async and grow above the viewport —
      // re-pin once the frame after the swap settles.
      if (anchor) requestAnimationFrame(() => restoreThreadAnchor(anchor));
    }
  },
  'scroll-thread-to-bottom': () => {
    // User clicked the floating "jump to latest" arrow. Re-enable
    // auto-follow so subsequent streaming chunks keep the view pinned to
    // the bottom, and snap to bottom immediately (instant, not smooth —
    // a smooth animation fires scroll events mid-animation that would
    // briefly flip auto-follow back off and make the button flicker).
    uiState.threadAutoFollow = true;
    uiState.lastKnownScrollTop = 0;
    const scroller = document.querySelector('.thread-scroll-region');
    if (scroller instanceof HTMLElement) {
      scroller.scrollTop = scroller.scrollHeight;
    }
    render();
  },
  'speak-message': async ({ trigger }) => {
    await handleSpeakMessage(trigger);
  },
};

// Form submits (formerly `case` branches of app.js's submit listener).
export const chatForms = {};

// app.js's click listener, before the action dispatch (its old position): the
// chat files <summary> must preventDefault synchronously or the <details>
// toggles natively as well, so this stays an early branch, not a registry
// action. Returns true when it handled the click.
export function handleChatFilesToggle(action, trigger, event) {
  if(action==='toggle-chat-files') {event.preventDefault();uiState.chatFilesOpen=!uiState.chatFilesOpen;trigger.parentElement.open=uiState.chatFilesOpen;return true;}
  return false;
}

export { prepareThreadNavigation, updateThreadAutoFollow, syncThreadViewport };
