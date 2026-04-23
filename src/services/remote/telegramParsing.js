// ─── Telegram message parsing ────────────────────────────────────────────────
// Turn raw Telegram Bot API updates into Melo's own incoming-message shape,
// with attachments resolved to fetchable URLs. No state — everything reads
// from the passed-in `channel`/`message`/`update` and returns new objects.
//
// This module owns:
//   - resolveTelegramFileAttachment — (channel, fileId, template) → resolved
//     attachment with a public URL via buildTelegramFileUrl(getFile → file_path)
//   - extractTelegramAttachments — walk every well-known Telegram attachment
//     field (photo / document / video / audio / voice / video_note / animation)
//     and resolve each to a normalizeMessageAttachments() entry
//   - buildTelegramThreadKey — deterministic (agentId, chatId, threadId) →
//     "telegram:<agent>:<chat>[:thread]" key used as externalThreadKey on the
//     stored chat
//   - latestProcessableTelegramText — the gatekeeper: given a Telegram update,
//     return either null ("ignore this one") or the fully-normalized
//     "incoming" envelope used by the routing / scoring layer
//
// Extracted from desktopStore.js in the Phase 5c refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module: only imports from the
// already-extracted telegramApi.js and the shared helpers module.

import {
  telegramApiRequest,
  buildTelegramFileUrl,
} from './telegramApi.js';
import {
  nowIso,
  normalizeAgentStorageId,
  normalizeMessageAttachments,
} from '../../shared/helpers.js';

export async function resolveTelegramFileAttachment(channel, fileId, attachment = {}) {
  const normalizedFileId = String(fileId || '').trim();
  if (!normalizedFileId) {
    return null;
  }

  try {
    const payload = await telegramApiRequest(channel, 'getFile', {
      searchParams: {
        file_id: normalizedFileId,
      },
      timeoutMs: 10000,
    });
    const filePath = String(payload?.result?.file_path || '').trim();
    const url = buildTelegramFileUrl(channel, filePath);
    if (!url) {
      return null;
    }

    return normalizeMessageAttachments([
      {
        ...attachment,
        url,
      },
    ])[0] || null;
  } catch {
    return null;
  }
}

export async function extractTelegramAttachments(message, channel) {
  if (!message || !channel) {
    return [];
  }

  const attachments = [];
  const photos = Array.isArray(message?.photo) ? message.photo : [];
  if (photos.length) {
    const largestPhoto = photos[photos.length - 1];
    const attachment = await resolveTelegramFileAttachment(channel, largestPhoto?.file_id, {
      kind: 'image',
      title: 'Telegram photo',
      mimeType: 'image/jpeg',
      fileName: 'telegram-photo.jpg',
    });
    if (attachment) {
      attachments.push(attachment);
    }
  }

  if (message?.document?.file_id) {
    const mimeType = String(message.document.mime_type || '').trim();
    const attachment = await resolveTelegramFileAttachment(channel, message.document.file_id, {
      kind: mimeType.startsWith('image/')
        ? 'image'
        : mimeType.startsWith('video/')
          ? 'video'
          : mimeType.startsWith('audio/')
            ? 'audio'
            : 'link',
      title: message.document.file_name || 'Telegram document',
      mimeType,
      fileName: String(message.document.file_name || '').trim(),
    });
    if (attachment) {
      attachments.push(attachment);
    }
  }

  if (message?.video?.file_id) {
    const attachment = await resolveTelegramFileAttachment(channel, message.video.file_id, {
      kind: 'video',
      title: 'Telegram video',
      mimeType: String(message.video.mime_type || 'video/mp4').trim(),
      fileName: String(message.video.file_name || '').trim(),
    });
    if (attachment) {
      attachments.push(attachment);
    }
  }

  if (message?.audio?.file_id) {
    const attachment = await resolveTelegramFileAttachment(channel, message.audio.file_id, {
      kind: 'audio',
      title: message.audio.title || 'Telegram audio',
      mimeType: String(message.audio.mime_type || '').trim(),
      fileName: String(message.audio.file_name || '').trim(),
    });
    if (attachment) {
      attachments.push(attachment);
    }
  }

  if (message?.voice?.file_id) {
    const attachment = await resolveTelegramFileAttachment(channel, message.voice.file_id, {
      kind: 'audio',
      title: 'Telegram voice note',
      mimeType: String(message.voice.mime_type || 'audio/ogg').trim(),
      fileName: 'telegram-voice.ogg',
    });
    if (attachment) {
      attachments.push(attachment);
    }
  }

  // Circular video clips recorded in-app (hold camera button)
  if (message?.video_note?.file_id) {
    const attachment = await resolveTelegramFileAttachment(channel, message.video_note.file_id, {
      kind: 'video',
      title: 'Telegram video note',
      mimeType: 'video/mp4',
      fileName: 'telegram-videonote.mp4',
    });
    if (attachment) {
      attachments.push(attachment);
    }
  }

  // Animated GIFs sent as animation (Telegram converts them to silent mp4)
  if (message?.animation?.file_id) {
    const mimeType = String(message.animation.mime_type || 'video/mp4').trim();
    const attachment = await resolveTelegramFileAttachment(channel, message.animation.file_id, {
      kind: 'video',
      title: message.animation.file_name || 'Telegram animation',
      mimeType,
      fileName: String(message.animation.file_name || 'telegram-animation.mp4').trim(),
    });
    if (attachment) {
      attachments.push(attachment);
    }
  }

  return normalizeMessageAttachments(attachments);
}

export function buildTelegramThreadKey(agentId, remoteChatId, messageThreadId = null) {
  const suffix =
    Number.isFinite(Number(messageThreadId)) && Number(messageThreadId) > 0
      ? `:${Number(messageThreadId)}`
      : '';
  return `telegram:${normalizeAgentStorageId(agentId)}:${String(remoteChatId)}${suffix}`;
}

export async function latestProcessableTelegramText(update, channel) {
  const message = update?.message || update?.edited_message;
  if (!message || message?.from?.is_bot) {
    return null;
  }

  const attachments = await extractTelegramAttachments(message, channel);
  const text = String(message?.text || message?.caption || '').trim();
  if (!text && !attachments.length) {
    return null;
  }

  const from = message?.from || {};
  const chat = message?.chat || {};
  const senderName =
    [from.first_name, from.last_name].filter(Boolean).join(' ').trim() ||
    from.username ||
    (from.id ? `user_${from.id}` : 'Unknown user');
  const replyToMessage = message?.reply_to_message || null;
  const repliedToText = String(
    replyToMessage?.text || replyToMessage?.caption || '',
  ).trim();

  return {
    text,
    attachments,
    // True when the incoming Telegram message was a voice note (audio recorded in-app).
    // Used to auto-trigger voice reply even if the text transcription arrived instead.
    wasVoiceMessage: Boolean(message?.voice?.file_id || message?.audio?.file_id),
    chatId: String(chat?.id || '').trim(),
    chatType: typeof chat?.type === 'string' && chat.type.trim() ? chat.type.trim() : 'private',
    chatTitle: typeof chat?.title === 'string' ? chat.title.trim() : '',
    senderId: String(from?.id || '').trim(),
    senderName,
    senderUsername: typeof from?.username === 'string' ? from.username.trim() : '',
    isReplyToBot: Boolean(replyToMessage?.from?.is_bot),
    repliedToMessageId:
      Number.isFinite(Number(replyToMessage?.message_id)) && Number(replyToMessage.message_id) > 0
        ? Number(replyToMessage.message_id)
        : null,
    repliedToText,
    messageId:
      Number.isFinite(Number(message?.message_id)) && Number(message.message_id) > 0
        ? Number(message.message_id)
        : null,
    messageThreadId:
      Number.isFinite(Number(message?.message_thread_id)) && Number(message.message_thread_id) > 0
        ? Number(message.message_thread_id)
        : null,
    receivedAt:
      Number.isFinite(Number(message?.date)) && Number(message.date) > 0
        ? new Date(Number(message.date) * 1000).toISOString()
        : nowIso(),
  };
}
