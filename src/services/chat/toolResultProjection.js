/**
 * src/services/chat/toolResultProjection.js
 *
 * Projects an executor `{ call, result }` pair into the persistence-bound
 * shape that chatExecutionRunner accumulates and sendChatMessage attaches
 * to `assistantMessage.toolResults` (G-1d slice 2, 2026-05-12).
 *
 * Extracted from chatExecutionRunner's tool-loop body so the
 * "project + filter" logic can be unit-tested without spinning up the
 * full graph machine.  Codex review on commit 1 (B + ⚪) flagged the
 * gap: hydration was well-tested but the producer-side projection had
 * no direct coverage — a future "simplify by inlining" refactor could
 * silently break the persisted shape with all gate tests still green.
 *
 * Contract:
 *   - input.call: { id, name } from the parsed model tool_call request
 *   - input.result: { ok, evidenceTrail?, ... } from executor.js
 *   - output: { toolCallId, toolName, ok, evidenceTrail? }
 *
 * evidenceTrail is included only when present AND non-empty — sparse
 * by design (most tools never produce one), matching the conditional-
 * spread pattern used throughout the rest of the trail chain.
 */

import { normalizeToSearchTaskResult } from '../search/searchTask.js';

// 2026-05-23 架构 audit #2 闭环: the SearchTask adapter (8-code unified
// error taxonomy in src/services/search/searchTask.js) had zero production
// callers — 701 lines maintained but never consumed.  This wires its FIRST
// real consumer: derive the unified errorCode for failed search-tool results
// and attach it to the persisted toolResult entry, riding the same rails
// `evidenceTrail` already uses (persist + SSE debug channel).  Purely
// additive — does NOT alter model-facing prose (formatToolResult), so there
// is no model-behavior change; the value is precise failure classification
// in the persisted record + devtools overlay (legacy `result.error` conflates
// e.g. SEARCH_FAILED across NO_RESULTS/TIMEOUT/NETWORK; the adapter reads the
// trail to disambiguate).
//
// Only the two directly-registered search tools map to adapter `source`s.
// (social-link is no longer a registered tool — its failures surface through
// fetch_url's nested trail, covered by 'url-fetch'.)
const SEARCH_TOOL_SOURCE = Object.freeze({
  fetch_url: 'url-fetch',
  web_search: 'web-search',
});

/**
 * Derive the unified SearchTask error code for a failed search-tool result,
 * or null when not applicable (success, non-search tool, or adapter throw).
 * Best-effort enrichment — never throws.
 *
 * @param {{ name?: string }} call
 * @param {{ ok?: boolean, error?: string, evidenceTrail?: Array }} result
 * @returns {string|null}
 */
export function deriveUnifiedErrorCode(call, result) {
  if (result?.ok !== false) return null;
  const source = SEARCH_TOOL_SOURCE[call?.name];
  if (!source) return null;
  try {
    const task = normalizeToSearchTaskResult(result, source, {});
    return task?.error || null;
  } catch {
    return null;
  }
}

/**
 * @param {{ id?: string, name?: string }} call
 * @param {{ ok?: boolean, error?: string, evidenceTrail?: Array }} result
 * @returns {{ toolCallId: string, toolName: string, ok: boolean, evidenceTrail?: Array, errorCode?: string }}
 */
export function projectToolResultForPersist(call, result) {
  const entry = {
    toolCallId: typeof call?.id === 'string' ? call.id : '',
    toolName: typeof call?.name === 'string' ? call.name : '',
    ok: result?.ok !== false,
  };
  if (Array.isArray(result?.evidenceTrail) && result.evidenceTrail.length > 0) {
    entry.evidenceTrail = result.evidenceTrail;
  }
  if (result?.meta?.backupOperationId) entry.backupOperationId = result.meta.backupOperationId;
  if (result?.meta?.path) entry.path = String(result.meta.path);
  if (Number.isInteger(result?.meta?.exitCode)) entry.exitCode = result.meta.exitCode;
  if (result?.meta?.replayed) entry.replayed = true;
  const errorCode = deriveUnifiedErrorCode(call, result) || (result?.ok === false
    ? result?.meta?.denied ? 'PERMISSION_DENIED'
      : /^[A-Z][A-Z0-9_]{1,63}$/.test(result?.error || '') ? result.error : 'TOOL_FAILED'
    : null);
  if (errorCode) {
    entry.errorCode = errorCode;
  }
  return entry;
}
