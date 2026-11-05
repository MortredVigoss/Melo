import { toolEffect } from '../../shared/agent/toolEffects.js';
import { toolCallFingerprint } from '../../shared/agent/repeatGuard.js';

// One ledger per user turn, shared by the lead and every descendant. Reserve
// synchronously before awaiting permission/execution so concurrent jobs cannot
// both dispatch the same effect. Entries never authorize an operation.
export function createTurnEffects() { return { active: false, entries: new Map() }; }
export function reserveTurnEffect(ledger, tool, args, workspacePath) {
  if (!ledger || !['write', 'unknown'].includes(toolEffect(tool.id, args, tool))) return null;
  const key = JSON.stringify([workspacePath || '', toolCallFingerprint(tool.id, args)]);
  const prior = ledger.entries.get(key);
  if (ledger.active && prior) return { result: { ok: false, error: 'TURN_EFFECT_ALREADY_ATTEMPTED',
    output: `This operation was already ${prior.status} in this turn. Read or verify its result; do not repeat the effect.`,
    meta: { executionStarted: false, priorStatus: prior.status } } };
  const entry = { status: 'pending' }; ledger.entries.set(key, entry);
  return { finish(result) {
    if (ledger.entries.get(key) !== entry) return;
    if (result?.meta?.executionStarted === false) ledger.entries.delete(key);
    else entry.status = result?.ok === true ? 'successful' : 'uncertain';
  } };
}
