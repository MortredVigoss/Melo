// Supplements typed while a chat's turn is running. The agent loop takes them
// before its next model call; whatever is still queued when the turn ends is
// handed back so the client sends it as the next message. Only exists for the
// duration of a turn, so nothing leaks into a later turn.
import { randomUUID } from 'node:crypto';
import { AGENT_LOOP_CONTRACT } from '../../runtime/agentLoopContract.js';

// Wrapper text and size are shared with the iPhone loop (shared/protocol/agent-loop.json).
const SUPPLEMENT = AGENT_LOOP_CONTRACT.supplement;

// chatId -> [{ queued: [{id,text}], used: [{id,text}] }, …] in arrival order. Turns of one chat execute in
// that order, so the first run belongs to the turn that is executing. One slot per chat used to be reset
// by every arriving request and deleted by every ending one: a second request for the same chat wiped the
// running turn's supplements, and the first turn's end then left the second with none (2026-11-10 audit).
const runs = new Map();
const current = chatId => runs.get(chatId)?.[0];

/** Opens the run of one turn and returns it; pass it to endSupplements. */
export function beginSupplements(chatId) {
  if (!chatId) return null;
  const run = { queued: [], used: [] };
  runs.set(chatId, [...(runs.get(chatId) || []), run]);
  return run;
}
export function addSupplement(chatId, text) {
  const run = current(chatId), clean = String(text || '').trim().slice(0, SUPPLEMENT.maxChars);
  if (!run || !clean) return null;
  const entry = { id: randomUUID(), text: clean };
  run.queued.push(entry);
  return entry;
}
export function takeSupplements(chatId) {
  const run = current(chatId);
  if (!run?.queued.length) return [];
  const taken = run.queued.splice(0);
  run.used.push(...taken);
  return taken;
}
export function usedSupplements(chatId) {
  return [...(current(chatId)?.used || [])];
}
// Ends one turn: returns the supplements it never used. `run` is what beginSupplements returned; ending the
// same run twice returns nothing the second time and never touches another turn's run.
export function endSupplements(chatId, run = current(chatId)) {
  if (!run) return [];
  const rest = (runs.get(chatId) || []).filter(entry => entry !== run);
  if (rest.length) runs.set(chatId, rest); else runs.delete(chatId);
  return run.queued.splice(0);
}
export const supplementMessage = entries => `${SUPPLEMENT.prefix}${SUPPLEMENT.separator}${entries.map(entry => entry.text).join(SUPPLEMENT.separator)}`;
