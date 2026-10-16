import {mkdir,lstat,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {loadState,updateStateAtomically} from '../../state/stateStore.js';
import {requireProjectWorkspace,requireWorkspacePath,workspaceError} from './workspacePolicy.js';

export function captureWorkspaceBinding(state,chat,projectId=chat.projectId) {
  if (projectId) {
    const p=state.projects.find(p=>p.id===projectId);
    return Object.freeze({kind:'project',id:projectId,workspacePath:p?.workspacePath || null,
      deletedAt:p?.deletedAt || (!p?'missing':null),workspaceConfirmation:p?.workspaceConfirmation?Object.freeze({...p.workspaceConfirmation}):null});
  }
  return Object.freeze({kind:'chat',id:chat.id,workspacePath:chat.workspacePath || null});
}
const localTools=new Set(['bash','file_read','file_write','file_edit','file_delete','file_move','file_mkdir','glob','grep','pdf','xlsx']);
export const toolNeedsWorkspace=(id,args={})=>localTools.has(id) || id==='image' || id==='knowledge' && args.action==='index';
export function chatWorkspacePath(home,chatId) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(chatId || '')) throw workspaceError('WORKSPACE_UNAVAILABLE','无法为此对话分配安全工作目录。');
  return join(home,'workspaces','chats',chatId);
}
async function ensureChatWorkspace(context,binding) {
  const {home}=context,expected=chatWorkspacePath(home,binding.id);
  const canonicalExpected=chatWorkspacePath(await realpath(home),binding.id);
  const matches=async path=>!path || [resolve(expected),canonicalExpected].includes(await realpath(path).catch(()=>resolve(path)));
  const state=await loadState({home}),chat=state.chats.find(c=>c.id===binding.id);
  if (!chat || chat.projectId || !await matches(chat.workspacePath)) throw workspaceError('WORKSPACE_CHANGED','对话工作目录已变化，请重新发起操作。');
  // Each owned component is checked before descending. Never follow a user-
  // replaced workspace symlink into another folder when allocating a chat.
  let current=await realpath(home);
  for (const part of ['workspaces','chats',binding.id]) {
    current=join(current,part);
    await mkdir(current,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const info=await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw workspaceError('WORKSPACE_UNAVAILABLE','对话工作目录被替换，请检查本地目录。');
  }
  if (!chat.workspacePath) await updateStateAtomically(async latest=>{
    const target=latest.chats.find(c=>c.id===binding.id);
    if (!target || target.projectId || !await matches(target.workspacePath)) throw workspaceError('WORKSPACE_CHANGED','对话工作目录已变化，请重试。');
    target.workspacePath=expected;
  },{home});
  return expected;
}
export async function workspaceForTool(context,tool,args,requestedPath) {
  if (!toolNeedsWorkspace(tool.id,args)) return context.workspacePath || requestedPath || null;
  let binding=context.turnBinding?.workspace;
  if (!binding && context.chatId) {
    const state=await loadState({home:context.home}),chat=state.chats.find(c=>c.id===context.chatId);
    if (chat) binding=captureWorkspaceBinding(state,chat,context.turnBinding?.project ?? chat.projectId);
  }
  if (binding?.kind==='project') return requireProjectWorkspace(binding);
  if (binding?.kind==='chat') return ensureChatWorkspace(context,binding);
  return requireWorkspacePath(context.workspacePath || requestedPath);
}

// Exempt only a validated generated workspace, never an arbitrary Melo data
// directory selected by a caller. The gate still compares lexical and real paths.
export async function ownedWorkspaceSafety(context, path) {
  const projectId=context.turnBinding?.workspace?.kind==='project' ? context.turnBinding.workspace.id : null;
  const parts=projectId ? ['workspaces',projectId] : context.chatId ? ['workspaces','chats',context.chatId] : null;
  if (!parts || !/^[a-zA-Z0-9_-]{1,200}$/.test(parts.at(-1)) || path!==join(context.home,...parts)) return null;
  const home=await realpath(context.home);
  const canonical=await realpath(path).catch(()=>null);
  if (canonical!==join(home,...parts)) return null;
  return Object.freeze({path,canonical,home});
}
