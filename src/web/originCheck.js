/**
 * Pure helper for CSRF-style Origin validation on state-mutating POST
 * endpoints. Extracted from server.js so it can be unit-tested without
 * booting the HTTP server (which imports would trigger as a side effect).
 *
 * Rules:
 *   - Missing / empty Origin → allowed (trusted CLI / native WebView
 *     contexts don't send an Origin header).
 *   - Origin matches `http://<host>:<port>`, `http://127.0.0.1:<port>`,
 *     or `http://localhost:<port>` → allowed.
 *   - Any other Origin → rejected.
 */
export function isOriginAllowed(origin, boundHost, boundPort) {
  if (!origin) return true;
  const allowed = new Set([
    `http://${boundHost}:${boundPort}`,
    `http://127.0.0.1:${boundPort}`,
    `http://localhost:${boundPort}`,
  ]);
  return allowed.has(origin);
}
