import { normalizeMediaText } from './common.js';
import { getCachedExtraction, setCachedExtraction } from './cache.js';
import { extractAudioContent } from './extractors/audioExtractor.js';
import { extractDocumentContent } from './extractors/documentExtractor.js';
import { extractImageContent } from './extractors/imageExtractor.js';
import { extractLinkContent } from './extractors/linkExtractor.js';
import { extractVideoContent } from './extractors/videoExtractor.js';
import { extractYoutubeContent } from './extractors/youtubeExtractor.js';
import { detectUrlKind } from './urlDetector.js';

const VALID_EXTRACTED_MEDIA_KINDS = new Set(['transcript', 'caption', 'article', 'summary']);
let TOTAL_BUDGET_MS = 30000;
let PER_ATTACHMENT_BUDGET_MS = 15000;

// Tests inject smaller budgets so abort-path coverage doesn't need to wait
// the full 15s. Pass `null` to restore production defaults.
export function _setMediaBudgetsForTests({ totalMs, perAttachmentMs } = {}) {
  TOTAL_BUDGET_MS = (typeof totalMs === 'number' && totalMs > 0) ? totalMs : 30000;
  PER_ATTACHMENT_BUDGET_MS = (typeof perAttachmentMs === 'number' && perAttachmentMs > 0) ? perAttachmentMs : 15000;
}

function isPlaceholderSource(source = '') {
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

/**
 * Race a workFn against a timeout AND propagate cancellation. The previous
 * `withTimeout` only raced — when the timer fired, the underlying
 * extraction (whisper.cpp child / Whisper API fetch / etc.) kept running
 * in the background. With AbortController the timer also aborts the work,
 * so backend resources are released immediately.
 *
 * Always resolves to either the work's result or null (never rejects,
 * never hangs past `ms`).
 */
function withTimeoutAndAbort(workFn, ms) {
  const ac = new AbortController();
  return new Promise(resolve => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      ac.abort();
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), Math.max(0, ms));
    Promise.resolve()
      .then(() => workFn(ac.signal))
      .then(
        val => { clearTimeout(timer); finish(val); },
        () => { clearTimeout(timer); finish(null); },
      );
  });
}

function extractedMediaLabel(entry = {}) {
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

async function routeExtraction(attachment, context, signal) {
  if (!attachment?.url) {
    return null;
  }
  if (signal?.aborted) return null;

  if (attachment.kind === 'image') {
    return extractImageContent(attachment, context);
  }

  if (attachment.kind === 'audio') {
    return extractAudioContent(attachment, context, { signal });
  }

  if (attachment.kind === 'video') {
    const urlKind = detectUrlKind(attachment.url);
    if (urlKind === 'video-platform') {
      const platformResult = await extractYoutubeContent(attachment, context?.config);
      if (platformResult) {
        return platformResult;
      }
    }
    return extractVideoContent(attachment, context, { signal });
  }

  if (
    String(attachment.mimeType || '').includes('pdf') ||
    /\.pdf(?:\?|$)/i.test(String(attachment.url || ''))
  ) {
    return extractDocumentContent(attachment);
  }

  if (attachment.kind === 'link') {
    const urlKind = detectUrlKind(attachment.url);
    if (urlKind === 'video-platform') {
      const platformResult = await extractYoutubeContent(attachment, context?.config);
      if (platformResult) {
        return platformResult;
      }
    }
    return extractLinkContent(attachment.url);
  }

  return null;
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

export async function enrichMessageWithMediaContext(message, context = {}) {
  if (!message || typeof message !== 'object') {
    return message;
  }

  if (process.env.MELO_DISABLE_MEDIA === '1') {
    message.extractedMedia = [];
    return message;
  }

  if (Array.isArray(message.extractedMedia) && message.extractedMedia.length) {
    message.extractedMedia = normalizeExtractedMedia(message.extractedMedia);
    return message;
  }

  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (!attachments.length) {
    message.extractedMedia = [];
    return message;
  }

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const extractionTasks = attachments.map(async attachment => {
    const cacheKey = `${attachment.kind}:${attachment.url}`;
    const cached = await getCachedExtraction(cacheKey);
    if (cached) {
      return {
        attachmentId: attachment.id || null,
        ...cached,
      };
    }

    const remaining = Math.max(
      0,
      Math.min(PER_ATTACHMENT_BUDGET_MS, deadline - Date.now()),
    );
    // Skip extraction if there's not enough time left to make meaningful
    // progress. Production threshold stays at 1s; in test mode with a
    // very small per-attachment budget, the threshold scales down so the
    // budget actually gets exercised instead of always-skip.
    const minRemaining = Math.min(1000, Math.floor(PER_ATTACHMENT_BUDGET_MS / 4));
    if (remaining < minRemaining) {
      return null;
    }

    try {
      const result = await withTimeoutAndAbort(
        signal => routeExtraction(attachment, context, signal).catch(() => null),
        remaining,
      );
      if (!result) {
        return null;
      }

      await setCachedExtraction(cacheKey, result).catch(() => {});
      return {
        attachmentId: attachment.id || null,
        ...result,
      };
    } catch {
      return null;
    }
  });

  const extractedMedia = await Promise.all(extractionTasks);
  message.extractedMedia = normalizeExtractedMedia(extractedMedia)
    .filter(entry => !isPlaceholderSource(entry?.metadata?.source));
  return message;
}
