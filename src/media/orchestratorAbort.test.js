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
    const { readFile } = await import('node:fs/promises');
    const videoBuf = await readFile(videoPath);
    const dataUrl = `data:video/mp4;base64,${videoBuf.toString('base64')}`;

    // Generous inner budgets (30s) so only the parent can fire first.
    _setMediaBudgetsForTests({ totalMs: 30000, perAttachmentMs: 1500 });
    _setVideoBudgetsForTests({ audioMs: 30000, keyframeMs: 30000 });

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

      // Anti-false-green: the stub MUST have run, otherwise the test proves
      // nothing about parent-signal propagation.
      assert.ok(audioStubReached, 'audio stub must have been reached — otherwise ffmpeg pre-pass took longer than parent budget and the test is not exercising the post-download path');
      // The core contract: parent's 1500ms timeout fires → inner stub's
      // signal fires → stub resolves null. Without parent-signal threading,
      // the stub would hang until the inner audio budget (30s) ran out.
      assert.ok(audioStubSignalAborted, 'parent abort must propagate into the inner audio stub signal');
      assert.ok(elapsed < 4000, `parent budget ~1.5s + cleanup; should not approach the 30s inner budget. took ${elapsed}ms`);
    } finally {
      _setExtractAudioContentForTests(null);
      _setVideoBudgetsForTests();
      _setMediaBudgetsForTests();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});
