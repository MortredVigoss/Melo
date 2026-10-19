import {execFileSync} from 'node:child_process';
import {resolvePermission} from '../../tools/permissions.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access,readFile,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequestContext} from '../../runtime/requestContext.js';
import {runWithRequestContext} from '../../runtime/requestScope.js';
import {PROJECT_DIR} from '../../runtime/paths.js';
import {updateStateAtomically,readStateSnapshot} from '../../state/stateStore.js';
import {createChat} from '../chat/chatMutations.js';
import {createTask} from '../task/taskMutations.js';
import {createApproval} from '../approval/approvalMutations.js';
import {createProject,updateProject} from '../project/projectMutations.js';
import {buildProjectContextSection} from '../project/projectContext.js';
import {buildWorkspaceSnapshot} from './workspaceSnapshot.js';
import {beginChatRun} from '../chat/turnLedger.js';
import {executeTool} from '../../tools/executor.js';
import {bashTool} from '../../tools/builtins/bashTool.js';
import {fileWriteTool} from '../../tools/builtins/fileWriteTool.js';
import {resolveFileSafety} from '../../safety/fileSafetyGate.js';
import {scopeMatches} from '../../safety/permissionContext.js';
async function fixture(t,work){
 const home=await mkdtemp(join(tmpdir(),'melo-project-r1-'));t.after(()=>rm(home,{recursive:true,force:true}));
 return runWithRequestContext(createRequestContext({home}),async()=>{
  await updateStateAtomically(s=>{s.projects=[{id:'a',name:'A',workspacePath:home},{id:'b',name:'B',workspacePath:home},{id:'deleted',name:'Deleted',deletedAt:'2026-01-01T00:00:00.000Z',workspacePath:home}];s.chats=[];s.tasks=[];s.approvals=[];s.settings.selectedProjectId='a';s.settings.selectedChatId=null;});
  return work(home);
 });
}
async function turn(home,chatId,requestId='turn'){
 const context=createRequestContext({home,chatId,requestId});const {turnBinding}=await beginChatRun({chatId,content:'test'},context);return {...context,turnBinding,capabilityScope:turnBinding.capabilityScope};
}
const allow=(event,payload)=>{if(event==='tool_permission'){resolveFileSafety(payload.requestId,'once');resolvePermission(payload.requestId,true);}};
test('creation is explicit: null/omitted stay unassigned; unknown/deleted are rejected',t=>fixture(t,async home=>{
 for(const create of [createChat,createTask,createApproval]){
  for(const projectId of [undefined,null])await create({projectId});
  for(const projectId of ['missing','deleted'])await assert.rejects(create({projectId}),/项目|Project/);
 }
 const s=await readStateSnapshot({home});assert.ok([...s.chats,...s.tasks,...s.approvals].every(row=>row.projectId===null));
}));
test('parallel chats retain their requested project; task and approval inherit the explicit chat',t=>fixture(t,async home=>{
 await Promise.all([createChat({projectId:'a',agentId:'main'}),createChat({projectId:'b',agentId:'research'})]);
 let s=await readStateSnapshot({home});assert.equal(s.chats.find(c=>c.agentId==='main').projectId,'a');const child=s.chats.find(c=>c.agentId==='research');assert.equal(child.projectId,'b');
 await createTask({chatId:child.id,projectId:'a'});await createApproval({chatId:child.id,projectId:'a'});s=await readStateSnapshot({home});assert.equal(s.tasks[0].projectId,'b');assert.equal(s.approvals[0].projectId,'b');
}));
test('idle unassigned chat has no workspace; first pwd/write uses a private persistent chat directory',t=>fixture(t,async home=>{
 const b=await createChat({projectId:null});const id=b.activeChat.id;const expected=join(home,'workspaces','chats',id);
 assert.equal((await buildWorkspaceSnapshot(await readStateSnapshot({home}),null)).rootPath,null);await assert.rejects(access(expected));
 const context=await turn(home,id);const pwd=await runWithRequestContext(context,()=>executeTool(bashTool,{command:'pwd'},{sseEmitter:allow}));assert.equal(pwd.ok,true,pwd.output);assert.equal(resolve(pwd.output.replace(/^stdout:\s*/, '').trim()),resolve(await import('node:fs/promises').then(fs=>fs.realpath(expected))));
 const written=await runWithRequestContext(context,()=>executeTool(fileWriteTool,{path:'proof.txt',content:'isolated'},{sseEmitter:allow}));assert.equal(written.ok,true,written.output);assert.equal(await readFile(join(expected,'proof.txt'),'utf8'),'isolated');
 assert.equal((await stat(expected)).mode&0o777,0o700);assert.equal((await readStateSnapshot({home})).chats.find(c=>c.id===id).workspacePath,expected);
 const cold=execFileSync(process.execPath,['--input-type=module','-e',"import {readStateSnapshot} from './src/state/stateStore.js';const s=await readStateSnapshot();process.stdout.write(JSON.stringify(s.chats.map(c=>({id:c.id,workspacePath:c.workspacePath}))));"],{env:{...process.env,MELO_HOME:home},encoding:'utf8'});assert.equal(JSON.parse(cold).find(c=>c.id===id).workspacePath,expected);
 assert.notEqual(expected,PROJECT_DIR);assert.equal(scopeMatches({role:'main',project:null,workspace:{path:PROJECT_DIR}},{role:'main',project:null,workspace:{path:expected}}),false);
}));
test('legacy program workspace is blocked before execution and can be explicitly confirmed',t=>fixture(t,async home=>{
 await updateStateAtomically(s=>{s.projects[0].workspacePath=PROJECT_DIR;});const b=await createChat({projectId:'a'});let ran=0;
 const tool={id:'file_write',requiresPermission:false,run:async()=>{ran++;return{ok:true,output:'ok'};}};
 const blocked=await runWithRequestContext(await turn(home,b.activeChat.id),()=>executeTool(tool,{}, {workspacePath:PROJECT_DIR}));assert.equal(blocked.error,'WORKSPACE_CONFIRMATION_REQUIRED');assert.equal(ran,0);
 await updateProject('a',{confirmWorkspace:true});const accepted=await runWithRequestContext(await turn(home,b.activeChat.id,'confirmed'),()=>executeTool(tool,{}));assert.equal(accepted.ok,true,accepted.output);assert.equal(ran,1);
}));
test('empty project text stays empty; exact legacy placeholders are hidden without rewriting stored text',t=>fixture(t,async home=>{
 const fresh=await createProject({name:'New'});assert.equal(fresh.project.summary,'');assert.equal(fresh.project.instructions,'');
 const freshView=(await (await import('../desktop/bootstrap.js')).getDesktopBootstrap()).activeProject;assert.equal(freshView.id,fresh.project.id);assert.equal(freshView.summary,'');assert.equal(freshView.instructions,'');
 const old={summary:'归拢相关对话、资料与目标。',instructions:'Keep this project focused, actionable, and easy to continue later.'};
 await updateStateAtomically(s=>{Object.assign(s.projects.find(p=>p.id==='a'),old);});
 const {getDesktopBootstrap}=await import('../desktop/bootstrap.js');const view=await getDesktopBootstrap();assert.equal(view.projects.find(p=>p.id==='a').summary,'');
 const stored=(await readStateSnapshot({home})).projects.find(p=>p.id==='a');assert.equal(stored.summary,old.summary);assert.equal(stored.instructions,old.instructions);
 const prompt=buildProjectContextSection(stored,{});assert.doesNotMatch(prompt,/Summary:|Instructions:|归拢相关|Keep this project/);
 assert.match(buildProjectContextSection({...stored,summary:old.summary+' '},{}),/归拢相关/);
}));
test('chat allocation rejects a substituted workspace parent before executing or creating outside files',t=>fixture(t,async home=>{
 const outside=await mkdtemp(join(tmpdir(),'melo-r1-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
 const b=await createChat({projectId:null});await symlink(outside,join(home,'workspaces'));
 let ran=0;const result=await runWithRequestContext(await turn(home,b.activeChat.id),()=>executeTool({id:'file_write',run:async()=>{ran++;return{ok:true};}},{},{workspacePath:PROJECT_DIR}));
 assert.equal(result.error,'WORKSPACE_UNAVAILABLE');assert.equal(result.meta.executionStarted,false);assert.equal(ran,0);await assert.rejects(access(join(outside,'chats')));
}));
test('an explicit project remains the execution directory even when caller supplies a different directory',t=>fixture(t,async home=>{
 const b=await createChat({projectId:'b'});let actual;
 const result=await runWithRequestContext(await turn(home,b.activeChat.id),()=>executeTool({id:'file_read',requiresPermission:false,run:async(_,ctx)=>{actual=ctx.workspacePath;return{ok:true,output:'ok'};}},{},{workspacePath:PROJECT_DIR}));
 assert.equal(result.ok,true);assert.equal(actual,home);
}));
test('direct local tools never fall back to the process directory',async()=>{
 const definitions=[['bash','bash',{command:'pwd'}],['fileRead','fileRead',{path:'package.json'}],['fileWrite','fileWrite',{path:'r1.txt',content:'x'}],['fileEdit','fileEdit',{path:'r1.txt',old_string:'x',new_string:'y'}],['fileDelete','fileDelete',{paths:['r1.txt']}],['fileMove','fileMove',{src:'r1.txt',dst:'r2.txt'}],['fileMkdir','fileMkdir',{path:'r1-dir'}],['glob','glob',{pattern:'*'}],['grep','grep',{pattern:'x'}],['image','image',{action:'info',path:'image.png'}],['pdf','pdf',{action:'read',path:'file.pdf'}],['xlsx','xlsx',{path:'table.xlsx'}]];
 for(const [file,name,args] of definitions){
  const module=await import(`../../tools/builtins/${file}Tool.js`);let prompts=0;
  const result=await module[`${name}Tool`].run(args,{sseEmitter:()=>prompts++});
  assert.equal(result.error,'WORKSPACE_REQUIRED',file+': '+result.output);assert.equal(result.meta.executionStarted,false);assert.equal(prompts,0);
 }
});

test('owned workspace writes do not exempt app state, siblings, roots, or escaped real targets',t=>fixture(t,async home=>{
 const b=await createChat({projectId:null});const id=b.activeChat.id;let checks;
 const {classifyPath}=await import('../../safety/sensitivePaths.js');
 const result=await runWithRequestContext(await turn(home,id),()=>executeTool({id:'file_write',requiresPermission:false,run:async(_,ctx)=>{
   checks=[classifyPath(join(ctx.workspacePath,'file.txt')),classifyPath(ctx.workspacePath),classifyPath(join(home,'config.json')),classifyPath(join(home,'workspaces','chats','other','file.txt'))];
   return {ok:true,output:'checked'};
 }},{}));assert.equal(result.ok,true);assert.deepEqual(checks,['safe','melo_internal','melo_internal','melo_internal']);
 await symlink(join(home,'desktop'),join(home,'workspaces','chats',id,'escape'));
 const blocked=await runWithRequestContext(await turn(home,id,'escape'),()=>executeTool(fileWriteTool,{path:'escape/evil.txt',content:'no'},{sseEmitter:allow}));assert.equal(blocked.ok,false);assert.match(blocked.output,/blocked|拒绝/i);await assert.rejects(access(join(home,'desktop','evil.txt')));
}));
