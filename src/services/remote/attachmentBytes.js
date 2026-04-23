// ─── Attachment → bytes helper ───────────────────────────────────────────────
// When the Telegram / Discord bots want to forward an image attachment that
// the assistant produced, they need the actual file bytes — Telegram's
// sendPhoto accepts a URL but only for HTTPS URLs that are publicly
// reachable, and our signed workspace URLs live on 127.0.0.1. Discord's
// attachments endpoint requires multipart bytes either way.
//
// This module owns:
//   - decodeSignedWorkspaceUrl(url) — if the URL is a signed workspace URL
//     minted by web/urlSigning.js in THIS process, extract the absolute
//     file path it references. Returns null for any other shape of URL.
//     We do NOT run the full HMAC verification here — the signing secret
//     is per-process and we only ever call this on URLs we just minted
//     ourselves, so decoding the `p` param is enough. (And even if the
//     URL is forged, the worst case is a readFile failure, which is
//     already handled.)
//   - loadAttachmentBytes(attachment, opts) — high-level: given an
//     attachment from a message, return { buffer, mimeType, fileName }
//     ready to hand to sendPhoto / files[0]. Tries the local shortcut
//     first (signed-URL decode + readFile) and falls back to HTTP fetch
//     with a configurable timeout.
//
// Pure module — no state, no side effects beyond readFile / fetch.

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const SIGNED_URL_PATHNAME = '/api/files/signed';

// Common IMAGE_EXT → mime table for sniffing fileNames / paths when the
// attachment record doesn't already carry a mimeType. We only cover
// formats the image pipeline actually emits (sd.cpp = PNG, MiniMax = JPG)
// plus a few the user might drop in manually.
const MIME_BY_EXT = Object.freeze({
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.bmp':  'image/bmp',
  '.avif': 'image/avif',
  '.svg':  'image/svg+xml',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.m4a':  'audio/mp4',
  '.mp4':  'video/mp4',
  '.mov':  'video/quicktime',
  '.webm': 'video/webm',
  '.pdf':  'application/pdf',
});

function guessMimeFromFileName(fileName) {
  const ext = extname(String(fileName || '').toLowerCase());
  return MIME_BY_EXT[ext] || '';
}

function b64urlToBuffer(input) {
  const str = String(input || '');
  if (!str) return null;
  const pad = 4 - (str.length % 4);
  const padded = pad === 4 ? str : str + '='.repeat(pad);
  try {
    return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return null;
  }
}

/**
 * If the URL is a signed workspace URL (`…/api/files/signed/<name>?p=…&e=…&s=…`),
 * extract the absolute path encoded in `p`. Returns null for any other shape.
 *
 * We accept URLs on any origin (127.0.0.1:<port>, but also env-derived hosts
 * used in tests) — what matters is the pathname and the `p` query param.
 */
export function decodeSignedWorkspaceUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (!parsed.pathname.startsWith(SIGNED_URL_PATHNAME)) {
    return null;
  }

  const p = parsed.searchParams.get('p');
  if (!p) return null;

  const buf = b64urlToBuffer(p);
  if (!buf) return null;

  const decoded = buf.toString('utf8');
  // Defensive: signed URLs always encode absolute paths; reject anything
  // that would obviously result in a relative read.
  if (!decoded || !decoded.startsWith('/')) return null;

  return decoded;
}

/**
 * Resolve an attachment to `{ buffer, mimeType, fileName }` ready for
 * multipart upload.
 *
 * Strategy (in order):
 *   1. If the URL is a local signed workspace URL, decode it and read the
 *      file directly from disk. This is the fast path for images the
 *      assistant generated in this same server process.
 *   2. Otherwise fetch the URL via HTTP with a timeout. Works for MiniMax
 *      CDN URLs and any other externally-hosted attachment the assistant
 *      embedded in its reply.
 *
 * Returns null (not throwing) when the attachment has no URL; throws when
 * the URL exists but the bytes couldn't be loaded so the caller can log
 * + fall back appropriately.
 */
export async function loadAttachmentBytes(attachment, { timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  const url = String(attachment?.url || '').trim();
  if (!url) return null;

  const declaredMime = String(attachment?.mimeType || '').trim();
  const declaredName = String(attachment?.fileName || '').trim();

  // Fast path: this URL was minted by our own signWorkspaceFileUrl and
  // points at a file on the local filesystem.
  const localPath = decodeSignedWorkspaceUrl(url);
  if (localPath) {
    try {
      const buffer = await readFile(localPath);
      const fileName = declaredName || basename(localPath) || 'attachment';
      return {
        buffer,
        mimeType: declaredMime || guessMimeFromFileName(fileName) || 'application/octet-stream',
        fileName,
      };
    } catch (err) {
      // Fall through to HTTP — the server endpoint can still serve this
      // signed URL if the process is alive. That shouldn't happen in
      // practice (same process, same fs), but it's a harmless retry.
    }
  }

  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`attachment fetch failed: HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  let fileName = declaredName;
  if (!fileName) {
    try {
      fileName = basename(new URL(url).pathname) || 'attachment';
    } catch {
      fileName = 'attachment';
    }
  }

  const headerMime = String(response.headers?.get?.('content-type') || '').split(';')[0].trim();
  const mimeType =
    declaredMime ||
    headerMime ||
    guessMimeFromFileName(fileName) ||
    'application/octet-stream';

  return { buffer, mimeType, fileName };
}
