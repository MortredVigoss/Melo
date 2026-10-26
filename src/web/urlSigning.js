import { DESKTOP_SERVICE_DEFAULTS } from '../shared/localServices.js';
/**
 * Signed workspace-file URLs.
 *
 * Tools that produce files (image edits, generated PDFs, MiniMax images, etc.)
 * write them to the chat's workspace directory and need a URL the UI can
 * render as an <img>/<video>/<a href>. Absolute file paths don't work because
 * the UI is a WKWebView served over http://127.0.0.1:<port>, so we expose a
 * single signed endpoint — `/api/files/signed` — and return URLs that point at
 * it.
 *
 * Security model
 * --------------
 *   - Signing key: 32 random bytes generated once per server process. Signed
 *     URLs become invalid when the server restarts, which is fine: they're
 *     meant for same-session rendering immediately after a tool call.
 *   - Signature: HMAC-SHA256 over `${absPath}|${expiryMs}`, truncated to 128
 *     bits and base64url-encoded.
 *   - Expiry: callers pick a TTL (default 10 min). The endpoint rejects
 *     anything past the expiry.
 *   - Path trust: the signature authorises *exactly* the absolute path that
 *     was signed. The endpoint does not do further sandbox checks because
 *     only in-process tool code can call `signWorkspaceFileUrl` — a third
 *     party can't mint a URL for `/etc/passwd` without the secret.
 *
 * The endpoint itself lives in server.js (see `/api/files/signed`); this
 * module is just the crypto + URL-building helpers.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { basename } from 'node:path';

const DEFAULT_TTL_MS = 10 * 60_000; // 10 minutes
const MAX_TTL_MS = 60 * 60_000;     // hard cap — 1 hour

// Per-process signing secret. Regenerated on every server start, which is
// exactly what we want for short-lived render URLs.
const SIGNING_SECRET = randomBytes(32);

// Server origin (e.g. "http://127.0.0.1:43127"). Set by the HTTP bootstrap in
// server.js via `setServerOrigin`. Until set, we fall back to an env-derived
// guess so that unit tests and CLI tool runs still produce a usable URL shape.
let _serverOrigin = null;

function guessOriginFromEnv() {
  const host = '127.0.0.1';
  const port = process.env.MELO_DESKTOP_PORT || DESKTOP_SERVICE_DEFAULTS.port;
  return `http://${host}:${port}`;
}

/** Called once by server.js after `server.listen(...)`. */
export function setServerOrigin(origin) {
  if (typeof origin === 'string' && origin.startsWith('http')) {
    _serverOrigin = origin.replace(/\/$/, '');
  }
}

export function getServerOrigin() {
  return _serverOrigin || guessOriginFromEnv();
}

// ─── HMAC signing ────────────────────────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const pad = 4 - (str.length % 4);
  const padded = pad === 4 ? str : str + '='.repeat(pad);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function signPayload(absPath, expiryMs) {
  const mac = createHmac('sha256', SIGNING_SECRET)
    .update(`${absPath}|${expiryMs}`)
    .digest();
  // 128 bits is plenty for short-lived tokens and keeps URLs compact.
  return b64url(mac.subarray(0, 16));
}

/**
 * Build a signed URL the UI can GET to retrieve the file.
 *
 * @param {string} absPath   Absolute path on disk
 * @param {{ ttlMs?: number }} [opts]
 * @returns {string} fully-qualified URL
 */
export function signWorkspaceFileUrl(absPath, opts = {}) {
  if (!absPath || typeof absPath !== 'string' || !absPath.startsWith('/')) {
    throw new Error('signWorkspaceFileUrl requires an absolute path');
  }
  const ttl = Math.min(Math.max(Number(opts.ttlMs) || DEFAULT_TTL_MS, 1000), MAX_TTL_MS);
  const expiryMs = Date.now() + ttl;
  const sig = signPayload(absPath, expiryMs);
  const origin = getServerOrigin();
  const p = b64url(Buffer.from(absPath, 'utf8'));

  // Embed the basename in the path so urlDetector.js can recognise the file
  // type from the extension (e.g. `.jpg?` suffix matches IMAGE_EXT). The
  // server ignores the basename — only the query params are authoritative.
  const name = encodeURIComponent(basename(absPath)) || 'file';
  return `${origin}/api/files/signed/${name}?p=${p}&e=${expiryMs}&s=${sig}`;
}

/**
 * Verify signature + expiry on a request's query params. Returns the
 * decoded absolute path if valid, or null otherwise.
 *
 * @param {URLSearchParams} params
 * @returns {string | null}
 */
export function verifySignedFileUrl(params) {
  const p = params.get('p');
  const e = params.get('e');
  const s = params.get('s');
  if (!p || !e || !s) return null;

  const expiryMs = Number(e);
  if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) return null;

  let absPath;
  try {
    absPath = fromB64url(p).toString('utf8');
  } catch {
    return null;
  }
  if (!absPath.startsWith('/')) return null;

  const expected = signPayload(absPath, expiryMs);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(s, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return null;
  if (!timingSafeEqual(expectedBuf, actualBuf)) return null;

  return absPath;
}

// ─── Internal — exposed for tests only ──────────────────────────────────────

/** @internal */
export function __getSigningSecretLength() {
  return SIGNING_SECRET.length;
}
