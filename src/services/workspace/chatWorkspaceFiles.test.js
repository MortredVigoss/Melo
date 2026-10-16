import {updateDesktopSettings} from '../settings/desktopSettings.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,rm,symlink,rename,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequestContext} from '../../runtime/requestContext.js';
import {runWithRequestContext} from '../../runtime/requestScope.js';
import {loadState,updateStateAtomically} from '../../state/stateStore.js';
import {ownedChatDirectory,previewChatDeletion,listChatFiles,decideChatFiles,finishChatFileDeletions} from './chatWorkspaceFiles.js';
import {buildWorkspaceSnapshot} from './workspaceSnapshot.js';
import {readWorkspaceFile,writeWorkspaceFile} from './workspaceFiles.js';
import {stageChatDeletion,assertChatDeletable} from '../chat/chatDeletion.js';
import {deleteChat} from '../chat/chatMutations.js';

async function fixture(t,fn) {
 const home=await mkdtemp(join(tmpdir(),'melo-chat-files-'));t.after(()=>rm(home,{recursive:true,force:true}));
 return runWithRequestContext(createRequestContext({home}),async()=>{
  await updateStateAtomically(s=>{s.chats=[{id:'a',title:'Output',messages:[],mode:'chat',projectId:null}];s.settings.selectedChatId='a';},{home});
  const path=join(home,'workspaces','chats','a');
  const create=async()=>{await mkdir(path,{recursive:true});await writeFile(join(path,'result.txt'),'preserve');};
  await fn({home,path,create});
 });
}
test('chat snapshot follows chat, never creates a directory, and previews existing output',t=>fixture(t,async({home,path,create})=>{
 let state=await loadState({home});state.projects=[{id:'p',workspacePath:home}];
 assert.equal((await buildWorkspaceSnapshot(state,state.projects[0],{chat:state.chats[0],home})).exists,false);
 await assert.rejects(lstat(path),{code:'ENOENT'});
 await create();state.chats[0].workspacePath=await realpath(path);const snapshot=await buildWorkspaceSnapshot(state,state.projects[0],{chat:state.chats[0],home});
 assert.equal(snapshot.chatId,'a');assert.equal(snapshot.selectedFile.content,'preserve');assert.equal(snapshot.projectId,null);
}));
test('local deletion requires file choice and stale destructive confirmation has no effect',t=>fixture(t,async({home,path,create})=>{
 await create();await assert.rejects(deleteChat('a'),{code:'FILE_DECISION_REQUIRED'});
 assert.equal((await loadState({home})).chats.length,1);
 await assert.rejects(deleteChat('a',{fileDecision:'delete',workspaceToken:'wrong'}),{code:'WORKSPACE_CHANGED'});
 assert.equal(await readFile(join(path,'result.txt'),'utf8'),'preserve');
}));
test('remote tombstone preserves files; persisted pending decision supports keep then explicit delete',t=>fixture(t,async({home,path,create})=>{
 await create();await updateStateAtomically(s=>{stageChatDeletion(s,['a']);s.chats=[];},{home});
 await finishChatFileDeletions(home);
 let record=(await listChatFiles()).directories[0];assert.equal(record.decision,'pending');
 await decideChatFiles({chatId:'a',decision:'keep',token:record.token});
 assert.equal((await loadState({home})).chatWorkspaceRetentions[0].decision,'keep');
 assert.equal(await readFile(join(path,'result.txt'),'utf8'),'preserve');
 await decideChatFiles({chatId:'a',decision:'delete',token:record.token});
 await assert.rejects(lstat(path),{code:'ENOENT'});assert.deepEqual((await listChatFiles()).directories,[]);
}));
test('cleanup refuses live chats, running jobs, replaced directories and symlinks',t=>fixture(t,async({home,path,create})=>{
 await create();const preview=await previewChatDeletion('a');
 await assert.rejects(decideChatFiles({chatId:'a',decision:'delete',token:preview.token}),{code:'CHAT_ACTIVE'});
 await updateStateAtomically(s=>{stageChatDeletion(s,['a']);s.chats=[];},{home});

 await rename(path,path+'-old');await mkdir(path);
 await assert.rejects(decideChatFiles({chatId:'a',decision:'delete',token:preview.token}),{code:'WORKSPACE_CHANGED'});
 await rm(path,{recursive:true});await symlink(path+'-old',path);
 await assert.rejects(ownedChatDirectory(home,'a'),{code:'WORKSPACE_CHANGED'});
 assert.equal(await readFile(join(path+'-old','result.txt'),'utf8'),'preserve');
}));
test('historical orphans are discoverable and outside file symlinks cannot be previewed',t=>fixture(t,async({home,path,create})=>{
 await create();await writeFile(join(home,'private.txt'),'private');await symlink(join(home,'private.txt'),join(path,'linked.txt'));
 await assert.rejects(readWorkspaceFile(path,'linked.txt'),/escapes/);
 await assert.rejects(writeWorkspaceFile(path,'linked.txt','overwrite'));
 await symlink(home,join(path,'parent-link'));await assert.rejects(writeWorkspaceFile(path,'parent-link/private.txt','overwrite'));
 assert.equal(await readFile(join(home,'private.txt'),'utf8'),'private');
 await updateStateAtomically(s=>{s.chats=[];},{home});assert.equal((await listChatFiles()).directories[0].chatId,'a');
}));

test('a running approval prevents deleting its chat while files are being written',()=>{assert.throws(()=>assertChatDeletable({chatRuns:[],approvals:[{chatId:'a',status:'running'}]},{id:'a'}),/执行/);});

test('all settings-based chat entry points select the chat project rather than the previously viewed project',t=>fixture(t,async({home})=>{await updateStateAtomically(s=>{s.projects=[{id:'old',name:'Old',workspacePath:home}];s.settings.selectedProjectId='old';},{home});const result=await updateDesktopSettings({selectedChatId:'a',activeView:'chat'});assert.equal(result.settings.selectedProjectId,null);}));
