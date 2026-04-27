// Phase 2/3 video-extractor regression. Two layers of coverage:
//   - Unit: `extractKeyframes`, `withKeyframeBudget`, and `spawnWithAbort`
//     in isolation. These don't depend on Whisper credentials.
//   - End-to-end: `extractVideoContent` driven through the DI hook
//     `_setExtractAudioContentForTests`. The hook lets us stub the audio
//     branch (success / null / placeholder) without a real Whisper key, so
//     we can lock the Phase 3 contract: keyframes-only video still ships a
//     useful entry to the model.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _setBudgetsForTests,
  _setExtractAudioContentForTests,
  extractKeyframes,
  extractVideoContent,
  spawnWithAbort,
  withAudioBudget,
  withKeyframeBudget,
} from './videoExtractor.js';

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

async function buildTestVideo(videoPath, durationSec = 6, { withAudio = true } = {}) {
  // Generate a tiny synthetic mp4 in pure ffmpeg (no camera, no network).
  // 6s at 4 fps with a moving counter so each keyframe is visibly different
  // — confirms we're sampling distinct moments, not duplicating one.
  // withAudio=true adds a silent audio track so the audio-extraction path
  // succeeds (needed for the "happy path" e2e test); withAudio=false leaves
  // it video-only so we can also exercise the silent-video → keyframes-only
  // branch realistically.
  const args = [
    '-f', 'lavfi',
    '-i', `testsrc2=size=320x240:rate=4:duration=${durationSec}`,
  ];
  if (withAudio) {
    args.push('-f', 'lavfi', '-i', `anullsrc=r=16000:cl=mono`);
    args.push('-c:a', 'aac', '-shortest');
  }
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', videoPath);

  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: 'ignore' });
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

// ─── withKeyframeBudget contract ────────────────────────────────────────────
// Codex C-grade finding: the outer routeExtraction race kills the WHOLE
// extraction at 15s, so a slow ffmpeg keyframe pass could throw away an
// already-successful transcript. These three tests lock the contract that
// withKeyframeBudget always resolves to an array within budget, regardless
// of what the inner work() does — so the caller's transcript stays safe.

test('withKeyframeBudget: hanging work resolves to [] within the budget', async () => {
  const start = Date.now();
  const result = await withKeyframeBudget(
    () => new Promise(() => {}),  // never resolves
    50,                           // tiny budget for fast test
  );
  const elapsed = Date.now() - start;
  assert.deepEqual(result, []);
  assert.ok(elapsed < 500, `should bail near budget, took ${elapsed}ms`);
});

test('withKeyframeBudget: throwing work resolves to []', async () => {
  const result = await withKeyframeBudget(() => Promise.reject(new Error('boom')));
  assert.deepEqual(result, []);
});

test('withKeyframeBudget: fast successful work returns its result unchanged', async () => {
  const fakeFrames = ['data:image/jpeg;base64,abc', 'data:image/jpeg;base64,def'];
  const result = await withKeyframeBudget(() => Promise.resolve(fakeFrames));
  assert.deepEqual(result, fakeFrames);
});

test('withKeyframeBudget: aborts the work signal on timeout', async () => {
  let abortFired = false;
  await withKeyframeBudget(
    signal => new Promise(resolve => {
      signal.addEventListener('abort', () => {
        abortFired = true;
        resolve(['should-be-ignored']);
      });
    }),
    50,
  );
  assert.equal(abortFired, true);
});

// ─── spawnWithAbort: real child-process kill on abort ──────────────────────
// Codex C-grade fix #2 reason for existing: previous revision only proved the
// JS-level signal fired, not that the actual ffmpeg/ffprobe child was killed.
// These tests use a real `node` child that hangs forever — if abort doesn't
// SIGKILL it, the test will hang past its budget and the assertion catches it.

test('spawnWithAbort: abort while a hanging child is running rejects within budget', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 80);

  const start = Date.now();
  await assert.rejects(
    spawnWithAbort('node', ['-e', 'setInterval(()=>{},1e9)'], { signal: ac.signal }),
    /aborted/i,
  );
  const elapsed = Date.now() - start;
  // If kill didn't work, the node child runs ~31 years. Anything under a
  // second proves SIGKILL landed and the parent didn't end up waiting on a
  // zombie that never exits.
  assert.ok(elapsed < 1000, `spawnWithAbort should reject promptly on abort, took ${elapsed}ms`);
});

test('spawnWithAbort: signal already aborted at call → child is killed before settling', async () => {
  const ac = new AbortController();
  ac.abort();

  let observedChild;
  const start = Date.now();
  await assert.rejects(
    spawnWithAbort('node', ['-e', 'setInterval(()=>{},1e9)'], {
      signal: ac.signal,
      onSpawn: c => { observedChild = c; },
    }),
    /aborted/i,
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `pre-aborted spawn should bail fast, took ${elapsed}ms`);
  assert.ok(observedChild, 'onSpawn must observe the child even when pre-aborted');
  // Node sets `killed = true` synchronously when kill() is invoked.
  assert.equal(observedChild.killed, true);
});

test('spawnWithAbort: clean exit removes the abort listener (no late settle)', async () => {
  // Use a child that exits quickly. After it exits, fire abort. If the
  // listener wasn't removed, the abort handler would try to kill an already-
  // exited process and could cause an unhandled rejection or settle the
  // already-resolved promise. We assert no exception is thrown post-resolve.
  const ac = new AbortController();
  await spawnWithAbort('node', ['-e', 'process.exit(0)'], { signal: ac.signal });
  // If we reach here the spawn resolved cleanly; aborting now must be a no-op.
  ac.abort();
  // Yield once so any stray microtasks fire — would surface a TypeError if
  // the listener tried to call kill() on a dead handle.
  await new Promise(r => setTimeout(r, 20));
});

// ─── extractKeyframes: signal threading ─────────────────────────────────────

test('extractKeyframes: aborted signal short-circuits with []', { skip: !ffmpegOk || !ffprobeOk }, async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'melo-video-test-abort-'));
  const videoPath = join(workDir, 'sample.mp4');
  const framesDir = join(workDir, 'frames');
  try {
    await buildTestVideo(videoPath, 6);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(framesDir, { recursive: true });

    const ac = new AbortController();
    ac.abort();  // already aborted before we call

    const frames = await extractKeyframes(videoPath, framesDir, { signal: ac.signal });
    assert.deepEqual(frames, []);
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

// ─── extractVideoContent end-to-end (Phase 3 contract) ──────────────────────
// Codex C-grade fix #3 reason: previous revisions threw away keyframes when
// audio extraction failed (no Whisper / silent video). These tests use the
// DI hook to drive each branch of the audio outcome and assert that visual
// context survives.

async function runExtractVideoContentWith(audioStub, { durationSec = 6, withAudio = true, corruptInput = false } = {}) {
  const workDir = await mkdtemp(join(tmpdir(), 'melo-video-e2e-'));
  const videoPath = join(workDir, 'sample.mp4');
  try {
    if (corruptInput) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(videoPath, Buffer.from('not a real mp4'));
    } else {
      await buildTestVideo(videoPath, durationSec, { withAudio });
    }
    const { readFile } = await import('node:fs/promises');
    const videoBuf = await readFile(videoPath);
    const dataUrl = `data:video/mp4;base64,${videoBuf.toString('base64')}`;

    _setExtractAudioContentForTests(audioStub);
    try {
      return await extractVideoContent({
        id: 'test-video',
        kind: 'video',
        url: dataUrl,
        fileName: 'sample.mp4',
        mimeType: 'video/mp4',
      });
    } finally {
      _setExtractAudioContentForTests(null);  // restore real impl
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

test('extractVideoContent: audio + keyframes both succeed → both in result', { skip: !ffmpegOk || !ffprobeOk }, async () => {
  const result = await runExtractVideoContentWith(async () => ({
    kind: 'transcript',
    text: 'fake transcript: someone speaks',
    metadata: { source: 'whisper-cpp', fileName: 'sample.ogg', url: '' },
  }));
  assert.ok(result, 'should return a non-null entry');
  assert.equal(result.kind, 'transcript');
  assert.equal(result.text, 'fake transcript: someone speaks');
  assert.equal(result.metadata.source, 'video-audio-transcript');
  assert.equal(result.metadata.originalKind, 'video');
  assert.ok(Array.isArray(result.metadata.keyframes));
  assert.ok(result.metadata.keyframes.length >= 1, 'at least one keyframe expected');
  for (const f of result.metadata.keyframes) {
    assert.match(f, /^data:image\/jpeg;base64,/);
  }
});

test('extractVideoContent: silent video (no audio stream) + keyframes → frames-only entry (Phase 3)', { skip: !ffmpegOk || !ffprobeOk }, async () => {
  // Real-world silent video: ffmpeg audio pass fails ("Output file does not
  // contain any stream"), Phase 3 must still ship the visual keyframes.
  // Audio stub is irrelevant here because audioBuffer is null before the
  // stub is even called — but we set it to a fake just to prove the code
  // path reaches keyframes via the audio-buffer-null branch, not via the
  // stub returning null.
  const result = await runExtractVideoContentWith(
    async () => ({ kind: 'transcript', text: 'should not be used', metadata: {} }),
    { withAudio: false },
  );
  assert.ok(result, 'frames-only entry should be returned, not null');
  assert.equal(result.kind, 'transcript');
  assert.match(result.text, /no audio transcript/i, 'text must signal absent audio');
  assert.equal(result.metadata.source, 'video-keyframes-only');
  assert.equal(result.metadata.originalKind, 'video');
  assert.ok(result.metadata.keyframes.length >= 1, 'keyframes must survive');
});

test('extractVideoContent: audio stub returns null + keyframes succeed → frames-only entry', { skip: !ffmpegOk || !ffprobeOk }, async () => {
  // Whisper-unavailable scenario: video has audio, ffmpeg encodes it fine,
  // but the audio stub (representing extractAudioContent) returns null —
  // e.g. no API key, codex without local fallback. Phase 3 still ships
  // keyframes through the second code branch.
  const result = await runExtractVideoContentWith(async () => null, { withAudio: true });
  assert.ok(result);
  assert.equal(result.metadata.source, 'video-keyframes-only');
  assert.ok(result.metadata.keyframes.length >= 1);
});

test('extractVideoContent: BOTH audio and keyframes fail → returns null', { skip: !ffmpegOk || !ffprobeOk }, async () => {
  // Corrupt input file: ffmpeg audio pass fails (no streams), ffprobe also
  // fails on the same corrupt bytes → keyframes = []. Both branches empty
  // → the function correctly returns null instead of shipping a useless
  // entry. Locks the explicit `if (keyframes.length > 0)` guard above.
  const result = await runExtractVideoContentWith(async () => null, { corruptInput: true });
  assert.equal(result, null);
});

// ─── Phase 3 hardening: parallel branches, slow-audio, audio-throw ──────────
// Codex C-grade fix #4 reason: previous Phase 3 only handled audio FAILURE,
// not audio HANG. Audio + keyframes now run in parallel via Promise.all
// with independent budgets — these tests exercise the slow / hanging /
// throwing audio paths against a small audio budget so the test suite
// stays fast.

test('withAudioBudget: hanging work resolves to null within budget', async () => {
  const start = Date.now();
  const result = await withAudioBudget(() => new Promise(() => {}), 80);
  const elapsed = Date.now() - start;
  assert.equal(result, null);
  assert.ok(elapsed < 500, `expected ~80ms, got ${elapsed}ms`);
});

test('withAudioBudget: throwing work resolves to null', async () => {
  const result = await withAudioBudget(() => Promise.reject(new Error('boom')));
  assert.equal(result, null);
});

test('withAudioBudget: fast successful work returns its value', async () => {
  const fake = { kind: 'transcript', text: 'ok', metadata: {} };
  const result = await withAudioBudget(() => Promise.resolve(fake));
  assert.deepEqual(result, fake);
});

test('extractVideoContent: SLOW/hanging audio does not block keyframes (Phase 3 parallelism)', { skip: !ffmpegOk || !ffprobeOk }, async () => {
  // Slash the audio budget to 100ms so the test stays fast; stub the audio
  // call to hang forever. Keyframes branch should still settle inside its
  // own 5s budget (typical 6s test video → 1-2s extraction). End result is
  // a frames-only entry, NOT null and NOT a hung promise.
  _setBudgetsForTests({ audioMs: 100 });
  try {
    const start = Date.now();
    const result = await runExtractVideoContentWith(
      () => new Promise(() => {}),  // hangs forever
      { withAudio: true },
    );
    const elapsed = Date.now() - start;

    assert.ok(result, 'frames-only entry expected, not null');
    assert.equal(result.metadata.source, 'video-keyframes-only');
    assert.ok(result.metadata.keyframes.length >= 1);
    // Sanity: max(audio=100ms, keyframes=~2s) ≈ 2s. If audio actually
    // blocked the function, we'd hit the 30s test default timeout instead.
    assert.ok(elapsed < 8000, `extractVideoContent should settle within keyframe budget, took ${elapsed}ms`);
  } finally {
    _setBudgetsForTests();  // restore defaults
  }
});

test('extractVideoContent: audio throws → keyframes-only entry', { skip: !ffmpegOk || !ffprobeOk }, async () => {
  const result = await runExtractVideoContentWith(
    async () => { throw new Error('whisper down'); },
    { withAudio: true },
  );
  assert.ok(result);
  assert.equal(result.metadata.source, 'video-keyframes-only');
  assert.ok(result.metadata.keyframes.length >= 1);
});

test('Phase 3 frames-only entry survives normalizeExtractedMedia', async () => {
  // Final integration: confirm the frames-only entry isn't silently dropped
  // by the normalizer. If the source ever ends up in isPlaceholderSource's
  // list (vision-passthrough / whisper-unavailable / *-placeholder), the
  // model would never see the keyframes — this test catches that drift.
  const { normalizeExtractedMedia } = await import('../index.js');
  const entry = {
    attachmentId: 'vid-x',
    kind: 'transcript',
    text: 'This video has no audio transcript; visual keyframes are attached separately.',
    metadata: {
      source: 'video-keyframes-only',
      originalKind: 'video',
      keyframes: ['data:image/jpeg;base64,/9j/4AAQ'],
    },
  };
  const out = normalizeExtractedMedia([entry]);
  assert.equal(out.length, 1, 'frames-only entry must not be filtered');
  assert.deepEqual(out[0].metadata.keyframes, entry.metadata.keyframes);
});
