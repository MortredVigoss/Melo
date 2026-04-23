// ─── Discord voice audio pipeline helpers ────────────────────────────────────
// Pure utilities for the Discord voice track:
//   - 48 kHz stereo s16le PCM (what @discordjs/voice receiver emits) →
//     16 kHz mono WAV buffer (what the Whisper/native STT path expects)
//   - Energy-based VAD state machine (speaking start/end detection,
//     barge-in signal while the bot is playing back)
//   - TTS Buffer (mp3 from MiniMax / wav from OpenAI) → AudioResource
//     piped through ffmpeg-static and re-encoded to the opus format the
//     voice connection needs
//
// This module owns:
//   - stereo48kPcmToMono16kPcm  — decimate 48 kHz→16 kHz, average L/R
//   - pcmToWavBuffer            — wrap s16le PCM in a WAV RIFF header
//   - createEnergyVad           — simple RMS + hang-time state machine
//   - createAudioResourceFromBuffer — feed an in-memory buffer into ffmpeg
//     and hand the decoded stream to @discordjs/voice
//
// Pure module — no runtime state, no desktopStore dependency. Imported by
// discordVoiceSession.js.

import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

// ─── Constants ────────────────────────────────────────────────────────────────

// @discordjs/voice receiver default: 48 kHz, 2 channels, 16-bit signed little-endian
export const DISCORD_PCM_SAMPLE_RATE = 48000;
export const DISCORD_PCM_CHANNELS = 2;
export const DISCORD_PCM_BYTES_PER_SAMPLE = 2;
// Whisper prefers 16 kHz mono — matches whisper.cpp + OpenAI expectation.
export const STT_SAMPLE_RATE = 16000;
// 48000 / 16000 = 3 — clean integer decimation, no fractional resampler needed.
const DECIMATION = DISCORD_PCM_SAMPLE_RATE / STT_SAMPLE_RATE;

// ─── PCM transforms ──────────────────────────────────────────────────────────

/**
 * Convert 48 kHz stereo s16le PCM to 16 kHz mono s16le PCM.
 *
 * We take every 3rd stereo frame and average the two channels. Naive but
 * cheap, and for voice content (<8 kHz usable bandwidth) aliasing is
 * dominated by the room / mic anyway. Whisper is robust enough that this
 * works fine in practice; upgrade to a proper FIR lowpass only if STT
 * quality ever regresses.
 */
export function stereo48kPcmToMono16kPcm(stereoBuffer) {
  if (!Buffer.isBuffer(stereoBuffer) || !stereoBuffer.length) return Buffer.alloc(0);

  const stereoFrameBytes = DISCORD_PCM_CHANNELS * DISCORD_PCM_BYTES_PER_SAMPLE; // 4
  const totalFrames = Math.floor(stereoBuffer.length / stereoFrameBytes);
  const outFrames = Math.floor(totalFrames / DECIMATION);
  const out = Buffer.alloc(outFrames * DISCORD_PCM_BYTES_PER_SAMPLE);

  for (let i = 0; i < outFrames; i += 1) {
    const srcOffset = i * DECIMATION * stereoFrameBytes;
    const left = stereoBuffer.readInt16LE(srcOffset);
    const right = stereoBuffer.readInt16LE(srcOffset + 2);
    // Average with rounding — clamp just in case
    let mono = (left + right) >> 1;
    if (mono > 32767) mono = 32767;
    else if (mono < -32768) mono = -32768;
    out.writeInt16LE(mono, i * DISCORD_PCM_BYTES_PER_SAMPLE);
  }
  return out;
}

/**
 * Wrap a raw s16le PCM buffer in a WAV (RIFF) header so Whisper / Apple
 * SFSpeechRecognizer / whisper.cpp can parse it without knowing the format
 * out of band.
 */
export function pcmToWavBuffer(pcmBuffer, { sampleRate = STT_SAMPLE_RATE, channels = 1 } = {}) {
  const pcm = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);           // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// ─── Energy VAD ──────────────────────────────────────────────────────────────

/**
 * Simple energy-based voice-activity detector.
 *
 * Why not webrtc-vad or a neural VAD? For voice-channel cascade we only
 * need two signals: "user started talking" (barge-in / interruption) and
 * "user stopped talking" (end of turn → flush to STT). A rolling RMS
 * threshold with hang-time handles both well enough in practice and is
 * ~40 lines vs. pulling a native addon.
 *
 * Feed the VAD every stereo PCM chunk from the @discordjs/voice receiver.
 * The state machine:
 *   idle       — RMS below threshold
 *   rising     — seen ACTIVATION_FRAMES loud frames → emit utteranceStart
 *   speaking   — collecting chunks
 *   cooling    — silence seen, still within hang window → keep buffering
 *   idle       — hang exceeded → emit utteranceEnd with buffered PCM
 *
 * Usage:
 *   const vad = createEnergyVad({ onUtteranceStart, onUtteranceEnd })
 *   vad.feed(stereoChunk)
 *   vad.reset()
 */
export function createEnergyVad({
  // RMS (0..32768) below which we consider the frame "silent". -40 dBFS ≈ 327.
  activationRms = 400,
  // Consecutive non-silent frames to transition idle → speaking.
  activationFrames = 3,
  // Silence duration (ms) after last loud frame before we call the utterance ended.
  hangMs = 700,
  // Sample rate of the stream being fed. Determines frame→ms math.
  sampleRate = DISCORD_PCM_SAMPLE_RATE,
  channels = DISCORD_PCM_CHANNELS,
  // Discard utterances shorter than this — filters throat clears / keyboard taps.
  minUtteranceMs = 250,
  // Hard cap: flush even if the user is still talking, to keep STT latency bounded.
  maxUtteranceMs = 15000,
  onUtteranceStart = null,
  onUtteranceEnd = null,
  onBargeIn = null, // fired on every idle→speaking transition, even mid-playback
} = {}) {
  let state = 'idle';
  let riseCount = 0;
  let lastLoudAt = 0;
  let utteranceStartAt = 0;
  const chunks = [];
  const bytesPerMs = (sampleRate * channels * 2) / 1000;

  function computeRms(buf) {
    if (!buf?.length) return 0;
    const samples = buf.length / 2;
    let sumSq = 0;
    // Sample every 4th sample to keep VAD cheap on large chunks.
    for (let i = 0; i < samples; i += 4) {
      const s = buf.readInt16LE(i * 2);
      sumSq += s * s;
    }
    const n = Math.max(1, Math.floor(samples / 4));
    return Math.sqrt(sumSq / n);
  }

  function flush(reason) {
    if (!chunks.length) {
      state = 'idle';
      riseCount = 0;
      return;
    }
    const pcm = Buffer.concat(chunks);
    const durMs = (pcm.length / bytesPerMs) | 0;
    chunks.length = 0;
    state = 'idle';
    riseCount = 0;
    if (durMs < minUtteranceMs) return; // too short → drop silently
    if (typeof onUtteranceEnd === 'function') {
      try {
        onUtteranceEnd({ pcm, durationMs: durMs, reason });
      } catch {}
    }
  }

  return {
    /**
     * Feed a PCM chunk from the receiver. Chunk must be 16-bit LE,
     * channels and sampleRate per this VAD's construction args.
     */
    feed(chunk) {
      if (!Buffer.isBuffer(chunk) || !chunk.length) return;
      const now = Date.now();
      const rms = computeRms(chunk);
      const loud = rms >= activationRms;

      if (state === 'idle') {
        if (loud) {
          riseCount += 1;
          chunks.push(chunk);
          lastLoudAt = now;
          if (riseCount >= activationFrames) {
            state = 'speaking';
            utteranceStartAt = now;
            if (typeof onUtteranceStart === 'function') {
              try { onUtteranceStart({ at: now }); } catch {}
            }
            if (typeof onBargeIn === 'function') {
              try { onBargeIn({ at: now }); } catch {}
            }
          }
        } else {
          // soft-decay: forget the rise streak if we get a silent frame
          riseCount = 0;
          chunks.length = 0;
        }
        return;
      }

      // state === 'speaking'
      chunks.push(chunk);
      if (loud) lastLoudAt = now;

      const sinceLoud = now - lastLoudAt;
      const totalDur = now - utteranceStartAt;

      if (sinceLoud >= hangMs) {
        flush('silence');
        return;
      }
      if (totalDur >= maxUtteranceMs) {
        flush('maxlen');
      }
    },
    /** Force-flush whatever is buffered. Used on session shutdown. */
    end() {
      if (state === 'speaking') flush('end');
      else { chunks.length = 0; state = 'idle'; riseCount = 0; }
    },
    reset() { chunks.length = 0; state = 'idle'; riseCount = 0; },
    get isSpeaking() { return state === 'speaking'; },
  };
}

// ─── TTS Buffer → AudioResource ──────────────────────────────────────────────

// Resolve the ffmpeg binary packaged by ffmpeg-static. We go through
// createRequire because ffmpeg-static is CommonJS-only and we're ESM. Cached
// because pathing the binary every call is wasteful.
let _ffmpegPath = null;
function resolveFfmpegPath() {
  if (_ffmpegPath !== null) return _ffmpegPath;
  try {
    const require_ = createRequire(import.meta.url);
    const p = require_('ffmpeg-static');
    _ffmpegPath = typeof p === 'string' ? p : (p?.default || '');
  } catch {
    _ffmpegPath = '';
  }
  if (!_ffmpegPath) _ffmpegPath = process.env.MELO_FFMPEG_BIN || 'ffmpeg';
  return _ffmpegPath;
}

/**
 * Turn a TTS Buffer (mp3/wav/ogg — we let ffmpeg probe) into an
 * @discordjs/voice AudioResource. ffmpeg transcodes to s16le 48 kHz stereo
 * which the voice connection wraps into opus frames via its own opus
 * encoder (either @discordjs/opus native or opusscript pure JS).
 *
 * The caller provides { createAudioResource, StreamType } from
 * @discordjs/voice to avoid importing that ESM package here (keeps this
 * module usable from unit tests that don't need a full voice stack).
 */
export function createAudioResourceFromBuffer(audioBuffer, { createAudioResource, StreamType }) {
  if (!Buffer.isBuffer(audioBuffer) || !audioBuffer.length) {
    throw new Error('createAudioResourceFromBuffer: empty buffer');
  }
  const ff = spawn(resolveFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-f', 's16le',
    '-ar', String(DISCORD_PCM_SAMPLE_RATE),
    '-ac', String(DISCORD_PCM_CHANNELS),
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  // Pipe the audio into ffmpeg's stdin. End() so ffmpeg sees EOF.
  ff.stdin.write(audioBuffer);
  ff.stdin.end();
  // Swallow stderr noise (ffmpeg errors are already gated by -loglevel error
  // but some builds still chatter on stderr).
  ff.stderr.on('data', () => {});
  ff.on('error', () => {});

  const out = new PassThrough();
  ff.stdout.pipe(out);
  ff.on('close', code => {
    if (code !== 0 && !out.destroyed) out.destroy(new Error(`ffmpeg exited ${code}`));
  });

  return createAudioResource(out, {
    inputType: StreamType.Raw,
    inlineVolume: true,
  });
}
