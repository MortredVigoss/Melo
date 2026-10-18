// desktop-ui/threadWindow.js
//
// Long-thread render window (design audit L2, 2026-10-17).
//
// `renderMessageList` used to turn EVERY message of the active chat into HTML
// on every non-delta render — 1000-message threads scaled linearly on each
// streaming frame / autosave / runtime poll. This module decides which slice
// of `chat.messages` actually gets rendered:
//
//   - by default only the last THREAD_RENDER_WINDOW (60) messages;
//   - plus whatever the user has expanded via the "加载更早" button, tracked
//     per chatId in a tiny state map (`expandThreadWindow`);
//   - the window is always extended to include a highlighted message
//     (search hit / quote jump) and any explicitly pinned ids (e.g. a message
//     that is still streaming), so navigation never lands on a missing node.
//
// Pure functions + a plain object for state; no DOM. Tested without jsdom in
// threadWindow.test.js.

export const THREAD_RENDER_WINDOW = 60;

function normalizeCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function extraFor(state, chatId) {
  if (!state || typeof state !== 'object' || !chatId) return 0;
  return normalizeCount(state[chatId]);
}

/**
 * Grow the render window for `chatId` by `by` messages (default 60).
 * Mutates `state` in place and returns the new extra count for the chat.
 * Other chats are untouched.
 */
export function expandThreadWindow(state, chatId, by = THREAD_RENDER_WINDOW) {
  if (!state || typeof state !== 'object' || !chatId) return 0;
  const next = extraFor(state, chatId) + normalizeCount(by);
  state[chatId] = next;
  return next;
}

/**
 * Make sure the window for `chatId` is wide enough that `messageId` (an
 * element of `messages`) is inside it, persisting the expansion into
 * `state`. Returns true when the message exists (visible after this call),
 * false when the id isn't in `messages` at all.
 */
export function ensureMessageInThreadWindow(state, chatId, messages, messageId) {
  const list = Array.isArray(messages) ? messages : [];
  if (!messageId) return false;
  const index = list.findIndex(message => message && message.id === messageId);
  if (index < 0) return false;
  const needed = list.length - index; // how many tail messages include it
  const current = THREAD_RENDER_WINDOW + extraFor(state, chatId);
  if (needed > current) {
    expandThreadWindow(state, chatId, needed - current);
  }
  return true;
}

/**
 * Compute the slice of `messages` to render.
 *
 * @param {Array} messages            full chat.messages (oldest → newest)
 * @param {object} options
 * @param {string} options.chatId
 * @param {object} options.state       per-chat extra counts, see expandThreadWindow
 * @param {string|null} options.highlightedMessageId  message that must be in view
 * @param {string[]} [options.pinnedMessageIds]       extra ids that must be in view
 *                                                    (e.g. the streaming message)
 * @param {number} [options.windowSize]               override of THREAD_RENDER_WINDOW
 * @returns {{ messages: Array, hiddenCount: number, startIndex: number, total: number }}
 */
export function visibleMessageWindow(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const total = list.length;
  const {
    chatId = null,
    state = null,
    highlightedMessageId = null,
    pinnedMessageIds = [],
    windowSize = THREAD_RENDER_WINDOW,
  } = options || {};

  const base = normalizeCount(windowSize) || THREAD_RENDER_WINDOW;
  let count = Math.min(total, base + extraFor(state, chatId));

  // The newest message (the one a reply streams into) is always inside a
  // tail slice, but a caller may also pin arbitrary ids — a highlighted
  // search hit, a quoted message, a message still being streamed into.
  const mustInclude = [highlightedMessageId, ...(Array.isArray(pinnedMessageIds) ? pinnedMessageIds : [])]
    .filter(Boolean);
  if (mustInclude.length && count < total) {
    const wanted = new Set(mustInclude);
    for (let index = 0; index < total; index += 1) {
      const message = list[index];
      if (message && wanted.has(message.id)) {
        count = Math.max(count, total - index);
        break; // first (oldest) match is the one that widens the window most
      }
    }
  }

  const startIndex = total - count;
  return {
    messages: startIndex === 0 ? list.slice() : list.slice(startIndex),
    hiddenCount: startIndex,
    startIndex,
    total,
  };
}
