// Tool result envelope (2026-10-17 design audit T2 / option B1).
//
// Before this module every tool invented its own `error` string: web_search
// reported an empty SERP and a dead provider with the same SEARCH_FAILED,
// grep/glob reported "no matches" as a plain success, bash used "Exit code 1",
// file tools passed `err.message` through, permission denials were "DENIED"
// in one place and PERMISSION_DENIED in another. The model could not tell
// "nothing found" from "the tool is broken", the UI's errorCode and the
// model-facing error were different strings, and repeatGuard fingerprinted
// on free text so identical failures with a path in the message were never
// recognised as repeats.
//
// The executor now finalises every result through `finalizeToolResult`:
//   status : 'ok' | 'empty' | 'error'   — 'empty' = the tool ran fine and
//            found nothing (not a failure; do not retry blindly)
//   code   : canonical UPPER_SNAKE code; free-text errors are mapped and the
//            original text is kept in meta.detail
//   error  : kept equal to `code` for existing `result.error === 'X'` checks
// Pure module: no imports from services/state/http.

import { AGENT_LOOP_CONTRACT, contractRegExp } from '../runtime/agentLoopContract.js';

// Codes, hints and the contract note are shared with the iPhone loop
// (shared/protocol/agent-loop.json); this module stays the desktop's API.
const RESULT_CONTRACT = AGENT_LOOP_CONTRACT.toolResult;

export const TOOL_ERROR_CODES = Object.freeze([...RESULT_CONTRACT.errorCodes]);

const CANONICAL = contractRegExp(RESULT_CONTRACT.canonicalCode);

// Canonical-looking legacy codes that are renamed to the generic set.
const LEGACY_ALIASES = RESULT_CONTRACT.legacyAliases;

// Free-text error → canonical code. Matched in order; first hit wins.
const LEGACY_PATTERNS = RESULT_CONTRACT.legacyPatterns.map(entry => [contractRegExp(entry), entry.code]);

export function canonicalToolCode(rawError, { aborted = false, timedOut = false } = {}) {
  if (timedOut) return 'TIMEOUT';
  if (aborted) return 'ABORTED';
  const text = String(rawError ?? '').trim();
  if (!text) return 'UNKNOWN';
  // Already-canonical codes (TOOL_NOT_WHITELISTED, COMMIT_FAILED,
  // FILE_SAFETY_DENIED, REPEATED_FAILURE, INVALID_TOOL_ARGUMENTS, SearchTask
  // codes, …) stay as-is: they carry more meaning than the generic set. Only
  // the few legacy aliases are rewritten.
  if (CANONICAL.test(text)) {
    const alias = Object.hasOwn(LEGACY_ALIASES, text) ? LEGACY_ALIASES[text] : undefined;
    return alias || text;
  }
  for (const [pattern, code] of LEGACY_PATTERNS) if (pattern.test(text)) return code;
  return 'UNKNOWN';
}

export function toolStatus(result) {
  if (!result || result.ok === false) return 'error';
  if (result.status === 'empty' || result.meta?.empty === true || result.code === 'NO_RESULTS') return 'empty';
  return 'ok';
}

/**
 * Attach `status` and `code` to a normalised executor result. Idempotent:
 * a result that already carries a canonical code keeps it.
 */
export function finalizeToolResult(result) {
  if (!result || typeof result !== 'object') return result;
  const meta = result.meta && typeof result.meta === 'object' ? { ...result.meta } : {};
  const status = toolStatus(result);
  if (status !== 'error') {
    const code = status === 'empty' ? 'NO_RESULTS' : null;
    const next = { ...result, status, meta };
    if (code) next.code = code; else delete next.code;
    if (next.error && status === 'ok') delete next.error;
    return next;
  }
  const raw = result.error;
  const code = result.code && CANONICAL.test(String(result.code))
    ? String(result.code)
    : canonicalToolCode(raw, { aborted: Boolean(meta.aborted), timedOut: Boolean(meta.timedOut) });
  if (raw !== undefined && raw !== null && String(raw) !== code && meta.detail === undefined) meta.detail = String(raw).slice(0, 500);
  if (code === 'EXIT_NONZERO' && meta.exitCode === undefined) {
    const match = String(raw || '').match(/Exit code (\d+)/i);
    if (match) meta.exitCode = Number(match[1]);
  }
  return { ...result, ok: false, status, code, error: code, meta };
}

/** One-line hint the model can act on, per code. */
export function toolCodeHint(code) {
  return typeof code === 'string' && Object.hasOwn(RESULT_CONTRACT.hints, code) ? RESULT_CONTRACT.hints[code] : '';
}

// Model-facing status explanation, appended to the tool instructions.
export const TOOL_RESULT_CONTRACT_NOTE = RESULT_CONTRACT.contractNote;
