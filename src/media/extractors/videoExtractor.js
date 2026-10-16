import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { combineSignals, composeAbortSignals } from '../common.js';
import { extractAudioContent as _realExtractAudioContent } from './audioExtractor.js';
import { stat } from 'node:fs/promises';
import { uploadPath, MAX_UPLOAD_BYTES } from '../uploads.js';
import { currentRequestContext } from '../../runtime/requestScope.js';

// DI hook so the "audio fails / Whisper unavailable, but keyframes succeed"
// path can be tested without real Whisper credentials. Tests call
// _setExtractAudioContentForTests(stub) to inject a fake; default is the
// real implementation. Mirrors fileSearch.js's _setRipgrepBinaryForTests.
let _extractAudioContentImpl = _realExtractAudioContent;
export function _setExtractAudioContentForTests(fn) {
  _extractAudioContentImpl = typeof fn === 'function' ? fn : _realExtractAudioContent;
}

// DI hook for the audio pre-pass (the ffmpeg invocation that strips the audio
// track into audioPath before _extractAudioContentImpl runs). Tests need this
// because the real ffmpeg call can take 50ms locally but >1.5s on slow CI,
// which exceeds tight orchestrator-abort test budgets and kills the audio
// branch BEFORE the audio stub is reached — making the test silently skip
// the path it claims to exercise. Pass null to restore the real ffmpeg call.
let _audioPrePassImpl = null;
export function _setAudioPrePassForTests(fn) {
  _audioPrePassImpl = typeof fn === 'function' ? fn : null;
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

// Independent budgets for the two parallel branches. The outer
// routeExtraction race in src/media/index.js gives the WHOLE extraction
// 15s; running audio (≤10s, dominated by Whisper API latency) and
// keyframes (≤5s, ffprobe + ffmpeg encode) in parallel via Promise.all
// settles in max(10, 5) = 10s under nominal conditions, leaving 5s
// headroom for IO + bookkeeping. Either branch can hang and the other
// still ships its result — that's the Phase 3 contract.
let _AUDIO_BUDGET_MS = 10000;
let _KEYFRAME_BUDGET_MS = 5000;
export const KEYFRAME_BUDGET_MS = 5000;
export const AUDIO_BUDGET_MS = 10000;

// Tests inject custom budgets so a "hanging audio" e2e doesn't have to
// wait the real 10s. Pass `null` to restore defaults.
export function _setBudgetsForTests({ audioMs, keyframeMs } = {}) {
  _AUDIO_BUDGET_MS = (typeof audioMs === 'number' && audioMs > 0) ? audioMs : 10000;
  _KEYFRAME_BUDGET_MS = (typeof keyframeMs === 'number' && keyframeMs > 0) ? keyframeMs : 5000;
}

// Extensions that indicate a direct binary video stream (not a webpage).
const DIRECT_VIDEO_URL_RE = /\.(mp4|mov|webm|m4v|mkv|avi|flv|ts|m2ts)(\?|$|#)/i;
// Social platforms often expose playable URLs without a file extension.
// Douyin's SSR preview, for example, yields aweme.snssdk.com/aweme/v1/playwm.
// Treat only known media endpoints as direct streams; regular platform
// pages still go through the social-link/browser readers first.
const DIRECT_SOCIAL_VIDEO_URL_RE =
  /^https?:\/\/[^/]*(?:aweme\.snssdk\.com|douyinvod\.com)\/.*(?:\/play(?:wm)?\/|\/tos-|video_id=)/i;

export function isLikelyDirectVideoStreamUrl(url = '') {
  const normalized = String(url || '').trim();
  if (!normalized) return false;
  return (
    normalized.startsWith('data:video/') ||
    DIRECT_VIDEO_URL_RE.test(normalized) ||
    DIRECT_SOCIAL_VIDEO_URL_RE.test(normalized)
  );
}

async function hasFfmpeg({ signal } = {}) {
  if (signal?.aborted) return false;
  try {
    await spawnWithAbort('ffmpeg', ['-version'], { signal });
    return true;
  } catch {
    return false;
  }
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

// Uploaded videos are studied, not just glanced at: more and sharper frames.
export const STUDY_FRAMES = Object.freeze({ maxFrames: 24, width: 768, secondsPerFrame: 15 });

export async function extractKeyframes(videoPath, framesDir, { signal, maxFrames = KEYFRAME_MAX_COUNT, width = KEYFRAME_WIDTH, secondsPerFrame = null, onTimes } = {}) {
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
  const target = secondsPerFrame ? Math.min(maxFrames, Math.max(KEYFRAME_TARGET_COUNT, Math.round(durationSec / secondsPerFrame))) : KEYFRAME_TARGET_COUNT;
  const rawInterval = durationSec / target;
  const intervalSec = Math.min(
    KEYFRAME_MAX_INTERVAL_SEC,
    Math.max(KEYFRAME_MIN_INTERVAL_SEC, rawInterval),
  );

  await spawnWithAbort('ffmpeg', [
    '-i', videoPath,
    '-vf', `fps=1/${intervalSec},scale=${width}:-2`,
    '-frames:v', String(maxFrames),
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
  onTimes?.(entries.slice(0, maxFrames).map((_, index) => Math.round(index * intervalSec)));
  for (const name of entries.slice(0, maxFrames)) {
    const buf = await readFile(join(framesDir, name));
    frames.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
  }
  return frames;
}

/**
 * Race a keyframe-producing function against the keyframe budget. Always
 * resolves to an array (never throws, never hangs). On timeout the caller
 * gets [], the signal fires, and any in-flight ffmpeg child is killed by
 * `extractKeyframes`'s abort handler.
 *
 * `parentSignal` is the orchestrator's AbortSignal — when it fires, this
 * budget short-circuits to [] AND the work function's signal is also
 * aborted (via AbortSignal.any), so an outer 15s timeout cancels the
 * inner ffmpeg child instead of letting it run to its full local budget.
 *
 * Tests can override the default budget via `_setBudgetsForTests({ keyframeMs })`.
 */
export async function withKeyframeBudget(work, budgetMs, parentSignal) {
  const effectiveBudget = (typeof budgetMs === 'number' && budgetMs > 0) ? budgetMs : _KEYFRAME_BUDGET_MS;
  const localAc = new AbortController();
  // Combined signal: fires if EITHER the local timeout or the parent
  // (orchestrator) aborts. Goes through composeAbortSignals so the Node
  // 18 fallback path is exercised on package-supported runtimes.
  const combinedSignal = composeAbortSignals(localAc.signal, parentSignal);
  return new Promise(resolve => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      localAc.abort();
      resolve(Array.isArray(val) ? val : []);
    };
    if (parentSignal?.aborted) {
      finish([]);
      return;
    }
    const timer = setTimeout(() => finish([]), effectiveBudget);
    parentSignal?.addEventListener('abort', () => finish([]), { once: true });
    Promise.resolve()
      .then(() => work(combinedSignal))
      .then(
        val => { clearTimeout(timer); finish(val); },
        () => { clearTimeout(timer); finish([]); },
      );
  });
}

/**
 * Race an audio-producing function against the audio budget. Always
 * resolves to either an audioResult object or null. Mirrors
 * withKeyframeBudget — same shape, different default budget.
 *
 * The work function receives an AbortSignal combining the local timeout
 * with `parentSignal` (the orchestrator). A parent abort propagates into
 * the audio ffmpeg child / Whisper fetch so backend resources release
 * immediately instead of running out the local 10s budget.
 */
export async function withAudioBudget(work, budgetMs, parentSignal) {
  const effectiveBudget = (typeof budgetMs === 'number' && budgetMs > 0) ? budgetMs : _AUDIO_BUDGET_MS;
  const localAc = new AbortController();
  const combinedSignal = composeAbortSignals(localAc.signal, parentSignal);
  return new Promise(resolve => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      localAc.abort();
      resolve(val ?? null);
    };
    if (parentSignal?.aborted) {
      finish(null);
      return;
    }
    const timer = setTimeout(() => finish(null), effectiveBudget);
    parentSignal?.addEventListener('abort', () => finish(null), { once: true });
    Promise.resolve()
      .then(() => work(combinedSignal))
      .then(
        val => { clearTimeout(timer); finish(val); },
        () => { clearTimeout(timer); finish(null); },
      );
  });
}

/**
 * Audio extraction branch: ffmpeg -vn → readFile → _extractAudioContentImpl.
 * Returns an audioResult or null. Never throws. Threads `signal` through
 * the ffmpeg child so a budget timeout kills it cleanly. Reads the audio
 * file synchronously after ffmpeg exits (fast, signal-irrelevant).
 *
 * Exported so e2e tests can drive the branch in isolation if needed,
 * but the load-bearing tests stub _setExtractAudioContentForTests.
 */
async function audioBranch(videoPath, audioPath, attachment, context, signal) {
  if (signal?.aborted) return null;
  let audioBuffer = null;
  try {
    if (_audioPrePassImpl) {
      await _audioPrePassImpl(videoPath, audioPath, { signal });
    } else {
      await spawnWithAbort('ffmpeg', [
        '-i', videoPath,
        '-vn',
        '-acodec', 'libopus',
        '-b:a', '32k',
        '-ac', '1',
        '-ar', '16000',
        '-y',
        audioPath,
      ], { signal });
    }
    if (signal?.aborted) return null;
    audioBuffer = await readFile(audioPath);
  } catch {
    return null;
  }

  if (!audioBuffer || signal?.aborted) return null;

  try {
    return await _extractAudioContentImpl({
      ...attachment,
      url: `data:audio/ogg;base64,${audioBuffer.toString('base64')}`,
      mimeType: 'audio/ogg',
      fileName: (attachment.fileName || 'video').replace(/\.[^.]+$/, '') + '.ogg',
    }, context, { suppressFallback: true, signal });
  } catch {
    return null;
  }
}

export async function extractVideoContent(attachment, context = {}, { signal } = {}) {
  if (signal?.aborted) return null;
  const url = String(attachment?.url || '');
  if (!url) return null;

  // Guard: only attempt download for data URLs or URLs pointing at actual video files.
  // Platform page URLs (bilibili.com, youtube.com, etc.) must be handled by the
  // platform extractor first; fetching them here would download HTML and fail ffmpeg.
  const isDataUrl   = url.startsWith('data:');
  // Videos uploaded to this Melo are read straight from disk (no download, no base64).
  const home = context.home || currentRequestContext()?.home;
  const localPath = home ? uploadPath(url, home) : null;
  const isDirectUrl = !localPath && isLikelyDirectVideoStreamUrl(url);
  if (!isDataUrl && !isDirectUrl && !localPath) {
    return null;
  }

  if (!(await hasFfmpeg({ signal }))) {
    return null;
  }
  if (signal?.aborted) return null;

  const tempDir = await mkdtemp(join(tmpdir(), 'melo-video-'));
  const videoPath = localPath || join(tempDir, 'video.bin');
  const audioPath = join(tempDir, 'audio.ogg');
  const framesDir = join(tempDir, 'frames');

  try {
    let videoBuffer;
    if (localPath) {
      const size = (await stat(localPath)).size;
      if (!size || size > MAX_UPLOAD_BYTES) return null;
    } else if (isDataUrl) {
      // Parse data URL directly — avoids a round-trip through the network stack
      const base64Part = url.split(',')[1] || '';
      videoBuffer = Buffer.from(base64Part, 'base64');
    } else {
      // Combine the orchestrator's external signal with the internal 60s
      // download timeout via combineSignals (which uses the Node 18
      // fallback path when AbortSignal.any isn't available).
      const response = await fetch(url, { signal: combineSignals(signal, 60000) });
      if (!response.ok) return null;
      videoBuffer = Buffer.from(await response.arrayBuffer());
    }
    if (!localPath) {
      if (videoBuffer.length > MAX_VIDEO_BYTES) {
        return null;
      }
      await writeFile(videoPath, videoBuffer);
    }

    // Phase 3: audio + keyframes run in PARALLEL with independent budgets.
    // Each branch's withXBudget always settles to a value (audioResult or
    // null; frames or []) — never throws, never hangs past its budget. This
    // means a slow Whisper call (audio) cannot starve keyframe extraction,
    // and vice versa. Promise.all settles in max(10s, 5s) = 10s under the
    // outer 15s gate. mkdir-for-frames is sync-fast and runs before the
    // race so the keyframe branch doesn't waste budget creating its dir.
    try { await mkdir(framesDir, { recursive: true }); } catch {}

    // Pass the orchestrator's signal as parent so an outer 15s timeout
    // also kills the inner audio ffmpeg / Whisper / keyframe ffmpeg
    // children — instead of letting them run their full inner budgets
    // (10s/5s) after the parent already returned null.
    let keyframeTimes = [];
    const study = Boolean(localPath);
    const [audioResult, keyframes] = await Promise.all([
      withAudioBudget(s => audioBranch(videoPath, audioPath, attachment, context, s), study ? 200000 : undefined, signal),
      withKeyframeBudget(s => extractKeyframes(videoPath, framesDir, { signal: s, ...(study ? STUDY_FRAMES : {}), onTimes: times => { keyframeTimes = times; } }), study ? 60000 : undefined, signal),
    ]);

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
          keyframeTimes,
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
          keyframeTimes,
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
