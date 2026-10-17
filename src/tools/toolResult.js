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

export const TOOL_ERROR_CODES = Object.freeze([
  'INVALID_ARGS',
  'NOT_FOUND',
  'NO_RESULTS',
  'PERMISSION_DENIED',
  'CAPABILITY_DENIED',
  'TIMEOUT',
  'ABORTED',
  'NETWORK',
  'PROVIDER_DOWN',
  'EXIT_NONZERO',
  'UNKNOWN',
]);

const CANONICAL = /^[A-Z][A-Z0-9_]{1,63}$/;

// Canonical-looking legacy codes that are renamed to the generic set.
const LEGACY_ALIASES = Object.freeze({ DENIED: 'PERMISSION_DENIED', TOOL_TIMEOUT: 'TIMEOUT', SEARCH_FAILED: 'PROVIDER_DOWN', TOOL_EXECUTION_FAILED: 'UNKNOWN' });

// Free-text error → canonical code. Matched in order; first hit wins.
const LEGACY_PATTERNS = [
  [/^Exit code /i, 'EXIT_NONZERO'],
  [/timed? ?out|ETIMEDOUT|deadline/i, 'TIMEOUT'],
  [/\babort/i, 'ABORTED'],
  [/ENOENT|no such file|not found|does not exist|missing file/i, 'NOT_FOUND'],
  [/EACCES|EPERM|permission denied|not permitted|denied by/i, 'PERMISSION_DENIED'],
  [/ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up|certificate/i, 'NETWORK'],
  [/rate.?limit|\b429\b|\b5\d\d\b|unavailable|provider/i, 'PROVIDER_DOWN'],
  [/invalid|must be|required|unsupported|malformed|schema/i, 'INVALID_ARGS'],
];

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
    const alias = LEGACY_ALIASES[text];
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
  switch (code) {
    case 'NO_RESULTS': return 'The tool ran successfully and found nothing; broaden or change the query rather than retrying the same call.';
    case 'NOT_FOUND': return 'The target does not exist at that path or id; check the location before retrying.';
    case 'PERMISSION_DENIED': return 'The user or policy denied this action; do not retry it, explain or choose another approach.';
    case 'CAPABILITY_DENIED': return 'This agent is not allowed to use this tool; tell the user instead of retrying.';
    case 'TIMEOUT': return 'The tool exceeded its time limit; retry only with a narrower request.';
    case 'ABORTED': return 'The run was cancelled; stop.';
    case 'NETWORK': return 'A network error occurred; one retry may help, repeated failures mean the resource is unreachable.';
    case 'PROVIDER_DOWN': return 'The backing service is unavailable; do not keep retrying — report it.';
    case 'EXIT_NONZERO': return 'The command ran but exited non-zero; read stderr before retrying.';
    case 'INVALID_ARGS': return 'The arguments were rejected; fix them according to the schema.';
    default: return '';
  }
}

// Model-facing status explanation, appended to the tool instructions.
export const TOOL_RESULT_CONTRACT_NOTE =
  'Every tool result carries status and code: status "ok" means it worked, "empty" means it ran correctly but found nothing (do not retry the same call; change the query or move on), "error" means it failed with a code (NOT_FOUND, PERMISSION_DENIED, TIMEOUT, NETWORK, PROVIDER_DOWN, EXIT_NONZERO, INVALID_ARGS, …) and a hint. Treat denials and provider outages as final for this turn.';
