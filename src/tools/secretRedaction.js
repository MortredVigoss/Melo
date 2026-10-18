// Value-level secret redaction (bug audit 2026-10-18, T6 / T9).
//
// `redactToolArgs` only looked at *keys* (`apiKey`, `token`, …), so a secret
// inside a value — `Authorization: Bearer eyJ…` in a fetch header string, a
// `?token=` query parameter in a URL, `KEY=sk-…` in a bash command or in a
// tool's output — went verbatim into `tool_calls_start`, the execution scene,
// `metadata.toolChain`, `*.tools.jsonl`, `toolResults[].summary` and the
// record's `modelFacingOutput`. This module is the one place those patterns
// live; executionObservation.safeText, toolInvocationRecord, toolProtocol
// (persisted tool chain) and toolResultProjection all run text through it.
// Pure module: no imports.

export const REDACTED = '[redacted]';

const PATTERNS = [
  // Authorization schemes.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/=]{8,}/gi, '$1 ' + REDACTED],
  // `key=value` / `key: value` / `"key": "value"` for secret-looking keys (value kept when it is clearly a placeholder).
  [/(\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|key|secret|token|password|passwd|pwd|authorization|cookie|session[_-]?id)["']?\s*[:=]\s*["']?)(?!\[redacted\])(?!\$\{)(?!<)(?!(?:Bearer|Basic|Token)\b)[^\s"'&;,\\]{4,}/gi, '$1' + REDACTED],
  // URL userinfo (`https://user:pw@host/`).
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>\\]{1,200}@/gi, '$1' + REDACTED + '@'],
  // Secret-looking query parameters.
  [/([?&](?:token|access_token|refresh_token|id_token|api_key|apikey|key|secret|password|passwd|pwd|auth|signature|sig|client_secret)=)[^&\s"'<>\\]+/gi, '$1' + REDACTED],
  // Well-known credential shapes.
  [/\bsk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{8,}/g, 'sk-' + REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_' + REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_' + REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA' + REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'xox*-' + REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'AIza' + REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, 'glpat-' + REDACTED],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY----- ' + REDACTED + ' -----END PRIVATE KEY-----'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'eyJ' + REDACTED],
];

/**
 * Replace secret-looking fragments inside free text with `[redacted]`.
 * Non-strings are returned unchanged; the surrounding text (keys, scheme,
 * host, parameter names) is kept so the record stays readable.
 */
export function redactSecretsInText(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** True when `redactSecretsInText` would change the text. */
export function containsSecret(text) {
  return typeof text === 'string' && redactSecretsInText(text) !== text;
}
