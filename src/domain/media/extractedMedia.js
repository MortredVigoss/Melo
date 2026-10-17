// Pure extracted-media helpers — byte-for-byte extraction from
// src/media/index.js (2026-10-17 audit A-4): domain/message/messageSearch.js
// needed only these text helpers but pulled the whole media extraction stack
// (and through it services/search) into the domain layer. media/index.js
// re-exports them so existing importers are unchanged.
import { normalizeMediaText } from '../../media/common.js';

const VALID_EXTRACTED_MEDIA_KINDS = new Set(['transcript', 'caption', 'article', 'summary']);

export function isPlaceholderSource(source = '') {
  const normalized = String(source || '').trim().toLowerCase();
  // whisper-unavailable: informative messages returned when transcription is impossible.
  // Filtering these prevents them from reaching the LLM as fake transcript content,
  // which would cause the model to repeat the error back to the end user.
  return (
    normalized === 'vision-passthrough' ||
    normalized === 'whisper-unavailable' ||
    normalized.endsWith('-placeholder')
  );
}

export function extractedMediaLabel(entry = {}) {
  const title = String(entry?.metadata?.title || '').trim();
  const titleSuffix = title ? ` — ${title}` : '';
  switch (entry?.kind) {
    case 'transcript':
      return `Audio transcript${titleSuffix}`;
    case 'article':
      return `Linked content${titleSuffix}`;
    case 'caption':
      return `Image text (OCR)${titleSuffix}`;
    default:
      return `Media content${titleSuffix}`;
  }
}

export function normalizeExtractedMedia(media) {
  if (!Array.isArray(media)) {
    return [];
  }

  return media
    .map(entry => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const text = normalizeMediaText(entry.text || '', 12000);
      if (!text) {
        return null;
      }

      if (isPlaceholderSource(entry?.metadata?.source)) {
        return null;
      }

      return {
        attachmentId:
          typeof entry.attachmentId === 'string' && entry.attachmentId.trim()
            ? entry.attachmentId.trim()
            : null,
        kind: VALID_EXTRACTED_MEDIA_KINDS.has(entry.kind) ? entry.kind : 'summary',
        text,
        metadata: entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {},
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

export function extractedMediaSearchText(media) {
  return normalizeExtractedMedia(media)
    .map(entry =>
      [
        entry.metadata?.title || '',
        entry.metadata?.url || '',
        entry.metadata?.siteName || '',
        entry.metadata?.author || '',
        entry.text,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .filter(Boolean)
    .join('\n\n');
}

export function renderExtractedMediaContext(
  media,
  { maxItems = 4, maxCharsPerItem = 1200, includeVisionPassthrough = false } = {},
) {
  return normalizeExtractedMedia(media)
    .filter(entry => {
      if (!entry?.text) {
        return false;
      }
      if (includeVisionPassthrough) {
        return true;
      }
      return !isPlaceholderSource(entry?.metadata?.source);
    })
    .slice(0, maxItems)
    .map(entry => {
      const sourceUrl = entry?.metadata?.url ? `\n(source: ${entry.metadata.url})` : '';
      return `[${extractedMediaLabel(entry)}]\n${normalizeMediaText(entry.text, maxCharsPerItem)}${sourceUrl}`;
    })
    .join('\n\n');
}

export function memoryKindForExtractedMedia(kind = '') {
  switch (kind) {
    case 'transcript':
      return 'audio-transcript';
    case 'article':
      return 'link-article';
    case 'caption':
      return 'image-ocr';
    default:
      return 'media-content';
  }
}
