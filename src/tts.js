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
const MINIMAX_TTS_MODEL = 'speech-01-turbo';

function isLocalEndpoint(url = '') {
  return /https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(url);
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
        'http://127.0.0.1:11434/v1',
    );
    return { apiKey: '', baseUrl };
  }

  // codex or unknown → chatgpt.com doesn't support /audio/speech
  return { apiKey: '', baseUrl: '' };
}

// ─── Edge TTS (local CLI) ─────────────────────────────────────────────────────

async function _resolveEdgeTtsBin() {
  if (process.env.MELO_EDGE_TTS_BIN) return process.env.MELO_EDGE_TTS_BIN;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { homedir } = await import('node:os');
  const execFileAsync = promisify(execFile);
  const home = homedir();
  const candidates = [
    'edge-tts',
    `${home}/opt/anaconda3/bin/edge-tts`,
    `${home}/anaconda3/bin/edge-tts`,
    `${home}/miniconda3/bin/edge-tts`,
    `${home}/opt/miniconda3/bin/edge-tts`,
    `${home}/.local/bin/edge-tts`,
    '/opt/homebrew/bin/edge-tts',
    '/usr/local/bin/edge-tts',
  ];
  for (const bin of candidates) {
    try { await execFileAsync(bin, ['--version'], { timeout: 3000 }); return bin; } catch {}
  }
  return 'edge-tts';
}

async function _synthesizeWithEdgeTts(input, config = {}) {
  const { execFile } = await import('node:child_process');
  const { readFile, unlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: jp } = await import('node:path');
  const text = String(input || '').trim().slice(0, 4096);
  if (!text) return null;
  const hasChinese  = /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(text);
  const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF]/.test(text);
  const hasKorean   = /[\uAC00-\uD7AF\u1100-\u11FF]/.test(text);
  let defaultVoice;
  if (hasChinese)       defaultVoice = 'zh-CN-XiaoxiaoNeural';
  else if (hasJapanese) defaultVoice = 'ja-JP-NanamiNeural';
  else if (hasKorean)   defaultVoice = 'ko-KR-SunHiNeural';
  else                  defaultVoice = 'en-US-AriaNeural';
  const voice   = String(config.ttsEdgeVoice || defaultVoice);
  const tmpFile = jp(tmpdir(), `melo-edge-tts-${Date.now()}.mp3`);
  const bin     = await _resolveEdgeTtsBin();
  return new Promise((resolve) => {
    execFile(bin, ['--voice', voice, '--text', text, '--write-media', tmpFile],
      { timeout: 30_000 },
      async (err) => {
        if (err) {
          process.stderr.write(`[tts/edge] exec error (bin=${bin}): ${err.message}\n`);
          resolve(null); return;
        }
        try {
          const buffer = await readFile(tmpFile);
          resolve({ buffer, mimeType: 'audio/mpeg' });
        } catch (e) {
          process.stderr.write(`[tts/edge] read error: ${e.message}\n`);
          resolve(null);
        } finally {
          unlink(tmpFile).catch(() => {});
        }
      },
    );
  });
}

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

async function synthesizeViaMinimax(input, apiKey, voiceId, signal, groupId, { speed = 1.0, pitch = 0, vol = 1.0 } = {}) {
  // Pre-process: drop Korean runs entirely — the Chinese-trained custom
  // voice (e.g. "金冬天") can't read KR well, and we don't have a
  // dedicated KR voice yet. If nothing is left to say, signal the outer
  // pipeline so it can fall back to Edge TTS (ko-KR-SunHiNeural).
  // See `stripKoreanForMinimax` for the rationale.
  const spokenText = stripKoreanForMinimax(input);
  if (!spokenText) {
    throw new Error('MiniMax TTS: input reduced to empty after stripping Korean');
  }
  const url = groupId
    ? `${MINIMAX_TTS_BASE}?GroupId=${encodeURIComponent(groupId)}`
    : MINIMAX_TTS_BASE;
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
        speed: Math.max(0.5, Math.min(2.0, speed)),
        vol: Math.max(0.1, Math.min(10.0, vol)),
        pitch: Math.max(-12, Math.min(12, pitch)),
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
  if (minimaxKey && minimaxVoice) {
    try {
      const ttsSpeed = parseFloat(config?.ttsSpeed) || 1.0;
      const ttsPitch = parseFloat(config?.ttsPitch) || 0;
      const ttsVol   = parseFloat(config?.ttsVol)   || 1.0;
      const koStripped = /[\uAC00-\uD7AF\u1100-\u11FF]/.test(input);
      process.stderr.write(`[tts] MiniMax: voiceId=${minimaxVoice.slice(0,20)} speed=${ttsSpeed} pitch=${ttsPitch}` +
        (koStripped ? ' ko-stripped=on' : '') +
        ` text="${input.slice(0,60)}"\n`);
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
  const minimaxAttempted = !!(minimaxKey && minimaxVoice);
  if (wantEdge || minimaxAttempted) {
    process.stderr.write(`[tts] Falling back to Edge TTS\n`);
    const edgeResult = await _synthesizeWithEdgeTts(input, config);
    if (edgeResult) return edgeResult;
    // If edge also fails, continue to OpenAI fallback
  }

  // ── Priority 3: OpenAI-compatible /v1/audio/speech ─────────────────────────
  const { apiKey, baseUrl } = resolveTtsConfig(config);
  if (!baseUrl) return null;
  if (!apiKey && !isLocalEndpoint(baseUrl)) return null;

  const model  = String(options.model || config?.ttsModel || 'tts-1');
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
  if (minimaxKey && minimaxVoice) return null;

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
