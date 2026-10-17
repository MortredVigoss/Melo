import {validateAgentSettings,refreshAgentSettings,applyAgentSettings,confirmAgentSettings} from '../../mobile-sync/agentSettings.js';
import {mergeWorkspaces} from '../../mobile-sync/workspaceProtocol.js';
import { finishChatDeletions } from '../services/chat/chatDeletion.js';
import { refreshPortableMemory, stagePortableMemory, replayPortableMemory } from '../services/chat/portableMemory.js';
import { loadState, updateStateAtomically } from '../state/stateStore.js';
import { sendJson, readJsonBody } from './transport.js';
import { validateSnapshot } from '../../mobile-sync/protocol.js';
import { authorized } from '../../mobile-sync/server.js';
import { join } from 'node:path';
import { getResolvedConfig, getMeloHome } from '../config.js';
import { refreshPortableWorkspace, applyPortableWorkspace } from '../services/chat/portableWorkspace.js';
import { resolveWorkspace, stableJSON } from '../../mobile-sync/workspaceProtocol.js';
import { createAgentMarkdownFileHelpers } from '../persistence/agentMarkdownFiles.js';
// Business logic lives in services/remote/mobileSync.js (audit A-4); re-exported
// here so existing importers of this module keep working.
import { exportMobileSnapshot, importMobileSnapshot, preloadMobileScenes, verifiedMobileScenes, persistPortableFiles } from '../services/remote/mobileSync.js';
export { exportMobileSnapshot, importMobileSnapshot, preloadMobileScenes, verifiedMobileScenes, persistPortableFiles };
const token = process.env.MELO_SYNC_TOKEN || '';
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
