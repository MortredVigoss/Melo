import { toolEffect } from '../../shared/agent/toolEffects.js';
import { toolCallFingerprint } from '../../shared/agent/repeatGuard.js';

// One ledger per user turn, shared by the lead and every descendant. Reserve
// synchronously before awaiting permission/execution so concurrent jobs cannot
// both dispatch the same effect. Entries never authorize an operation.
//
// Scope (2026-11-05 review C1): a declared `write` never repeats once members
// are active. An `unknown` effect (bash, MCP tools without a read-only hint,
// browser actions) repeats only for the actor that already ran it and only
// after that run finished: paging through results or re-listing a directory
// stays possible, while a second member or the lead cannot replay it. A tool
// may refine its own effect per call through `effectFor(args)`.
export function createTurnEffects() { return { active: false, entries: new Map() }; }
export function reserveTurnEffect(ledger, tool, args, workspacePath, actor = null) {
  if (!ledger) return null;
  let effect = toolEffect(tool.id, args, tool);
  if (effect === 'unknown' && typeof tool.effectFor === 'function' && tool.effectFor(args) === 'read') effect = 'read';
  if (!['write', 'unknown'].includes(effect)) return null;
  const key = JSON.stringify([workspacePath || '', toolCallFingerprint(tool.id, args)]);
  const prior = ledger.entries.get(key);
  const blocked = Boolean(prior) && ledger.active && (effect === 'write' || prior.status === 'pending' || prior.actor !== actor);
  if (blocked) return { result: { ok: false, error: 'TURN_EFFECT_ALREADY_ATTEMPTED',
    output: `This operation was already ${prior.status} in this turn. Read or verify its result; do not repeat the effect.`,
    meta: { executionStarted: false, priorStatus: prior.status } } };
  const entry = { status: 'pending', actor }; ledger.entries.set(key, entry);
  return { finish(result) {
    if (ledger.entries.get(key) !== entry) return;
    if (result?.meta?.executionStarted === false) ledger.entries.delete(key);
    else entry.status = result?.ok === true ? 'successful' : 'uncertain';
  } };
}
