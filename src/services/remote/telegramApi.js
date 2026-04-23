// ─── Telegram Bot API — HTTP layer ──────────────────────────────────────────
// Thin wrappers around fetch() for the Telegram Bot API. No state here; these
// functions all take a `channel` record (which must carry botToken) and talk
// to https://api.telegram.org directly.
//
// This module owns:
//   - telegramApiBase — resolve the API root (env-overridable via
//     MELO_TELEGRAM_API_BASE so tests can point at a fake)
//   - buildTelegramMethodUrl / buildTelegramFileUrl — URL construction
//   - telegramApiRequest — JSON GET/POST with 15s default timeout + Bot API
//     envelope unwrapping (throws on { ok: false })
//   - telegramApiFormRequest — multipart variant for file uploads (sendAudio,
//     sendVoice), 45s default timeout
//   - convertToOggOpus — ffmpeg shell-out: any audio buffer → OGG/OPUS buffer
//     suitable for sendVoice (Telegram requires this exact codec)
//   - sendTelegramAudioReply — high-level: TTS buffer → sendVoice, with an
//     automatic fallback to sendAudio if ffmpeg fails
//   - pingTelegramChannel / fetchTelegramUpdates — common method wrappers
//     used by the polling loop
//
// TELEGRAM_POLL_LIMIT lives in desktopStore.js as a runtime-tuning constant;
// fetchTelegramUpdates takes it as a parameter so the two modules stay loose.
//
// Extracted from desktopStore.js in the Phase 5a refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — no state dependencies,
// no imports from desktopStore.

export function telegramApiBase() {
  return String(process.env.MELO_TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
}

export function buildTelegramMethodUrl(channel, method, searchParams = {}) {
  const token = String(channel?.botToken || '').trim();
  if (!token) {
    throw new Error('Telegram needs a bot token before it can be used.');
  }

  const url = new URL(`${telegramApiBase()}/bot${encodeURIComponent(token)}/${method}`);
  for (const [key, value] of Object.entries(searchParams || {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

export async function telegramApiRequest(
  channel,
  method,
  { searchParams = {}, body = null, timeoutMs = 15000 } = {},
) {
  const url = buildTelegramMethodUrl(channel, method, searchParams);
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body
      ? {
          'content-type': 'application/json; charset=utf-8',
        }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.description || `Telegram ${method} request failed.`);
  }
  return payload;
}

// Multipart FormData variant — used for file uploads (sendAudio, sendVoice).
export async function telegramApiFormRequest(channel, method, formData, timeoutMs = 45000) {
  const url = buildTelegramMethodUrl(channel, method);
  const response = await fetch(url, {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.description || `Telegram ${method} request failed.`);
  }
  return payload;
}

/**
 * Convert any audio buffer (MP3, WAV, etc.) to OGG/OPUS in-memory via ffmpeg.
 * Telegram's sendVoice requires OGG container with OPUS codec.
 * Returns a Buffer, or throws if ffmpeg fails.
 */
export async function convertToOggOpus(inputBuffer, inputMime) {
  const { execFile } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join: jp } = await import('node:path');
  const { writeFile, readFile, unlink } = await import('node:fs/promises');

  const ext = inputMime?.includes('wav') ? 'wav' : 'mp3';
  const inPath  = jp(tmpdir(), `melo-tg-in-${Date.now()}.${ext}`);
  const outPath = jp(tmpdir(), `melo-tg-out-${Date.now()}.ogg`);

  await writeFile(inPath, inputBuffer);

  await new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-y', '-i', inPath, '-c:a', 'libopus', '-b:a', '64k', '-vbr', 'on', outPath],
      { timeout: 30_000 },
      (err) => { err ? reject(err) : resolve(); },
    );
  });

  const result = await readFile(outPath);
  await Promise.allSettled([unlink(inPath), unlink(outPath)]);
  return result;
}

/**
 * Send audio as a Telegram voice message (sendVoice) — shows as waveform voice note.
 * Converts TTS output to OGG/OPUS (required by Telegram) via ffmpeg.
 */
export async function sendTelegramAudioReply(telegramChannel, incoming, audioBuffer, mimeType = 'audio/mpeg') {
  let oggBuffer;
  try {
    oggBuffer = await convertToOggOpus(audioBuffer, mimeType);
  } catch (err) {
    process.stderr.write(`[telegram-voice] OGG conversion failed: ${err.message} — falling back to audio file\n`);
    // Fallback: send as regular audio attachment
    const formData = new FormData();
    formData.append('chat_id', String(incoming.chatId));
    if (incoming.messageThreadId) formData.append('message_thread_id', String(incoming.messageThreadId));
    if (incoming.messageId) formData.append('reply_to_message_id', String(incoming.messageId));
    formData.append('audio', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'reply.mp3');
    return telegramApiFormRequest(telegramChannel, 'sendAudio', formData);
  }

  const formData = new FormData();
  formData.append('chat_id', String(incoming.chatId));
  if (incoming.messageThreadId) formData.append('message_thread_id', String(incoming.messageThreadId));
  if (incoming.messageId) formData.append('reply_to_message_id', String(incoming.messageId));
  formData.append('voice', new Blob([oggBuffer], { type: 'audio/ogg' }), 'voice.ogg');
  return telegramApiFormRequest(telegramChannel, 'sendVoice', formData);
}

export async function pingTelegramChannel(channel) {
  return telegramApiRequest(channel, 'getMe');
}

/**
 * Fetch pending updates via long-poll offset. pollLimit comes from the caller
 * (desktopStore owns TELEGRAM_POLL_LIMIT), so this module doesn't couple to
 * any runtime tuning constant.
 */
export async function fetchTelegramUpdates(channel, pollLimit = 12) {
  const lastUpdateId =
    Number.isFinite(Number(channel?.lastUpdateId)) && Number(channel.lastUpdateId) > 0
      ? Number(channel.lastUpdateId)
      : 0;

  return telegramApiRequest(channel, 'getUpdates', {
    searchParams: {
      offset: lastUpdateId + 1,
      limit: pollLimit,
      timeout: 0,
    },
    timeoutMs: 10000,
  });
}

export function buildTelegramFileUrl(channel, filePath = '') {
  const normalizedToken = String(channel?.botToken || '').trim();
  const normalizedPath = String(filePath || '').trim().replace(/^\/+/, '');
  if (!normalizedToken || !normalizedPath) {
    return '';
  }

  return `${telegramApiBase()}/file/bot${encodeURIComponent(normalizedToken)}/${normalizedPath}`;
}
