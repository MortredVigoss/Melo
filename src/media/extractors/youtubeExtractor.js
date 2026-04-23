import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debugWarn } from '../../debug.js';

const YOUTUBE_ID_PATTERNS = [
  /youtube\.com\/watch\?v=([\w-]{11})/i,
  /youtu\.be\/([\w-]{11})/i,
  /youtube\.com\/shorts\/([\w-]{11})/i,
];
const YTDLP_TIMEOUT_MS = 30_000;
const YTDLP_META_TIMEOUT_MS = 60_000;
const TRANSCRIPT_MAX_CHARS = 6000;
const DESCRIPTION_MAX_CHARS = 3000;
const YTDLP_SUB_LANGS = 'en.*,zh.*,zh-Hans.*,zh-Hant.*,ja.*,ko.*,all';

// ─── Cookie resolver (mirrors fetchUrlTool.js + mediaInfoTool.js) ─────────────
//
// config.domainCookies: { "douyin.com": "sessionid=...; ...", "tiktok.com": "sid_guard=...; ..." }
// Matches exact hostname or suffix (e.g. "douyin.com" covers "www.douyin.com").
// Exported for unit testing; production callers use it via the extractor.
export function resolveCookiesForUrl(url, config) {
  const domainCookies = config?.domainCookies;
  if (!domainCookies || typeof domainCookies !== 'object') return '';
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    for (const [domain, cookieStr] of Object.entries(domainCookies)) {
      const d = String(domain || '').replace(/^\./, '').replace(/^www\./, '');
      if (!d) continue;
      if (hostname === d || hostname.endsWith(`.${d}`)) {
        return String(cookieStr || '').trim();
      }
    }
  } catch {}
  return '';
}

let ytDlpAvailabilityPromise = null;

export function extractYoutubeId(url) {
  for (const pattern of YOUTUBE_ID_PATTERNS) {
    const match = String(url || '').match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function ytDlpBinary() {
  return String(process.env.MELO_YTDLP_BIN || 'yt-dlp').trim() || 'yt-dlp';
}

function runProcess(command, args, { timeoutMs = YTDLP_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const finish = handler => value => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      handler(value);
    };

    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }

    if (child.stdout) {
      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on('data', chunk => {
        stderr += chunk.toString();
      });
    }

    child.on('error', finish(reject));
    child.on('exit', finish(code => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited ${code}`));
    }));

    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject)(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

async function hasYtDlp() {
  if (ytDlpAvailabilityPromise) {
    return ytDlpAvailabilityPromise;
  }

  ytDlpAvailabilityPromise = runProcess(ytDlpBinary(), ['--version'], { timeoutMs: 5000 })
    .then(() => true)
    .catch(() => false);
  return ytDlpAvailabilityPromise;
}

export function parseWebVttTranscript(value = '') {
  return String(value || '')
    .replace(/^WEBVTT[^\n]*\n?/i, '')
    .replace(/\r/g, '')
    .replace(/^\s*\d+\s*$/gm, '')
    .replace(
      /^\s*\d{2}:\d{2}(?::\d{2})?\.\d{3}\s+-->\s+\d{2}:\d{2}(?::\d{2})?\.\d{3}.*$/gm,
      '',
    )
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchYoutubeOembed(videoId) {
  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!response.ok) {
      debugWarn('media', `youtube oembed returned ${response.status} for id=${videoId}`);
      return null;
    }
    return response.json();
  } catch (error) {
    debugWarn('media', `youtube oembed failed for id=${videoId}:`, error?.message || error);
    return null;
  }
}

async function fetchYoutubeTranscript(videoUrl, videoId) {
  if (!(await hasYtDlp())) {
    return null;
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'melo-ytdlp-'));
  const outputTemplate = join(tempDir, `${videoId}.%(ext)s`);

  try {
    await runProcess(ytDlpBinary(), [
      '--skip-download',
      '--write-auto-sub',
      '--write-sub',
      '--sub-langs',
      YTDLP_SUB_LANGS,
      '--sub-format',
      'vtt',
      '--output',
      outputTemplate,
      videoUrl,
    ]);

    const files = await readdir(tempDir).catch(() => []);
    const subtitleFile =
      files.find(file => file.endsWith('.en.vtt')) ||
      files.find(file => /\.zh(?:-[^.]+)?\.vtt$/i.test(file)) ||
      files.find(file => /\.(?:ja|ko)\.vtt$/i.test(file)) ||
      files.find(file => file.endsWith('.vtt'));
    if (!subtitleFile) {
      return null;
    }

    const raw = await readFile(join(tempDir, subtitleFile), 'utf8');
    const transcript = parseWebVttTranscript(raw).slice(0, TRANSCRIPT_MAX_CHARS);
    return transcript || null;
  } catch (error) {
    debugWarn('media', `yt-dlp subtitle fetch failed for id=${videoId}:`, error?.message || error);
    return null;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── Vimeo oEmbed ────────────────────────────────────────────────────────────

async function fetchVimeoOembed(url) {
  try {
    const endpoint = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      debugWarn('media', `vimeo oembed returned ${res.status} for ${url}`);
      return null;
    }
    return res.json();
  } catch (error) {
    debugWarn('media', `vimeo oembed failed for ${url}:`, error?.message || error);
    return null;
  }
}

// ─── yt-dlp universal metadata fallback ──────────────────────────────────────

/**
 * Use yt-dlp --dump-json to extract metadata from ANY supported platform.
 * Returns { title, uploader, description, duration, platform, subtitleText,
 *           viewCount, likeCount, commentCount, uploadDate } or null.
 *
 * `config` (optional) may contain `domainCookies` for platforms that require
 * login-gated access (e.g. Douyin, TikTok region-locked content). Cookies are
 * injected via --add-header, mirroring mediaInfoTool.js.
 */
async function fetchPlatformMetadataViaYtdlp(url, config) {
  if (!(await hasYtDlp())) return null;

  const tempDir = await mkdtemp(join(tmpdir(), 'melo-ytdlp-meta-'));
  const outputTemplate = join(tempDir, '%(id)s.%(ext)s');

  try {
    // Build arg list, optionally injecting per-domain cookies
    const args = [
      '--dump-json',
      '--skip-download',
      '--write-auto-sub',
      '--write-sub',
      '--sub-langs', YTDLP_SUB_LANGS,
      '--sub-format', 'vtt',
      '--output', outputTemplate,
      '--no-warnings',
      '--no-playlist',
    ];

    const cookieStr = resolveCookiesForUrl(url, config);
    if (cookieStr) {
      args.push('--add-header', `Cookie:${cookieStr}`);
    }

    args.push(url);

    const { stdout } = await runProcess(ytDlpBinary(), args, {
      timeoutMs: YTDLP_META_TIMEOUT_MS,
    });

    if (!stdout.trim()) return null;
    const meta = JSON.parse(stdout.trim().split('\n').pop() || stdout);

    // Look for a subtitle file written to tempDir
    let subtitleText = null;
    try {
      const files = await readdir(tempDir).catch(() => []);
      const subFile =
        files.find(f => f.endsWith('.en.vtt')) ||
        files.find(f => /\.zh(?:-[^.]+)?\.vtt$/i.test(f)) ||
        files.find(f => /\.(?:ja|ko)\.vtt$/i.test(f)) ||
        files.find(f => f.endsWith('.vtt'));
      if (subFile) {
        const raw = await readFile(join(tempDir, subFile), 'utf8');
        subtitleText = parseWebVttTranscript(raw).slice(0, TRANSCRIPT_MAX_CHARS) || null;
      }
    } catch {}

    // Format upload_date (yt-dlp gives YYYYMMDD) → YYYY-MM-DD
    let uploadDate = '';
    if (typeof meta.upload_date === 'string' && /^\d{8}$/.test(meta.upload_date)) {
      uploadDate = `${meta.upload_date.slice(0, 4)}-${meta.upload_date.slice(4, 6)}-${meta.upload_date.slice(6, 8)}`;
    }

    return {
      title:        meta.title || meta.fulltitle || '',
      uploader:     meta.uploader || meta.channel || meta.creator || '',
      description:  String(meta.description || '').slice(0, DESCRIPTION_MAX_CHARS),
      duration:     meta.duration ? `${Math.floor(meta.duration / 60)}m${meta.duration % 60}s` : '',
      platform:     meta.extractor_key || meta.extractor || 'unknown',
      subtitleText,
      viewCount:    Number.isFinite(meta.view_count) ? meta.view_count : null,
      likeCount:    Number.isFinite(meta.like_count) ? meta.like_count : null,
      commentCount: Number.isFinite(meta.comment_count) ? meta.comment_count : null,
      uploadDate,
    };
  } catch (error) {
    debugWarn('media', `yt-dlp metadata fallback failed for ${url}:`, error?.message || error);
    return null;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function formatCount(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── Main entry point: video platform content extractor ──────────────────────

export async function extractYoutubeContent(attachment, config) {
  const url = attachment?.url;
  if (!url) return null;

  // ── YouTube (oembed + yt-dlp subtitles) ───────────────────────────────────
  const videoId = extractYoutubeId(url);
  if (videoId) {
    const oembed = await fetchYoutubeOembed(videoId);
    if (oembed) {
      const transcript = await fetchYoutubeTranscript(url, videoId);
      const text = transcript
        ? `${oembed.title}\n\nby ${oembed.author_name}\n\n${transcript}`
        : `${oembed.title}\n\nby ${oembed.author_name}`;
      return {
        kind: 'article',
        text: String(text).slice(0, 8000),
        metadata: {
          title:         oembed.title || '',
          author:        oembed.author_name || '',
          source:        transcript ? 'youtube-oembed+yt-dlp' : 'youtube-oembed',
          videoId,
          url,
          hasTranscript: Boolean(transcript),
        },
      };
    }
  }

  // ── Vimeo (oembed) ────────────────────────────────────────────────────────
  if (/vimeo\.com\/\d+/i.test(url)) {
    const oembed = await fetchVimeoOembed(url);
    if (oembed) {
      // yt-dlp subtitle attempt for Vimeo
      const meta = await fetchPlatformMetadataViaYtdlp(url, config);
      const text = [
        oembed.title,
        oembed.author_name ? `by ${oembed.author_name}` : '',
        oembed.description || '',
        meta?.subtitleText || '',
      ].filter(Boolean).join('\n\n');
      return {
        kind: 'article',
        text: text.slice(0, 8000),
        metadata: {
          title:  oembed.title || '',
          author: oembed.author_name || '',
          source: 'vimeo-oembed',
          url,
        },
      };
    }
  }

  // ── Universal yt-dlp fallback (Bilibili, TikTok, Douyin, Twitter/X, etc.) ─
  const meta = await fetchPlatformMetadataViaYtdlp(url, config);
  if (!meta) return null;

  // Assemble a numeric stats line (Views / Likes / Comments / Date) when present,
  // so the LLM has enough social context to reason about short-form video posts.
  const statsBits = [];
  if (meta.viewCount != null)    statsBits.push(`Views ${formatCount(meta.viewCount)}`);
  if (meta.likeCount != null)    statsBits.push(`Likes ${formatCount(meta.likeCount)}`);
  if (meta.commentCount != null) statsBits.push(`Comments ${formatCount(meta.commentCount)}`);
  if (meta.uploadDate)           statsBits.push(`Posted ${meta.uploadDate}`);
  const statsLine = statsBits.length ? statsBits.join(' · ') : '';

  const parts = [meta.title];
  if (meta.uploader)    parts.push(`by ${meta.uploader}`);
  if (meta.duration)    parts.push(`Duration: ${meta.duration}`);
  if (statsLine)        parts.push(statsLine);
  if (meta.description) parts.push(meta.description);
  if (meta.subtitleText) parts.push(`\nTranscript/Subtitles:\n${meta.subtitleText}`);

  const text = parts.filter(Boolean).join('\n\n');
  return {
    kind: 'article',
    text: text.slice(0, 8000),
    metadata: {
      title:         meta.title || '',
      author:        meta.uploader || '',
      source:        `yt-dlp:${meta.platform}`,
      url,
      hasTranscript: Boolean(meta.subtitleText),
      viewCount:     meta.viewCount,
      likeCount:     meta.likeCount,
      commentCount:  meta.commentCount,
      uploadDate:    meta.uploadDate || '',
    },
  };
}
