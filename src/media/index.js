import { captureBehavior } from '../runtime/runtimeBehavior.js';
import {
  isPlaceholderSource,
  extractedMediaLabel,
  normalizeExtractedMedia,
  extractedMediaSearchText,
  renderExtractedMediaContext,
  memoryKindForExtractedMedia,
} from '../domain/media/extractedMedia.js';
export { normalizeExtractedMedia, extractedMediaSearchText, renderExtractedMediaContext, memoryKindForExtractedMedia };
import { normalizeMediaText } from './common.js';
import { getCachedExtraction, setCachedExtraction } from './cache.js';
import { extractAudioContent } from './extractors/audioExtractor.js';
import { extractDocumentContent } from './extractors/documentExtractor.js';
import { extractImageContent } from './extractors/imageExtractor.js';
import { extractLinkContent } from './extractors/linkExtractor.js';
import {
  extractVideoContent,
  isLikelyDirectVideoStreamUrl,
} from './extractors/videoExtractor.js';
import { extractYoutubeContent } from './extractors/youtubeExtractor.js';
import { detectUrlKind } from './urlDetector.js';
import { isSocialLinkUrl, readSocialLink } from '../services/search/socialLinkReader.js';
import { logSearchTrail } from '../runtime/trailLogger.js';
import { createCapabilityRecorder, describeMediaEvidence } from '../runtime/capabilities.js';

let TOTAL_BUDGET_MS = 30000;
let PER_ATTACHMENT_BUDGET_MS = 15000;
let SOCIAL_DIRECT_TOTAL_BUDGET_MS = 60000;
let SOCIAL_DIRECT_PER_ATTACHMENT_BUDGET_MS = 55000;

// Tests inject smaller budgets so abort-path coverage doesn't need to wait
// the full 15s. Pass `null` to restore production defaults.
export function _setMediaBudgetsForTests({
  totalMs,
  perAttachmentMs,
  socialDirectTotalMs,
  socialDirectPerAttachmentMs,
} = {}) {
  TOTAL_BUDGET_MS = (typeof totalMs === 'number' && totalMs > 0) ? totalMs : 30000;
  PER_ATTACHMENT_BUDGET_MS = (typeof perAttachmentMs === 'number' && perAttachmentMs > 0) ? perAttachmentMs : 15000;
  SOCIAL_DIRECT_TOTAL_BUDGET_MS =
    (typeof socialDirectTotalMs === 'number' && socialDirectTotalMs > 0)
      ? socialDirectTotalMs
      : 60000;
  SOCIAL_DIRECT_PER_ATTACHMENT_BUDGET_MS =
    (typeof socialDirectPerAttachmentMs === 'number' && socialDirectPerAttachmentMs > 0)
      ? socialDirectPerAttachmentMs
      : 55000;
}


export function shouldBypassCachedExtraction(attachment = {}, cached = {}) {
  const source = String(cached?.metadata?.source || '').trim().toLowerCase();
  if (!source.startsWith('social-link:')) {
    return false;
  }
  if (!isSocialLinkUrl(attachment?.url)) {
    return false;
  }
  const cachedMedia = Array.isArray(cached?.metadata?.media) ? cached.metadata.media : [];
  const hasDirectMedia = cachedMedia.some(item =>
    item?.src && isLikelyDirectVideoStreamUrl(item.src)
  );
  if (
    hasDirectMedia &&
    !cached?.metadata?.directMediaExtractionAttempted
  ) {
    return true;
  }

  // Shallow social previews are useful as a last resort, but they must not
  // block a later retry from using the deeper browser/yt-dlp paths. This
  // matters for Douyin short links where the browser redirect chain can mint
  // a temporary visitor credential.
  return !(
    source === 'social-link:yt-dlp' ||
    source.startsWith('social-link:browser:') ||
    source.includes('+douyin-ssr')
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


async function extractSocialPreviewContent(attachment, context, signal) {
  const result = await readSocialLink(attachment.url, {
    config: context?.config || {},
    signal,
  });
  // Phase 2 trail-log instrumentation (Codex Phase 2 B follow-up 2026-05-11):
  // capture the direct readSocialLink call path that bypasses fetchUrlTool's
  // wrap.  When MELO_SEARCH_TRAIL_LOG=1, the raw socialLink result lands
  // in $MELO_HOME/desktop/search-trail-log/YYYY-MM-DD.jsonl alongside the
  // fetchUrl/webSearch entries — adapter fixture refresh can build a
  // unified corpus across all 3 entry points.
  logSearchTrail({
    source: 'social-link',
    input: { url: attachment.url },
    result,
  });
  if (!result?.body) return null;
  const previewEntry = {
    kind: 'article',
    text: normalizeMediaText(result.body, 12000),
    metadata: {
      title: result.preview?.title || '',
      author: result.preview?.author || '',
      siteName: result.preview?.siteName || '',
      previewImage: result.preview?.image || '',
      itemId: result.preview?.itemId || '',
      media: Array.isArray(result.preview?.media) ? result.preview.media : [],
      source: `social-link:${result.via || 'preview'}`,
      url: result.canonicalUrl || attachment.url,
      originalUrl: attachment.url,
    },
  };

  return enrichSocialPreviewWithDirectMedia(previewEntry, context, signal);
}

function firstDirectSocialVideo(media = []) {
  if (!Array.isArray(media)) return null;
  return media.find(item =>
    item?.src && isLikelyDirectVideoStreamUrl(item.src)
  ) || null;
}

export function shouldUseLongSocialMediaBudget(attachment = {}) {
  const url = String(attachment?.url || '');
  if (!url) return false;

  // Social share pages can first require a browser/SSR preview step and then
  // a direct video pass (download + ffmpeg + transcript/keyframes). Keeping
  // the generic 15s budget for those links caused Melo to stop after title
  // metadata and tell the user it needed cookies, even though the direct
  // media URL had already been discovered.
  if (
    (attachment.kind === 'link' || attachment.kind === 'video') &&
    isSocialLinkUrl(url)
  ) {
    return true;
  }

  return (
    attachment.kind === 'video' &&
    isLikelyDirectVideoStreamUrl(url)
  );
}

// Uploaded videos are studied in full: frames + transcript
// can take minutes, so they get their own budget instead of the 15 s default.
let LOCAL_VIDEO_BUDGET_MS = 240000;
export function _setLocalVideoBudgetForTests(ms) { LOCAL_VIDEO_BUDGET_MS = typeof ms === 'number' && ms > 0 ? ms : 240000; }
export function isUploadedVideo(attachment = {}) {
  const url = String(attachment?.url || '');
  return attachment?.kind === 'video' && url.startsWith('/api/media/uploads/');
}

function totalBudgetForAttachments(attachments = []) {
  if (attachments.some(isUploadedVideo)) return Math.max(TOTAL_BUDGET_MS, LOCAL_VIDEO_BUDGET_MS + 10000);
  const hasLongSocialMedia = attachments.some(shouldUseLongSocialMediaBudget);
  return hasLongSocialMedia
    ? Math.max(TOTAL_BUDGET_MS, SOCIAL_DIRECT_TOTAL_BUDGET_MS)
    : TOTAL_BUDGET_MS;
}

function perAttachmentBudgetForAttachment(attachment = {}) {
  if (isUploadedVideo(attachment)) return Math.max(PER_ATTACHMENT_BUDGET_MS, LOCAL_VIDEO_BUDGET_MS);
  return shouldUseLongSocialMediaBudget(attachment)
    ? Math.max(PER_ATTACHMENT_BUDGET_MS, SOCIAL_DIRECT_PER_ATTACHMENT_BUDGET_MS)
    : PER_ATTACHMENT_BUDGET_MS;
}

export function mergeSocialPreviewWithDirectVideoExtraction(previewEntry, videoEntry, { directUrl = '' } = {}) {
  const metadata = {
    ...(previewEntry?.metadata || {}),
    directMediaExtractionAttempted: true,
    directMediaExtractionSucceeded: Boolean(videoEntry),
    directMediaUrl: directUrl,
    directMediaExtractionSource: videoEntry?.metadata?.source || '',
  };

  if (Array.isArray(videoEntry?.metadata?.keyframes) && videoEntry.metadata.keyframes.length) {
    metadata.keyframes = videoEntry.metadata.keyframes;
  }

  const sections = [previewEntry?.text || ''].filter(Boolean);
  if (videoEntry?.text) {
    const source = String(videoEntry?.metadata?.source || '');
    const label = source === 'video-keyframes-only'
      ? 'Direct video visual extraction'
      : 'Direct video transcript';
    sections.push(`[${label}]\n${normalizeMediaText(videoEntry.text, 8000)}`);
  } else if (directUrl) {
    sections.push(
      '[Direct video extraction]\n' +
      'The share preview exposed a direct media URL, but Melo could not extract a transcript or keyframes from it within this turn.',
    );
  }

  return {
    ...(previewEntry || {}),
    kind: 'article',
    text: normalizeMediaText(sections.join('\n\n'), 12000),
    metadata,
  };
}

async function enrichSocialPreviewWithDirectMedia(previewEntry, context, signal) {
  const media = Array.isArray(previewEntry?.metadata?.media) ? previewEntry.metadata.media : [];
  const directVideo = firstDirectSocialVideo(media);
  if (!directVideo?.src || signal?.aborted) {
    return previewEntry;
  }

  const videoEntry = await extractVideoContent({
    id: 'social-direct-video',
    kind: 'video',
    url: directVideo.src,
    title: previewEntry?.metadata?.title || '',
    fileName: 'social-video.mp4',
    mimeType: 'video/mp4',
  }, context, { signal }).catch(() => null);

  return mergeSocialPreviewWithDirectVideoExtraction(previewEntry, videoEntry, {
    directUrl: directVideo.src,
  });
}

async function routeExtraction(attachment, context, signal) {
  if (!attachment?.url) {
    return null;
  }
  if (signal?.aborted) return null;

  const isSocialPage = isSocialLinkUrl(attachment.url);
  if ((attachment.kind === 'link' || attachment.kind === 'video') && isSocialPage) {
    return extractSocialPreviewContent(attachment, context, signal);
  }

  if (attachment.kind === 'image') {
    return extractImageContent(attachment, { ...context, signal });
  }

  if (attachment.kind === 'audio') {
    return extractAudioContent(attachment, context, { signal });
  }

  if (attachment.kind === 'video') {
    const urlKind = detectUrlKind(attachment.url);
    if (urlKind === 'video-platform') {
      const platformResult = await extractYoutubeContent(attachment, context?.config, { signal });
      if (platformResult) {
        return platformResult;
      }
      return null;
    }
    return extractVideoContent(attachment, context, { signal });
  }

  if (
    String(attachment.mimeType || '').includes('pdf') ||
    /\.pdf(?:\?|$)/i.test(String(attachment.url || ''))
  ) {
    return extractDocumentContent(attachment, { signal });
  }

  if (attachment.kind === 'link') {
    const urlKind = detectUrlKind(attachment.url);
    if (urlKind === 'video-platform') {
      const platformResult = await extractYoutubeContent(attachment, context?.config, { signal });
      if (platformResult) {
        return platformResult;
      }
    }
    return extractLinkContent(attachment.url, { signal });
  }

  return null;
}

export async function enrichMessageWithMediaContext(message, context = {}) {
  const record = createCapabilityRecorder({ config: context.config });
  if (!message || typeof message !== 'object') {
    return message;
  }

  if (captureBehavior(context.config).MELO_DISABLE_MEDIA === '1') {
    message.extractedMedia = [];
    return message;
  }

  if (Array.isArray(message.extractedMedia) && message.extractedMedia.length) {
    message.extractedMedia = normalizeExtractedMedia(message.extractedMedia);
    for (const entry of message.extractedMedia) {
      const attachment = (Array.isArray(message.attachments) ? message.attachments : []).find(item => item?.id && item.id === entry.attachmentId);
      if (!attachment) continue;
      // Reused/on-device text proves available context, not a fresh backend run.
      const evidence = describeMediaEvidence(attachment, entry, { ...context, cached: true });
      void record(evidence.id, evidence);
    }
    return message;
  }

  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (!attachments.length) {
    message.extractedMedia = [];
    return message;
  }

  const deadline = Date.now() + totalBudgetForAttachments(attachments);
  const extractionTasks = attachments.map(async attachment => {
    // Explicit closed-context/no-network requests must not prefetch links before routing.
    if (context.allowRemoteExtraction === false && /^https?:\/\//iu.test(attachment.url || '')) return null;
    const cacheKey = `${attachment.kind}:${attachment.url}`;
    const cached = await getCachedExtraction(cacheKey);
    if (cached && !shouldBypassCachedExtraction(attachment, cached)) {
      const evidence = describeMediaEvidence(attachment, cached, { ...context, cached: true });
      void record(evidence.id, evidence);
      return {
        attachmentId: attachment.id || null,
        ...cached,
      };
    }

    const perAttachmentBudget = perAttachmentBudgetForAttachment(attachment);
    const remaining = Math.max(
      0,
      Math.min(perAttachmentBudget, deadline - Date.now()),
    );
    // Skip extraction if there's not enough time left to make meaningful
    // progress. Production threshold stays at 1s; in test mode with a
    // very small per-attachment budget, the threshold scales down so the
    // budget actually gets exercised instead of always-skip.
    const minRemaining = Math.min(1000, Math.floor(perAttachmentBudget / 4));
    if (remaining < minRemaining) {
      return null;
    }

    try {
      const result = await withTimeoutAndAbort(
        signal => routeExtraction(attachment, context, signal).catch(() => null),
        remaining,
      );
      const evidence = describeMediaEvidence(attachment, result, context);
      void record(evidence.id, evidence);
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
