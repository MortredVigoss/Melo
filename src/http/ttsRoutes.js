import { createRouteRegistry } from './routeRegistry.js';
import { sendJson, readJsonBody } from './transport.js';
import { synthesizeWithEdgeTts as _synthesizeWithEdgeTts } from '../services/tts/edgeTts.js';
import { createNativeSayQueue } from '../services/tts/nativeSayQueue.js';

export function createTtsRoutes({ startVoicePackServers }) {
let _nativeSayQueue = null;
async function _getNativeSayQueue() {
  if (_nativeSayQueue) return _nativeSayQueue;
  const { spawn } = await import('node:child_process');
  _nativeSayQueue = createNativeSayQueue({
    spawn,
    stderr: line => process.stderr.write(`${line}\n`),
  });
  return _nativeSayQueue;
}

function _concatWavBuffers(wavBuffers) {
  if (!wavBuffers.length) return Buffer.alloc(0);
  let sampleRate = 24000, numChannels = 1, bitsPerSample = 16;
  const pcmChunks = [];
  for (const buf of wavBuffers) {
    if (!buf || buf.length < 44) continue;
    numChannels   = buf.readUInt16LE(22);
    sampleRate    = buf.readUInt32LE(24);
    bitsPerSample = buf.readUInt16LE(34);
    // Locate 'data' sub-chunk (usually at offset 36, but search to be safe)
    let dataStart = 44;
    for (let i = 12; i < Math.min(buf.length - 8, 256); i++) {
      if (buf[i] === 0x64 && buf[i+1] === 0x61 && buf[i+2] === 0x74 && buf[i+3] === 0x61) {
        dataStart = i + 8; // skip 'data' tag (4) + size field (4)
        break;
      }
    }
    pcmChunks.push(buf.subarray(dataStart));
  }
  const pcm = Buffer.concat(pcmChunks);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);                                          // fmt chunk size
  header.writeUInt16LE(1, 20);                                           // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * numChannels * (bitsPerSample >> 3), 28); // byte rate
  header.writeUInt16LE(numChannels * (bitsPerSample >> 3), 32);          // block align
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function _splitSentences(text, maxLen = 110) {
  const BREAK = /[。！？\n]|[.!?](?=\s|$)/;
  const sentences = [];
  let buf = '';
  for (const char of text) {
    buf += char;
    if (BREAK.test(char)) {
      const s = buf.trim();
      if (s.length >= 2) sentences.push(s);
      buf = '';
    }
    // Force-split if buffer exceeds maxLen (no punctuation in sight)
    if (buf.length >= maxLen) {
      const s = buf.trim();
      if (s.length >= 2) sentences.push(s);
      buf = '';
    }
  }
  const tail = buf.trim();
  if (tail.length >= 2) sentences.push(tail);
  return sentences.length ? sentences : [text.slice(0, maxLen)];
}

function _trackTtsController() {
  if (!globalThis._ttsActiveControllers) globalThis._ttsActiveControllers = new Set();
  const ctrl = new AbortController();
  globalThis._ttsActiveControllers.add(ctrl);
  return ctrl;
}

function _untrackTtsController(ctrl) {
  globalThis._ttsActiveControllers?.delete(ctrl);
}

function _abortAllTtsControllers() {
  if (!globalThis._ttsActiveControllers) return;
  for (const ctrl of globalThis._ttsActiveControllers) {
    try { ctrl.abort(); } catch {}
  }
  globalThis._ttsActiveControllers.clear();
}

async function _synthesizeWithRecovery(text, config, opts = {}) {
  const { synthesizeSpeech } = await import('../tts.js');
  let result = await synthesizeSpeech(text, config, opts);
  if (result) return result;

  // Synthesis returned null — check if this is a local F5-TTS endpoint
  const whisperUrl = String(config?.whisperBaseUrl || '');
  if (!/127\.0\.0\.1:7860/.test(whisperUrl)) return null; // remote endpoint, don't interfere

  process.stdout.write('[tts] Synthesis failed — restarting F5-TTS and retrying...\n');
  try {
    await startVoicePackServers({ force: true });
    const ready = await _waitForF5Tts(90_000);
    if (!ready) {
      process.stderr.write('[tts] F5-TTS did not recover within 90s.\n');
      return null;
    }
    result = await synthesizeSpeech(text, config, opts);
    if (result) {
      process.stdout.write('[tts] F5-TTS recovery successful.\n');
    } else {
      process.stderr.write('[tts] F5-TTS synthesis still failing after restart.\n');
    }
  } catch (err) {
    process.stderr.write(`[tts] Recovery error: ${err?.message || err}\n`);
  }
  return result;
}

async function _waitForF5Tts(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = 'http://127.0.0.1:7860/health';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 4000));
  }
  return false;
}

async function _playBufferWithAfplay(buffer, mimeType) {
  const { writeFile, unlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: jp } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const ext = mimeType === 'audio/mpeg' ? 'mp3' : 'wav';
  const tmpFile = jp(tmpdir(), `melo-tts-${Date.now()}.${ext}`);
  await writeFile(tmpFile, buffer);
  await new Promise((resolve) => {
    if (globalThis._meloAfplayProcess) {
      try { globalThis._meloAfplayProcess.kill(); } catch {}
    }
    const proc = spawn('/usr/bin/afplay', [tmpFile], { detached: false });
    globalThis._meloAfplayProcess = proc;
    proc.on('exit', async () => {
      if (globalThis._meloAfplayProcess === proc) globalThis._meloAfplayProcess = null;
      await unlink(tmpFile).catch(() => {});
      resolve();
    });
    proc.on('error', resolve);
  });
}

async function _runTtsQueue() {
  if (globalThis._ttsQueueRunning) return;
  globalThis._ttsQueueRunning = true;
  while (globalThis._ttsQueue?.length > 0) {
    const item = globalThis._ttsQueue.shift();
    if (item.sessionId !== (globalThis._ttsQueueSession || 0)) continue; // stale
    try {
      const result = await item.audioPromise;
      if (item.sessionId !== (globalThis._ttsQueueSession || 0)) break; // cleared mid-flight
      if (result?.buffer) await _playBufferWithAfplay(result.buffer, result.mimeType);
    } catch (e) {
      process.stderr.write(`[tts-queue] ${e?.message || e}\n`);
    }
  }
  globalThis._ttsQueueRunning = false;
}
const router = createRouteRegistry([
    // ── TTS endpoint ─────────────────────────────────────────────────────────
    { method: 'POST', paths: ["/api/tts/speak"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      const text = String(body?.text || '').trim();
      if (!text) {
        sendJson(response, 400, { ok: false, error: 'text is required.' });
        return;
      }
      const { getResolvedConfig } = await import('../config.js');
      const { synthesizeSpeech, getTtsUnavailableReason } = await import('../tts.js');
      const config = await getResolvedConfig();
      const unavailable = getTtsUnavailableReason(config);
      if (unavailable) {
        sendJson(response, 422, { ok: false, error: unavailable });
        return;
      }
      const result = await synthesizeSpeech(text, config, {
        voice: body?.voice || undefined,
        model: body?.model || undefined,
      });
      if (!result) {
        sendJson(response, 502, {
          ok: false,
          error: 'TTS synthesis failed. Check that your API key supports the /audio/speech endpoint.',
        });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        audio: result.buffer.toString('base64'),
        mimeType: result.mimeType,
      });
      return;
    } },

    // ── TTS sentence queue (streaming TTS: parallel synthesis, ordered playback) ─
    // Each sentence is synthesized in parallel but played in submission order.
    // Endpoint: /api/tts/queue-add  — add sentence, starts synthesis immediately
    //           /api/tts/queue-clear — stop playback & discard pending sentences
    { method: 'POST', paths: ["/api/tts/queue-add"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      const text = String(body?.text || '').trim();
      if (!text) { sendJson(response, 400, { ok: false, error: 'text required' }); return; }
      const { getResolvedConfig } = await import('../config.js');
      const { getTtsUnavailableReason } = await import('../tts.js');
      const config = await getResolvedConfig();
      const unavailable = getTtsUnavailableReason(config);
      if (unavailable) { sendJson(response, 422, { ok: false, error: unavailable }); return; }
      // Start synthesis immediately; add its Promise to ordered playback queue.
      // Each item owns an AbortController so /api/tts/queue-clear can really
      // halt the in-flight network call instead of only invalidating the id.
      const ctrl = _trackTtsController();
      const audioPromise = (config.ttsProvider === 'edge'
        ? _synthesizeWithEdgeTts(text, config, { signal: ctrl.signal })
        : _synthesizeWithRecovery(text, config, { voice: body?.voice, signal: ctrl.signal })
      ).finally(() => _untrackTtsController(ctrl));
      if (!globalThis._ttsQueue) globalThis._ttsQueue = [];
      const sessionId = globalThis._ttsQueueSession || 0;
      globalThis._ttsQueue.push({ audioPromise, sessionId });
      sendJson(response, 200, { ok: true });
      _runTtsQueue();
      return;
    } },

    { method: 'POST', paths: ["/api/tts/queue-clear"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      globalThis._ttsQueueSession = ((globalThis._ttsQueueSession || 0) + 1);
      globalThis._ttsQueue = [];
      // Bumping the session id only stops play-time skipping. Aborting every
      // tracked controller stops in-flight HTTP fetches + edge-tts subprocess.
      _abortAllTtsControllers();
      if (globalThis._meloAfplayProcess) {
        try { globalThis._meloAfplayProcess.kill(); } catch {}
        globalThis._meloAfplayProcess = null;
      }
      if (globalThis._meloSayProcess) {
        try { globalThis._meloSayProcess.kill(); } catch {}
        globalThis._meloSayProcess = null;
      }
      // Bug 1 (2026-05-12): also clear the new native streaming queue.
      // Without this, the streaming queue keeps reading sentences from a
      // previous reply even after the user stop-clicked or sent a new chat.
      if (_nativeSayQueue) _nativeSayQueue.clear();
      sendJson(response, 200, { ok: true });
      return;
    } },

    // Bug 1 (2026-05-12): streaming TTS for the macOS `say` engine.
    // Pushes one sentence into a sequential queue — the next say spawns
    // only after the previous one exits.  Replaces the per-sentence
    // /api/tts/native POSTs that suffered from kill+replace truncation.
    { method: 'POST', paths: ["/api/tts/native-queue-add"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      const text = String(body?.text || '').trim().slice(0, 400);
      if (!text) { sendJson(response, 400, { ok: false, error: 'text is required.' }); return; }
      const explicitVoice = String(body?.voice || '').trim();
      const lang = String(body?.lang || '').toLowerCase();
      const args = [];
      if (explicitVoice) {
        args.push('-v', explicitVoice);
      } else if (lang.startsWith('zh') || lang.startsWith('cmn')) {
        args.push('-v', 'Tingting');
      } else if (lang.startsWith('ko')) {
        args.push('-v', 'Yuna');
      } else if (lang.startsWith('ja')) {
        args.push('-v', 'Kyoko');
      }
      args.push('--', text);
      const queue = await _getNativeSayQueue();
      queue.add(args);
      sendJson(response, 200, { ok: true });
      return;
    } },

    // ── TTS synthesize-and-play (single utterance, bypasses WKWebView) ────────
    { method: 'POST', paths: ["/api/tts/speak-play"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      const text = String(body?.text || '').trim();
      if (!text) {
        sendJson(response, 400, { ok: false, error: 'text is required.' });
        return;
      }
      const { getResolvedConfig } = await import('../config.js');
      const { synthesizeSpeech, getTtsUnavailableReason } = await import('../tts.js');
      const config = await getResolvedConfig();
      const unavailable = getTtsUnavailableReason(config);
      if (unavailable) {
        sendJson(response, 422, { ok: false, error: unavailable });
        return;
      }
      sendJson(response, 200, { ok: true });
      (async () => {
        try {
          const result = await _synthesizeWithRecovery(text, config, { voice: body?.voice });
          if (result?.buffer) await _playBufferWithAfplay(result.buffer, result.mimeType);
          else process.stderr.write('[tts/speak-play] synthesis returned null — no audio played\n');
        } catch (err) {
          process.stderr.write(`[tts/speak-play] ${err?.message || err}\n`);
        }
      })();
      return;
    } },

    // ── speak-text: full-text TTS with sentence chunking ─────────────────────
    // Used by both the manual "Read aloud" button and auto-speak after streaming.
    // When ttsProvider='edge': sends full text to Edge TTS in one shot (~1-2s).
    // Otherwise: splits into sentences, synthesises in parallel via Fish Speech.
    { method: 'POST', paths: ["/api/tts/speak-text"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      const text = String(body?.text || '').trim();
      if (!text) { sendJson(response, 400, { ok: false, error: 'text required' }); return; }
      const { getResolvedConfig } = await import('../config.js');
      const { getTtsUnavailableReason } = await import('../tts.js');
      const config = await getResolvedConfig();

      // ── Edge TTS fast path ────────────────────────────────────────────────
      if (config.ttsProvider === 'edge') {
        sendJson(response, 200, { ok: true, chunks: 1 });
        if (!globalThis._speakTextSession) globalThis._speakTextSession = 0;
        const sessionId = ++globalThis._speakTextSession;
        const ctrl = _trackTtsController();
        (async () => {
          try {
            const result = await _synthesizeWithEdgeTts(text, config, { signal: ctrl.signal });
            if (!result) { process.stderr.write('[edge-tts] synthesis returned null\n'); return; }
            if (globalThis._speakTextSession !== sessionId) return;
            await _playBufferWithAfplay(result.buffer, result.mimeType);
          } catch (e) {
            process.stderr.write(`[edge-tts] error: ${e?.message || e}\n`);
          } finally {
            _untrackTtsController(ctrl);
          }
        })();
        return;
      }

      // ── MiniMax fast path ─────────────────────────────────────────────────
      if (config.ttsProvider === 'minimax') {
        sendJson(response, 200, { ok: true, chunks: 1 });
        if (!globalThis._speakTextSession) globalThis._speakTextSession = 0;
        const sessionId = ++globalThis._speakTextSession;
        const ctrl = _trackTtsController();
        (async () => {
          try {
            const { synthesizeSpeech } = await import('../tts.js');
            const result = await synthesizeSpeech(text, config, { signal: ctrl.signal });
            if (!result) { process.stderr.write('[minimax-tts] synthesis returned null\n'); return; }
            if (globalThis._speakTextSession !== sessionId) return;
            await _playBufferWithAfplay(result.buffer, result.mimeType);
          } catch (e) {
            process.stderr.write(`[minimax-tts] error: ${e?.message || e}\n`);
          } finally {
            _untrackTtsController(ctrl);
          }
        })();
        return;
      }

      // ── Fish Speech / OpenAI path ─────────────────────────────────────────
      if (getTtsUnavailableReason(config)) {
        sendJson(response, 422, { ok: false, error: getTtsUnavailableReason(config) }); return;
      }

      // Split text into sentences (≤ 110 chars each — under F5-TTS 120-char limit)
      const sentences = _splitSentences(text, 110);

      sendJson(response, 200, { ok: true, chunks: sentences.length });

      if (!globalThis._speakTextSession) globalThis._speakTextSession = 0;
      const sessionId = ++globalThis._speakTextSession;

      // One controller for the whole sentence set: aborting cancels every
      // parallel sentence fetch at once.
      const sentenceCtrl = _trackTtsController();

      (async () => {
        // Synthesise all sentences in parallel, then concatenate into a single
        // WAV and play once — eliminates inter-sentence gaps entirely.
        const audioPromises = sentences.map(s =>
          _synthesizeWithRecovery(s, config, { voice: body?.voice, signal: sentenceCtrl.signal }),
        );
        let results;
        try {
          results = await Promise.all(audioPromises);
        } catch (e) {
          process.stderr.write(`[tts/speak-text] synthesis error: ${e?.message || e}\n`);
          _untrackTtsController(sentenceCtrl);
          return;
        }
        _untrackTtsController(sentenceCtrl);
        if (globalThis._speakTextSession !== sessionId) return; // stopped while synthesising

        const wavBuffers = results
          .filter(r => r?.buffer && /wav/i.test(r?.mimeType || ''))
          .map(r => r.buffer);

        if (wavBuffers.length > 0) {
          try {
            const combined = _concatWavBuffers(wavBuffers);
            await _playBufferWithAfplay(combined, 'audio/wav');
          } catch (e) {
            process.stderr.write(`[tts/speak-text] playback error: ${e?.message || e}\n`);
          }
        } else {
          // Fallback: non-WAV results (e.g. remote mp3) — play sequentially
          for (const result of results) {
            if (globalThis._speakTextSession !== sessionId) break;
            if (result?.buffer) {
              try { await _playBufferWithAfplay(result.buffer, result.mimeType); } catch {}
            }
          }
        }
      })();
      return;
    } },

    // ── Stop afplay TTS ───────────────────────────────────────────────────────
    { method: 'POST', paths: ["/api/tts/speak-stop"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      // Invalidate speak-text session so in-flight loops stop
      globalThis._speakTextSession = (globalThis._speakTextSession || 0) + 1;
      // Abort every in-flight synthesis fetch (covers both speak-text fast
      // paths and the queue path so a single Stop click halts everything).
      _abortAllTtsControllers();
      if (globalThis._meloAfplayProcess) {
        try { globalThis._meloAfplayProcess.kill(); } catch {}
        globalThis._meloAfplayProcess = null;
      }
      if (globalThis._meloSayProcess) {
        try { globalThis._meloSayProcess.kill(); } catch {}
        globalThis._meloSayProcess = null;
      }
      // Bug 1 (2026-05-12): also halt the streaming `say` queue.  Without
      // this, /api/tts/speak-stop wouldn't cover the macOS-streaming path
      // — the queue would keep reading sentences after the user pressed Stop.
      if (_nativeSayQueue) _nativeSayQueue.clear();
      sendJson(response, 200, { ok: true });
      return;
    } },

    // ── Test playback for a candidate MiniMax config ─────────────────────────
    // Lets the connector settings UI verify a MiniMax key/groupId/voiceId
    // BEFORE persisting. Body: { apiKey, groupId, voiceId, text? }.
    // synthesizeSpeech receives a one-shot config override (no global save)
    // and on success the audio plays through host speakers via afplay so
    // the user hears the result immediately.
    { method: 'POST', paths: ["/api/tts/test-minimax"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      const formApiKey  = String(body?.apiKey  || '').trim();
      const formGroupId = String(body?.groupId || '').trim();
      const formVoiceId = String(body?.voiceId || '').trim();
      const text        = String(body?.text || '你好，这是 MiniMax 测试朗读').slice(0, 200);
      const formSpeed = Number.isFinite(Number(body?.speed)) ? Number(body.speed) : undefined;
      const formPitch = Number.isFinite(Number(body?.pitch)) ? Number(body.pitch) : undefined;
      const formVol = Number.isFinite(Number(body?.vol)) ? Number(body.vol) : undefined;

      // Fallback to the persisted config when the form field is blank —
      // lets users click "Test playback" without retyping a key they
      // already saved (the password input is masked so blank means
      // "use the saved one"). Group ID is optional; voice ID can come
      // from either side. process.env is still ignored so this stays
      // a "test the form/saved values" semantics, not "test the env".
      const { getResolvedConfig } = await import('../config.js');
      const cfg = await getResolvedConfig();
      const apiKey  = formApiKey  || String(cfg.minimaxApiKey  || '').trim();
      const groupId = formGroupId || String(cfg.minimaxGroupId || '').trim();
      const voiceId = formVoiceId || String(cfg.minimaxVoiceId || '').trim();
      const speed = formSpeed ?? (Number.isFinite(Number(cfg.ttsSpeed)) ? Number(cfg.ttsSpeed) : undefined);
      const pitch = formPitch ?? (Number.isFinite(Number(cfg.ttsPitch)) ? Number(cfg.ttsPitch) : undefined);
      const vol = formVol ?? (Number.isFinite(Number(cfg.ttsVol)) ? Number(cfg.ttsVol) : undefined);

      if (!apiKey) {
        sendJson(response, 400, { ok: false, error: 'No MiniMax API key — type one in the form, or save one first.' });
        return;
      }
      if (!voiceId) {
        sendJson(response, 400, { ok: false, error: 'voiceId is required' });
        return;
      }
      try {
        const { testMinimaxSynthesis } = await import('../tts.js');
        const result = await testMinimaxSynthesis(text, { apiKey, groupId, voiceId, speed, pitch, vol });
        if (!result) {
          sendJson(response, 502, { ok: false, error: 'MiniMax synthesis returned null — check API key, Group ID, and voice ID.' });
          return;
        }
        // Play through host speakers (same pattern as /api/tts/speak-text).
        sendJson(response, 200, { ok: true, bytes: result.buffer.length });
        _playBufferWithAfplay(result.buffer, result.mimeType).catch(e => {
          process.stderr.write(`[tts/test-minimax] playback error: ${e?.message || e}\n`);
        });
      } catch (e) {
        sendJson(response, 400, { ok: false, error: e?.message || 'Unexpected error during synthesis' });
      }
      return;
    } },

    // ── Native TTS via macOS `say` command (plays audio directly on host) ────
    // Uses `say` without -o so audio plays through system speakers immediately.
    // Responds immediately; a separate /api/tts/native-stop can kill the process.
    //
    // The UI now passes an explicit `voice` parameter (selected from
    // /api/tts/say-voices). Falls back to the legacy lang→voice heuristic
    // (Tingting/Yuna/Kyoko) when no explicit voice is supplied — preserves
    // backward-compatible behavior for any caller that hasn't migrated.
    { method: 'POST', paths: ["/api/tts/native"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      const text = String(body?.text || '').trim().slice(0, 400);
      if (!text) {
        sendJson(response, 400, { ok: false, error: 'text is required.' });
        return;
      }
      const { spawn } = await import('node:child_process');
      const explicitVoice = String(body?.voice || '').trim();
      const lang = String(body?.lang || '').toLowerCase();
      const args = [];
      if (explicitVoice) {
        // UI selected a specific voice from the macOS voice list — trust it.
        // `say -v <name>` is happy with any output of `say -v '?'`.
        args.push('-v', explicitVoice);
      } else if (lang.startsWith('zh') || lang.startsWith('cmn')) {
        args.push('-v', 'Tingting');
      } else if (lang.startsWith('ko')) {
        args.push('-v', 'Yuna');
      } else if (lang.startsWith('ja')) {
        args.push('-v', 'Kyoko');
      }
      args.push('--', text);
      // Kill any running say process first
      if (globalThis._meloSayProcess) {
        try { globalThis._meloSayProcess.kill(); } catch {}
        globalThis._meloSayProcess = null;
      }
      const proc = spawn('/usr/bin/say', args, { detached: false });
      globalThis._meloSayProcess = proc;
      proc.on('exit', () => { if (globalThis._meloSayProcess === proc) globalThis._meloSayProcess = null; });
      sendJson(response, 200, { ok: true });
      return;
    } },

    // ── List macOS `say` voices ──────────────────────────────────────────────
    // Parses `say -v '?'` output into [{ name, lang, sample }] so the UI can
    // populate the macOS voice dropdown with the actual voices installed on
    // this Mac (instead of recycling the browser's speechSynthesis list,
    // which is what the legacy "System voice" UI did and was confusingly
    // ineffective). Returns an empty list on non-macOS hosts.
    { method: 'GET', paths: ["/api/tts/say-voices"], auth: 'local-read', handler: async ({ request, response, url, requireLocalOrigin }) => {
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const { parseSayVoiceList } = await import('../tts.js');
        const { stdout } = await execFileAsync('/usr/bin/say', ['-v', '?'], {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        });
        sendJson(response, 200, { ok: true, voices: parseSayVoiceList(stdout) });
      } catch (err) {
        // Non-macOS host or `say` missing — empty list, not an error.
        sendJson(response, 200, { ok: true, voices: [], reason: err?.message || 'say unavailable' });
      }
      return;
    } },

    // ── Stop native TTS (legacy path kept as alias) ───────────────────────────
    { method: 'POST', paths: ["/api/tts/native-stop"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      if (globalThis._meloSayProcess) {
        try { globalThis._meloSayProcess.kill(); } catch {}
        globalThis._meloSayProcess = null;
      }
      if (globalThis._meloAfplayProcess) {
        try { globalThis._meloAfplayProcess.kill(); } catch {}
        globalThis._meloAfplayProcess = null;
      }
      // Bug 1 follow-up (Codex 🔵 on 987f6e2): also clear the streaming
      // `say` queue.  This endpoint advertises itself as the native-TTS
      // stop alias, so omitting it would leave macOS streaming playback
      // un-stoppable through this path — symmetric gap with the speak-stop
      // / queue-clear endpoints which already got the fix in 987f6e2.
      if (_nativeSayQueue) _nativeSayQueue.clear();
      sendJson(response, 200, { ok: true });
      return;
    } },

    // ── Audio transcription endpoint ─────────────────────────────────────────
    { method: 'POST', paths: ["/api/audio/transcribe"], auth: 'local-write', handler: async ({ request, response, url, requireLocalOrigin }) => {
      const body = await readJsonBody(request);
      const audioUrl = String(body?.url || '').trim();
      if (!audioUrl) {
        sendJson(response, 400, { ok: false, error: 'url is required.' });
        return;
      }
      const { getResolvedConfig } = await import('../config.js');
      const { extractAudioContent } = await import('../media/extractors/audioExtractor.js');
      const config = await getResolvedConfig();
      try {
        const result = await extractAudioContent(
          { kind: 'audio', url: audioUrl, name: 'audio' },
          { config },
        );
        // The chat-extraction soft-fallback returns
        //   { kind:'transcript', text:<placeholder>, metadata:{ source:'whisper-unavailable' } }
        // so messages still get a placeholder. The explicit transcribe
        // endpoint is the user's "give me the transcript" request, not a
        // background extraction — surface the placeholder as an actionable
        // error pointing at settings instead of pretending it succeeded.
        const source = result?.metadata?.source || '';
        if (source === 'whisper-unavailable' || source === 'whisper-error') {
          sendJson(response, 422, {
            ok: false,
            error: result?.content || result?.text ||
              'Transcription is not available — set a Whisper-compatible endpoint in Settings → Connector.',
          });
          return;
        }
        const text = result?.content || result?.text || '';
        if (!text.trim()) {
          sendJson(response, 502, { ok: false, error: 'Transcription returned empty text.' });
          return;
        }
        sendJson(response, 200, { ok: true, text });
      } catch (err) {
        sendJson(response, 500, { ok: false, error: err?.message || 'Transcription failed.' });
      }
      return;
    } },
]);
return { handle: router.handle, matches: router.matches, inventory: router.inventory };
}
