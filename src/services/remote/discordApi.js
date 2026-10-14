// ─── Discord Bot API — HTTP layer ────────────────────────────────────────────
// Thin wrappers around fetch() for the Discord Bot API (REST only; gateway
// and voice websockets are out of scope). No state here; every function
// takes a `channel` record that must carry `botToken`.
//
// This module owns:
//   - DISCORD_API_VERSION — the v10 version pin baked into the default base
//   - discordApiBase — resolve the API root (env-overridable via
//     MELO_DISCORD_API_BASE so tests can point at a fake)
//   - buildDiscordUrl — URL construction with optional query params
//   - discordApiRequest — JSON request with 15s default timeout, Bearer auth
//     ("Bot <token>"), rate-limit (429) surfacing, 204 No Content → null
//   - pingDiscordChannel — GET /users/@me (returns the bot user object, used
//     for bot-id detection)
//   - fetchDiscordUpdates(channel, pollLimit) — GET /channels/.../messages
//     with the "after" cursor. pollLimit is injected by the caller so this
//     module stays loose from desktopStore's runtime tuning constants.
//   - sendDiscordMediaReply(channel, incoming, buffer, opts) — multipart
//     upload (payload_json + files[0]) for any binary attachment. Shared
//     code path for audio / image / document attachments; callers choose
//     the mime+filename.
//
// Extracted from desktopStore.js in the Phase 6a refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — no state dependencies,
// no imports from desktopStore.

export const DISCORD_API_VERSION = 'v10';

export function discordApiBase() {
  return String(
    process.env.MELO_DISCORD_API_BASE || `https://discord.com/api/${DISCORD_API_VERSION}`,
  ).replace(/\/+$/, '');
}

export function buildDiscordUrl(path, searchParams = {}, baseUrl = discordApiBase()) {
  const url = new URL(`${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`);
  for (const [key, value] of Object.entries(searchParams || {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

export async function discordApiRequest(
  channel,
  path,
  { method = 'GET', body = null, searchParams = {}, timeoutMs = 15000, baseUrl } = {},
) {
  const token = String(channel?.botToken || '').trim();
  if (!token) {
    throw new Error('Discord needs a bot token before it can be used.');
  }

  const url = buildDiscordUrl(path, searchParams, baseUrl);
  const headers = {
    authorization: `Bot ${token}`,
    'user-agent': 'MeloDesktopBot (https://github.com, 1.0)',
  };
  if (body) {
    headers['content-type'] = 'application/json; charset=utf-8';
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });

  // 204 No Content is a valid success response for some endpoints.
  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  const payload = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;

  // Rate limit — surface retry_after so the caller can back off.
  if (response.status === 429) {
    const retryAfter = Number(payload?.retry_after || 1);
    const err = new Error(
      `Discord rate-limited (${response.status}): retry_after=${retryAfter}s`,
    );
    err.retryAfterMs = Math.max(1000, retryAfter * 1000);
    throw err;
  }

  if (!response.ok) {
    const reason = payload?.message || payload?.error || `HTTP ${response.status}`;
    throw new Error(`Discord ${method} ${path} failed: ${reason}`);
  }

  return payload;
}

/**
 * Send a binary attachment via the Discord multipart convention
 * (payload_json + files[0]). Generic across audio / image / document — the
 * caller picks mimeType + fileName and optionally an inline content string.
 *
 * Reply semantics mirror sendDiscordReply: when `incoming.messageId` is
 * present we include `message_reference` so the attachment shows up as a
 * reply to that message. The `content` field is optional — Discord accepts
 * a message with only an attachment.
 *
 * On failure we throw with `err.status` and `err.bodyPreview` populated so
 * the caller can surface actionable details (common cases: 403 Missing
 * Access, 403 Missing Permissions / ATTACH_FILES, 40005 Payload too large
 * / > 25 MiB, 50035 Invalid Form Body).
 */
export async function sendDiscordMediaReply(
  channel,
  incoming,
  buffer,
  { mimeType = 'application/octet-stream', fileName = 'file', content = '', timeoutMs = 45000 } = {},
) {
  const targetChannelId = String(incoming?.chatId || channel?.channelId || '').trim();
  if (!targetChannelId) {
    throw new Error('Discord media reply is missing a channelId.');
  }
  const token = String(channel?.botToken || '').trim();
  if (!token) {
    throw new Error('Discord media reply needs a bot token.');
  }

  const safeFileName = fileName || 'file';
  const safeMime = mimeType || 'application/octet-stream';

  // Discord's multipart convention: one form field named payload_json carrying
  // the message JSON, plus files[0..N] entries for attachments. The message
  // JSON's `attachments` array is optional but recommended — it lets us tie
  // the filename into the message record for thread rendering.
  const payload = {
    content: String(content || '').slice(0, 2000),
    attachments: [{ id: 0, filename: safeFileName }],
  };
  if (incoming?.messageId) {
    payload.message_reference = {
      message_id: String(incoming.messageId),
      channel_id: targetChannelId,
      fail_if_not_exists: false,
    };
  }

  const formData = new FormData();
  formData.append('payload_json', JSON.stringify(payload));
  formData.append('files[0]', new Blob([buffer], { type: safeMime }), safeFileName);

  const url = buildDiscordUrl(`/channels/${encodeURIComponent(targetChannelId)}/messages`, {});
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bot ${token}`,
      'user-agent': 'MeloDesktopBot (https://github.com, 1.0)',
      // NB: do NOT set content-type manually — fetch sets the correct multipart
      // boundary automatically when the body is a FormData.
    },
    body: formData,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status === 204) return null;
  const text = await response.text();
  const parsed = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
  if (response.status === 429) {
    const retryAfter = Number(parsed?.retry_after || 1);
    const err = new Error(`Discord media rate-limited: retry_after=${retryAfter}s`);
    err.retryAfterMs = Math.max(1000, retryAfter * 1000);
    throw err;
  }
  if (!response.ok) {
    const reason = parsed?.message || parsed?.error || `HTTP ${response.status}`;
    const err = new Error(`Discord sendMedia failed (HTTP ${response.status}): ${reason}`);
    err.status = response.status;
    err.bodyPreview = (text || '').slice(0, 300);
    throw err;
  }
  return parsed;
}

export async function pingDiscordChannel(channel) {
  // Returns the bot user object { id, username, discriminator, bot }.
  return discordApiRequest(channel, '/users/@me');
}

/**
 * Fetch new messages via the /channels/{id}/messages?after={lastUpdateId}
 * cursor. pollLimit comes from the caller (desktopStore owns
 * DISCORD_POLL_LIMIT), so this module doesn't couple to any runtime tuning.
 */
export async function fetchDiscordUpdates(channel, pollLimit = 50) {
  const targetChannelId = String(channel?.channelId || '').trim();
  if (!targetChannelId) {
    throw new Error('Discord channel is missing a channelId.');
  }

  const lastUpdateId =
    typeof channel?.lastUpdateId === 'string' && channel.lastUpdateId.trim()
      ? channel.lastUpdateId.trim()
      : Number.isFinite(Number(channel?.lastUpdateId)) && Number(channel.lastUpdateId) > 0
        ? String(Number(channel.lastUpdateId))
        : '';

  // GET /channels/{id}/messages returns newest first; we reverse to chronological.
  const searchParams = { limit: pollLimit };
  if (lastUpdateId) {
    searchParams.after = lastUpdateId;
  }

  const payload = await discordApiRequest(
    channel,
    `/channels/${encodeURIComponent(targetChannelId)}/messages`,
    { searchParams, timeoutMs: 12000 },
  );
  const messages = Array.isArray(payload) ? payload : [];
  return messages.slice().reverse(); // chronological
}
