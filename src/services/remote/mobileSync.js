import { withDevelopmentCheckpoints } from '../../development/checkpoint.js';
// Mobile sync business logic — byte-for-byte extraction from
// src/http/mobileSyncRoutes.js (2026-10-17 audit A-4 / A-12: the transport
// module carried export/import/merge/persist logic, and
// services/settings/localData.js imported it from http/, inverting the
// layering). The HTTP handler stays in http/ and re-exports these names for
// existing importers.
import { assertChatDeletable, stageChatDeletion } from '../chat/chatDeletion.js';
import { createChatRecord } from '../../state/conversation.js';
import { validateSnapshot, mergeSnapshots, mergeDeletedChats, withoutDeletedChatContext } from '../../../mobile-sync/protocol.js';
import { mkdir } from 'node:fs/promises';
import { applyPortableWorkspace } from '../chat/portableWorkspace.js';
import { stableJSON } from '../../../mobile-sync/workspaceProtocol.js';
import { readExecutionScene } from '../chat/executionScenes.js';
import { writeMarkdownFile } from '../../persistence/agentMarkdownFiles.js';
const portableDate = (value, fallback) => {
  const candidate = Number.isFinite(Date.parse(value)) ? value : fallback;
  return Number.isFinite(Date.parse(candidate)) ? new Date(candidate).toISOString() : '1970-01-01T00:00:00.000Z';
};
export function exportMobileSnapshot(state, {workspace = false, development = []} = {}) {
  const deletedChats = mergeDeletedChats(state.mobileDeletedChats);
  const deleted = new Set(deletedChats.map(row => row.id));
  return validateSnapshot({ version: 1, deletedChats,
    ...(workspace && state.mobileWorkspaceSync ? {workspace:withoutDeletedChatContext(state.mobileWorkspaceSync, deletedChats)} : {}),
    ...(state.tasks?.length || state.mobileTaskSync || development.length ? {
      tasks: withDevelopmentCheckpoints([...(state.mobileTaskSync?.tasks || []).filter(remote=>!state.tasks?.some(t=>t.id===remote.id)), ...(state.tasks || []).map(t=>({id:t.id,title:String(t.title || '任务').slice(0,500),status:t.status,owner:t.owner,checkpoint:((Object.keys(t.execution?.pendingApprovals || {}).length ? `等待执行设备确认：${Object.values(t.execution.pendingApprovals).join('、')}。\n` : '')+(t.latestNote || t.summary || '')).slice(0,12000),revision:t.syncRevision || 1,sourceDevice:'desktop',updatedAt:t.updatedAt,chatId:t.execution?.chatId || null,needsApproval:Object.keys(t.execution?.pendingApprovals || {}).length>0 || ['blocked','review'].includes(t.status)}))], development),
      handoffs:state.mobileTaskSync?.handoffs || [],
    } : {}), chats: state.chats.filter(chat => !chat.externalThreadKey && !deleted.has(chat.id)).map(chat => ({
    id: chat.id, title: String(chat.title || '对话').slice(0,500), createdAt: portableDate(chat.createdAt, chat.updatedAt), updatedAt: portableDate(chat.updatedAt, chat.createdAt),
    messages: chat.messages.filter(message => ['user','assistant'].includes(message.role) && typeof message.content === 'string' && message.content.length > 0 && !message.pending).map(message => ({ id: message.id, role: message.role, content: message.content, createdAt: portableDate(message.createdAt, chat.createdAt || chat.updatedAt) })),
  })) });
}
export function importMobileSnapshot(state, incoming, options = {}) {
  const merged = mergeSnapshots(exportMobileSnapshot(state,{workspace:!!state.mobileWorkspaceSync}), incoming);
  if (merged.deletedChats.some(row => state.chats.some(chat => chat.id === row.id && chat.externalThreadKey))) throw new Error('External-channel chat cannot be deleted from mobile');
  const newlyDeleted = merged.deletedChats.filter(row => !(state.mobileDeletedChats || []).some(old => old.id === row.id) || state.chats.some(c => c.id === row.id));
  for (const row of newlyDeleted) {
    const chat = state.chats.find(c => c.id === row.id);
    if (chat) assertChatDeletable(state, chat);
  }
  stageChatDeletion(state, newlyDeleted.map(row => row.id));
  state.mobileDeletedChats = merged.deletedChats;
  const deleted = new Set(merged.deletedChats.map(row => row.id));
  state.chats = state.chats.filter(chat => !deleted.has(chat.id));
  if (deleted.has(state.settings?.selectedChatId)) state.settings.selectedChatId = null;
  if (merged.tasks) {
    state.mobileTaskSync = {tasks:merged.tasks,handoffs:merged.handoffs || []};
    for(const task of state.tasks || []) {
      const requests=(merged.handoffs || []).filter(h=>h.taskId===task.id && h.revision===(task.syncRevision || 1));
      if(requests.length) task.handoff = requests.sort((a,b)=>b.requestedAt.localeCompare(a.requestedAt))[0];
    }
  }
  for (const remote of merged.chats) {
    let chat = state.chats.find(item => item.id === remote.id);
    if (chat?.externalThreadKey) throw new Error('External-channel chat cannot be imported from mobile');
    if (!chat) { chat = { ...createChatRecord({ mode: 'chat' }), ...remote, messages: [], source: 'iphone' }; state.chats.unshift(chat); }
    const ids = new Set(chat.messages.map(message => message.id));
    for (const message of remote.messages) if (!ids.has(message.id)) chat.messages.push({ ...message, attachments: [] });
    chat.messages.sort((a,b) => portableDate(a.createdAt, chat.createdAt).localeCompare(portableDate(b.createdAt, chat.createdAt)) || String(a.id).localeCompare(String(b.id)));
    if (remote.updatedAt > chat.updatedAt) { chat.updatedAt = remote.updatedAt; chat.title = remote.title; }
  }
  if(merged.workspace)applyPortableWorkspace(state,merged.workspace,options);
  return state;
}

// Scene disk reads happen outside the global state queue, with bounded I/O.
// Revalidate both message and sync revision before publishing the snapshot.
export async function preloadMobileScenes(state, home, readScene = readExecutionScene) {
  const rows = new Map((state.mobileWorkspaceSync?.records || []).filter(r => r.kind === 'message').map(r => [r.id, stableJSON(r)]));
  const messages = state.chats.filter(c => !c.externalThreadKey).flatMap(c => c.messages.filter(m => m.role === 'assistant' && m.metadata?.runId));
  const prepared = new Map();
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, messages.length) }, async () => {
    while (index < messages.length) {
      const message = messages[index++];
      const fingerprint = stableJSON(message), revision = rows.get(message.id);
      const scene = await readScene(home, message.metadata.runId, { message });
      if (scene) prepared.set(message.id, { fingerprint, revision, scene });
    }
  }));
  return prepared;
}
export function verifiedMobileScenes(state, prepared) {
  const rows = new Map((state.mobileWorkspaceSync?.records || []).filter(r => r.kind === 'message').map(r => [r.id, stableJSON(r)]));
  const scenes = new Map();
  for (const chat of state.chats.filter(c => !c.externalThreadKey)) for (const message of chat.messages) {
    const entry = prepared.get(message.id);
    if (entry && entry.fingerprint === stableJSON(message) && entry.revision === rows.get(message.id)) scenes.set(message.metadata.runId, entry.scene);
  }
  return scenes;
}

export async function persistPortableFiles(state,getPaths) {
  for(const row of state.mobileWorkspaceSync?.records || []) {
    if(row.versions.length!==1)continue;
    if(row.kind==='project') {
      const project=state.projects.find(p=>p.id===row.id);
      if(project?.workspacePath)await mkdir(project.workspacePath,{recursive:true,mode:0o700});
    }
    if(row.kind==='agent') {
      const agent=state.agentProfiles[row.id],paths=getPaths(row.id,{scope:'global'});
      await writeMarkdownFile(paths.identityPath,agent.identity);await writeMarkdownFile(paths.soulPath,agent.soulMd);
    }
    if(row.kind==='project')for(const [id,agent] of Object.entries(state.projectAgentOverrides[row.id] || {})) {
      const paths=getPaths(id,{scope:'project',projectId:row.id});
      await writeMarkdownFile(paths.identityPath,agent.identity || '');await writeMarkdownFile(paths.soulPath,agent.soulMd || '');
    }
  }
}
