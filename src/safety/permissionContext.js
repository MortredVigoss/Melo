import { realpath, stat } from 'node:fs/promises';
import { loadState } from '../state/stateStore.js';
export async function operationScope(context, workspacePath, agentId) {
  const binding = context.turnBinding;
  const chat = binding ? null : (await loadState({ home: context.home })).chats.find(c => c.id === context.chatId);
  if (!binding && !chat) return null;
  let workspace = null;
  if (workspacePath) {
    try { const path = await realpath(workspacePath); const s = await stat(path); workspace = { path, device: String(s.dev), inode: String(s.ino) }; }
    catch { workspace = { path: workspacePath, unavailable: true }; }
  }
  return { role: agentId || binding?.role || chat?.agentId || 'main', project: binding?.project ?? chat?.projectId ?? null, workspace };
}
export function scopeMatches(saved, current) {
  if (!saved) return true; // Existing user-wide rules retain their explicit scope.
  if (!current || saved.workspace?.unavailable || current.workspace?.unavailable) return false;
  return JSON.stringify(saved) === JSON.stringify(current);
}
// Whether an approval prompt (tool permission, file safety) can be answered.
// Every chat turn wraps its emitter to record execution, so an emitter alone
// cannot tell the live desktop stream from Telegram / Discord / the JSON route;
// sendChatMessage marks those turns `permissionSurface: 'none'` and members
// inherit the request context. Unmarked callers keep the emitter rule.
export function hasApprovalSurface(sseEmitter, context) {
  return typeof sseEmitter === 'function' && context?.permissionSurface !== 'none';
}

// A prompt the server no longer waits for (timed out, or its run was cancelled) is announced, so
// the UI removes its card. Without this the card stayed until the turn ended, in front of every
// newer prompt, and answering it returned "Unknown or expired request." (2026-11-10 audit). Tool,
// task-scope and file-safety prompts share the event; capability prompts already had
// capability_request_closed.
export function announcePromptClosed(sseEmitter, requestId, reason) {
  if (typeof sseEmitter !== 'function') return;
  try { sseEmitter('tool_permission_closed', { requestId, reason }); } catch { /* The stream is gone; there is no card to remove. */ }
}
