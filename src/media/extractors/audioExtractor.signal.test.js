// Codex C-grade fix #5/#6: prove that AbortSignal threading actually kills
// the real audio-transcription backends, not just the JS-level promise
// wrapper. Earlier revision (commit 0ed90fd) was false-green:
//   - whisper.cpp test set `process.env.MELO_WHISPER_CLI` AFTER static import,
//     but production code reads `process.env.MELO_WHISPER_CLI` once at module
//     load into a `const`, so the fake hanging binary was never invoked —
//     the test passed because `whisper-cli` (real) wasn't on PATH and
//     checkWhisperCppReady returned false fast.
//   - OpenAI fetch test passed `authMode: 'apiKey'` but the contract is
//     `'api-key'` (with hyphen). The path fell through to soft-fallback
//     instead of hitting the fake server.
//
// Both are now fixed via the DI hooks `_setWhisperCliForTests` and a
// server-hit assertion that confirms the fake server actually receives a
// /audio/transcriptions request before we abort.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import {
  _resetWhisperCppReadyForTests,
  _setWhisperCliForTests,
  extractAudioContentFromBuffer,
} from './audioExtractor.js';

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

// ── Fake whisper-cli ─────────────────────────────────────────────────────────
// Bash script: `--help` exits 0 fast (so checkWhisperCppReady passes), any
// other invocation sleeps 99999s. If signal threading didn't reach the
// execFile child, this test would hang past the node:test default timeout.

const fakeBinDir = mkdtempSync(join(tmpdir(), 'melo-audio-signal-test-'));
const fakeWhisperPath = join(fakeBinDir, 'fake-whisper-cli');
writeFileSync(
  fakeWhisperPath,
  '#!/bin/bash\nif [[ "$1" == "--help" ]]; then echo ok; exit 0; fi\nsleep 99999\n',
  { mode: 0o755 },
);
chmodSync(fakeWhisperPath, 0o755);

const fakeModelPath = join(fakeBinDir, 'model.bin');
writeFileSync(fakeModelPath, 'fake');

after(() => {
  _setWhisperCliForTests(null, null);
  _resetWhisperCppReadyForTests();
  try { rmSync(fakeBinDir, { recursive: true, force: true }); } catch {}
});

const ffmpegOk = await ffmpegAvailable();

// ── Pre-aborted signal short-circuits before any backend runs ───────────────

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

// ── whisper.cpp child gets SIGTERM'd on abort ───────────────────────────────

test('extractAudioContentFromBuffer: aborts fake whisper-cli child within budget', { skip: !ffmpegOk }, async () => {
  // Force the fake binary via DI hook so production code uses our hanging
  // bash script, not the real `whisper-cli` (which may not be installed).
  _setWhisperCliForTests(fakeWhisperPath, fakeModelPath);

  // Use a WAV buffer so convertToWavForNative short-circuits (its first
  // check is "ext === 'wav' → return audioBuffer"). That isolates this test
  // to the whisper-cli signal path specifically. If we used OGG here, the
  // bisect would also pass with whisper-cli signal disabled because the
  // ffmpeg conversion in convertToWavForNative would itself catch the abort.
  const silentWav = await new Promise(resolve => {
    const ff = spawn('ffmpeg', [
      '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono',
      '-t', '1', '-f', 'wav', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    ff.stdout.on('data', c => chunks.push(c));
    ff.on('exit', () => resolve(Buffer.concat(chunks)));
    ff.on('error', () => resolve(Buffer.alloc(0)));
  });
  if (silentWav.length === 0) return; // ffmpeg lavfi unavailable, skip

  // Abort delay must be large enough that the abort fires while execFile is
  // actually in flight, not while pre-execFile setup (hasFfmpegLocal probe,
  // mkdtemp, writeFile) is still running. 1500ms gives plenty of headroom
  // — bisect-verified: with signal removed from execFile, the test hits
  // the test-timeout instead of returning fast.
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1500);

  const start = Date.now();
  const result = await extractAudioContentFromBuffer(
    silentWav,
    { fileName: 'test.wav', mimeType: 'audio/wav', url: 'data:audio/wav;base64,QUJD' },
    {
      // authMode: 'codex' keeps whisper.cpp priority (api-key would hit
      // OpenAI fetch instead).
      config: { authMode: 'codex', apiKey: '', baseUrl: 'https://chatgpt.com' },
      signal: ac.signal,
      suppressFallback: true,
    },
  );
  const elapsed = Date.now() - start;

  assert.equal(result, null);
  // Fake whisper-cli sleeps 99999s. Without signal threading on execFile,
  // the await blocks until the production 120s execFile timeout fires (or
  // forever in tests). With it, abort SIGTERMs the child shortly after
  // 1500ms and we return well within 4s.
  assert.ok(elapsed < 4000, `whisper-cli abort should land within 4s of start, took ${elapsed}ms`);
  // Anti-false-green: we MUST be returning past the 1500ms abort. If we
  // returned earlier, an upstream signal check caught the abort before
  // execFile ever ran.
  assert.ok(elapsed >= 1500, `should not bail before abort fires, took ${elapsed}ms`);

  _setWhisperCliForTests(null, null);
});

// ── OpenAI Whisper fetch is aborted by external signal ──────────────────────

test('extractAudioContentFromBuffer: aborts OpenAI Whisper fetch within budget', async () => {
  // Force whisper.cpp to be unready via DI hook (point at nonexistent
  // binary) so the code falls through to the OpenAI fetch path.
  _setWhisperCliForTests('/nonexistent-binary-xyz', '/nonexistent-model-xyz');

  // Hanging server: accept the connection, never reply. Track whether the
  // /audio/transcriptions endpoint actually got hit — if it didn't, the
  // test would silently pass via soft-fallback (false-green territory).
  let transcriptionRequestReceived = false;
  const server = createServer((req, res) => {
    if (String(req.url || '').includes('/audio/transcriptions')) {
      transcriptionRequestReceived = true;
    }
    /* never end — fetch hangs until aborted */
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const fakeUrl = `http://127.0.0.1:${port}/v1`;

  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);

    const start = Date.now();
    const result = await extractAudioContentFromBuffer(
      Buffer.alloc(4096, 0x41),
      { fileName: 'test.ogg', mimeType: 'audio/ogg', url: 'data:audio/ogg;base64,QUJD' },
      {
        // 'api-key' (with hyphen) is the contract value resolveTranscriptionConfig
        // recognises. 'apiKey' (camelCase) was the previous test bug — fell
        // through to codex-local-fallback / soft-fallback paths and never
        // hit the fake server.
        config: {
          authMode: 'api-key',
          apiKey: 'fake-key',
          baseUrl: fakeUrl,
        },
        signal: ac.signal,
        suppressFallback: true,
      },
    );
    const elapsed = Date.now() - start;

    assert.equal(result, null);
    // Anti-false-green guard: confirm the fake server actually saw the
    // /audio/transcriptions POST. If this fails, the OpenAI path was never
    // exercised and the elapsed-time check below is meaningless.
    assert.ok(
      transcriptionRequestReceived,
      'fake server must have received POST /audio/transcriptions — otherwise the test is false-green',
    );
    // Internal fetch timeout is 60s. With signal threading, abort lands fast.
    assert.ok(elapsed < 3000, `fetch abort should land well within 3s, took ${elapsed}ms`);
  } finally {
    server.close();
    _setWhisperCliForTests(null, null);
  }
});

// ── Download stage (readAttachmentBuffer) honors the signal ────────────────

test('extractAudioContent: aborts a hanging remote audio download within budget', async () => {
  const { extractAudioContent } = await import('./audioExtractor.js');

  let downloadHit = false;
  const server = createServer((req, res) => {
    downloadHit = true;
    /* hang */
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);

    const start = Date.now();
    const result = await extractAudioContent(
      { fileName: 'remote.ogg', mimeType: 'audio/ogg', url: `http://127.0.0.1:${port}/audio.ogg` },
      { config: { authMode: 'api-key', apiKey: 'fake', baseUrl: 'http://127.0.0.1:1' } },
      { signal: ac.signal, suppressFallback: true },
    );
    const elapsed = Date.now() - start;

    assert.equal(result, null);
    assert.ok(downloadHit, 'fake download server must have been hit — otherwise the signal threading test is false-green');
    // Internal download timeout is 30s. With signal threading, abort lands fast.
    assert.ok(elapsed < 3000, `download abort should land well within 3s, took ${elapsed}ms`);
  } finally {
    server.close();
  }
});
