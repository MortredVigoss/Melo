import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAudioContent, extractAudioContentFromBuffer } from './audioExtractor.js';

test('extractAudioContentFromBuffer returns a soft fallback in codex mode without credentials', async () => {
  const fakeBuffer = Buffer.alloc(4096, 0x41);
  const result = await extractAudioContentFromBuffer(fakeBuffer, {
    fileName: 'voice.ogg',
    mimeType: 'audio/ogg',
    url: 'data:audio/ogg;base64,QUJD',
  }, {
    config: {
      authMode: 'codex',
      apiKey: '',
      baseUrl: 'https://chatgpt.com/backend-api',
    },
  });

  assert.ok(result !== null, 'should return a fallback object, not null');
  assert.equal(result?.kind, 'transcript');
  assert.match(result?.text || '', /transcription/i);
  assert.equal(result?.metadata?.source, 'whisper-unavailable');
});

test('extractAudioContentFromBuffer returns a soft fallback in local mode without credentials', async () => {
  const fakeBuffer = Buffer.alloc(4096, 0x41);
  const result = await extractAudioContentFromBuffer(fakeBuffer, {
    fileName: 'voice.wav',
    mimeType: 'audio/wav',
    url: 'data:audio/wav;base64,QUJD',
  }, {
    config: {
      authMode: 'local',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434/v1',
    },
  });

  assert.ok(result !== null, 'should return a fallback object in local mode too');
  assert.equal(result?.kind, 'transcript');
  assert.equal(result?.metadata?.source, 'whisper-unavailable');
});

test('extractAudioContentFromBuffer returns null in api-key mode without credentials (misconfigured)', async () => {
  const fakeBuffer = Buffer.alloc(4096, 0x41);
  const result = await extractAudioContentFromBuffer(fakeBuffer, {
    fileName: 'voice.mp3',
    mimeType: 'audio/mpeg',
    url: 'data:audio/mpeg;base64,QUJD',
  }, {
    config: {
      authMode: 'api-key',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
    },
  });

  assert.equal(result, null, 'api-key mode without key returns null, not a fallback');
});

test('extractAudioContentFromBuffer suppresses fallback when suppressFallback is true', async () => {
  const fakeBuffer = Buffer.alloc(4096, 0x41);
  const result = await extractAudioContentFromBuffer(fakeBuffer, {
    fileName: 'audio-from-video.ogg',
    mimeType: 'audio/ogg',
    url: 'data:audio/ogg;base64,QUJD',
  }, {
    config: {
      authMode: 'codex',
      apiKey: '',
      baseUrl: 'https://chatgpt.com/backend-api',
    },
    suppressFallback: true,
  });

  assert.equal(result, null, 'should return null when suppressFallback=true even in codex mode');
});

test('extractAudioContent passes suppressFallback through to extractAudioContentFromBuffer', async () => {
  const fakeBuffer = Buffer.alloc(4096, 0x41);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => fakeBuffer.buffer });

  try {
    const result = await extractAudioContent(
      { url: 'https://example.com/voice.ogg', mimeType: 'audio/ogg', fileName: 'voice.ogg' },
      { config: { authMode: 'codex', apiKey: '', baseUrl: 'https://chatgpt.com/backend-api' } },
      { suppressFallback: true },
    );
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
