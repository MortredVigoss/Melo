// Build the model-facing message window from a chat object.
//
// This is sub-phase 7d-1 of the desktopStore decomposition: pull the pure
// "chat → array of { role, content } messages the model sees" pipeline out
// of desktopStore. That pipeline comprises:
//
//   1. A token-bounded sliding window over recent messages, anchored at
//      whatever compact boundary the memory subsystem established.
//   2. Rich-media carry-forward: if the *latest* user turn is a short
//      follow-up like "放大看一下" / "transcribe this", and the previous
//      user turn carried an image / audio / video / link, splice that
//      media into the latest turn so the model can reason about it.
//   3. Historical rich-media stripping: older user turns get their heavy
//      attachments dropped before they hit the window, so we don't resend
//      megabytes of images every turn for no reason.
//   4. Serialization: each message becomes a { role, content } pair where
//      content is either a plain string (text-only) or a structured multi-
//      part array (text + attachments + extracted-media context).
//
// Everything here is pure. `chat` and `message` shapes are read; no state
// mutation, no I/O. Tests inject in-memory chat fixtures — no desktopStore
// boot required.
//
// Callers: desktopStore.buildModelMessagesFromChat re-exports the entry
// point; future chatExecutionService (sub-phase 7d-5) will consume it
// directly.

import { buildRecentWindow } from '../../memory/contextCompact.js';
import {
  normalizeMessageAttachments,
  titleCase,
} from '../../shared/helpers.js';
import {
  normalizeExtractedMedia,
  renderExtractedMediaContext,
} from '../../media/index.js';
import { messageVisibleText } from '../message/messageBlocks.js';

// ────────────────────────────────────────────────────────────────────────────
// Attachment classification constants
// ────────────────────────────────────────────────────────────────────────────

// URL schemes the model is actually able to consume for each media kind.
// Anything outside these patterns (local file paths, signed-but-expired
// workspace URLs, base64-less data URIs) gets dropped rather than handed
// to the model half-broken.
export const MODEL_IMAGE_ATTACHMENT_PATTERN = /^(https?:\/\/|data:image\/)/i;
export const MODEL_AUDIO_ATTACHMENT_PATTERN = /^(https?:\/\/|data:audio\/)/i;
export const MODEL_VIDEO_ATTACHMENT_PATTERN = /^(https?:\/\/|data:video\/)/i;
export const MODEL_LINK_ATTACHMENT_PATTERN = /^https?:\/\//i;

export const RICH_MEDIA_ATTACHMENT_KINDS = new Set(['image', 'audio', 'video', 'link']);

// ────────────────────────────────────────────────────────────────────────────
// Follow-up detection patterns (EN + ZH)
// ────────────────────────────────────────────────────────────────────────────
//
// When a user says "放大看一下" with no attachments in this turn but the
// previous turn had an image, we want to carry the image forward so the
// model can actually respond. These patterns define what "clearly a
// follow-up about the previous media" looks like.

// NOTE: the `\b...\b` wrappers around the English alternation are
// load-bearing. Without them, `photo` inside the group would match
// `photography`, `photographic`, etc., spuriously triggering the carry-
// forward and dragging an old image into an unrelated next turn. This was
// the exact regression Codex flagged when reviewing the 7d-1 extraction —
// the original desktopStore pattern had them; I dropped them by accident
// during the copy and restored them before committing the tests below.
//
// Tightened 2026-04-30 (Codex review round): the previous extension also
// had bare CJK verbs like 改成/换成/去掉/换掉/加上/再改/让X更. Those
// were false-positives in code/text follow-ups — a user who saw an image
// last turn then asked "把这个函数改成 async" would have the image
// carried forward AND the fast-path fire on it. Carry-forward MUST stay
// strict: the trigger has to mention an image OBJECT, not just an edit
// verb. Anything that doesn't unambiguously reference a picture lives
// in IMAGE_EDIT_INTENT_PATTERN instead, where it's only consulted
// alongside an explicit image-object check at the fast-path dispatcher.
//
// Allowed phrasings (every entry below must unambiguously refer to a
// PICTURE — never a CSS file, a Button.jsx component, a Markdown
// document, or a layout viewport):
//
//   English image-object words: image / photo / picture / screenshot
//   Image-only verbs: recolor / retouch / crop (these are simply not
//     used outside of image work — "let's recolor the variable" isn't
//     idiomatic; "let's crop the function" isn't either)
//   Explicit-object English: 'edit the (image|photo|picture|screenshot)',
//     'this/that (image|photo|picture|screenshot)', 'look at the …'
//   Image-leaning brightness adjectives: make it (brighter|darker)
//     (not used in CSS/layout in practice; we WOULD see "make the
//     viewport smaller" or "make it more responsive", which DON'T
//     match because we no longer accept bare make-it-smaller/larger)
//   CJK image-specific verbs: 换背景 / 换色 / 换底色 / 抠图 / 抠掉 /
//     裁切 / 抹掉 / 调亮 / 调暗 / 这张图.* / 那张图.* (rarely used
//     outside image work)
//
// Removed in earlier rounds (now lives in IMAGE_EDIT_INTENT_PATTERN
// only — too ambiguous for carry-forward):
//   CJK: 改成 / 换成 / 换一下 / 换个色 / 换个背景 / 换个 / 去掉 /
//        换掉 / 加上 / 加个 / 再改 / 让.{0,5}更 / 让.{0,5}变
//
// Removed in THIS round (Codex review round 6, 2026-04-30) — would
// false-positive on CSS / UI / layout follow-ups when the previous
// turn happened to have an image (e.g. user shared a screenshot then
// asked about CSS):
//   English: 'change the (color|background|font|style)' — common in
//     CSS / theming / component questions
//   English: 'make it (smaller|larger|more|less)' — common in
//     viewport / layout / sizing questions
//
// The dropped English phrases are still valid edit-intent signals,
// just not by themselves enough to drag an image into the next turn.
// Users who want fast-path on those need to add an explicit image
// word ('change the background of this photo' still fires because of
// 'this photo').
export const IMAGE_FOLLOW_UP_PATTERN = /(?:\b(?:image|photo|picture|screenshot|screen shot|zoom in|look at (?:the )?(?:image|photo|picture|screenshot)|what(?:'s| is)? in(?:side)? (?:the )?(?:image|photo|picture|screenshot)|this (?:image|photo|picture|screenshot)|that (?:image|photo|picture|screenshot)|what about this (?:image|photo|picture|screenshot)|what about that (?:image|photo|picture|screenshot)|recolor(?:ed|ing)?|retouch(?:ed|ing)?|crop(?:ped|ping)?|edit (?:the |this |that )?(?:image|photo|picture|screenshot)|make it (?:brighter|darker))\b|图片|照片|截图|看图|图里|这张图|那张图|放大|看清|再看一下|里面有什么|里面写了什么|图里有什么|图里写了什么|上面写了什么|换背景|换色|换底色|抠图|抠掉|裁切|抹掉|调亮|调暗|这张图改|那张图改|这张图换|那张图换|这张图加|这张图去掉)/iu;

// Image-edit intent detector. Used by chatExecutionRunner's fast-path to
// short-circuit the agent loop when (Codex auth + has input image +
// edit intent + workspace) all hold. Permissive on purpose: the AND with
// hasInputImage upstream is what protects against false positives, so
// generic edit verbs ("modify the colors", "swap with X") are fair game
// here — they would NOT have triggered carry-forward (different gate),
// but with an image already present they are clearly edit asks.
export const IMAGE_EDIT_INTENT_PATTERN = /(?:\b(?:edit(?:ed|ing|s)?|change(?:d|s|ing)?|modify|modified|modifies|modifying|replace(?:d|s|ing)?|swap(?:ped|s|ping)?|recolor(?:ed|ing|s)?|retouch(?:ed|ing|es)?|crop(?:ped|s|ping)?|redraw(?:n|s|ing)?|redrew|remove (?:the |this |that )?|add (?:a |the )?|put (?:a |the |some )|make it|turn it into|paint over)\b|改成|改一下|再改|换成|换色|换背景|换一下|换个色|换个|去掉|加上|加个|抠图|抠掉|裁切|裁掉|抹掉|调亮|调暗|调一下|修改|编辑|变成|弄成|做成|搞成|涂掉|擦掉|删掉|换掉|改掉|让.{0,5}更|让.{0,5}变)/iu;

/**
 * Returns true when the given text reads as an image-edit request. Cheap
 * regex check — no LLM call. Designed to be combined upstream with a
 * "does this conversation have an input image?" check via AND, so
 * false positives are bounded to actual image-bearing turns.
 */
export function detectImageEditIntent(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  return IMAGE_EDIT_INTENT_PATTERN.test(text);
}
export const AUDIO_FOLLOW_UP_PATTERN = /(?:\b(?:audio|voice|recording|recordings|voice note|voicemail|transcript|transcribe|what(?:'s| is) being said|what did (?:he|she|they) say|listen to (?:it|this)|what does the audio say)\b|语音|音频|录音|这段语音|这段音频|这段录音|录音里|语音里|音频里|说了什么|讲了什么|转写|听一下|听听|再听一下)/i;
export const VIDEO_FOLLOW_UP_PATTERN = /(?:\b(?:video|clip|footage|scene|what(?:'s| is) in the video|what does the video say|what happens in the video|watch (?:it|this))\b|视频|录像|片段|这段视频|这个视频|视频里|画面里|视频说了什么|视频讲了什么|视频里有什么|再看一下视频)/i;
export const LINK_FOLLOW_UP_PATTERN = /(?:\b(?:link|url|article|page|webpage|website|site|post|post says|summari[sz]e (?:this|that) link|what does this link say|what does the article say|what is on the page)\b|链接|这个链接|那个链接|链接里|文章里|网页里|页面里|这篇文章|这个页面|这个网页|总结一下链接|链接讲了什么|文章讲了什么|页面讲了什么)/i;

// ────────────────────────────────────────────────────────────────────────────
// Attachment summarization
// ────────────────────────────────────────────────────────────────────────────

/**
 * Plain-text summary of a list of attachments, suitable for inclusion in a
 * prompt. One line per attachment: `- Image: label (url)`. Data URIs get
 * their URL omitted so we don't splatter base64 into the prompt.
 */
export function summarizeAttachmentsForPrompt(attachments = []) {
  if (!attachments.length) return '';
  return attachments
    .map(attachment => {
      const label =
        attachment.title ||
        attachment.fileName ||
        `${titleCase(attachment.kind)} attachment`;
      const printableUrl =
        attachment.url && !attachment.url.startsWith('data:')
          ? ` (${attachment.url})`
          : '';
      return `- ${titleCase(attachment.kind)}: ${label}${printableUrl}`;
    })
    .join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// Rich-media filtering
// ────────────────────────────────────────────────────────────────────────────

/**
 * Return the subset of `message.attachments` that the model can actually
 * consume — rich-media kinds (image / audio / video / link) whose URL
 * matches the appropriate scheme pattern.
 */
export function modelRichMediaAttachments(message) {
  return normalizeMessageAttachments(message?.attachments).filter(attachment => {
    const kind = String(attachment?.kind || '').toLowerCase();
    if (!RICH_MEDIA_ATTACHMENT_KINDS.has(kind)) return false;

    const url = String(attachment?.url || '');
    if (kind === 'image') return MODEL_IMAGE_ATTACHMENT_PATTERN.test(url);
    if (kind === 'audio') return MODEL_AUDIO_ATTACHMENT_PATTERN.test(url);
    if (kind === 'video') return MODEL_VIDEO_ATTACHMENT_PATTERN.test(url);
    if (kind === 'link') return MODEL_LINK_ATTACHMENT_PATTERN.test(url);
    return false;
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Follow-up carry-forward detection
// ────────────────────────────────────────────────────────────────────────────

export function followUpPatternForSourceMessage(sourceMessage) {
  const attachments = modelRichMediaAttachments(sourceMessage);
  const kinds = new Set(attachments.map(a => String(a?.kind || '').toLowerCase()));
  if (kinds.has('image')) return IMAGE_FOLLOW_UP_PATTERN;
  if (kinds.has('audio')) return AUDIO_FOLLOW_UP_PATTERN;
  if (kinds.has('video')) return VIDEO_FOLLOW_UP_PATTERN;
  if (kinds.has('link'))  return LINK_FOLLOW_UP_PATTERN;
  return null;
}

/**
 * True when the latest user turn is a short follow-up clearly referring to
 * media attached in an earlier (nearby) turn. Capped at 4 turns back so a
 * reference to "that image" doesn't reach all the way to an unrelated
 * image from 20 turns ago.
 */
export function shouldCarryForwardRecentMedia(messages, latestIndex, sourceIndex) {
  if (latestIndex <= 0 || sourceIndex < 0 || sourceIndex >= latestIndex) return false;
  if (latestIndex - sourceIndex > 4) return false;

  const latestText = messageVisibleText(messages[latestIndex]).trim();
  if (!latestText) return false;

  const followUpPattern = followUpPatternForSourceMessage(messages[sourceIndex]);
  return followUpPattern ? followUpPattern.test(latestText) : false;
}

// ────────────────────────────────────────────────────────────────────────────
// Rich-media merge / strip
// ────────────────────────────────────────────────────────────────────────────

/**
 * Clone `message` with `sourceMessage`'s rich-media attachments + extracted
 * media spliced in, deduplicated against whatever's already on the target.
 * Used when carrying media forward into a follow-up turn.
 */
export function mergeRichMediaContextIntoMessage(message, sourceMessage) {
  const targetAttachments = normalizeMessageAttachments(message?.attachments);
  const sourceMediaAttachments = modelRichMediaAttachments(sourceMessage);

  const seenUrls = new Set(
    targetAttachments
      .filter(a => RICH_MEDIA_ATTACHMENT_KINDS.has(String(a?.kind || '').toLowerCase()))
      .map(a => String(a.url || '').trim())
      .filter(Boolean),
  );
  const mergedMediaAttachments = sourceMediaAttachments.filter(a => {
    const url = String(a.url || '').trim();
    return url && !seenUrls.has(url);
  });

  const targetExtractedMedia = normalizeExtractedMedia(message?.extractedMedia);
  const sourceExtractedMedia = normalizeExtractedMedia(sourceMessage?.extractedMedia);
  const seenKeys = new Set(
    targetExtractedMedia.map(entry =>
      `${entry.attachmentId || ''}::${entry.kind}::${String(entry.text || '').slice(0, 120)}`,
    ),
  );
  const mergedExtractedMedia = sourceExtractedMedia.filter(entry => {
    const key = `${entry.attachmentId || ''}::${entry.kind}::${String(entry.text || '').slice(0, 120)}`;
    return !seenKeys.has(key);
  });

  if (!mergedMediaAttachments.length && !mergedExtractedMedia.length) return message;

  return {
    ...message,
    attachments: [...targetAttachments, ...mergedMediaAttachments],
    extractedMedia: [...targetExtractedMedia, ...mergedExtractedMedia],
  };
}

/**
 * Clone `message` with all rich-media attachments + extracted-media entries
 * stripped. Applied to historical user turns before they enter the model
 * window so we don't resend the same image / audio / video every turn.
 */
export function stripHistoricalRichMediaFromMessage(message) {
  const attachments = normalizeMessageAttachments(message?.attachments);
  const richAttachments = attachments.filter(a =>
    RICH_MEDIA_ATTACHMENT_KINDS.has(String(a?.kind || '').toLowerCase()),
  );
  const hasExtractedMedia = normalizeExtractedMedia(message?.extractedMedia).length > 0;
  if (!richAttachments.length && !hasExtractedMedia) return message;

  return {
    ...message,
    attachments: attachments.filter(a =>
      !RICH_MEDIA_ATTACHMENT_KINDS.has(String(a?.kind || '').toLowerCase()),
    ),
    extractedMedia: [],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Message → model content serialization
// ────────────────────────────────────────────────────────────────────────────

/**
 * Convert a single chat message into the `content` field of the model
 * message payload. Text-only messages become a plain string; anything
 * with attachments or extracted media returns a structured array of
 * content parts the model can render.
 *
 * This is a faithful port of the original desktopStore implementation —
 * intro-text fallback phrasing, nested `audio_attachment` / `video_attachment`
 * wrapper shape, "Additional attachments:" label, and single-text-part
 * collapse behavior are all preserved so callers see identical output.
 */
export function messageToModelContent(message, { includeSenderPrefix = false } = {}) {
  const attachments = normalizeMessageAttachments(message?.attachments);
  const extractedMedia = normalizeExtractedMedia(message?.extractedMedia);
  const senderPrefix =
    includeSenderPrefix && message?.role === 'user' && message?.senderName
      ? `[${message.senderName}]: `
      : '';
  const text = `${senderPrefix}${messageVisibleText(message).trim()}`.trim();
  if (!attachments.length && !extractedMedia.length) {
    return text;
  }

  const contentParts = [];
  const imageAttachments = attachments.filter(attachment =>
    attachment.kind === 'image' &&
    /^(https?:\/\/|data:image\/)/i.test(attachment.url),
  );
  const audioAttachments = attachments.filter(attachment =>
    attachment.kind === 'audio' &&
    /^(https?:\/\/|data:audio\/)/i.test(attachment.url),
  );
  const videoAttachments = attachments.filter(attachment =>
    attachment.kind === 'video' &&
    /^(https?:\/\/|data:video\/)/i.test(attachment.url),
  );
  const nonImageAttachments = attachments.filter(attachment => attachment.kind !== 'image');
  const attachmentSummary = summarizeAttachmentsForPrompt(nonImageAttachments);
  const mediaContext = renderExtractedMediaContext(extractedMedia, {
    maxItems: 4,
    maxCharsPerItem: 1400,
  });

  const introText = text ||
    (imageAttachments.length
      ? 'Please consider the attached image context.'
      : 'Please consider the attached context.');
  if (introText) {
    contentParts.push({ type: 'text', text: introText });
  }

  for (const attachment of imageAttachments) {
    contentParts.push({
      type: 'image_url',
      image_url: {
        url: attachment.url,
      },
    });
  }

  for (const attachment of audioAttachments) {
    contentParts.push({
      type: 'audio_attachment',
      audio_attachment: {
        url: attachment.url,
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
      },
    });
  }

  for (const attachment of videoAttachments) {
    // Phase 2: if videoExtractor managed to pull keyframes for this attachment,
    // emit them as image_url parts so the model actually sees the picture
    // (alongside the transcript that lands as text via mediaContext below).
    // Falls back gracefully when no keyframes were captured (no ffmpeg, very
    // short clip, ffprobe failure, etc.) — model just gets the transcript.
    const matchedEntry = extractedMedia.find(
      e => e?.attachmentId && attachment.id && e.attachmentId === attachment.id,
    );
    const keyframes = Array.isArray(matchedEntry?.metadata?.keyframes)
      ? matchedEntry.metadata.keyframes
      : [];
    for (const dataUrl of keyframes) {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) continue;
      contentParts.push({
        type: 'image_url',
        image_url: { url: dataUrl },
      });
    }

    contentParts.push({
      type: 'video_attachment',
      video_attachment: {
        url: attachment.url,
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
      },
    });
  }

  if (attachmentSummary) {
    contentParts.push({
      type: 'text',
      text: `Additional attachments:\n${attachmentSummary}`,
    });
  }

  if (mediaContext) {
    contentParts.push({
      type: 'text',
      text: mediaContext,
    });
  }

  return contentParts.length === 1 && contentParts[0].type === 'text'
    ? contentParts[0].text
    : contentParts;
}

// ────────────────────────────────────────────────────────────────────────────
// The main entry point: build a model-ready message window from a chat
// ────────────────────────────────────────────────────────────────────────────

/**
 * Produce the array of `{ role, content }` messages the model should see
 * for a given chat. Applies:
 *   - compact-boundary anchoring (drops already-summarised history),
 *   - token-bounded sliding window,
 *   - rich-media carry-forward from a nearby prior user turn when the
 *     latest turn is a follow-up without its own media,
 *   - historical rich-media stripping for older user turns.
 */
export function buildModelMessagesFromChat(chat) {
  const isGroupChat = chat?.chatType === 'group' || chat?.chatType === 'supergroup';
  const allMessages = Array.isArray(chat?.messages) ? chat.messages : [];

  // Token-bounded sliding window (replaces the old hard slice(-12)). When a
  // compact summary exists, only consider messages AFTER the compact
  // boundary so we don't re-send already-summarised history.
  let candidateMessages = allMessages;
  const boundaryId = chat?.compactBoundaryMessageId;
  if (boundaryId) {
    const boundaryIdx = allMessages.findIndex(m => m.id === boundaryId);
    if (boundaryIdx >= 0) {
      candidateMessages = allMessages.slice(boundaryIdx + 1);
    }
  }

  const messages = buildRecentWindow(candidateMessages);

  const latestIndex = messages.length - 1;
  let carryForwardSourceIndex = -1;

  if (latestIndex >= 0 && messages[latestIndex]?.role === 'user') {
    const latestMedia = modelRichMediaAttachments(messages[latestIndex]);
    if (!latestMedia.length) {
      for (let index = latestIndex - 1; index >= 0; index -= 1) {
        if (messages[index]?.role !== 'user') continue;
        if (!modelRichMediaAttachments(messages[index]).length) continue;
        carryForwardSourceIndex = shouldCarryForwardRecentMedia(messages, latestIndex, index)
          ? index
          : -1;
        break;
      }
    }
  }

  return messages.map((message, index) => {
    let effectiveMessage = message;
    if (index === latestIndex && message?.role === 'user' && carryForwardSourceIndex >= 0) {
      effectiveMessage = mergeRichMediaContextIntoMessage(message, messages[carryForwardSourceIndex]);
    } else if (index !== latestIndex && message?.role === 'user') {
      effectiveMessage = stripHistoricalRichMediaFromMessage(message);
    }
    return {
      role: message.role,
      content: messageToModelContent(effectiveMessage, { includeSenderPrefix: isGroupChat }),
    };
  });
}

