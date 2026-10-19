// Codex C-grade fix #7 (final round): the media orchestrator now uses
// `withTimeoutAndAbort` so its per-attachment budget actually CANCELS the
// underlying extraction (not just races a JS promise). This integration
// test drives a real audio attachment through `enrichMessageWithMediaContext`
// against a hanging server and asserts the connection is dropped before the
// budget upper bound — proving the orchestrator-created AbortSignal made it
// through routeExtraction → extractAudioContent → readAttachmentBuffer →
// fetch.
//
// Companion to src/media/extractors/audioExtractor.signal.test.js, which
// proves the BACKEND respects an externally-supplied signal. Together they
// lock the chain end-to-end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {
  _setMediaBudgetsForTests,
  enrichMessageWithMediaContext,
} from './index.js';
import {
  _setBudgetsForTests as _setVideoBudgetsForTests,
  _setExtractAudioContentForTests,
  _setAudioPrePassForTests,
} from './extractors/videoExtractor.js';

async function ffmpegAvailable() {
  return new Promise(resolve => {
    try {
      const c = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      c.on('error', () => resolve(false));
      c.on('exit', code => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

async function buildSilentVideo(videoPath, durationSec = 6) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=4:duration=${durationSec}`,
      '-f', 'lavfi', '-i', `anullsrc=r=16000:cl=mono`,
      '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-shortest',
      '-y', videoPath,
    ], { stdio: 'ignore' });
    ff.on('error', reject);
    ff.on('exit', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

const ffmpegOk = await ffmpegAvailable();

test('enrichMessageWithMediaContext: hanging audio download is aborted by per-attachment budget', async () => {
  // 200ms per-attachment budget so the test is fast. Production default 15s.
  _setMediaBudgetsForTests({ totalMs: 5000, perAttachmentMs: 200 });

  let downloadHit = false;
  let connectionAbortedByClient = false;
  const server = createServer((req, res) => {
    downloadHit = true;
    req.on('close', () => {
      // Node sets `aborted` true when the client (our fetch) aborts mid-flight
      // BEFORE the response ends. `complete` is true if the server sent a
      // proper response. We hung — never sent — so `aborted=true` here means
      // the client side cancelled.
      if (req.aborted || !res.writableEnded) {
        connectionAbortedByClient = true;
      }
    });
    /* never end */
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const message = {
      role: 'user',
      blocks: [{ kind: 'text', text: 'check this' }],
      attachments: [{
        id: 'a1',
        kind: 'audio',
        url: `http://127.0.0.1:${port}/audio.ogg`,
        fileName: 'remote.ogg',
        mimeType: 'audio/ogg',
      }],
    };

    const start = Date.now();
    await enrichMessageWithMediaContext(message, {
      config: { authMode: 'codex', apiKey: '', baseUrl: 'https://chatgpt.com' },
    });
    const elapsed = Date.now() - start;

    // Anti-false-green: if the server wasn't hit, the test proves nothing.
    // Possible reasons: cache hit, wrong route, budget skipped extraction
    // entirely. None should happen with the setup above.
    assert.ok(downloadHit, 'fake download server must have received the request');

    // The orchestrator's 200ms budget MUST have aborted before the internal
    // 30s readAttachmentBuffer fetch timeout. Allow generous headroom for
    // socket teardown but well under any non-abort path.
    assert.ok(elapsed < 2000, `should abort well within budget, took ${elapsed}ms`);

    // Give Node a tick to surface the close event after the orchestrator returns.
    await new Promise(r => setTimeout(r, 50));
    assert.ok(connectionAbortedByClient, 'fetch must have been aborted client-side — otherwise the abort signal never reached fetch');
  } finally {
    server.closeAllConnections?.();
    server.close();
    _setMediaBudgetsForTests();  // restore production defaults
  }
});

// ─── Codex C-grade fix #8: video post-download parent-abort propagation ────
// extractVideoContent's inner withAudioBudget / withKeyframeBudget create
// their own AbortControllers. Without parent-signal threading, when the
// orchestrator's 15s timeout fires AFTER the video download completes and
// the inner branches have started, those inner branches keep running their
// full local budgets (audio 10s + keyframe 5s) — leaking ffmpeg / Whisper
// children for several seconds. This test drives that exact scenario:
//   1. Real video downloads/decodes successfully (data URL, instant).
//   2. ffmpeg pre-pass finishes (~50-100ms on testsrc2).
//   3. The audio stub starts and listens for abort.
//   4. Orchestrator's 1500ms parent budget fires.
//   5. Stub's signal MUST fire (proving parent → withAudioBudget combined
//      signal → stub).
test('video post-download abort: orchestrator timeout propagates into inner audio branch', { skip: !ffmpegOk }, async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'melo-orch-video-test-'));
  const videoPath = join(workDir, 'sample.mp4');
  try {
    await buildSilentVideo(videoPath, 6);
    const { readFile, writeFile } = await import('node:fs/promises');
    const videoBuf = await readFile(videoPath);
    // Embed a per-run nonce in the data URL parameters so the orchestrator's
    // media cache (keyed on `${attachment.kind}:${attachment.url}`) does not
    // pollute across runs. buildSilentVideo's bytes are deterministic; without
    // the nonce a prior run's `keyframes-only` cache entry short-circuits
    // extraction and the audio stub is never reached.
    const dataUrl = `data:video/mp4;melo-test-nonce=${Date.now()}-${Math.random().toString(36).slice(2)};base64,${videoBuf.toString('base64')}`;

    // Tight parent budget so the abort path fires fast. Set the SOCIAL_DIRECT
    // budgets too — `data:video/*` URLs trigger `shouldUseLongSocialMediaBudget`,
    // which floors per-attachment budget at SOCIAL_DIRECT_PER_ATTACHMENT_BUDGET_MS
    // (default 55s). Without overriding that, the test's perAttachmentMs:1500
    // is silently ignored and the inner audio budget (30s below) fires first.
    _setMediaBudgetsForTests({
      totalMs: 30000,
      perAttachmentMs: 1500,
      socialDirectTotalMs: 30000,
      socialDirectPerAttachmentMs: 1500,
    });
    // Generous inner budgets (30s) so only the parent can fire first.
    _setVideoBudgetsForTests({ audioMs: 30000, keyframeMs: 30000 });

    // Stub the ffmpeg audio pre-pass. The real call takes 50-300ms locally
    // but can exceed the 1.5s parent budget on slow CI, which would kill the
    // pre-pass and prevent the audio stub from being reached — making this
    // test silently fail to exercise the post-download abort path it claims
    // to verify (G-1c style false-skip). Stub writes a 4-byte placeholder so
    // the subsequent readFile() succeeds and audioBranch advances to the
    // _extractAudioContentImpl call that the test cares about.
    let prePassCalls = 0;
    _setAudioPrePassForTests(async (_videoPath, audioPath) => {
      prePassCalls += 1;
      await writeFile(audioPath, Buffer.from([0x4F, 0x67, 0x67, 0x53]));
    });

    let audioStubSignalAborted = false;
    let audioStubReached = false;
    _setExtractAudioContentForTests((attachment, context, opts) => {
      audioStubReached = true;
      return new Promise(resolve => {
        const sig = opts?.signal;
        if (!sig) {
          // Test setup error — without a signal the stub couldn't observe abort
          return resolve(null);
        }
        sig.addEventListener('abort', () => {
          audioStubSignalAborted = true;
          resolve(null);
        });
        // Otherwise hang until aborted — exact behavior of a slow Whisper backend.
      });
    });

    try {
      const message = {
        role: 'user',
        blocks: [{ kind: 'text', text: 'analyze this' }],
        attachments: [{
          id: 'v-test',
          kind: 'video',
          url: dataUrl,
          fileName: 'sample.mp4',
          mimeType: 'video/mp4',
        }],
      };

      const start = Date.now();
      await enrichMessageWithMediaContext(message, {});
      const elapsed = Date.now() - start;

      // Anti-false-green: the pre-pass DI seam MUST have been used. If the
      // hook somehow regresses to the real ffmpeg call, prePassCalls stays 0
      // and the timing assertion below could mask the regression on a fast
      // machine — making this test re-flake later.
      assert.equal(prePassCalls, 1, 'audio pre-pass stub must have been called exactly once (real seam check)');
      // Anti-false-green: the stub MUST have run, otherwise the test proves
      // nothing about parent-signal propagation.
      assert.ok(audioStubReached, 'audio stub must have been reached — otherwise ffmpeg pre-pass took longer than parent budget and the test is not exercising the post-download path');
      // The core contract: parent's 1500ms timeout fires → inner stub's
      // signal fires → stub resolves null. Without parent-signal threading,
      // the stub would hang until the inner audio budget (30s) ran out.
      assert.ok(audioStubSignalAborted, 'parent abort must propagate into the inner audio stub signal');
      assert.ok(elapsed < 4000, `parent budget ~1.5s + cleanup; should not approach the 30s inner budget. took ${elapsed}ms`);
    } finally {
      _setAudioPrePassForTests(null);
      _setExtractAudioContentForTests(null);
      _setVideoBudgetsForTests();
      _setMediaBudgetsForTests();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ─── Phase 4 fan-out: image / PDF / link / yt-dlp signal propagation ───────
// These tests drive the remaining four extractor kinds through the same
// orchestrator path used by audio/video. Each one stands up a hanging
// server (or fake hanging child for yt-dlp), runs the orchestrator with a
// 200ms budget, and asserts:
//   1. the backend was actually reached (anti-false-green flag),
//   2. the connection / child was cancelled client-side (proves the abort
//      signal propagated through routeExtraction → extractor → fetch/spawn),
//   3. elapsed << internal extractor timeout (proves we're not waiting for
//      the per-extractor 30s/60s timeout to fire).

test('orchestrator abort: PDF download cancelled mid-flight', async () => {
  _setMediaBudgetsForTests({ totalMs: 5000, perAttachmentMs: 200 });

  let downloadHit = false;
  let connectionAborted = false;
  const server = createServer((req, res) => {
    downloadHit = true;
    req.on('close', () => {
      if (req.aborted || !res.writableEnded) connectionAborted = true;
    });
    /* hang */
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const message = {
      role: 'user',
      blocks: [{ kind: 'text', text: 'parse this' }],
      attachments: [{
        id: 'p1',
        kind: 'link',  // routeExtraction's PDF detection fires off mimeType / .pdf URL
        url: `http://127.0.0.1:${port}/spec.pdf`,
        fileName: 'spec.pdf',
        mimeType: 'application/pdf',
      }],
    };

    const start = Date.now();
    await enrichMessageWithMediaContext(message, {});
    const elapsed = Date.now() - start;

    assert.ok(downloadHit, 'PDF server must have received the request');
    assert.ok(elapsed < 2000, `PDF abort took ${elapsed}ms; expected < 2000ms`);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(connectionAborted, 'PDF fetch must be aborted client-side');
  } finally {
    server.closeAllConnections?.();
    server.close();
    _setMediaBudgetsForTests();
  }
});

test('orchestrator abort: link fetch cancelled mid-flight', async () => {
  _setMediaBudgetsForTests({ totalMs: 5000, perAttachmentMs: 200 });

  let downloadHit = false;
  let connectionAborted = false;
  const server = createServer((req, res) => {
    downloadHit = true;
    req.on('close', () => {
      if (req.aborted || !res.writableEnded) connectionAborted = true;
    });
    /* hang */
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const message = {
      role: 'user',
      blocks: [{ kind: 'text', text: 'check this article' }],
      attachments: [{
        id: 'l1',
        kind: 'link',
        url: `http://127.0.0.1:${port}/article.html`,
        fileName: '',
        mimeType: 'text/html',
      }],
    };

    const start = Date.now();
    await enrichMessageWithMediaContext(message, {});
    const elapsed = Date.now() - start;

    assert.ok(downloadHit, 'link server must have received the request');
    assert.ok(elapsed < 2000, `link abort took ${elapsed}ms; expected < 2000ms`);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(connectionAborted, 'link fetch must be aborted client-side');
  } finally {
    server.closeAllConnections?.();
    server.close();
    _setMediaBudgetsForTests();
  }
});

// Deterministic since 2026-10-19: under the daily gate's parallel load the
// 200 ms wall-clock budget could expire before the request even reached the
// server ("image server must have received the request"). The orchestrator's
// budget timer now runs on node:test mock timers and fires only once the
// server holds the request; the server holds its response, so only that
// budget can end the download; the test then waits for the connection close
// event instead of sleeping 50 ms. Same assertions as before: the request
// arrived, the budget (not a server reply) ended the extraction promptly, and
// the client dropped the connection.
test('orchestrator abort: image download cancelled mid-flight (OCR pre-stage)', { timeout: 15000 }, async t => {
  _setMediaBudgetsForTests({ totalMs: 5000, perAttachmentMs: 200 });

  let downloadHit = false;
  let connectionAborted = false;
  let requestArrived;
  let connectionClosed;
  const arrived = new Promise(resolve => { requestArrived = resolve; });
  const closed = new Promise(resolve => { connectionClosed = resolve; });
  const server = createServer((req, res) => {
    downloadHit = true;
    req.on('close', () => {
      if (req.aborted || !res.writableEnded) connectionAborted = true;
      connectionClosed();
    });
    requestArrived();
    /* hold the response: only the orchestrator's budget may end this request */
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  // Only setTimeout (the orchestrator's per-attachment budget timer); fetch
  // and the server run on real I/O.
  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    const message = {
      role: 'user',
      blocks: [{ kind: 'text', text: 'OCR this' }],
      attachments: [{
        id: 'img1',
        kind: 'image',
        url: `http://127.0.0.1:${port}/screenshot.png`,
        fileName: 'screenshot.png',
        mimeType: 'image/png',
      }],
    };

    // Force OCR path (modelSupportsVision: false means extractImageContent
    // runs Tesseract instead of returning null immediately). Default for
    // unspecified vision context.
    let settled = false;
    const enriched = enrichMessageWithMediaContext(message, { modelSupportsVision: false })
      .finally(() => { settled = true; });
    await arrived;
    assert.ok(downloadHit, 'image server must have received the request');
    assert.equal(settled, false, 'the held download keeps the extraction pending until the budget fires');

    const start = Date.now();
    t.mock.timers.tick(200);
    await enriched;
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `image download abort took ${elapsed}ms; expected < 2000ms`);

    t.mock.timers.reset();
    let guard;
    await Promise.race([closed, new Promise(resolve => { guard = setTimeout(resolve, 2000); })]);
    clearTimeout(guard);
    assert.ok(connectionAborted, 'image fetch must be aborted client-side');
  } finally {
    t.mock.timers.reset();
    server.closeAllConnections?.();
    server.close();
    _setMediaBudgetsForTests();
  }
});

// Codex B finding (#10 follow-up + #11 follow-up): OCR is backed by a
// Tesseract worker that we can `.terminate()` on abort, so a hung OCR pass
// no longer pins a CPU core after the orchestrator returns. The
// `_setTesseractForTests` DI hook lets us drive the three abort phases
// against a controllable fake — the real Tesseract's createWorker takes
// 5-30s on a cold cache and can't be cancelled mid-flight, so a real-lib
// integration test can't reliably exercise mid-create or mid-recognize
// abort.

test('orchestrator abort: pre-aborted signal short-circuits OCR worker creation', async () => {
  const { extractImageContent } = await import('./extractors/imageExtractor.js');
  const ac = new AbortController();
  ac.abort();

  // Real-ish PNG header + padding to clear MIN_OCR_BYTES (1024). The exact
  // bytes don't matter — we never reach Tesseract.recognize.
  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    Buffer.alloc(2000, 0xFF),
  ]);
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;

  const start = Date.now();
  const result = await extractImageContent(
    { url: dataUrl, fileName: 'test.png', mimeType: 'image/png' },
    { signal: ac.signal },
  );
  const elapsed = Date.now() - start;

  assert.equal(result, null);
  // Tesseract.createWorker on a cold cache takes 5-30s downloading language
  // data. If we bailed in <500ms we definitely never got there.
  assert.ok(elapsed < 500, `pre-abort should bail in <500ms, took ${elapsed}ms`);
});

test('OCR mid-createWorker abort: terminates the freshly-created worker, returns null', async () => {
  const { extractImageContent, _setTesseractForTests } = await import('./extractors/imageExtractor.js');

  let createStarted = false;
  let recognizeStarted = false;
  let terminateCalled = false;
  // Fake Tesseract that takes 300ms to create the worker, then would run
  // recognize forever. Abort at 100ms — during createWorker. When
  // createWorker resolves, the production code must check the flag and
  // terminate immediately without calling recognize.
  _setTesseractForTests({
    createWorker: () => {
      createStarted = true;
      return new Promise(resolve => setTimeout(() => {
        resolve({
          recognize: () => { recognizeStarted = true; return new Promise(() => {}); },
          terminate: async () => { terminateCalled = true; },
        });
      }, 300));
    },
  });

  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);

    const buf = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47]),
      Buffer.alloc(2000, 0xFF),
    ]);
    const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    const start = Date.now();
    const result = await extractImageContent(
      { url: dataUrl, fileName: 'test.png', mimeType: 'image/png' },
      { signal: ac.signal },
    );
    const elapsed = Date.now() - start;

    assert.equal(result, null);
    assert.ok(createStarted, 'createWorker must have been invoked (otherwise abort hit pre-create branch, not mid-create)');
    // Anti-false-green: the fake's recognize MUST NOT run — abort hit
    // during createWorker, so the post-create check should terminate
    // without ever calling recognize.
    assert.equal(recognizeStarted, false, 'recognize must NOT run when abort fires during createWorker');
    assert.ok(terminateCalled, 'worker must be terminated after createWorker resolves with abort flag set');
    // createWorker takes 300ms, abort at 100ms, terminate happens at
    // ~300ms (when createWorker resolves). Should land under 800ms.
    assert.ok(elapsed < 800, `mid-create abort should settle near createWorker completion, took ${elapsed}ms`);
  } finally {
    _setTesseractForTests(null);
  }
});

test('OCR mid-recognize abort: terminates the worker, recognize promise rejected, returns null', async () => {
  const { extractImageContent, _setTesseractForTests } = await import('./extractors/imageExtractor.js');

  let recognizeStarted = false;
  let terminateCalled = false;
  // Fake worker: createWorker returns instantly. recognize hangs forever.
  // Abort fires at 100ms during recognize. Listener should call terminate;
  // recognize promise rejects (we make it reject when terminate is called
  // — that's how the real Tesseract worker would behave).
  let rejectRecognize = null;
  _setTesseractForTests({
    createWorker: async () => ({
      recognize: () => new Promise((resolve, reject) => {
        recognizeStarted = true;
        rejectRecognize = reject;  // captured so terminate can settle it
      }),
      terminate: async () => {
        terminateCalled = true;
        if (rejectRecognize) rejectRecognize(new Error('worker terminated'));
      },
    }),
  });

  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);

    const buf = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47]),
      Buffer.alloc(2000, 0xFF),
    ]);
    const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    const start = Date.now();
    const result = await extractImageContent(
      { url: dataUrl, fileName: 'test.png', mimeType: 'image/png' },
      { signal: ac.signal },
    );
    const elapsed = Date.now() - start;

    assert.equal(result, null);
    assert.ok(recognizeStarted, 'recognize must have started — otherwise abort hit a pre-recognize branch');
    assert.ok(terminateCalled, 'worker must be terminated when abort fires during recognize');
    // Abort at 100ms; terminate is synchronous; total should be near 100-200ms.
    assert.ok(elapsed < 1000, `mid-recognize abort should settle near abort time, took ${elapsed}ms`);
  } finally {
    _setTesseractForTests(null);
  }
});

test('orchestrator abort: yt-dlp child SIGKILL on budget timeout', async () => {
  // Stand up a fake yt-dlp that exits 0 fast for --version (so hasYtDlp()
  // resolves true) but hangs forever on real metadata calls. The fake
  // writes marker files at each entry point so we can prove (anti-false-
  // green) that:
  //   - the metadata path was actually reached (not short-circuited),
  //   - the spawned child PID was killed by SIGKILL (not allowed to finish
  //     naturally — no "completed" marker, kill -0 fails after abort).
  // Without these markers, an elapsed-only assertion would pass even if
  // the fake binary never ran (e.g., routeExtraction failed earlier).
  const fakeBinDir = await mkdtemp(join(tmpdir(), 'melo-fake-ytdlp-'));
  const fakeYtDlp = join(fakeBinDir, 'fake-yt-dlp');
  const versionMarker = join(fakeBinDir, 'version-marker');
  const metadataMarker = join(fakeBinDir, 'metadata-marker');
  const completedMarker = join(fakeBinDir, 'completed-marker');
  const pidFile = join(fakeBinDir, 'metadata-pid');
  const { writeFile, chmod, readFile, stat } = await import('node:fs/promises');
  await writeFile(
    fakeYtDlp,
    [
      '#!/bin/bash',
      `if [[ "$1" == "--version" ]]; then`,
      `  echo "1.0.0"; touch "${versionMarker}"; exit 0`,
      `fi`,
      // Real metadata invocation: write PID + marker, then `exec sleep` so
      // bash REPLACES itself with sleep. The spawned PID is now sleep
      // directly — production's SIGKILL on that PID kills the real
      // blocking process (no orphan sleep child reparented to PID 1).
      // Without `exec`, every test run would leak a 99999s sleep.
      `echo "$$" > "${pidFile}"`,
      `touch "${metadataMarker}"`,
      `exec sleep 99999`,
      // Unreachable: exec replaces the process. Kept as a safety marker —
      // if `exec` somehow fails, the completed marker would tell us.
      `touch "${completedMarker}"`,
    ].join('\n') + '\n',
    { mode: 0o755 },
  );
  await chmod(fakeYtDlp, 0o755);

  const ORIG_BIN = process.env.MELO_YTDLP_BIN;
  process.env.MELO_YTDLP_BIN = fakeYtDlp;

  const { _resetYtDlpAvailabilityForTests } = await import('./extractors/youtubeExtractor.js');
  if (typeof _resetYtDlpAvailabilityForTests === 'function') {
    _resetYtDlpAvailabilityForTests();
  }

  _setMediaBudgetsForTests({ totalMs: 5000, perAttachmentMs: 1500 });

  try {
    const message = {
      role: 'user',
      blocks: [{ kind: 'text', text: 'analyze' }],
      attachments: [{
        id: 'y1',
        kind: 'video',
        url: 'https://www.bilibili.com/video/BV1234567890',
        fileName: '',
        mimeType: '',
      }],
    };

    const start = Date.now();
    await enrichMessageWithMediaContext(message, {});
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 4000, `yt-dlp abort took ${elapsed}ms; expected < 4000ms`);

    // Anti-false-green guards:
    //   1. --version probe ran (otherwise hasYtDlp() returned false and the
    //      metadata branch never started).
    await stat(versionMarker);  // throws if missing → test fails
    //   2. metadata invocation actually reached (otherwise the abort was
    //      observed at some earlier stage, not at runProcess level).
    await stat(metadataMarker);
    //   3. NO "completed" marker — if SIGKILL didn't land, the bash script
    //      would eventually run `touch completedMarker` after `sleep 99999`
    //      finishes naturally. Allowing 100ms slack post-abort for the
    //      filesystem to settle.
    await new Promise(r => setTimeout(r, 100));
    await assert.rejects(stat(completedMarker), /ENOENT/);
    //   4. The metadata-stage child PID is dead. `kill -0 <pid>` returns 0
    //      if alive, throws if dead/missing. `process.kill(pid, 0)` is the
    //      Node equivalent. We expect it to throw.
    const pidText = await readFile(pidFile, 'utf8');
    const pid = parseInt(pidText.trim(), 10);
    assert.ok(Number.isFinite(pid) && pid > 0, `pid file should contain a PID, got: ${pidText}`);
    // Strictly ESRCH — EPERM would mean the process EXISTS but we lack
    // permission, which is the opposite of "dead". The fake yt-dlp ran
    // under the same uid as the test, so we should never hit EPERM here.
    assert.throws(() => process.kill(pid, 0), /ESRCH/, `pid ${pid} must be dead after abort (only ESRCH accepted)`);
  } finally {
    if (ORIG_BIN === undefined) delete process.env.MELO_YTDLP_BIN;
    else process.env.MELO_YTDLP_BIN = ORIG_BIN;
    if (typeof _resetYtDlpAvailabilityForTests === 'function') {
      _resetYtDlpAvailabilityForTests();
    }
    _setMediaBudgetsForTests();
    await rm(fakeBinDir, { recursive: true, force: true }).catch(() => {});
  }
});
