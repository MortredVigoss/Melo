// Phase 2 keyframe extraction regression. We intentionally test the
// keyframe pass in isolation (via the exported `extractKeyframes`) because
// the full `extractVideoContent` entry depends on Whisper credentials that
// aren't available in CI / clean dev envs — `suppressFallback: true` makes
// it return null without an API key. Keyframe extraction is the new
// surface area; the audio path is already covered by audioExtractor tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractKeyframes } from './videoExtractor.js';

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

async function hasFfprobe() {
  return new Promise(resolve => {
    try {
      const child = spawn('ffprobe', ['-version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', code => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

async function buildTestVideo(videoPath, durationSec = 6) {
  // Generate a tiny synthetic mp4 in pure ffmpeg (no audio, no camera, no
  // network). 6s at 4 fps with a moving counter so each keyframe is visibly
  // different — confirms we're sampling distinct moments, not duplicating one.
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-f', 'lavfi',
      '-i', `testsrc2=size=320x240:rate=4:duration=${durationSec}`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-y',
      videoPath,
    ], { stdio: 'ignore' });
    ff.on('error', reject);
    ff.on('exit', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg testsrc gen exited ${code}`))));
  });
}

const ffmpegOk = await hasFfmpeg();
const ffprobeOk = await hasFfprobe();
// node:test's `skip` is truthy/string-based — pass `false` when we don't
// want to skip (passing `null` actually registers a skip in some versions).
const skipReason = !ffmpegOk
  ? 'ffmpeg unavailable on this host'
  : !ffprobeOk
    ? 'ffprobe unavailable on this host'
    : false;

test('extractKeyframes pulls evenly-spaced JPEG data URLs from a 6s test video', { skip: skipReason }, async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'melo-video-test-'));
  const videoPath = join(workDir, 'sample.mp4');
  const framesDir = join(workDir, 'frames');
  try {
    await buildTestVideo(videoPath, 6);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(framesDir, { recursive: true });

    const frames = await extractKeyframes(videoPath, framesDir);

    // 6s ÷ 5 target = 1.2s interval → ~5 frames extracted (cap 8).
    assert.ok(frames.length >= 3, `expected ≥3 frames, got ${frames.length}`);
    assert.ok(frames.length <= 8, `expected ≤8 frames, got ${frames.length}`);

    for (const dataUrl of frames) {
      assert.ok(
        dataUrl.startsWith('data:image/jpeg;base64,'),
        `frame must be a JPEG data URL, got: ${dataUrl.slice(0, 40)}`,
      );
      // Sanity: the base64 payload should decode to >0 bytes (not an empty stub).
      const b64 = dataUrl.split(',')[1] || '';
      assert.ok(b64.length > 100, 'JPEG payload should not be trivially small');
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('extractKeyframes returns [] when ffprobe cannot read duration', { skip: !ffmpegOk }, async () => {
  // Feed it a path that exists but isn't a valid video — ffprobe fails,
  // probeDurationSec returns null, function bails to [].
  const workDir = await mkdtemp(join(tmpdir(), 'melo-video-test-bad-'));
  const fakePath = join(workDir, 'not-a-video.bin');
  const framesDir = join(workDir, 'frames');
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(framesDir, { recursive: true });
    await writeFile(fakePath, Buffer.from('this is not a video file'));

    const frames = await extractKeyframes(fakePath, framesDir);
    assert.deepEqual(frames, []);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});
