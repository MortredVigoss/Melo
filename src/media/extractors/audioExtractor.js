import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Combine an optional external AbortSignal with an internal timeout into a
// single signal that fires when EITHER aborts. AbortSignal.any is in Node
// 20.3+; Melo runs Node 22. When both args are missing, returns undefined
// so the caller can pass it through unchanged (no signal = current behavior).
function combineSignals(externalSignal, timeoutMs) {
  const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : null;
  if (externalSignal && timeoutSignal) return AbortSignal.any([externalSignal, timeoutSignal]);
  return externalSignal || timeoutSignal || undefined;
}

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
// Port where the Swift native transcription server listens.
// The Swift app starts this server at (Node.js port + 1), defaulting to 43128.
const NATIVE_TRANSCRIPTION_PORT =
  Number(process.env.MELO_DESKTOP_PORT || 43127) + 1;

// Local endpoints that don't require an Authorization header (e.g. Ollama)
function isLocalEndpoint(url = '') {
  return /https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(url);
}

function resolveTranscriptionConfig(config = {}) {
  const authMode = String(config?.authMode || '').trim().toLowerCase();

  // Priority 1: Explicit whisper-specific credentials always win
  const explicitKey = String(
    process.env.MELO_WHISPER_API_KEY || config?.whisperApiKey || '',
  ).trim();
  const explicitBaseUrl = String(
    process.env.MELO_WHISPER_BASE_URL || config?.whisperBaseUrl || '',
  ).trim();

  if (explicitKey || explicitBaseUrl) {
    return {
      apiKey: explicitKey,
      baseUrl: explicitBaseUrl || 'https://api.openai.com/v1',
      source: 'explicit',
    };
  }

  // Priority 2: api-key mode → use main chat credentials directly
  if (authMode === 'api-key') {
    const apiKey = String(
      process.env.MELO_API_KEY ||
        process.env.OPENAI_API_KEY ||
        config?.apiKey ||
        '',
    ).trim();
    const baseUrl = String(
      process.env.MELO_BASE_URL ||
        process.env.OPENAI_BASE_URL ||
        config?.baseUrl ||
        'https://api.openai.com/v1',
    ).trim();
    return { apiKey, baseUrl, source: 'api-key' };
  }

  // Priority 3: local mode → use main baseUrl with no auth (Ollama)
  if (authMode === 'local') {
    const baseUrl = String(
      process.env.MELO_BASE_URL ||
        process.env.OPENAI_BASE_URL ||
        config?.baseUrl ||
        'http://127.0.0.1:11434/v1',
    ).trim();
    return { apiKey: '', baseUrl, source: 'local' };
  }

  // Priority 4: codex mode (or unknown).
  // chatgpt.com/backend-api doesn't support Whisper. Prefer env-backed
  // MELO_API_KEY / MELO_BASE_URL when present so users in codex mode can add
  // a Whisper-compatible key via env vars without switching authMode. If no
  // env credentials are set, probe local Ollama as an auto-fallback.
  const codexEnvKey = String(
    process.env.MELO_API_KEY || process.env.OPENAI_API_KEY || '',
  ).trim();
  const codexEnvBase = String(
    process.env.MELO_BASE_URL || process.env.OPENAI_BASE_URL || '',
  ).trim();
  if (codexEnvKey) {
    return {
      apiKey: codexEnvKey,
      baseUrl: codexEnvBase || 'https://api.openai.com/v1',
      source: 'codex-env-fallback',
    };
  }
  return {
    apiKey: '',
    baseUrl: 'http://127.0.0.1:11434/v1',
    source: 'codex-local-fallback',
  };
}

function resolveWhisperBaseUrl(rawBaseUrl = '') {
  const raw = String(rawBaseUrl || 'https://api.openai.com/v1').trim();
  if (!raw || /chatgpt\.com\/backend-api/i.test(raw)) {
    return '';
  }

  return raw
    .replace(/\/chat\/completions.*$/i, '')
    .replace(/\/responses.*$/i, '')
    .replace(/\/+$/, '');
}

async function readAttachmentBuffer(attachment, { signal } = {}) {
  if (signal?.aborted) return null;
  if (!attachment?.url) {
    return null;
  }

  if (String(attachment.url).startsWith('data:')) {
    const base64 = String(attachment.url).split(',')[1] || '';
    return Buffer.from(base64, 'base64');
  }

  // Combine internal 30s timeout with the caller's external signal so an
  // outer budget abort cancels the download mid-flight.
  const response = await fetch(attachment.url, {
    signal: combineSignals(signal, 30000),
  });
  if (!response.ok) {
    return null;
  }

  return Buffer.from(await response.arrayBuffer());
}

// ---------------------------------------------------------------------------
// whisper.cpp — highest-quality on-device transcription (Priority 0)
// Uses the whisper-cli binary installed via `brew install whisper-cpp`.
// Model: ggml-large-v3-turbo (FP16, 828 MB, Metal GPU accelerated on Apple Silicon).
// Auto-detects language via `-l auto` — works for all supported Whisper languages.
// ---------------------------------------------------------------------------

const WHISPER_CLI = process.env.MELO_WHISPER_CLI || 'whisper-cli';
const WHISPER_CPP_MODEL =
  process.env.MELO_WHISPER_CPP_MODEL ||
  '/opt/homebrew/share/whisper.cpp/models/ggml-large-v3-turbo.bin';

// MELO_WHISPER_CLI / _MODEL are read at module load — env mutations after
// import don't take effect. These DI overrides give tests a real handle
// (mirrors fileSearch.js's _setRipgrepBinaryForTests pattern).
let _whisperCliOverride = null;
let _whisperModelOverride = null;
let whisperCppReady = null; // null=unchecked, true/false

function getWhisperCli() { return _whisperCliOverride || WHISPER_CLI; }
function getWhisperModel() { return _whisperModelOverride || WHISPER_CPP_MODEL; }

export function _setWhisperCliForTests(cli, model) {
  _whisperCliOverride = (typeof cli === 'string' && cli) ? cli : null;
  _whisperModelOverride = (typeof model === 'string' && model) ? model : null;
  whisperCppReady = null;  // force re-check on next call
}

export function _resetWhisperCppReadyForTests() {
  whisperCppReady = null;
}

async function checkWhisperCppReady() {
  if (whisperCppReady !== null) return whisperCppReady;
  try {
    await execFileAsync(getWhisperCli(), ['--help'], {
      timeout: 8000,
      maxBuffer: 1024 * 1024,
    });
    const { existsSync } = await import('node:fs');
    whisperCppReady = existsSync(getWhisperModel());
  } catch {
    whisperCppReady = false;
  }
  return whisperCppReady;
}

/**
 * Transcribe audio using the local whisper-cli binary with the large-v3-turbo model.
 * Automatically detects language. Returns transcript string or null on failure.
 *
 * Honors an external AbortSignal: when fired, execFile sends SIGTERM to the
 * whisper-cli child so a cancelled video extraction doesn't keep the GPU
 * pegged for 30-120s in the background.
 */
async function tryWhisperCpp(audioBuffer, attachment = {}, { signal } = {}) {
  if (signal?.aborted) return null;
  if (!(await checkWhisperCppReady())) return null;

  const wavBuffer = await convertToWavForNative(audioBuffer, attachment, { signal });
  if (!wavBuffer || signal?.aborted) return null;

  const tempDir = await mkdtemp(join(tmpdir(), 'melo-whispercpp-'));
  const wavPath = join(tempDir, 'audio.wav');

  try {
    await writeFile(wavPath, wavBuffer);

    const { stdout } = await execFileAsync(
      getWhisperCli(),
      [
        '-m', getWhisperModel(),
        '-f', wavPath,
        '-l', 'auto',          // automatic language detection
        '--no-timestamps',      // cleaner output
        '--no-prints',          // suppress model-load messages to stdout
      ],
      { timeout: 120000, maxBuffer: 10 * 1024 * 1024, signal },
    );

    // whisper-cli output: one line per segment, possibly with [timestamp] prefix.
    // Strip any residual timestamp brackets and blank lines.
    const text = stdout
      .split('\n')
      .map(line => line.replace(/^\[[\d:.,\s\->]+\]\s*/, '').trim())
      .filter(line => line && line !== '[BLANK_AUDIO]')
      .join(' ')
      .trim();

    return text || null;
  } catch {
    return null;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Native on-device transcription via the Swift helper server (Priority 1)
// Falls back to Apple SFSpeechRecognizer when whisper.cpp is unavailable.
// ---------------------------------------------------------------------------

async function hasFfmpegLocal() {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert an audio buffer to 16-kHz mono WAV using ffmpeg so that
 * SFSpeechURLRecognitionRequest (which doesn't handle OGG/Opus natively) can
 * read it.  Returns null if ffmpeg is unavailable or conversion fails.
 * Honors an external AbortSignal — the ffmpeg child process is killed when
 * the signal fires.
 */
async function convertToWavForNative(audioBuffer, attachment = {}, { signal } = {}) {
  if (signal?.aborted) return null;
  if (!Buffer.isBuffer(audioBuffer) || !audioBuffer.length) return null;
  if (!(await hasFfmpegLocal())) return null;

  const ext = (() => {
    const mime = String(attachment.mimeType || '').toLowerCase();
    const name = String(attachment.fileName || '').toLowerCase();
    if (mime.includes('ogg') || mime.includes('opus') || name.endsWith('.ogg') || name.endsWith('.oga')) return 'ogg';
    if (mime.includes('webm') || name.endsWith('.webm')) return 'webm';
    if (mime.includes('mp4') || name.endsWith('.mp4') || name.endsWith('.m4a')) return 'm4a';
    if (mime.includes('mp3') || name.endsWith('.mp3')) return 'mp3';
    if (mime.includes('wav') || name.endsWith('.wav')) return 'wav';
    return 'bin';
  })();

  // WAV already — no conversion needed.
  if (ext === 'wav') return audioBuffer;

  const tempDir = await mkdtemp(join(tmpdir(), 'melo-native-'));
  const inPath  = join(tempDir, `input.${ext}`);
  const outPath = join(tempDir, 'output.wav');

  try {
    await writeFile(inPath, audioBuffer);
    await execFileAsync(
      'ffmpeg',
      ['-i', inPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', '-y', outPath],
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024, signal },
    );
    return await readFile(outPath);
  } catch {
    return null;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Ask the Swift native transcription server (running at 127.0.0.1:43128) to
 * transcribe a local WAV file using SFSpeechURLRecognitionRequest.
 * Returns the transcript string or null on any failure.
 */
async function tryNativeTranscription(audioBuffer, attachment = {}, { signal } = {}) {
  if (signal?.aborted) return null;
  const wavBuffer = await convertToWavForNative(audioBuffer, attachment, { signal });
  if (!wavBuffer || signal?.aborted) return null;

  const tempDir = await mkdtemp(join(tmpdir(), 'melo-native-'));
  const wavPath = join(tempDir, 'audio.wav');

  try {
    await writeFile(wavPath, wavBuffer);

    const response = await fetch(
      `http://127.0.0.1:${NATIVE_TRANSCRIPTION_PORT}/transcribe`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: wavPath }),
        // Combine internal 30s timeout with the caller's external signal so
        // either source triggers the fetch abort.
        signal: combineSignals(signal, 30000),
      },
    );

    if (!response.ok) return null;

    const payload = await response.json().catch(() => ({}));
    const text = String(payload?.text || '').trim();
    return text || null;
  } catch {
    return null;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function extractAudioContentFromBuffer(audioBuffer, attachment = {}, { config, suppressFallback = false, signal } = {}) {
  if (signal?.aborted) return null;

  // Priority 0: whisper.cpp (highest quality, Metal GPU, auto language detection).
  const whisperCppText = await tryWhisperCpp(audioBuffer, attachment, { signal });
  if (whisperCppText) {
    return {
      kind: 'transcript',
      text: whisperCppText.slice(0, 8000),
      metadata: {
        source: 'whisper-cpp',
        fileName: attachment.fileName || '',
        url: String(attachment.url || '').startsWith('data:') ? '' : (attachment.url || ''),
      },
    };
  }
  if (signal?.aborted) return null;

  // Priority 1: Apple SFSpeechRecognizer via Swift native server (fallback).
  // No API key needed, multilingual (system + ko/ja/fr/it/es).
  const nativeText = await tryNativeTranscription(audioBuffer, attachment, { signal });
  if (nativeText) {
    return {
      kind: 'transcript',
      text: nativeText.slice(0, 8000),
      metadata: {
        source: 'native-speech',
        fileName: attachment.fileName || '',
        url: String(attachment.url || '').startsWith('data:') ? '' : (attachment.url || ''),
      },
    };
  }

  const transcriptionConfig = resolveTranscriptionConfig(config);
  const { apiKey, baseUrl: rawBaseUrl, source } = transcriptionConfig;

  const baseUrl = resolveWhisperBaseUrl(rawBaseUrl);
  if (!baseUrl) {
    // chatgpt.com or empty — cannot transcribe
    if (!suppressFallback) {
      return {
        kind: 'transcript',
        text: 'Audio received. Transcription requires a Whisper-compatible endpoint. In Codex OAuth mode, configure a local model (Ollama) to enable transcription, or add a dedicated Whisper API key in Settings → API Configuration.',
        metadata: {
          source: 'whisper-unavailable',
          fileName: attachment.fileName || '',
          url: String(attachment.url || '').startsWith('data:') ? '' : (attachment.url || ''),
        },
      };
    }
    return null;
  }

  // Require an API key unless the endpoint is local (Ollama/localhost doesn't need auth)
  if (!apiKey && !isLocalEndpoint(baseUrl)) {
    if (!suppressFallback) {
      const authMode = String(config?.authMode || '').trim().toLowerCase();
      if (authMode === 'codex' || authMode === 'local') {
        return {
          kind: 'transcript',
          text: 'Audio received. Transcription requires an OpenAI-compatible API key with Whisper support. To enable, set MELO_API_KEY and MELO_BASE_URL to a Whisper-compatible endpoint, or switch to API key mode.',
          metadata: {
            source: 'whisper-unavailable',
            fileName: attachment.fileName || '',
            url: String(attachment.url || '').startsWith('data:') ? '' : (attachment.url || ''),
          },
        };
      }
    }
    return null;
  }

  if (!Buffer.isBuffer(audioBuffer) || !audioBuffer.length || audioBuffer.length > MAX_AUDIO_BYTES) {
    return null;
  }

  const form = new FormData();
  const fileName = attachment.fileName || 'audio.ogg';
  const mimeType = attachment.mimeType || 'audio/ogg';
  form.append('file', new Blob([audioBuffer], { type: mimeType }), fileName);
  form.append('model', process.env.MELO_WHISPER_MODEL || 'whisper-1');

  const headers = {};
  if (apiKey) {
    headers['authorization'] = `Bearer ${apiKey}`;
  }

  // Shared soft-fallback for sources that shouldn't error-out the chat when
  // the local Whisper endpoint is missing (codex-local-fallback) or
  // explicitly local-only (authMode === 'local').
  const localLikeSources = new Set(['codex-local-fallback', 'local']);
  const softFallback = () => ({
    kind: 'transcript',
    text: 'Audio received. Automatic transcription requires a local Whisper endpoint, which is not reachable. To enable transcription, run Ollama locally (ollama serve) with a Whisper-capable model, or add a dedicated Whisper API key in Settings → API Configuration.',
    metadata: {
      source: 'whisper-unavailable',
      fileName: attachment.fileName || '',
      url: String(attachment.url || '').startsWith('data:') ? '' : (attachment.url || ''),
    },
  });

  if (signal?.aborted) return null;
  try {
    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: form,
      // Combine internal 60s timeout with the caller's external signal so
      // an outer budget abort kills this fetch immediately.
      signal: combineSignals(signal, 60000),
    });

    // For codex-local-fallback / local modes: if local Ollama isn't running,
    // emit a soft fallback so the user sees an actionable message.
    if (!response.ok) {
      if (localLikeSources.has(source) && !suppressFallback) {
        return softFallback();
      }
      return null;
    }

    const payload = await response.json().catch(() => ({}));
    const text = String(payload?.text || '').trim();
    if (!text) {
      return null;
    }

    return {
      kind: 'transcript',
      text: text.slice(0, 8000),
      metadata: {
        source: 'whisper',
        fileName,
        url: String(attachment.url || '').startsWith('data:') ? '' : attachment.url || '',
      },
    };
  } catch {
    // Network error / timeout / connection refused. Same contract as the
    // !response.ok branch: codex-local-fallback and local modes get a soft
    // fallback; everyone else gets null (real configuration error).
    if (localLikeSources.has(source) && !suppressFallback) {
      return softFallback();
    }
    return null;
  }
}

export async function extractAudioContent(attachment, context = {}, { suppressFallback = false, signal } = {}) {
  if (signal?.aborted) return null;
  try {
    const audioBuffer = await readAttachmentBuffer(attachment, { signal });
    if (!audioBuffer) {
      return null;
    }

    return extractAudioContentFromBuffer(audioBuffer, attachment, { ...context, suppressFallback, signal });
  } catch {
    return null;
  }
}
