// "Nothing could transcribe this audio" must not be remembered.
//
// Until 2026-11-14 the placeholder the audio extractor returns in that case
// was written to the extraction cache like a real transcript. The cache key
// is the attachment's content, the lifetime is seven days, so the same file
// stayed without a transcript for a week, also after the user had installed
// or configured what was missing.
//
// These tests run the real enrichMessageWithMediaContext against a local
// stand-in for a Whisper-compatible endpoint, in a data directory of their
// own, and count the requests that reach it.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'melo-placeholder-cache-test-'));
const previousHome = process.env.MELO_HOME;
process.env.MELO_HOME = HOME;

// Environment variables that would send the request somewhere else.
const ENV_NAMES = ['MELO_WHISPER_API_KEY', 'MELO_WHISPER_BASE_URL', 'MELO_API_KEY', 'OPENAI_API_KEY', 'MELO_BASE_URL', 'OPENAI_BASE_URL'];
const previousEnv = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
for (const name of ENV_NAMES) delete process.env[name];

const { enrichMessageWithMediaContext, shouldBypassCachedExtraction } = await import('./index.js');
const { getCachedExtraction, setCachedExtraction } = await import('./cache.js');
const { _setWhisperCliForTests, _resetWhisperCppReadyForTests } = await import('./extractors/audioExtractor.js');

// The stand-in endpoint: refuses until `transcript` is set, then answers with it.
const endpoint = { requests: 0, transcript: '' };
const server = createServer((request, response) => {
  request.resume();
  request.on('end', () => {
    endpoint.requests += 1;
    if (!endpoint.transcript) { response.writeHead(503).end('{}'); return; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: endpoint.transcript }));
  });
});

let context;
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // Local mode: the main base URL is the transcription endpoint, no key.
  context = { config: { authMode: 'local', apiKey: '', baseUrl: `http://127.0.0.1:${server.address().port}/v1` } };
  // No whisper.cpp on this path, whatever the machine has installed. The
  // on-device recogniser is out too: the bytes below are not audio, so the
  // conversion it needs fails (or ffmpeg is absent) before it is asked.
  _setWhisperCliForTests('/nonexistent-whisper-cli', '/nonexistent-whisper-model');
});
after(async () => {
  _setWhisperCliForTests(null, null);
  _resetWhisperCppReadyForTests();
  await new Promise(resolve => server.close(resolve));
  if (previousHome === undefined) delete process.env.MELO_HOME; else process.env.MELO_HOME = previousHome;
  for (const name of ENV_NAMES) if (previousEnv[name] !== undefined) process.env[name] = previousEnv[name];
  try { rmSync(HOME, { recursive: true, force: true }); } catch {}
});

function audio(id, fill) {
  return { id, kind: 'audio', mimeType: 'audio/ogg', fileName: `${id}.ogg`, url: `data:audio/ogg;base64,${Buffer.alloc(2048, fill).toString('base64')}` };
}
const send = async attachment => {
  const message = { role: 'user', content: 'listen', attachments: [attachment] };
  await enrichMessageWithMediaContext(message, context);
  return message.extractedMedia;
};

test('a failed transcription is not cached: the same file is tried again once transcription works', async () => {
  const attachment = audio('voice-1', 0x41);
  const key = `${attachment.kind}:${attachment.url}`;

  endpoint.transcript = '';
  assert.deepEqual(await send(attachment), [], 'no transcript, and no placeholder text for the model');
  assert.equal(endpoint.requests, 1, 'the endpoint was really asked');
  assert.equal(await getCachedExtraction(key), null, 'nothing was written to the cache');

  endpoint.transcript = 'hello from the recording';
  const second = await send(attachment);
  assert.equal(endpoint.requests, 2, 'the same file is tried again');
  assert.equal(second.length, 1);
  assert.equal(second[0].text, 'hello from the recording');
  assert.equal(second[0].metadata.source, 'whisper');
  assert.equal(second[0].attachmentId, 'voice-1');

  const third = await send(attachment);
  assert.equal(endpoint.requests, 2, 'a real transcript is still served from the cache');
  assert.equal(third[0].text, 'hello from the recording');
});

test('a placeholder cached by an older version does not block the retry', async () => {
  const attachment = audio('voice-2', 0x42);
  const key = `${attachment.kind}:${attachment.url}`;
  const placeholder = { kind: 'transcript', text: 'Audio received. Automatic transcription requires a local Whisper endpoint.', metadata: { source: 'whisper-unavailable', fileName: 'voice-2.ogg', url: '' } };
  await setCachedExtraction(key, placeholder);
  assert.deepEqual(await getCachedExtraction(key), placeholder, 'the old entry is on disk');
  assert.equal(shouldBypassCachedExtraction(attachment, placeholder), true);

  endpoint.transcript = 'second recording';
  const before = endpoint.requests;
  const media = await send(attachment);
  assert.equal(endpoint.requests, before + 1, 'the endpoint is asked although an entry exists');
  assert.equal(media[0].text, 'second recording');
  assert.equal((await getCachedExtraction(key)).metadata.source, 'whisper', 'the real transcript replaces the placeholder');
});

test('shouldBypassCachedExtraction: every placeholder source is bypassed, a real transcript is not', () => {
  const attachment = audio('voice-3', 0x43);
  for (const source of ['whisper-unavailable', 'vision-passthrough', 'inline-image-placeholder']) {
    assert.equal(shouldBypassCachedExtraction(attachment, { metadata: { source } }), true, source);
  }
  for (const source of ['whisper', 'whisper-cpp', 'native-speech', '']) {
    assert.equal(shouldBypassCachedExtraction(attachment, { metadata: { source } }), false, source || '(none)');
  }
});
