/**
 * ttsRoutes.voiceCall.test.js — the live voice call routes (2026-11-16,
 * docs/realtime-voice-plan-20261116.md).
 *
 * speech-plan returns what a reply reads aloud and whether a server voice can
 * read it; speech synthesizes one sentence. The invariant that matters for an
 * interruption: when the page drops a sentence request, the synthesis behind
 * it is aborted — the provider request is really closed, nothing is written
 * back, and an aborted synthesis never restarts the local voice service.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';

import { createTtsRoutes } from './ttsRoutes.js';

function request(body) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', headers: {} });
}

function response() {
  const res = new EventEmitter();
  Object.assign(res, {
    status: 0, body: '', writableFinished: false, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers || {}); },
    end(text) { this.body = String(text || ''); this.writableFinished = true; },
  });
  return res;
}

async function call(routes, path, body, res = response()) {
  const handled = await routes.handle(request(body), res, new URL(`http://localhost${path}`), () => true);
  assert.equal(handled, true, `${path} is a declared route`);
  return res;
}

const noVoicePack = () => { throw new Error('the voice pack must not be started'); };

test('speech-plan: the sentences a call reads and whether a server voice can read them', async () => {
  const configs = [];
  const routes = createTtsRoutes({ startVoicePackServers: noVoicePack, voiceCall: { configFor: async body => { configs.push(body); return { ttsProvider: 'edge' }; } } });
  const res = await call(routes, '/api/voice-call/speech-plan', { text: '**好的**，明天上午十点提醒你。详细内容我放在聊天里了。\n1. 第一步', agentId: 'agent-a' });
  assert.equal(res.status, 200);
  const plan = JSON.parse(res.body);
  assert.deepEqual(plan.sentences, ['好的，明天上午十点提醒你。', '详细内容我放在聊天里了。']);
  assert.equal(plan.condensed, true);
  assert.equal(plan.serverVoice, true);
  assert.equal(configs[0].agentId, 'agent-a', 'the replying Agent decides the voice');

  const silent = createTtsRoutes({ startVoicePackServers: noVoicePack, voiceCall: { configFor: async () => ({ ttsProvider: 'minimax' }) } });
  const unavailable = JSON.parse((await call(silent, '/api/voice-call/speech-plan', { text: 'Sure, at ten.' })).body);
  assert.equal(unavailable.serverVoice, false, 'MiniMax without its key cannot read');
  assert.match(unavailable.reason, /MiniMax/);
  assert.deepEqual(unavailable.sentences, ['Sure, at ten.'], 'the page still gets the sentences for the system voice');

  const empty = JSON.parse((await call(routes, '/api/voice-call/speech-plan', { text: '' })).body);
  assert.deepEqual(empty.sentences, []);
});

test('speech: one sentence in the configured voice; empty text and an unavailable voice are refused', async () => {
  const synthesized = [];
  const routes = createTtsRoutes({
    startVoicePackServers: noVoicePack,
    voiceCall: {
      configFor: async () => ({ ttsProvider: 'edge', ttsEdgeVoice: 'zh-CN-XiaoxiaoNeural' }),
      synthesize: async (text, config, { signal }) => { synthesized.push({ text, voice: config.ttsEdgeVoice, aborted: signal.aborted }); return { buffer: Buffer.from('mp3-bytes'), mimeType: 'audio/mpeg' }; },
    },
  });
  const res = await call(routes, '/api/voice-call/speech', { text: '好的。', agentId: 'agent-a' });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(Buffer.from(body.audio, 'base64').toString(), 'mp3-bytes');
  assert.equal(body.mimeType, 'audio/mpeg');
  assert.deepEqual(synthesized, [{ text: '好的。', voice: 'zh-CN-XiaoxiaoNeural', aborted: false }]);

  assert.equal((await call(routes, '/api/voice-call/speech', { text: '   ' })).status, 400);
  assert.equal(synthesized.length, 1, 'nothing is synthesized for empty text');

  const unavailable = createTtsRoutes({ startVoicePackServers: noVoicePack, voiceCall: { configFor: async () => ({ ttsProvider: 'minimax' }), synthesize: async () => { synthesized.push('called'); return null; } } });
  assert.equal((await call(unavailable, '/api/voice-call/speech', { text: '好的。' })).status, 422);
  assert.equal(synthesized.length, 1, 'an unavailable voice is not even tried');

  const failing = createTtsRoutes({ startVoicePackServers: noVoicePack, voiceCall: { configFor: async () => ({ ttsProvider: 'edge' }), synthesize: async () => null } });
  assert.equal((await call(failing, '/api/voice-call/speech', { text: '好的。' })).status, 502);
});

test('speech: a dropped request aborts the synthesis in progress and writes nothing back', async () => {
  let finished = 0, aborted = 0;
  const routes = createTtsRoutes({
    startVoicePackServers: noVoicePack,
    voiceCall: {
      configFor: async () => ({ ttsProvider: 'edge' }),
      // Resolves on its own after 300 ms unless aborted first: an implementation
      // that ignored the drop would count `finished` and answer.
      synthesize: (text, config, { signal }) => new Promise(resolve => {
        const timer = setTimeout(() => { finished += 1; resolve({ buffer: Buffer.from('late'), mimeType: 'audio/mpeg' }); }, 300);
        signal.addEventListener('abort', () => { clearTimeout(timer); aborted += 1; resolve(null); }, { once: true });
      }),
    },
  });
  const res = response();
  const pending = call(routes, '/api/voice-call/speech', { text: '这一句会被打断。' }, res);
  await new Promise(resolve => setTimeout(resolve, 30));
  res.emit('close'); // the page aborted its fetch (barge-in / hang-up)
  await pending;
  assert.equal(aborted, 1, 'the synthesis saw the abort');
  assert.equal(finished, 0, 'no finished audio for a sentence nobody will hear');
  assert.equal(res.status, 0);
  assert.equal(res.body, '', 'nothing is written to a dropped request');
});

test('speech: the real synthesis chain closes the provider request on a drop and never restarts the voice pack', async t => {
  // A local "voice pack" that accepts the request and never answers.
  const seen = [];
  const closed = [];
  const provider = createServer(req => {
    seen.push(req.url);
    req.on('close', () => closed.push(req.url));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => new Promise(resolve => { provider.closeAllConnections?.(); provider.close(() => resolve()); }));
  const { port } = provider.address();
  let restarts = 0;
  const routes = createTtsRoutes({
    startVoicePackServers: async () => { restarts += 1; },
    voiceCall: { configFor: async () => ({ ttsProvider: 'custom', customVoiceBaseUrl: `http://127.0.0.1:${port}` }) },
  });
  const res = response();
  const pending = call(routes, '/api/voice-call/speech', { text: '这一句会被打断。' }, res);
  const deadline = Date.now() + 5000;
  while (!seen.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(seen, ['/audio/speech'], 'the synthesis reached the provider');
  res.emit('close');
  await pending;
  while (!closed.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(closed, ['/audio/speech'], 'the provider request was closed, not left running');
  assert.equal(restarts, 0, 'an aborted synthesis is not a voice-pack failure');
  assert.equal(res.body, '');
});
