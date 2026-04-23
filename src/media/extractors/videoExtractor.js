import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAudioContent } from './audioExtractor.js';

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

// Extensions that indicate a direct binary video stream (not a webpage).
const DIRECT_VIDEO_URL_RE = /\.(mp4|mov|webm|m4v|mkv|avi|flv|ts|m2ts)(\?|$|#)/i;

async function hasFfmpeg() {
  return new Promise(resolve => {
    try {
      const child = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', code => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

export async function extractVideoContent(attachment, context = {}) {
  const url = String(attachment?.url || '');
  if (!url) return null;

  // Guard: only attempt download for data URLs or URLs pointing at actual video files.
  // Platform page URLs (bilibili.com, youtube.com, etc.) must be handled by the
  // platform extractor first; fetching them here would download HTML and fail ffmpeg.
  const isDataUrl   = url.startsWith('data:');
  const isDirectUrl = DIRECT_VIDEO_URL_RE.test(url);
  if (!isDataUrl && !isDirectUrl) {
    return null;
  }

  if (!(await hasFfmpeg())) {
    return null;
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'melo-video-'));
  const videoPath = join(tempDir, 'video.bin');
  const audioPath = join(tempDir, 'audio.ogg');

  try {
    let videoBuffer;
    if (isDataUrl) {
      // Parse data URL directly — avoids a round-trip through the network stack
      const base64Part = url.split(',')[1] || '';
      videoBuffer = Buffer.from(base64Part, 'base64');
    } else {
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) return null;
      videoBuffer = Buffer.from(await response.arrayBuffer());
    }
    if (videoBuffer.length > MAX_VIDEO_BYTES) {
      return null;
    }
    await writeFile(videoPath, videoBuffer);

    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-i',
        videoPath,
        '-vn',
        '-acodec',
        'libopus',
        '-b:a',
        '32k',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-y',
        audioPath,
      ], { stdio: 'ignore' });
      ff.on('error', reject);
      ff.on('exit', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    });

    const audioBuffer = await readFile(audioPath);
    const audioResult = await extractAudioContent({
      ...attachment,
      url: `data:audio/ogg;base64,${audioBuffer.toString('base64')}`,
      mimeType: 'audio/ogg',
      fileName: (attachment.fileName || 'video').replace(/\.[^.]+$/, '') + '.ogg',
    }, context, { suppressFallback: true });

    if (!audioResult) {
      return null;
    }

    return {
      ...audioResult,
      kind: 'transcript',
      metadata: {
        ...audioResult.metadata,
        source: 'video-audio-transcript',
        originalKind: 'video',
      },
    };
  } catch {
    return null;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
