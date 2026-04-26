import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAudioContent as _realExtractAudioContent } from './audioExtractor.js';

// DI hook so the "audio fails / Whisper unavailable, but keyframes succeed"
// path can be tested without real Whisper credentials. Tests call
// _setExtractAudioContentForTests(stub) to inject a fake; default is the
// real implementation. Mirrors fileSearch.js's _setRipgrepBinaryForTests.
let _extractAudioContentImpl = _realExtractAudioContent;
export function _setExtractAudioContentForTests(fn) {
  _extractAudioContentImpl = typeof fn === 'function' ? fn : _realExtractAudioContent;
}

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

// Phase 2 keyframe extraction: aim for 5 evenly-spaced frames, hard-cap 8.
// Per-frame: 512px wide, JPEG q=4 (~70%). Each frame ~30-60 KB; 5 frames ~250 KB.
const KEYFRAME_TARGET_COUNT = 5;
const KEYFRAME_MAX_COUNT = 8;
const KEYFRAME_MIN_INTERVAL_SEC = 1;
const KEYFRAME_MAX_INTERVAL_SEC = 30;
const KEYFRAME_WIDTH = 512;
const KEYFRAME_JPEG_QUALITY = 4;

// Hard budget for the keyframe pass. The transcript is the load-bearing
// output — keyframes are bonus visual context. If ffmpeg / ffprobe hangs
// or the codec is unusually slow, we abandon the bonus and ship just the
// transcript. The outer routeExtraction race in src/media/index.js gives
// the WHOLE extraction 15s; budgeting keyframes at 5s leaves 10s for the
// audio pass and bookkeeping.
export const KEYFRAME_BUDGET_MS = 5000;

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

/**
 * Spawn a child process that respects an external AbortSignal end-to-end:
 * pre-abort short-circuits with a kill before the process can run; mid-flight
 * abort SIGKILLs the child and rejects; on natural exit/error the abort
 * listener is removed so it can't fire late.
 *
 * Exported so callers (probeDurationSec, the ffmpeg keyframe pass) and tests
 * share one definition of "kill on abort" — the previous separate
 * implementations let probeDurationSec leak orphan ffprobe processes when the
 * keyframe budget timed out (Codex C-grade fix #2).
 */
export function spawnWithAbort(bin, args, { collectStdout = false, signal, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        stdio: collectStdout ? ['ignore', 'pipe', 'ignore'] : 'ignore',
      });
    } catch (err) {
      return reject(err);
    }

    if (typeof onSpawn === 'function') {
      try { onSpawn(child); } catch {}
    }

    let stdoutText = '';
    if (collectStdout && child.stdout) {
      child.stdout.on('data', chunk => { stdoutText += chunk.toString('utf8'); });
    }

    let settled = false;
    const cleanupAbort = () => {
      if (signal && onAbort) {
        try { signal.removeEventListener('abort', onAbort); } catch {}
      }
    };
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      fn(val);
    };
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch {}
      settle(reject, new Error(`${bin} aborted`));
    };

    if (signal) {
      if (signal.aborted) {
        try { child.kill('SIGKILL'); } catch {}
        return settle(reject, new Error(`${bin} aborted before start`));
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', err => settle(reject, err));
    child.on('exit', code => {
      if (code === 0) settle(resolve, { code, stdoutText });
      else settle(reject, new Error(`${bin} exited ${code}`));
    });
  });
}

async function probeDurationSec(videoPath, { signal } = {}) {
  if (signal?.aborted) return null;
  try {
    const { stdoutText } = await spawnWithAbort('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ], { collectStdout: true, signal });
    const dur = parseFloat(stdoutText.trim());
    return Number.isFinite(dur) && dur > 0 ? dur : null;
  } catch {
    return null;
  }
}

export async function extractKeyframes(videoPath, framesDir, { signal } = {}) {
  if (signal?.aborted) {
    return [];
  }

  // Same signal threads through ffprobe → ffmpeg → readdir/readFile so a
  // budget timeout at any link in the chain kills the in-flight child instead
  // of orphaning it. Earlier revision passed signal only to ffmpeg.
  const durationSec = await probeDurationSec(videoPath, { signal });
  if (!durationSec || signal?.aborted) {
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

  await spawnWithAbort('ffmpeg', [
    '-i', videoPath,
    '-vf', `fps=1/${intervalSec},scale=${KEYFRAME_WIDTH}:-2`,
    '-frames:v', String(KEYFRAME_MAX_COUNT),
    '-q:v', String(KEYFRAME_JPEG_QUALITY),
    '-y',
    join(framesDir, 'frame-%03d.jpg'),
  ], { signal });

  if (signal?.aborted) {
    return [];
  }

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

/**
 * Race a keyframe-producing function against the global keyframe budget.
 * Always resolves to an array (never throws, never hangs). On timeout the
 * caller gets [], the signal fires, and any in-flight ffmpeg child is
 * killed by `extractKeyframes`'s abort handler.
 *
 * Exported so the contract "transcript survives keyframe failure" can be
 * locked by a focused unit test, instead of relying on inspection of the
 * caller's try/catch composition.
 */
export async function withKeyframeBudget(work, budgetMs = KEYFRAME_BUDGET_MS) {
  const ac = new AbortController();
  return new Promise(resolve => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      ac.abort();
      resolve(Array.isArray(val) ? val : []);
    };
    const timer = setTimeout(() => finish([]), budgetMs);
    Promise.resolve()
      .then(() => work(ac.signal))
      .then(
        val => { clearTimeout(timer); finish(val); },
        () => { clearTimeout(timer); finish([]); },
      );
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

    // The audio-extraction pass can legitimately fail for silent videos
    // (ffmpeg exits non-zero with "Output file does not contain any stream"
    // when -vn finds no audio to encode). That MUST NOT take down the whole
    // extraction — Phase 3 still wants keyframes shipped for silent video.
    let audioBuffer = null;
    try {
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
      audioBuffer = await readFile(audioPath);
    } catch {
      audioBuffer = null;
    }

    const audioResult = audioBuffer
      ? await _extractAudioContentImpl({
          ...attachment,
          url: `data:audio/ogg;base64,${audioBuffer.toString('base64')}`,
          mimeType: 'audio/ogg',
          fileName: (attachment.fileName || 'video').replace(/\.[^.]+$/, '') + '.ogg',
        }, context, { suppressFallback: true })
      : null;

    // Phase 2 keyframe pass — runs unconditionally now (Phase 3): the model
    // should still see the picture even if the audio failed (silent video,
    // Whisper unavailable, etc.). withKeyframeBudget caps at 5s and falls
    // back to [], so a slow ffmpeg can't take down the whole extraction.
    let keyframes = [];
    try {
      await mkdir(framesDir, { recursive: true });
      keyframes = await withKeyframeBudget(
        signal => extractKeyframes(videoPath, framesDir, { signal }),
      );
    } catch {
      keyframes = [];
    }

    if (audioResult) {
      // Happy path: transcript + keyframes (the UI's stated promise).
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
    }

    // Audio failed but keyframes succeeded — ship a "frames-only" entry so
    // the model still gets visual context. The text is a self-explanatory
    // placeholder (not in isPlaceholderSource's filter list — it must
    // survive normalizeExtractedMedia and reach renderExtractedMediaContext).
    if (keyframes.length > 0) {
      return {
        kind: 'transcript',
        text: 'This video has no audio transcript; visual keyframes are attached separately.',
        metadata: {
          source: 'video-keyframes-only',
          originalKind: 'video',
          fileName: attachment.fileName || '',
          url: String(attachment.url || '').startsWith('data:') ? '' : (attachment.url || ''),
          keyframes,
        },
      };
    }

    // Both failed — nothing useful to send.
    return null;
  } catch {
    return null;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
