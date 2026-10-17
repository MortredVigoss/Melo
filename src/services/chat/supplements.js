// Supplements typed while a chat's turn is running. The agent loop takes them
// before its next model call; whatever is still queued when the turn ends is
// handed back so the client sends it as the next message. Only exists for the
// duration of a turn, so nothing leaks into a later turn.
import { randomUUID } from 'node:crypto';

const runs = new Map(); // chatId -> { queued: [{id,text}], used: [{id,text}] }

export function beginSupplements(chatId) {
  if (chatId) runs.set(chatId, { queued: [], used: [] });
}
export function addSupplement(chatId, text) {
  const run = runs.get(chatId), clean = String(text || '').trim().slice(0, 4000);
  if (!run || !clean) return null;
  const entry = { id: randomUUID(), text: clean };
  run.queued.push(entry);
  return entry;
}
export function takeSupplements(chatId) {
  const run = runs.get(chatId);
  if (!run?.queued.length) return [];
  const taken = run.queued.splice(0);
  run.used.push(...taken);
  return taken;
}
export function usedSupplements(chatId) {
  return [...(runs.get(chatId)?.used || [])];
}
// Ends the turn: returns the supplements that were never used.
export function endSupplements(chatId) {
  const run = runs.get(chatId);
  runs.delete(chatId);
  return run ? run.queued : [];
}
export const supplementMessage = entries => `【用户在执行过程中补充，请结合已完成的步骤调整后续工作】\n${entries.map(entry => entry.text).join('\n')}`;
