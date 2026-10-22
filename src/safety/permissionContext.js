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
