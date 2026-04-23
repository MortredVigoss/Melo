/**
 * Scoped debug logger.
 *
 * Set MELO_DEBUG to a comma-separated list of scope names (or "*" for all)
 * to enable warn-level logging for that scope. Default: off — zero console
 * noise in production.
 *
 * Examples:
 *   MELO_DEBUG=web_search npm start
 *   MELO_DEBUG=web_search,fetch_url,media npm start
 *   MELO_DEBUG=* npm start
 *
 * This utility intentionally stays tiny and dependency-free so every
 * builtin tool / extractor can import it without worrying about startup cost.
 */

let _cachedScopes = null;
let _cachedEnvValue = null;

function resolveScopes() {
  const raw = String(process.env.MELO_DEBUG || '').trim();
  if (raw === _cachedEnvValue && _cachedScopes) {
    return _cachedScopes;
  }
  _cachedEnvValue = raw;
  _cachedScopes = raw
    ? new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
    : new Set();
  return _cachedScopes;
}

export function isDebugEnabled(scope) {
  if (!scope) return false;
  const scopes = resolveScopes();
  return scopes.has('*') || scopes.has(scope);
}

export function debugWarn(scope, message, ...extras) {
  if (!isDebugEnabled(scope)) return;
  try {
    const prefix = `[melo:${scope}]`;
    if (extras.length) {
      console.warn(prefix, message, ...extras);
    } else {
      console.warn(prefix, message);
    }
  } catch {
    // Never let a logger throw back into the call site.
  }
}
