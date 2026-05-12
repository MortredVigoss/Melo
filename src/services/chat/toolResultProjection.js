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

/**
 * @param {{ id?: string, name?: string }} call
 * @param {{ ok?: boolean, evidenceTrail?: Array }} result
 * @returns {{ toolCallId: string, toolName: string, ok: boolean, evidenceTrail?: Array }}
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
  return entry;
}
