import {validateAgentSettings,refreshAgentSettings,applyAgentSettings,confirmAgentSettings} from '../../mobile-sync/agentSettings.js';
import {mergeWorkspaces} from '../../mobile-sync/workspaceProtocol.js';
import { assertChatDeletable, stageChatDeletion, finishChatDeletions } from '../services/chat/chatDeletion.js';
import { refreshPortableMemory, stagePortableMemory, replayPortableMemory } from '../services/chat/portableMemory.js';
import { loadState, updateStateAtomically } from '../state/stateStore.js';
import { createChatRecord } from '../state/conversation.js';
import { sendJson, readJsonBody } from './transport.js';
import { validateSnapshot, mergeSnapshots, mergeDeletedChats, withoutDeletedChatContext } from '../../mobile-sync/protocol.js';
import { authorized } from '../../mobile-sync/server.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getResolvedConfig, getMeloHome } from '../config.js';
import { refreshPortableWorkspace, applyPortableWorkspace } from '../services/chat/portableWorkspace.js';
import { resolveWorkspace, stableJSON } from '../../mobile-sync/workspaceProtocol.js';
import { readExecutionScene } from '../services/chat/executionScenes.js';
import { createAgentMarkdownFileHelpers, writeMarkdownFile } from '../persistence/agentMarkdownFiles.js';
const token = process.env.MELO_SYNC_TOKEN || '';
const portableDate = (value, fallback) => {
  const candidate = Number.isFinite(Date.parse(value)) ? value : fallback;
  return Number.isFinite(Date.parse(candidate)) ? new Date(candidate).toISOString() : '1970-01-01T00:00:00.000Z';
};
export function exportMobileSnapshot(state, {workspace = false} = {}) {
  const deletedChats = mergeDeletedChats(state.mobileDeletedChats);
  const deleted = new Set(deletedChats.map(row => row.id));
  return validateSnapshot({ version: 1, deletedChats,
    ...(workspace && state.mobileWorkspaceSync ? {workspace:withoutDeletedChatContext(state.mobileWorkspaceSync, deletedChats)} : {}),
    ...(state.tasks?.length || state.mobileTaskSync ? {
      tasks: [...(state.mobileTaskSync?.tasks || []).filter(remote=>!state.tasks?.some(t=>t.id===remote.id)), ...(state.tasks || []).map(t=>({id:t.id,title:String(t.title || '任务').slice(0,500),status:t.status,owner:t.owner,checkpoint:((Object.keys(t.execution?.pendingApprovals || {}).length ? `等待执行设备确认：${Object.values(t.execution.pendingApprovals).join('、')}。\n` : '')+(t.latestNote || t.summary || '')).slice(0,12000),revision:t.syncRevision || 1,sourceDevice:'desktop',updatedAt:t.updatedAt,chatId:t.execution?.chatId || null,needsApproval:Object.keys(t.execution?.pendingApprovals || {}).length>0 || ['blocked','review'].includes(t.status)}))],
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
export async function handleMobileSyncRoute(request, response, url) {
  if (!['/api/mobile-sync','/api/mobile-sync/resolve','/api/agent-settings-sync','/api/agent-settings-sync/resolve','/api/agent-settings-sync/confirm'].includes(url.pathname) || !['GET','POST'].includes(request.method)) return false;
  // Capture home before any asynchronous work; all imported files remain here.
  const home=getMeloHome();
  if(url.pathname.startsWith('/api/agent-settings-sync')) {
    if(url.pathname.endsWith('/confirm')) {
      // Sync bearer credentials cannot be used at the desktop approval entry.
      // Require a same-origin desktop browser on the loopback socket.
      const address=request.socket?.remoteAddress;
      const origins=new Set(['localhost','127.0.0.1','[::1]'].map(host=>`http://${host}:${request.socket?.localPort}`));
      if(request.method!=='POST'||request.headers.authorization||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address)||!origins.has(request.headers.origin)) {
        sendJson(response,403,{error:'能力放宽只能在本机桌面设置中确认。'});return true;
      }
      const body=await readJsonBody(request);
      await updateStateAtomically(state=>confirmAgentSettings(state,body),{home});
      sendJson(response,200,{ok:true});return true;
    }
    const resolving=url.pathname.endsWith('/resolve');
    if(!resolving&&!authorized(request,token)){sendJson(response,401,{error:'Unauthorized'});return true;}
    if(resolving&&request.method!=='POST'){sendJson(response,405,{error:'POST required'});return true;}
    const incoming=request.method==='POST'?await readJsonBody(request,{maxBytes:8*1024*1024}):null;
    const result=await updateStateAtomically(state=>{
      let workspace=refreshAgentSettings(state);
      if(resolving){
        const row=workspace.records.find(r=>r.id===incoming.id);
        if(!incoming.expected||stableJSON(row?.versions[incoming.index])!==stableJSON(incoming.expected))throw Object.assign(new Error('同步冲突已变化，请刷新后重新选择。'),{statusCode:409});
        workspace=resolveWorkspace(workspace,'knowledge',incoming.id,incoming.index,state.mobileWorkspaceDevice);
      }else if(incoming)workspace=mergeWorkspaces(workspace,validateAgentSettings(incoming));
      if(Buffer.byteLength(JSON.stringify(workspace))>8*1024*1024)throw Object.assign(new Error('Agent settings exceed capacity'),{statusCode:413});
      applyAgentSettings(state,workspace);return state;
    },{home});
    sendJson(response,200,result.agentSettingsSync);return true;
  }
  const getPaths=createAgentMarkdownFileHelpers({agentsDir:join(home,'desktop','agents')}).getAgentMarkdownPaths;
  if(url.pathname.endsWith('/resolve')) {
    if(request.method!=='POST'){sendJson(response,405,{error:'POST required'});return true;}
    const body=await readJsonBody(request),config=await getResolvedConfig();
    await updateStateAtomically(s=>{ replayPortableMemory(s); return s; },{home});
    await updateStateAtomically(async s=>{
      const expectedMemories = refreshPortableMemory(s), baseline = structuredClone(s.mobileWorkspaceSync);
      const row=s.mobileWorkspaceSync?.records.find(r=>r.kind===body.kind&&r.id===body.id);
      if(!body.expected||stableJSON(row?.versions?.[body.index])!==stableJSON(body.expected))throw Object.assign(new Error('同步冲突已变化，请刷新后重新选择。'),{statusCode:409});
      s.mobileWorkspaceSync=resolveWorkspace(s.mobileWorkspaceSync,body.kind,body.id,body.index,s.mobileWorkspaceDevice);
      applyPortableWorkspace(s,s.mobileWorkspaceSync,{config,home,resolvedKeys:[`${body.kind}:${body.id}`]});
      await persistPortableFiles(s,getPaths);
      stagePortableMemory(s, expectedMemories, baseline);
      return s;
    },{home});
    const state=await updateStateAtomically(s=>{ replayPortableMemory(s); return s; },{home});
    sendJson(response,200,{conflicts:state.mobileWorkspaceSync.records.filter(r=>r.versions.length>1)});return true;
  }
  if (!authorized(request, token)) { sendJson(response, 401, { error: 'Mobile sync disabled or unauthorized' }); return true; }
  await updateStateAtomically(s=>{ replayPortableMemory(s); return s; },{home});
  const incoming=request.method==='POST'?validateSnapshot(await readJsonBody(request,{maxBytes:8*1024*1024})):null;
  const config=await getResolvedConfig();
  const snapshot = await loadState({ home });
  const preparedScenes = await preloadMobileScenes(snapshot, home);
  let state=await updateStateAtomically(async s=>{
    const scenes = verifiedMobileScenes(s, preparedScenes);
    refreshPortableWorkspace(s,{config,scenes});
    const expectedMemories = refreshPortableMemory(s);
    if(incoming) {
      const baseline = structuredClone(s.mobileWorkspaceSync);
      importMobileSnapshot(s,incoming,{config,home});
      if (Buffer.byteLength(JSON.stringify(exportMobileSnapshot(s,{workspace:true}))) > 8*1024*1024) throw Object.assign(new Error('同步资料超过 8 MiB 容量，原记录已保留。'),{statusCode:413,status:413});
      await persistPortableFiles(s,getPaths);
      stagePortableMemory(s, expectedMemories, baseline);
    }
    return s;
  },{home});
  if(incoming)state=await updateStateAtomically(s=>{ replayPortableMemory(s); return s; },{home});
  await finishChatDeletions(home);
  const outgoing = exportMobileSnapshot(state,{workspace:true});
  if (Buffer.byteLength(JSON.stringify(outgoing)) > 8 * 1024 * 1024) {
    sendJson(response,413,{error:'同步资料超过 8 MiB 容量，原记录已保留。请先导出备份并减少同步资料。'});
  } else sendJson(response,200,outgoing);
  return true;
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
