// Owned chat files have a separate lifecycle from chat history. Sync may remove
// history, but only an explicit local decision may remove the owned directory.
import {lstat, realpath, readdir, rename, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chatWorkspacePath} from './toolWorkspace.js';
import {projectWorkspaceStatus, workspaceError} from './workspacePolicy.js';
import {currentRequestContext} from '../../runtime/requestScope.js';
import {loadState, updateStateAtomically} from '../../state/stateStore.js';

export async function ownedChatDirectory(home, chatId) {
  const expected=chatWorkspacePath(home,chatId);
  let path=await realpath(home);
  for(const part of ['workspaces','chats',chatId]) {
    path=join(path,part);
    const info=await lstat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(!info) return {rootPath:expected,exists:false,token:'missing'};
    if(info.isSymbolicLink() || !info.isDirectory()) throw workspaceError('WORKSPACE_CHANGED','对话文件目录已被替换，请检查本地目录。');
  }
  const info=await lstat(path);
  return {rootPath:path,exists:true,token:`${info.dev}:${info.ino}`};
}
export async function chatWorkspaceStatus(state, chat, home) {
  if(chat?.projectId) return {...await projectWorkspaceStatus(state.projects.find(p=>p.id===chat.projectId)),chatId:chat.id,projectId:chat.projectId};
  if(!chat) return {rootPath:null,exists:false};
  const expected=chatWorkspacePath(home,chat.id);
  const canonicalExpected=chatWorkspacePath(await realpath(home),chat.id);
  if(chat.workspacePath && ![resolve(expected),canonicalExpected].includes(await realpath(chat.workspacePath).catch(()=>resolve(chat.workspacePath)))) throw workspaceError('WORKSPACE_CHANGED','对话工作目录已变化，请检查文件位置。');
  return {...await ownedChatDirectory(home,chat.id),chatId:chat.id,kind:'chat'};
}
export async function previewChatDeletion(chatId) {
  const home=currentRequestContext().home,state=await loadState({home});
  const chat=state.chats.find(c=>c.id===chatId);
  if(!chat) throw workspaceError('CHAT_NOT_FOUND','对话不存在。');
  // A chat may have acquired a project after creating its own directory. Only
  // its original owned directory can be removed; project files are never ours.
  const directory=await ownedChatDirectory(home,chatId);
  return {...directory,chatId,title:chat.title,projectFilesPreserved:Boolean(chat.projectId)};
}
export function stageChatFiles(state, ids, options={}) {
  state.chatWorkspaceRetentions ||= [];
  for(const chatId of ids) {
    const chat=state.chats.find(c=>c.id===chatId);
    if(state.chatWorkspaceRetentions.some(r=>r.chatId===chatId)) continue;
    state.chatWorkspaceRetentions.push({chatId,title:chat?.title || chatId,decision:options.fileDecision || 'pending',token:options.workspaceToken || null,deletedAt:new Date().toISOString()});
  }
}
export async function listChatFiles() {
  const home=currentRequestContext().home,state=await loadState({home});
  // Validate parent components before enumerating; never scan a linked folder.
  await ownedChatDirectory(home,'__directory_check__');
  const entries=await readdir(join(home,'workspaces','chats'),{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  const records=new Map((state.chatWorkspaceRetentions || []).map(r=>[r.chatId,r]));
  for(const entry of entries) if(!state.chats.some(c=>c.id===entry.name) && !records.has(entry.name)) records.set(entry.name,{chatId:entry.name,title:entry.name,decision:'pending'});
  const result=[];
  for(const record of records.values()) {
    if(state.chats.some(c=>c.id===record.chatId)) continue;
    try {const directory=await ownedChatDirectory(home,record.chatId);if(directory.exists) result.push({...record,...directory});}
    catch(error) {result.push({...record,exists:false,error:error.message});}
  }
  return {directories:result};
}
export async function decideChatFiles({chatId,decision,token}) {
  if(!['keep','delete'].includes(decision)) throw workspaceError('FILE_DECISION_REQUIRED','请选择保留文件或同时删除文件。');
  const home=currentRequestContext().home;
  // Serialize with new runs, sync imports and other local deletion decisions.
  await updateStateAtomically(async state=>{
    if(state.chats.some(c=>c.id===chatId) || state.chatRuns?.some(r=>r.chatId===chatId && r.status==='running')) throw workspaceError('CHAT_ACTIVE','对话仍存在，不能单独清理它的文件。');
    const directory=await ownedChatDirectory(home,chatId);
    if(directory.token!==token) throw workspaceError('WORKSPACE_CHANGED','文件目录已变化，请刷新后重新确认。');
    state.chatWorkspaceRetentions ||= [];
    let record=state.chatWorkspaceRetentions.find(r=>r.chatId===chatId);
    if(!record) state.chatWorkspaceRetentions.push(record={chatId,title:chatId,deletedAt:new Date().toISOString()});
    if(decision==='delete' && directory.exists) {
      // Move first, then verify identity, before recursively removing anything.
      // rm does not follow child symlinks. A failed cleanup remains discoverable.
      const destination=join(await realpath(home),'workspaces','chats',`deleted_${chatId}_${randomUUID()}`);
      await rename(directory.rootPath,destination);
      const moved=await lstat(destination);
      if(moved.isSymbolicLink() || `${moved.dev}:${moved.ino}`!==token) throw workspaceError('WORKSPACE_CHANGED',`文件目录已变化，已保留在 ${destination}`);
      try {await rm(destination,{recursive:true});} catch(error) {record.cleanupPath=destination;record.error=error.message;}
    }
    record.decision=decision==='delete'?'deleted':decision;record.token=token;
  },{home});
  return listChatFiles();
}
export async function finishChatFileDeletions(home) {
  const state=await loadState({home});
  for(const record of state.chatWorkspaceRetentions || []) if(record.decision==='delete' && !state.chats.some(c=>c.id===record.chatId)) {
    try {await decideChatFiles({chatId:record.chatId,decision:'delete',token:record.token});} catch(error) {console.warn(`Chat files retained: ${error.message}`);}
  }
}
export async function openChatFiles({chatId,retained=false}) {
  const home=currentRequestContext().home,state=await loadState({home});
  const chat=state.chats.find(c=>c.id===chatId);
  if(!chat && !retained) throw workspaceError('CHAT_NOT_FOUND','对话不存在。');
  if(chat && retained) throw workspaceError('CHAT_ACTIVE','请从对话打开文件。');
  const directory=chat?await chatWorkspaceStatus(state,chat,home):await ownedChatDirectory(home,chatId);
  if(!directory.rootPath || !await lstat(directory.rootPath).catch(()=>null)) throw workspaceError('WORKSPACE_UNAVAILABLE','文件目录尚未创建。');
  if(process.platform!=='darwin') throw workspaceError('OPEN_UNAVAILABLE','请使用显示的文件路径在文件管理器中打开。');
  await promisify(execFile)('/usr/bin/open',[directory.rootPath]);
  return {ok:true};
}
