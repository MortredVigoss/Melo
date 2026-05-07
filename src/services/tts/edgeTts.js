// Microsoft Edge neural-voice TTS via the local `edge-tts` Python CLI.
//
// Both src/tts.js and src/server.js used to maintain duplicate copies of
// this code. Drift between the two surfaced as "edge works for the inline
// MiniMax-fallback path but not the explicit /api/tts/speak-text edge path"
// (or vice versa) every time a binary candidate or env override was added
// to one side. Centralising lets future tweaks (new conda paths, new
// neural voices, etc.) land once.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

export async function resolveEdgeTtsBin() {
  if (process.env.MELO_EDGE_TTS_BIN) return process.env.MELO_EDGE_TTS_BIN;
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
    try {
      await execFileAsync(bin, ['--version'], { timeout: 3000 });
      return bin;
    } catch {}
  }
  return 'edge-tts';
}

function pickDefaultVoice(text) {
  if (/[一-鿿㐀-䶿]/.test(text)) return 'zh-CN-XiaoxiaoNeural';
  if (/[぀-ゟ゠-ヿ]/.test(text)) return 'ja-JP-NanamiNeural';
  if (/[가-힯ᄀ-ᇿ]/.test(text)) return 'ko-KR-SunHiNeural';
  return 'en-US-AriaNeural';
}

/**
 * Synthesize speech via the edge-tts CLI.
 *
 * @param {string} text
 * @param {object} [config]    Resolved Melo config; uses ttsEdgeVoice override.
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]  Aborts the underlying execFile and
 *   makes the returned promise resolve to null instead of throwing — both
 *   the queue runner and the inline fallback path treat null as "skip".
 * @returns {Promise<{buffer: Buffer, mimeType: string} | null>}
 */
export async function synthesizeWithEdgeTts(text, config = {}, opts = {}) {
  const input = String(text || '').trim().slice(0, 4096);
  if (!input) return null;
  const signal = opts.signal;
  if (signal?.aborted) return null;

  const voice = String(config?.ttsEdgeVoice || pickDefaultVoice(input));
  const tmpFile = joinPath(tmpdir(), `melo-edge-tts-${Date.now()}.mp3`);
  const bin = await resolveEdgeTtsBin();

  return new Promise((resolve) => {
    const child = execFile(
      bin,
      ['--voice', voice, '--text', input, '--write-media', tmpFile],
      { timeout: 30_000, signal },
      async (err) => {
        if (err) {
          // Aborted: silent (caller already knows it cancelled). Other
          // errors: log and resolve null so callers don't crash.
          if (err.name !== 'AbortError' && err.code !== 'ABORT_ERR') {
            process.stderr.write(`[edge-tts] exec error (bin=${bin}): ${err.message}\n`);
          }
          await unlink(tmpFile).catch(() => {});
          resolve(null);
          return;
        }
        try {
          const buffer = await readFile(tmpFile);
          resolve({ buffer, mimeType: 'audio/mpeg' });
        } catch (e) {
          process.stderr.write(`[edge-tts] read error: ${e.message}\n`);
          resolve(null);
        } finally {
          unlink(tmpFile).catch(() => {});
        }
      },
    );

    // Older Node versions ignore the {signal} option for execFile; fall back
    // to listening on the signal manually to ensure abort really kills.
    if (signal && !signal.aborted && typeof signal.addEventListener === 'function') {
      const onAbort = () => {
        try { child.kill('SIGTERM'); } catch {}
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
