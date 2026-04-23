/**
 * media_info tool
 *
 * Extracts metadata and direct media URLs from 1000+ sites using yt-dlp.
 * Covers: YouTube, Bilibili, QQ Music, Douyin/TikTok, Twitter/X, Instagram,
 * Spotify (metadata only), SoundCloud, Weibo video, and many more.
 *
 * Operations:
 *   info     — full metadata JSON (title, description, formats, thumbnail, subtitles…)
 *   url      — extract best direct stream URL(s) — skips DRM-locked content
 *   formats  — list all available formats with codecs + quality info
 *   subtitle — download/list available subtitles
 *
 * yt-dlp must be installed on the system (brew install yt-dlp / pip install yt-dlp).
 * Falls back gracefully with a helpful error message if not found.
 */

import { spawn } from 'node:child_process';

const YTDLP_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_BYTES  = 512 * 1024; // 512 KB

// ─── yt-dlp runner ───────────────────────────────────────────────────────────

function runYtdlp(args, signal) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
      reject(new Error(`yt-dlp timed out after ${YTDLP_TIMEOUT_MS / 1000}s`));
    }, YTDLP_TIMEOUT_MS);

    if (signal) {
      signal.addEventListener('abort', () => {
        killed = true;
        clearTimeout(timer);
        proc.kill('SIGTERM');
        reject(new Error('Aborted'));
      }, { once: true });
    }

    proc.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT_BYTES) {
        stdout = stdout.slice(-MAX_OUTPUT_BYTES);
      }
    });

    proc.stderr.on('data', chunk => {
      stderr += chunk.toString().slice(-4096);
    });

    proc.on('close', code => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        // Distinguish "not installed" from other errors
        if (code === null || stderr.includes('No such file') || stderr.includes('command not found')) {
          reject(new Error('yt-dlp is not installed. Install with: brew install yt-dlp'));
        } else {
          reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        }
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      if (killed) return;
      if (err.code === 'ENOENT') {
        reject(new Error('yt-dlp is not installed. Install with: brew install yt-dlp  OR  pip install yt-dlp'));
      } else {
        reject(err);
      }
    });
  });
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function summariseMetadata(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  const formats = (d.formats || []).slice(-8).map(f => ({
    id: f.format_id,
    ext: f.ext,
    quality: f.format_note || f.quality,
    vcodec: f.vcodec !== 'none' ? f.vcodec : undefined,
    acodec: f.acodec !== 'none' ? f.acodec : undefined,
    filesize: f.filesize ? `${Math.round(f.filesize / 1024)}KB` : undefined,
    url: f.url ? '[stream_url available]' : undefined,
  }));

  return {
    title:       d.title,
    uploader:    d.uploader || d.channel,
    duration:    d.duration ? `${Math.floor(d.duration / 60)}m${d.duration % 60}s` : undefined,
    upload_date: d.upload_date,
    view_count:  d.view_count,
    like_count:  d.like_count,
    description: (d.description || '').slice(0, 500),
    webpage_url: d.webpage_url,
    thumbnail:   d.thumbnail,
    tags:        (d.tags || []).slice(0, 10),
    subtitles:   d.subtitles ? Object.keys(d.subtitles) : [],
    formats:     formats,
    extractor:   d.extractor_key || d.extractor,
  };
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export const mediaInfoTool = {
  id: 'media_info',
  name: 'Media Info (yt-dlp)',
  description:
    'Extract metadata and direct stream URLs from 1000+ media sites: YouTube, Bilibili, ' +
    'QQ Music, Douyin/TikTok, Twitter/X, SoundCloud, Instagram, and more. ' +
    'Use "info" for full metadata, "url" for playable stream links, ' +
    '"formats" to list quality options, "subtitle" to get subtitles. ' +
    'Requires yt-dlp to be installed (brew install yt-dlp).',
  category: 'media',
  isConcurrencySafe: true,
  requiresPermission: false,
  parametersSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The media page URL (YouTube video, QQ Music song, Bilibili video, etc.)',
      },
      operation: {
        type: 'string',
        enum: ['info', 'url', 'formats', 'subtitle'],
        description:
          '"info" = full metadata. "url" = direct stream URL(s). ' +
          '"formats" = list all quality options. "subtitle" = available subtitle tracks.',
        default: 'info',
      },
      format: {
        type: 'string',
        description:
          'Format selector for "url" operation (yt-dlp syntax). ' +
          'Examples: "bestaudio", "bestvideo+bestaudio", "140" (format id), ' +
          '"bestaudio[ext=m4a]". Default: "bestaudio/best".',
        default: 'bestaudio/best',
      },
      cookies: {
        type: 'string',
        description:
          'Optional Cookie header string for authenticated requests (e.g. QQ Music, Bilibili VIP). ' +
          'Format: "name1=val1; name2=val2". Can also be set globally in config.domainCookies.',
      },
    },
    required: ['url'],
  },
  examples: [
    { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', operation: 'info' },
    { url: 'https://y.qq.com/n/ryqq/songDetail/001fNHEf1SFWQM', operation: 'info' },
    { url: 'https://www.bilibili.com/video/BV1xx411c7aQ', operation: 'url', format: 'bestaudio' },
    { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', operation: 'subtitle' },
  ],

  async run({ url, operation = 'info', format = 'bestaudio/best', cookies }, { signal, config } = {}) {
    if (!url || typeof url !== 'string' || !url.trim()) {
      return { ok: false, output: 'Missing or empty url parameter.', error: 'INVALID_URL' };
    }
    const targetUrl = url.trim();

    // Build yt-dlp args
    const args = ['--no-warnings', '--no-playlist'];

    // Cookie injection: explicit param > config.domainCookies
    let cookieStr = cookies || '';
    if (!cookieStr && config?.domainCookies) {
      try {
        const host = new URL(targetUrl).hostname.replace(/^www\./, '');
        // Try exact and wildcard matches
        for (const [domain, val] of Object.entries(config.domainCookies)) {
          if (host === domain || host.endsWith(`.${domain}`)) {
            cookieStr = val;
            break;
          }
        }
      } catch {}
    }
    if (cookieStr) {
      args.push('--add-header', `Cookie:${cookieStr}`);
    }

    try {
      let output = '';
      let meta = {};

      if (operation === 'info') {
        args.push('--dump-json', '--skip-download', targetUrl);
        const { stdout } = await runYtdlp(args, signal);
        const parsed = JSON.parse(stdout);
        const summary = summariseMetadata(parsed);
        output = JSON.stringify(summary, null, 2);
        meta = { extractor: summary.extractor, title: summary.title };

      } else if (operation === 'url') {
        args.push('-f', format, '--get-url', '--skip-download', targetUrl);
        const { stdout } = await runYtdlp(args, signal);
        const urls = stdout.split('\n').filter(Boolean);
        if (!urls.length) {
          return { ok: false, output: 'No direct URL found (content may be DRM-protected or login-required).', error: 'NO_URL' };
        }
        output = `Direct stream URL(s) for: ${targetUrl}\n\n` + urls.map((u, i) => `[${i + 1}] ${u}`).join('\n');
        meta = { urlCount: urls.length };

      } else if (operation === 'formats') {
        args.push('--list-formats', '--skip-download', targetUrl);
        const { stdout } = await runYtdlp(args, signal);
        output = `Available formats for: ${targetUrl}\n\n${stdout}`;

      } else if (operation === 'subtitle') {
        // List available subtitles
        const listArgs = [...args, '--list-subs', '--skip-download', targetUrl];
        const { stdout } = await runYtdlp(listArgs, signal);
        output = `Available subtitles for: ${targetUrl}\n\n${stdout || '(No subtitles found)'}`;
      }

      return { ok: true, output: `[source: ${targetUrl}] [via: yt-dlp]\n\n${output}`, meta };

    } catch (err) {
      return {
        ok: false,
        output: `media_info failed for "${targetUrl}": ${err.message}`,
        error: err.message,
      };
    }
  },
};
