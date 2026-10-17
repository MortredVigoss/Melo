// ─── Message search text helpers ─────────────────────────────────────────────
// Pure helpers that flatten a message (or one of its attachments) into a
// plain-text blob that the in-app search + memory layers can tokenize.
// These are separated from messageBlocks.js because they pull in the media /
// attachment layers — keeping the block/markdown module dependency-free.
//
// This module owns:
//   - attachmentSearchText(attachment) — title + filename + url + mime + size
//     joined newline-separated; URL is always included so audio/link
//     attachments remain findable before media extraction completes
//   - extractedMediaPromptText(message, maxItems, maxCharsPerItem) — thin
//     wrapper around renderExtractedMediaContext with conservative caps used
//     when injecting media into user prompts
//   - stripInvisibleSearchDecorators(value) — drop code fences but keep their
//     contents, then collapse to a single-line preview (for search indexing
//     where newlines/markdown decorators are noise)
//   - messageSearchText(message) — full combined plain text: visible message
//     text + attachment text + extracted media text
//
// Extracted from desktopStore.js in the Phase 9e refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — composition-only, just
// wires together helpers from messageBlocks, media, and shared.

import {
  messageVisibleText,
  normalizePreviewPlainText,
} from './messageBlocks.js';
import {
  extractedMediaSearchText,
  renderExtractedMediaContext,
} from '../media/extractedMedia.js';
import { normalizeMessageAttachments } from '../../shared/helpers.js';

export function attachmentSearchText(attachment) {
  return [
    attachment?.title,
    attachment?.fileName,
    // Include the URL for all attachment kinds so audio/video/link
    // attachments are still findable by their source URL even when
    // media extraction has not completed or failed.
    attachment?.url || '',
    attachment?.mimeType,
    attachment?.sizeLabel,
  ]
    .filter(Boolean)
    .join('\n');
}

export function extractedMediaPromptText(message, maxItems = 3, maxCharsPerItem = 400) {
  return renderExtractedMediaContext(message?.extractedMedia, {
    maxItems,
    maxCharsPerItem,
  });
}

export function stripInvisibleSearchDecorators(value = '') {
  return normalizePreviewPlainText(
    String(value || '').replace(/```[\w.+-]*\n([\s\S]*?)```/g, '$1'),
  );
}

export function messageSearchText(message) {
  const attachmentText = normalizeMessageAttachments(message?.attachments)
    .map(attachmentSearchText)
    .filter(Boolean)
    .join('\n');
  const mediaText = extractedMediaSearchText(message?.extractedMedia);

  return [
    messageVisibleText(message),
    attachmentText,
    mediaText,
  ]
    .filter(Boolean)
    .join('\n');
}
