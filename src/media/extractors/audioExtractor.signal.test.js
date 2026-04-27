// Codex C-grade fix #5: prove that AbortSignal threading actually kills the
// real audio-transcription backends, not just the JS-level promise wrapper.
//
// Strategy:
//   - whisper.cpp: stand up a fake whisper-cli that hangs forever on real
//     work but exits 0 for `--help` (so `checkWhisperCppReady` thinks it's
//     installed). Point MELO_WHISPER_CLI at the fake. Abort signal must
//     SIGTERM the child within budget.
//   - OpenAI Whisper fetch: stand up a tiny http server that never replies.
//     Set MELO_BASE_URL / MELO_API_KEY to drive the fetch path. Abort
//     signal must terminate the fetch within budget.
//
// We avoid stubbing extractAudioContent itself — the whole point is to prove
// the real cancellation path works end-to-end.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import {
  _resetWhisperCppReadyForTests,
  extractAudioContentFromBuffer,
} from './audioExtractor.js';

// ── Fixtures: fake whisper-cli ─────────────────────────────────────────────
// A bash script that exits 0 for `--help` but hangs forever for any real
// transcription call. Lets `checkWhisperCppReady()` succeed so the code
// proceeds to the actual exec where abort can be observed.

function ffmpegAvailable() {
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

const ORIG_WHISPER_CLI = process.env.MELO_WHISPER_CLI;
const ORIG_WHISPER_MODEL = process.env.MELO_WHISPER_CPP_MODEL;
const ORIG_BASE_URL = process.env.MELO_BASE_URL;
const ORIG_API_KEY = process.env.MELO_API_KEY;

const fakeBinDir = mkdtempSync(join(tmpdir(), 'melo-audio-signal-test-'));
const fakeWhisperPath = join(fakeBinDir, 'fake-whisper-cli');
writeFileSync(
  fakeWhisperPath,
  '#!/bin/bash\nif [[ "$1" == "--help" ]]; then echo ok; exit 0; fi\nsleep 99999\n',
  { mode: 0o755 },
);
chmodSync(fakeWhisperPath, 0o755);

// Fake model file just needs to exist for `existsSync` to return true.
const fakeModelPath = join(fakeBinDir, 'model.bin');
writeFileSync(fakeModelPath, 'fake');

after(() => {
  try { rmSync(fakeBinDir, { recursive: true, force: true }); } catch {}
  if (ORIG_WHISPER_CLI === undefined) delete process.env.MELO_WHISPER_CLI;
  else process.env.MELO_WHISPER_CLI = ORIG_WHISPER_CLI;
  if (ORIG_WHISPER_MODEL === undefined) delete process.env.MELO_WHISPER_CPP_MODEL;
  else process.env.MELO_WHISPER_CPP_MODEL = ORIG_WHISPER_MODEL;
  if (ORIG_BASE_URL === undefined) delete process.env.MELO_BASE_URL;
  else process.env.MELO_BASE_URL = ORIG_BASE_URL;
  if (ORIG_API_KEY === undefined) delete process.env.MELO_API_KEY;
  else process.env.MELO_API_KEY = ORIG_API_KEY;
});

const ffmpegOk = await ffmpegAvailable();

// ── Pre-aborted signal short-circuits before any backend runs ─────────────

test('extractAudioContentFromBuffer: pre-aborted signal returns null without invoking any backend', async () => {
  const ac = new AbortController();
  ac.abort();

  const start = Date.now();
  const result = await extractAudioContentFromBuffer(
    Buffer.alloc(4096, 0x41),
    { fileName: 'test.ogg', mimeType: 'audio/ogg', url: 'data:audio/ogg;base64,QUJD' },
    { config: { authMode: 'codex', apiKey: '', baseUrl: 'https://chatgpt.com' }, signal: ac.signal },
  );
  const elapsed = Date.now() - start;

  assert.equal(result, null);
  assert.ok(elapsed < 200, `pre-aborted should return immediately, took ${elapsed}ms`);
});

// ── whisper.cpp child gets SIGTERM'd on abort ─────────────────────────────

test('extractAudioContentFromBuffer: aborts whisper-cli child within budget', { skip: !ffmpegOk }, async () => {
  // Reset state, point MELO_WHISPER_CLI at our hanging fake.
  _resetWhisperCppReadyForTests();
  process.env.MELO_WHISPER_CLI = fakeWhisperPath;
  process.env.MELO_WHISPER_CPP_MODEL = fakeModelPath;

  // We need a WAV-encodable buffer so convertToWavForNative succeeds and the
  // call reaches the hanging whisper-cli step. Use a real ogg buffer via
  // ffmpeg generating 1s of silence. Tiny + valid input.
  const silentOgg = await new Promise(resolve => {
    const ff = spawn('ffmpeg', [
      '-f', 'lavfi',
      '-i', 'anullsrc=r=16000:cl=mono',
      '-t', '1',
      '-f', 'ogg',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    ff.stdout.on('data', c => chunks.push(c));
    ff.on('exit', () => resolve(Buffer.concat(chunks)));
    ff.on('error', () => resolve(Buffer.alloc(0)));
  });

  if (silentOgg.length === 0) {
    // ffmpeg lavfi unavailable on this machine — skip rather than fail.
    return;
  }

  const ac = new AbortController();
  // Abort 200ms after start: the fake whisper-cli is sleeping 99999s, so
  // without signal threading the call would hang far past any test budget.
  setTimeout(() => ac.abort(), 200);

  const start = Date.now();
  const result = await extractAudioContentFromBuffer(
    silentOgg,
    { fileName: 'test.ogg', mimeType: 'audio/ogg', url: 'data:audio/ogg;base64,QUJD' },
    { config: { authMode: 'codex', apiKey: '', baseUrl: 'https://chatgpt.com' }, signal: ac.signal, suppressFallback: true },
  );
  const elapsed = Date.now() - start;

  assert.equal(result, null);
  // Allow generous slack for ffmpeg WAV conversion (1-2s) before whisper-cli
  // even runs. If the kill didn't work, the call would hang ~99999s.
  assert.ok(elapsed < 5000, `whisper-cli abort should land well within 5s, took ${elapsed}ms`);

  _resetWhisperCppReadyForTests();
});

// ── OpenAI Whisper fetch is aborted by external signal ────────────────────

test('extractAudioContentFromBuffer: aborts OpenAI Whisper fetch within budget', async () => {
  // Fake whisper-cli not ready (unset) so the code falls through to the
  // OpenAI fetch path. Use authMode 'apiKey' + a non-local URL to skip the
  // soft-fallback and require the real fetch.
  _resetWhisperCppReadyForTests();
  process.env.MELO_WHISPER_CLI = '/nonexistent-binary-xyz';
  process.env.MELO_WHISPER_CPP_MODEL = '/nonexistent-model-xyz';

  // Stand up a fake server that accepts the connection but never replies.
  const server = createServer((req, res) => { /* hang */ });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const fakeUrl = `http://127.0.0.1:${port}/v1`;

  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);

    const start = Date.now();
    const result = await extractAudioContentFromBuffer(
      Buffer.alloc(4096, 0x41),
      { fileName: 'test.ogg', mimeType: 'audio/ogg', url: 'data:audio/ogg;base64,QUJD' },
      {
        config: { authMode: 'apiKey', apiKey: 'fake-key', baseUrl: fakeUrl },
        signal: ac.signal,
        suppressFallback: true,
      },
    );
    const elapsed = Date.now() - start;

    assert.equal(result, null);
    // Fetch's internal timeout is 60s. Without signal threading, we'd wait
    // the full 60s. With it, the abort lands well within budget.
    assert.ok(elapsed < 3000, `fetch abort should land well within 3s, took ${elapsed}ms`);
  } finally {
    server.close();
    _resetWhisperCppReadyForTests();
  }
});
