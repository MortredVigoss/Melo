/**
 * Text-to-Speech service.
 *
 * Provider priority:
 *   1. MiniMax T2A V2  — if minimaxApiKey + minimaxVoiceId are set in config
 *   2. OpenAI-compatible /v1/audio/speech — whisperApiKey / whisperBaseUrl, or api-key mode
 *
 * MiniMax API: POST https://api.minimax.chat/v1/t2a_v2
 *   Returns hex-encoded MP3 in data.audio field.
 */

import { PROVIDER_DEFAULTS } from './shared/modelCatalog.js';
import { localServiceUrl, customVoiceActive, customVoiceService, LOCAL_SERVICE_DEFAULTS } from './shared/localServices.js';

const TTS_TIMEOUT_MS = 180_000; // 3 min — local voice pack (F5-TTS on CPU) can take ~2 min
const TTS_MAX_CHARS  = 4096;

/**
 * Parse the stdout of `/usr/bin/say -v '?'` into `[{ name, lang, sample }]`.
 * Each line looks like:
 *
 *   `Albert              en_US    # Hello! My name is Albert.`
 *
 * Name can contain spaces (e.g. "Reed (English (US))") so we anchor on the
 * locale token (xx or xx_YY) instead of fixed-width columns. Lines that
 * don't match are silently skipped — a tolerant parser avoids crashing on
 * future macOS releases that introduce new format quirks.
 *
 * Exported so the /api/tts/say-voices route handler in src/server.js can
 * delegate, and unit tests can lock the contract without spawning `say`.
 */
export function parseSayVoiceList(stdout = '') {
  return String(stdout || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^(.+?)\s+([a-z]{2}(?:[_-][A-Z]{2,4})?)\s*#\s*(.*)$/);
      if (!match) return null;
      return {
        name: match[1].trim(),
        lang: match[2],
        sample: match[3].trim(),
      };
    })
    .filter(Boolean);
}

const MINIMAX_TTS_BASE = 'https://api.minimaxi.chat/v1/t2a_v2';
const MINIMAX_TTS_MODEL = PROVIDER_DEFAULTS.media.minimaxTts;

function isLocalEndpoint(url = '') {
  try { localServiceUrl(url); return true; } catch { return false; }
}

function cleanBaseUrl(raw = '') {
  return String(raw || '')
    .trim()
    .replace(/\/chat\/completions.*$/i, '')
    .replace(/\/responses.*$/i, '')
    .replace(/\/+$/, '');
}

function resolveTtsConfig(config = {}) {
  const authMode = String(config?.authMode || '').trim().toLowerCase();
  if (customVoiceActive(config)) return { apiKey: '', baseUrl: customVoiceService(config).baseUrl };

  // Priority 1: explicit whisper credentials (same key reused for TTS)
  const explicitKey = String(
    process.env.MELO_WHISPER_API_KEY || config?.whisperApiKey || '',
  ).trim();
  const explicitBaseUrl = String(
    process.env.MELO_WHISPER_BASE_URL || config?.whisperBaseUrl || '',
  ).trim();

  if (explicitKey || explicitBaseUrl) {
    const baseUrl = cleanBaseUrl(explicitBaseUrl || 'https://api.openai.com/v1');
    return { apiKey: explicitKey, baseUrl };
  }

  // Named LLM connections do not grant access to a voice service.
  if (config?.activeLlmProfileId && config.baseUrl !== 'https://api.openai.com/v1') return { apiKey: '', baseUrl: '' };

  // Priority 2: api-key mode
  if (authMode === 'api-key') {
    const apiKey = String(
      process.env.MELO_API_KEY || process.env.OPENAI_API_KEY || config?.apiKey || '',
    ).trim();
    const baseUrl = cleanBaseUrl(
      process.env.MELO_BASE_URL ||
        process.env.OPENAI_BASE_URL ||
        config?.baseUrl ||
        'https://api.openai.com/v1',
    );
    // chatgpt.com has no /audio/speech endpoint
    if (/chatgpt\.com/i.test(baseUrl)) return { apiKey: '', baseUrl: '' };
    return { apiKey, baseUrl };
  }

  // Priority 3: local mode (Ollama — most models don't support TTS but allow trying)
  if (authMode === 'local') {
    const baseUrl = cleanBaseUrl(
      process.env.MELO_BASE_URL ||
        process.env.OPENAI_BASE_URL ||
        config?.baseUrl ||
        LOCAL_SERVICE_DEFAULTS.ollama,
    );
    return { apiKey: '', baseUrl };
  }

  // codex or unknown → chatgpt.com doesn't support /audio/speech
  return { apiKey: '', baseUrl: '' };
}

// ─── Edge TTS (local CLI) ─────────────────────────────────────────────────────
// Implementation lives in src/services/tts/edgeTts.js so server.js and this
// module share one source of truth. Drift between two copies surfaced as
// "edge works for the inline fallback path but not the explicit speak-text
// path" every time a binary candidate or env override was added to one side.

import { synthesizeWithEdgeTts as _synthesizeWithEdgeTts } from "./services/tts/edgeTts.js";

// ─── MiniMax T2A V2 ───────────────────────────────────────────────────────────

// Unicode ranges that make up modern Korean writing:
//   AC00–D7AF  : Hangul Syllables (가 … 힣)
//   1100–11FF  : Hangul Jamo
//   3130–318F  : Hangul Compatibility Jamo (ㄱ … ㆎ)
//   A960–A97F  : Hangul Jamo Extended-A
//   D7B0–D7FF  : Hangul Jamo Extended-B
const _KOREAN_CHAR_RE_G = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]+/g;
const _KOREAN_CHAR_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]/;

/**
 * Strip Korean character runs from text before handing it to MiniMax.
 *
 * The custom-cloned MiniMax voice (e.g. "金冬天") is trained on Chinese
 * speech and does a poor job reading mixed-in Korean — it slurs the KR
 * run into the neighbouring CN phonemes. Until we hook up a dedicated
 * KR voice, we just drop Korean characters for this path so the rest
 * of the sentence still reads cleanly. If the caller handed us pure
 * Korean, the stripped result will be empty and we signal that to the
 * outer pipeline so it can fall back to Edge TTS (ko-KR-SunHiNeural).
 *
 * Collapses any double-space / leading-space left behind by the strip.
 *
 * Exported for unit tests; production call site is `synthesizeViaMinimax`.
 */
export function stripKoreanForMinimax(text) {
  const src = String(text || '');
  if (!src || !_KOREAN_CHAR_RE.test(src)) return src;
  return src
    .replace(_KOREAN_CHAR_RE_G, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?;:，。！？；：])/g, '$1')
    .trim();
}

/**
 * Synthesize a one-shot MiniMax test clip from explicit credentials,
 * deliberately ignoring `process.env.MINIMAX_API_KEY` /
 * `process.env.MINIMAX_GROUP_ID`. Used by the connector settings "test
 * playback" button so the user verifies the values they JUST typed,
 * not whatever stale env var the host happens to carry.
 *
 * Throws on backend error so the route can surface a meaningful message.
 */
export async function testMinimaxSynthesis(text, { apiKey, groupId, voiceId, speed, pitch, vol } = {}) {
  if (!apiKey)  throw new Error('apiKey is required');
  if (!voiceId) throw new Error('voiceId is required');
  const input = String(text || '').trim().slice(0, TTS_MAX_CHARS);
  if (!input) throw new Error('text is required');
  const signal = AbortSignal.timeout(30_000);
  return synthesizeViaMinimax(input, apiKey, voiceId, signal, groupId || '', {
    speed,
    pitch,
    vol,
  });
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

export function normalizeMinimaxVoiceSetting({ speed = 1.0, pitch = 0, vol = 1.0 } = {}) {
  return {
    speed: clampNumber(speed, 0.5, 2.0, 1.0),
    vol: clampNumber(vol, 0.1, 10.0, 1.0),
    pitch: clampNumber(pitch, -12, 12, 0),
  };
}

async function synthesizeViaMinimax(input, apiKey, voiceId, signal, groupId, { speed = 1.0, pitch = 0, vol = 1.0 } = {}) {
  // Pre-process: drop Korean runs entirely — the Chinese-trained custom
  // voice (e.g. "金冬天") can't read KR well, and we don't have a
  // dedicated KR voice yet. If nothing is left to say, signal the outer
  // pipeline so it can fall back to Edge TTS (ko-KR-SunHiNeural).
  // See `stripKoreanForMinimax` for the rationale.
  const spokenText = input;
  if (!spokenText) {
    throw new Error('MiniMax TTS: input reduced to empty after stripping Korean');
  }
  const url = groupId
    ? `${MINIMAX_TTS_BASE}?GroupId=${encodeURIComponent(groupId)}`
    : MINIMAX_TTS_BASE;
  const voiceSetting = normalizeMinimaxVoiceSetting({ speed, pitch, vol });
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MINIMAX_TTS_MODEL,
      text: spokenText,
      stream: false,
      voice_setting: {
        voice_id: voiceId,
        ...voiceSetting,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
        channel: 1,
      },
    }),
  });

  if (!res.ok) throw new Error(`MiniMax TTS returned ${res.status}`);
  const data = await res.json();

  // MiniMax returns hex-encoded audio in data.audio
  const hexAudio = data?.data?.audio;
  if (!hexAudio) throw new Error(`MiniMax TTS: empty audio in response`);

  return { buffer: Buffer.from(hexAudio, 'hex'), mimeType: 'audio/mpeg' };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Synthesize speech from text.
 *
 * @param {string} text
 * @param {object} config  resolved Melo config
 * @param {{ voice?: string, model?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<{ buffer: Buffer, mimeType: string } | null>}
 */
export async function synthesizeSpeech(text, config = {}, options = {}) {
  const input = String(text || '').trim().slice(0, TTS_MAX_CHARS);
  if (!input) return null;

  const signal = options.signal || AbortSignal.timeout(TTS_TIMEOUT_MS);

  // ── Priority 1: MiniMax ────────────────────────────────────────────────────
  const minimaxKey    = String(process.env.MINIMAX_API_KEY || config?.minimaxApiKey || '').trim();
  const minimaxVoice  = String(options.voiceId || config?.minimaxVoiceId || '').trim();
  const minimaxGroup  = String(process.env.MINIMAX_GROUP_ID || config?.minimaxGroupId || '').trim();
  if (minimaxKey && minimaxVoice && !customVoiceActive(config)) {
    try {
      const ttsSpeed = parseFloat(config?.ttsSpeed) || 1.0;
      const ttsPitch = parseFloat(config?.ttsPitch) || 0;
      const ttsVol   = parseFloat(config?.ttsVol)   || 1.0;
      const result = await synthesizeViaMinimax(input, minimaxKey, minimaxVoice, signal, minimaxGroup, { speed: ttsSpeed, pitch: ttsPitch, vol: ttsVol });
      process.stderr.write(`[tts] MiniMax OK: ${result.buffer.length} bytes\n`);
      return result;
    } catch (err) {
      process.stderr.write(`[tts] MiniMax failed: ${err.message} — falling back\n`);
    }
  } else {
    process.stderr.write(`[tts] MiniMax skipped: key=${!!minimaxKey} voice=${!!minimaxVoice}\n`);
  }

  // ── Priority 2: Edge TTS (local CLI) — used when ttsProvider === 'edge',
  //    or as fallback when MiniMax was attempted but failed ──────────────────
  const wantEdge = String(config?.ttsProvider || '').trim() === 'edge';
  const minimaxAttempted = !!(minimaxKey && minimaxVoice) && !customVoiceActive(config);
  if (wantEdge || minimaxAttempted) {
    process.stderr.write(`[tts] Falling back to Edge TTS\n`);
    const edgeResult = await _synthesizeWithEdgeTts(input, config, { signal });
    if (edgeResult) return edgeResult;
    // If edge also fails, continue to OpenAI fallback
  }

  // ── Priority 3: OpenAI-compatible /v1/audio/speech ─────────────────────────
  const { apiKey, baseUrl } = resolveTtsConfig(config);
  if (!baseUrl) return null;
  if (!apiKey && !isLocalEndpoint(baseUrl)) return null;

  const model  = String(options.model || config?.ttsModel || PROVIDER_DEFAULTS.media.tts);
  const voice  = String(options.voice  || config?.ttsVoice  || 'nova');
  // Request WAV for local endpoints so buffers can be concatenated gaplessly;
  // remote OpenAI keeps mp3 (smaller).
  const format = options.format || (isLocalEndpoint(baseUrl) ? 'wav' : 'mp3');

  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

  let response;
  try {
    response = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, voice, input, response_format: format }),
      signal,
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const ab = await response.arrayBuffer().catch(() => null);
  if (!ab) return null;

  return { buffer: Buffer.from(ab), mimeType: format === 'wav' ? 'audio/wav' : 'audio/mpeg' };
}

/**
 * Returns a human-readable error when TTS is not available for the current config,
 * or null when it should work.
 */
export function getTtsUnavailableReason(config = {}) {
  // MiniMax is always available if both key + voice id are set
  const minimaxKey   = String(process.env.MINIMAX_API_KEY || config?.minimaxApiKey || '').trim();
  const minimaxVoice = String(config?.minimaxVoiceId || '').trim();
  if (minimaxKey && minimaxVoice && !customVoiceActive(config)) return null;

  // Edge TTS is always available (uses CLI binary, no API key required)
  if (String(config?.ttsProvider || '').trim() === 'edge') return null;

  const { apiKey, baseUrl } = resolveTtsConfig(config);
  if (!baseUrl) {
    return 'TTS requires an OpenAI-compatible endpoint with /audio/speech support. In Codex OAuth mode, set a dedicated Whisper API key in Settings → Connector, or switch to API key mode.';
  }
  if (!apiKey && !isLocalEndpoint(baseUrl)) {
    return 'TTS requires an API key. Set one in Settings → Connector → Whisper API key.';
  }
  return null;
}
