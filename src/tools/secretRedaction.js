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
// Pure module: only the shared agent-loop contract.

import { AGENT_LOOP_CONTRACT, contractRegExp } from '../runtime/agentLoopContract.js';

// The token and every pattern are shared with the iPhone run records and tool
// traces (shared/protocol/agent-loop.json, `redaction`), so both sides redact
// the same fragments.
export const REDACTED = AGENT_LOOP_CONTRACT.redaction.token;

const PATTERNS = AGENT_LOOP_CONTRACT.redaction.patterns.map(entry => [contractRegExp(entry, 'g'), entry.replacement]);

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
