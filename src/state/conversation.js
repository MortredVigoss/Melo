// ─── Conversation (chat list) view-model helpers ─────────────────────────────
// Small, pure helpers that turn a persisted chat object into the shape the
// sidebar / chat list UI consumes. These live in the state layer (rather
// than the message service) because they are about the chat *state slice*,
// not individual message normalization — they're concerned with ordering,
// list-item previews, and title fallbacks.
//
// This module owns:
//   - sortChats(chats) — stable reverse-chronological sort by `updatedAt`.
//     Returns a new array; does not mutate input.
//   - summarizeChat(chat) — produce the sidebar-row view model
//     (id/title/projectId/mode/locked/updatedAt/updatedLabel/preview/
//     memorySummary/messageCount). Picks the most recent non-system
//     message for the preview line.
//   - describeChatForLimit(chat) — safe chat-title accessor used when
//     reporting quota/limit errors; falls back to "Untitled chat" for
//     missing or blank titles.
//   - summarizeMessagePreview(message) — produce the short preview text
//     shown under each chat row. Prefers the visible body text, falls back
//     to an attachment summary ("3 attachments · image, audio"), and
//     finally "No messages yet." when the chat is empty.
//
// Extracted from desktopStore.js in Phase 10c refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — depends only on
// `formatUpdatedAt` from shared/helpers and the already-extracted
// messageBlocks service.

import { randomUUID } from 'node:crypto';
import {
  formatUpdatedAt,
  nowIso,
  normalizeAgentStorageId,
} from '../shared/helpers.js';
import {
  normalizePreviewPlainText,
  messageVisibleText,
} from '../services/message/messageBlocks.js';

// `createChatRecord` builds a fresh persistent chat shape with safe
// defaults. Originally lived in desktopStore as a 17-line LOCAL helper
// shared by createChat (UI flow), ensureTelegramChatRecord, and
// ensureDiscordChatRecord. Phase 7d-5ζ moves it here so the polling
// modules can extract without reaching back into desktopStore.
export function createChatRecord({ mode, projectId, agentId }) {
  const timestamp = nowIso();
  return {
    id: randomUUID(),
    title: 'New chat',
    mode,
    projectId: projectId || null,
    agentId: agentId ? normalizeAgentStorageId(agentId) : 'main',
    source: 'desktop',
    externalThreadKey: '',
    locked: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    memorySummary: '',
    messages: [],
  };
}

export function sortChats(chats) {
  return [...chats].sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  );
}

export function summarizeChat(chat) {
  const lastMessage = [...chat.messages].reverse().find(message => message.role !== 'system');
  return {
    id: chat.id,
    title: chat.title,
    projectId: chat.projectId || null,
    mode: chat.mode,
    locked: Boolean(chat.locked),
    updatedAt: chat.updatedAt,
    updatedLabel: formatUpdatedAt(chat.updatedAt),
    preview: summarizeMessagePreview(lastMessage),
    memorySummary: chat.memorySummary || '',
    messageCount: chat.messages.length,
  };
}

export function describeChatForLimit(chat) {
  return String(chat?.title || 'Untitled chat').trim() || 'Untitled chat';
}

export function summarizeMessagePreview(message) {
  if (!message) {
    return 'No messages yet.';
  }

  const visibleContent = normalizePreviewPlainText(messageVisibleText(message));
  if (visibleContent) {
    return visibleContent.slice(0, 140);
  }

  if (message.attachments?.length) {
    const kinds = [...new Set(message.attachments.map(attachment => attachment.kind))];
    return `${message.attachments.length} attachment${message.attachments.length === 1 ? '' : 's'} · ${kinds.join(', ')}`;
  }

  return 'No messages yet.';
}
