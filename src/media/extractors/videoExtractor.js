import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAudioContent } from './audioExtractor.js';

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

// Phase 2 keyframe extraction: aim for 5 evenly-spaced frames, hard-cap 8.
// Per-frame: 512px wide, JPEG q=4 (~70%). Each frame ~30-60 KB; 5 frames ~250 KB.
const KEYFRAME_TARGET_COUNT = 5;
const KEYFRAME_MAX_COUNT = 8;
const KEYFRAME_MIN_INTERVAL_SEC = 1;
const KEYFRAME_MAX_INTERVAL_SEC = 30;
const KEYFRAME_WIDTH = 512;
const KEYFRAME_JPEG_QUALITY = 4;

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

async function probeDurationSec(videoPath) {
  return new Promise(resolve => {
    let stdout = '';
    try {
      const child = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        videoPath,
      ]);
      child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
      child.on('error', () => resolve(null));
      child.on('exit', code => {
        if (code !== 0) return resolve(null);
        const dur = parseFloat(stdout.trim());
        resolve(Number.isFinite(dur) && dur > 0 ? dur : null);
      });
    } catch {
      resolve(null);
    }
  });
}

export async function extractKeyframes(videoPath, framesDir) {
  const durationSec = await probeDurationSec(videoPath);
  if (!durationSec) {
    return [];
  }

  // Even spacing: pick interval so we land ~KEYFRAME_TARGET_COUNT frames.
  // Clamp so very short or very long videos don't degenerate (1 frame for a
  // 0.5s clip, 1 frame every 5 minutes for a feature film).
  const rawInterval = durationSec / KEYFRAME_TARGET_COUNT;
  const intervalSec = Math.min(
    KEYFRAME_MAX_INTERVAL_SEC,
    Math.max(KEYFRAME_MIN_INTERVAL_SEC, rawInterval),
  );

  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-i', videoPath,
      '-vf', `fps=1/${intervalSec},scale=${KEYFRAME_WIDTH}:-2`,
      '-frames:v', String(KEYFRAME_MAX_COUNT),
      '-q:v', String(KEYFRAME_JPEG_QUALITY),
      '-y',
      join(framesDir, 'frame-%03d.jpg'),
    ], { stdio: 'ignore' });
    ff.on('error', reject);
    ff.on('exit', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg keyframe pass exited ${code}`))));
  });

  const entries = (await readdir(framesDir))
    .filter(name => /^frame-\d+\.jpg$/i.test(name))
    .sort();

  const frames = [];
  for (const name of entries.slice(0, KEYFRAME_MAX_COUNT)) {
    const buf = await readFile(join(framesDir, name));
    frames.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
  }
  return frames;
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
  const framesDir = join(tempDir, 'frames');

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

    // Phase 2: pull a handful of keyframes so the model can actually see the
    // video, not just hear it. Failure here MUST NOT take down the transcript.
    let keyframes = [];
    try {
      await mkdir(framesDir, { recursive: true });
      keyframes = await extractKeyframes(videoPath, framesDir);
    } catch {
      keyframes = [];
    }

    return {
      ...audioResult,
      kind: 'transcript',
      metadata: {
        ...audioResult.metadata,
        source: 'video-audio-transcript',
        originalKind: 'video',
        keyframes,
      },
    };
  } catch {
    return null;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
