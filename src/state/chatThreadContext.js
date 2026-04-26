// Chat thread context — Phase 7d-5α-A1 (commit 3/9).
//
// This bundle holds everything desktopStore needs to derive and cache a
// "thread context" for a chat — the structured snapshot of recent
// turns, memory recap, and current user turn that the model and the
// UI both consume. The key entry is `ensureChatThreadContext`, which
// uses a non-enumerable `__threadContext` slot on the chat object as a
// per-chat memo cache so re-derivation only happens when the
// underlying messages actually changed.
//
// Why the bundle: `ensureChatThreadContext` is called from 5 distinct
// sites in desktopStore (persistChatThreads, two memory-summary helpers,
// the conversation-continuity context builder, and the chat execution
// graph). Pulling it out alongside its private cache helpers,
// `buildThreadContextForChat`, `messageTextForContext`, and
// `buildThreadCheckpointPayload` (private to persistChatThreads) keeps
// future commit 4 (`persistChatThreads` proper) and commit 7
// (`hydrateChatThreads`) able to reach this module without bouncing
// back through desktopStore.
//
// Per CLAUDE.md §5, every body below is byte-identical to the
// desktopStore original — only `export` keywords + a file header were
// added. The MAX_CONTEXT_* caps moved with the helpers since they
// would otherwise be orphan constants in desktopStore.

import {
  buildThreadContext as buildStructuredThreadContext,
  renderThreadContext as renderStructuredThreadContext,
  renderThreadMemorySnapshot as renderStructuredThreadMemorySnapshot,
} from '../memory/threadContext.js';
import { normalizeConversationSnippet } from '../memory/heuristics.js';
import { normalizeMessageAttachments } from '../shared/helpers.js';
import { messageVisibleText } from '../services/message/messageBlocks.js';
import { extractedMediaPromptText } from '../services/message/messageSearch.js';
import { summarizeAttachmentsForPrompt } from '../services/chat/messageBuilder.js';

export const MAX_CONTEXT_RECENT_MESSAGES = 8;
export const MAX_CONTEXT_MEMORY_MESSAGES = 24;
export const MAX_CONTEXT_MEMORY_ITEMS = 6;

export function messageTextForContext(message) {
  const attachments = normalizeMessageAttachments(message?.attachments);
  const text = messageVisibleText(message).trim();
  const attachmentSummary = summarizeAttachmentsForPrompt(attachments);
  const mediaSummary = extractedMediaPromptText(message, 2, 240);

  const parts = [text, attachmentSummary, mediaSummary].filter(Boolean);
  if (parts.length) {
    return parts.join('\n');
  }

  return '';
}

export function setChatThreadContextCache(chat, threadContext) {
  if (!chat || typeof chat !== 'object') {
    return;
  }

  Object.defineProperty(chat, '__threadContext', {
    value: threadContext || null,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

export function getChatThreadContextCache(chat) {
  return chat && typeof chat === 'object' ? chat.__threadContext || null : null;
}

export function buildThreadContextForChat(chat, latestUserMessage = '') {
  return buildStructuredThreadContext({
    chat,
    latestUserMessage,
    messageTextResolver: messageTextForContext,
    maxRecentMessages: MAX_CONTEXT_RECENT_MESSAGES,
    maxMemoryMessages: MAX_CONTEXT_MEMORY_MESSAGES,
    maxMemoryItems: MAX_CONTEXT_MEMORY_ITEMS,
  });
}

export function ensureChatThreadContext(chat, latestUserMessage = '') {
  const cached = getChatThreadContextCache(chat);
  const lastMessageId = Array.isArray(chat?.messages) && chat.messages.length
    ? chat.messages[chat.messages.length - 1].id || null
    : null;
  const needsRefresh =
    !cached ||
    cached.derivedFromMessageId !== lastMessageId ||
    (latestUserMessage && cached.currentTurn?.user !== normalizeConversationSnippet(latestUserMessage, 220));

  if (needsRefresh) {
    setChatThreadContextCache(chat, buildThreadContextForChat(chat, latestUserMessage));
  }

  const resolved = getChatThreadContextCache(chat) || buildThreadContextForChat(chat, latestUserMessage);
  setChatThreadContextCache(chat, resolved);
  chat.memorySummary = renderStructuredThreadMemorySnapshot(resolved);
  return resolved;
}

export function buildThreadCheckpointPayload(chat, threadContext) {
  return {
    version: 1,
    threadId: chat.id,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    messages: Array.isArray(chat.messages) ? chat.messages : [],
    derived: {
      threadContext,
      threadContextDerivedFromMessageId: threadContext?.derivedFromMessageId || null,
      memorySummary: renderStructuredThreadMemorySnapshot(threadContext),
      renderedThreadContext: renderStructuredThreadContext(threadContext),
    },
  };
}

// Phase 7d-5δ commit 8c: thin alias originally defined in desktopStore as a
// 3-line helper. byte-for-byte port (CLAUDE.md §5). Lives here because the
// two functions it composes (ensureChatThreadContext and
// renderStructuredThreadMemorySnapshot) are both already imported into
// this module.
export function refreshChatMemorySummary(chat) {
  return renderStructuredThreadMemorySnapshot(ensureChatThreadContext(chat));
}
