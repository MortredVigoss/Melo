import { extractTextUrls } from './textUrls.js';

const VIDEO_HOSTS = [
  // YouTube
  /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/i,
  /youtube\.com\/shorts\/([\w-]{11})/i,
  // Vimeo
  /vimeo\.com\/(\d+)/i,
  // Bilibili
  /bilibili\.com\/video\/([\w-]+)/i,
  // TikTok — desktop/mobile/short/share variants
  /tiktok\.com\/@[\w.-]+\/video\/\d+/i,
  /vm\.tiktok\.com\/[\w-]+/i,
  /tiktok\.com\/t\/[\w-]+/i,
  /m\.tiktok\.com\/v\/\d+/i,
  /m\.tiktok\.com\/@[\w.-]+\/video\/\d+/i,
  // Douyin — standard / short / share / iesdouyin CDN / discover modal
  /douyin\.com\/video\/\d+/i,
  /v\.douyin\.com\/[\w-]+/i,
  /douyin\.com\/discover\?.*modal_id=\d+/i,
  /iesdouyin\.com\/share\/video\/\d+/i,
  /iesdouyin\.com\/share\/[\w-]+/i,
  // Twitter / X video posts
  /(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/i,
  // Instagram Reels / posts with video
  /instagram\.com\/(?:reel|p)\/([\w-]+)/i,
  // Weibo video
  /weibo\.com\/tv\/show\//i,
  // QQ Video
  /v\.qq\.com\//i,
  // Facebook video
  /facebook\.com\/(?:watch|video|reel)/i,
  // Xiaohongshu (RedNote) — explore / discovery / share links
  /xiaohongshu\.com\/explore\/\w+/i,
  /xiaohongshu\.com\/discovery\/item\/\w+/i,
  /xhslink\.com\/[\w/]+/i,
  // Kuaishou — short share / long video / overseas (kwai)
  /v\.kuaishou\.com\/[\w-]+/i,
  /kuaishou\.com\/short-video\/\d+/i,
  /kwai\.com\/@?[\w.-]+\/?/i,
];

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?|$)/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v|mkv)(\?|$)/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|ogg|aac|flac|opus)(\?|$)/i;
const DOC_EXT = /\.(pdf|docx?|pptx?|xlsx?|txt|md)(\?|$)/i;

const SOCIAL_PREVIEW_HOST_SUFFIXES = [
  'douyin.com',
  'v.douyin.com',
  'iesdouyin.com',
  'xiaohongshu.com',
  'xhslink.com',
];

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function hostMatchesAnySuffix(host, suffixes) {
  if (!host) return false;
  return suffixes.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

export function isSocialPreviewUrl(url) {
  return hostMatchesAnySuffix(hostnameOf(url), SOCIAL_PREVIEW_HOST_SUFFIXES);
}

export function detectUrlKind(url) {
  const normalized = String(url || '').trim();
  if (!normalized) {
    return null;
  }

  for (const pattern of VIDEO_HOSTS) {
    if (pattern.test(normalized)) {
      return 'video-platform';
    }
  }

  if (IMAGE_EXT.test(normalized)) {
    return 'image';
  }
  if (VIDEO_EXT.test(normalized)) {
    return 'video';
  }
  if (AUDIO_EXT.test(normalized)) {
    return 'audio';
  }
  if (DOC_EXT.test(normalized)) {
    return 'document';
  }
  return 'link';
}

export function extractUrlsFromText(content = '') {
  const text = String(content || '');
  const matches = extractTextUrls(text);
  const seen = new Set();
  const results = [];

  for (const match of matches) {
    const url = match;
    if (!url || seen.has(url) || url.startsWith('data:')) {
      continue;
    }

    seen.add(url);
    results.push({
      url,
      kind: detectUrlKind(url),
    });
  }

  return results;
}

export function promoteTextUrlsToAttachments(content, existingAttachments = []) {
  const existingUrls = new Set(
    (existingAttachments || [])
      .map(attachment => String(attachment?.url || '').trim())
      .filter(Boolean),
  );

  const detected = extractUrlsFromText(content);
  const newAttachments = [];

  for (const { url, kind } of detected) {
    if (!url || existingUrls.has(url)) {
      continue;
    }

    // Platform URLs (YouTube/Douyin/Xiaohongshu/etc.) are pages, not
    // playable video files. Render them as links and let the media
    // extractor read their preview/metadata. Direct .mp4/.webm URLs still
    // classify as `video` via VIDEO_EXT above.
    const mappedKind =
      kind === 'video-platform' || kind === 'document'
        ? 'link'
        : kind;

    newAttachments.push({
      id: undefined,
      kind: mappedKind,
      url,
      title: url.replace(/^https?:\/\//i, '').slice(0, 120),
      mimeType:
        kind === 'document' && /\.pdf(?:\?|$)/i.test(url)
          ? 'application/pdf'
          : '',
      fileName: '',
    });
  }

  return newAttachments;
}
