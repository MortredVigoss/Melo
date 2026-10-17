/**
 * Pure helpers for request-origin validation on the local HTTP server.
 * Extracted from server.js so they can be unit-tested without booting the
 * HTTP server (which imports would trigger as a side effect).
 *
 * isOriginAllowed — CSRF-style Origin validation on state-mutating endpoints:
 *   - Missing / empty Origin → allowed (trusted CLI / native WebView
 *     contexts don't send an Origin header)… unless the browser-only
 *     Sec-Fetch-Site header says the request is cross-site (2026-10-17
 *     audit A-8: an <img src> or simple GET from a hostile page carries no
 *     Origin but does carry Sec-Fetch-Site: cross-site).
 *   - Origin matches `http://<host>:<port>`, `http://127.0.0.1:<port>`,
 *     or `http://localhost:<port>` → allowed.
 *   - Any other Origin → rejected.
 *
 * isHostAllowed — DNS-rebinding guard for every /api request (2026-10-17
 * audit A-3): a page served from attacker.example whose name was re-pointed
 * at 127.0.0.1 reaches this server with `Host: attacker.example:<port>`.
 * Only loopback names and the bound host are accepted.
 */
export function isOriginAllowed(origin, boundHost, boundPort, { secFetchSite } = {}) {
  if (!origin) {
    const site = String(secFetchSite || '').trim().toLowerCase();
    return !site || site === 'same-origin' || site === 'none';
  }
  const allowed = new Set([
    `http://${boundHost}:${boundPort}`,
    `http://127.0.0.1:${boundPort}`,
    `http://localhost:${boundPort}`,
  ]);
  return allowed.has(origin);
}

export function isHostAllowed(hostHeader, boundHost, boundPort) {
  if (!hostHeader) return true; // HTTP/1.0 style callers (rare); Origin rules still apply
  const value = String(hostHeader).trim().toLowerCase();
  const port = String(boundPort);
  // A server deliberately bound to every interface (LAN use) is reached by
  // whatever address the client used; the strict loopback rule only applies
  // to the default loopback binding, which is the DNS-rebinding case.
  if (['0.0.0.0', '::', '[::]'].includes(String(boundHost).toLowerCase())) return value.endsWith(`:${port}`);
  const allowed = new Set([
    `${String(boundHost).toLowerCase()}:${port}`,
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  return allowed.has(value);
}
