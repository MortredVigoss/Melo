import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {createServer} from 'node:http';

test('chat files, explicit deletion decisions and management actions work through the desktop UI', {timeout:120000}, async t=>{
 const home=await mkdtemp(join(tmpdir(),'melo-file-ui-'));let browser;
 const proof='.tmp/ui-function-alignment-20261016/screenshots';await mkdir(proof,{recursive:true});
 const child=spawn(process.execPath,['src/server.js','--host','127.0.0.1','--port','0'],{env:{...process.env,MELO_HOME:home,MELO_TEST_MODE:'1',MELO_MEMORY_RUNTIME:'0',MELO_DREAMING_ENABLED:'0'},stdio:['ignore','pipe','pipe']});
 const closed=once(child,'exit');
 let invocations=0;
 const external=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;res.setHeader('content-type','application/json');
  if(req.url==='/manifest')res.end(JSON.stringify({tools:[{name:'echo',id:'echo'}],resources:[{id:'readme',name:'Readme'}],prompts:[{id:'help',name:'Help'}]}));
  else if(req.url==='/invoke'){invocations++;res.end(JSON.stringify({output:'fixture tool result'}));}
  else res.end(JSON.stringify({ok:true,content:'fixture resource',prompt:'fixture prompt'}));
 });external.listen(0,'127.0.0.1');await once(external,'listening');
 t.after(async()=>{await browser?.close();external.close();child.kill('SIGTERM');await closed;await rm(home,{recursive:true,force:true});});
 const base=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(Error('Startup timeout')),15000);child.stdout.on('data',chunk=>{log+=chunk;const m=log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});child.once('exit',()=>{clearTimeout(timer);reject(Error('Server exited'));});});
 const post=async(path,body,status=200)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;};
 const boot=async()=>(await fetch(base+'/api/bootstrap')).json();
 const created=await post('/api/chats',{projectId:null,mode:'chat'}),chatId=created.activeChat.id;
 const path=join(home,'workspaces','chats',chatId);await mkdir(path,{recursive:true});await writeFile(join(path,'result.txt'),'visible output');
 // Retired direct endpoints cannot write a sentinel or run a command.
 for(const route of ['/api/workspace/save-file','/api/artifacts/apply','/api/command/run'])await post(route,{filePath:'blocked.txt',content:'blocked',projectId:null,chatId,templateId:'list-files'},410);
 await assert.rejects(access(join(path,'blocked.txt')));
 // The supported approval route binds an unassigned chat to its actual folder.
 const pending=await post('/api/approvals',{kind:'file-save',title:'Save fixture',chatId,payload:{filePath:'approved.txt',content:'approved output'}});
 const approval=pending.approvals.find(a=>a.title==='Save fixture');await post('/api/approvals/execute',{approvalId:approval.id});
 assert.equal(await readFile(join(path,'approved.txt'),'utf8'),'approved output');
 await post('/api/settings',{activeMode:'chat',activeView:'chat',selectedChatId:chatId});
 browser=await chromium.launch({executablePath:process.env.MELO_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',async r=>{if(r.url().includes('/api/workspace/select-file'))t.diagnostic('select '+r.status());});await page.goto(base);
 const files=page.locator('.chat-files-panel');await files.waitFor();await files.locator('summary').click();await files.locator('[data-file-path="result.txt"]').click();await files.locator('pre').filter({hasText:'visible output'}).waitFor({timeout:10000}).catch(async error=>{t.diagnostic(JSON.stringify({errors,html:await files.innerHTML(),open:await files.getAttribute('open'),selected:(await boot()).workspace.selectedFilePath,body:(await page.locator('body').innerText()).slice(-1800)}));throw error;});
 assert.equal(await files.locator('[data-action=open-chat-files]').count(),1);await page.screenshot({path:join(proof,'chat-files.png')});
 const remove=page.locator('[data-action=delete-active-chat]');await remove.click();let dialog=page.locator('dialog[open]');await page.screenshot({path:join(proof,'delete-choice.png')});await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.ok((await boot()).chats.some(c=>c.id===chatId));
 await remove.click();await dialog.getByRole('button',{name:'删除对话，保留文件',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('dialog[open]'));assert.equal(await readFile(join(path,'result.txt'),'utf8'),'visible output');
 const advanced=async()=>{await post('/api/settings',{activeView:'customize',selectedCustomizeSection:'advanced'});await page.reload();await page.locator('[data-action=manage-session-permissions]').waitFor();};
 await advanced();await page.locator('[data-action=decide-retained-files]').click();await dialog.getByRole('button',{name:'删除文件',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('dialog[open]'));await page.waitForFunction(()=>!document.querySelector('[data-action=decide-retained-files]'));await assert.rejects(access(path));
 // Direct simultaneous deletion also removes only the owned chat folder.
 const next=await post('/api/chats',{projectId:null,mode:'chat'}),nextId=next.activeChat.id,nextPath=join(home,'workspaces','chats',nextId);await mkdir(nextPath,{recursive:true});await writeFile(join(nextPath,'proof.txt'),'owned');
 await page.reload();await remove.click();await dialog.getByRole('button',{name:'同时删除文件',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('dialog[open]'));await assert.rejects(access(nextPath));
 // Connector CRUD and real loopback manifest/tool requests.
 await advanced();await page.locator('details.quality-details>summary').filter({hasText:'扩展与连接管理'}).click();await page.locator('[data-action=manage-new-connector]').click();
 await dialog.locator('[name=name]').fill('Fixture connector');await dialog.locator('[name=endpoint]').fill(`http://127.0.0.1:${external.address().port}`);await dialog.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
 await advanced();await page.locator('details.quality-details>summary').filter({hasText:'扩展与连接管理'}).click();await page.locator('[data-action=ping-connector]').click();
 await page.waitForFunction(()=>document.querySelector('[data-action=manage-invoke-connector]'));
 await page.locator('[data-action=manage-invoke-connector]').click();await dialog.locator('[name=id] option').first().waitFor({state:'attached'});await dialog.getByRole('button',{name:'执行',exact:true}).click();await dialog.locator('[role=status]').filter({hasText:'fixture tool result'}).waitFor();assert.equal(invocations,1);await dialog.getByRole('button',{name:'关闭',exact:true}).click();
 await page.locator('[data-action=manage-resource-connector]').click();await dialog.getByRole('button',{name:'执行',exact:true}).click();await dialog.locator('[role=status]').filter({hasText:'fixture resource'}).waitFor();await dialog.getByRole('button',{name:'关闭',exact:true}).click();
 await page.locator('[data-action=manage-edit-connector]').click();await dialog.locator('[name=name]').fill('Connector updated');await dialog.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('dialog[open]'));assert.ok((await boot()).customize.connectors.some(c=>c.name==='Connector updated'));
 await advanced();await page.locator('details.quality-details>summary').filter({hasText:'扩展与连接管理'}).click();await page.locator('[data-action=manage-remove-connector]').click();await dialog.getByRole('button',{name:'确认删除',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('dialog[open]'));assert.equal((await boot()).customize.connectors.some(c=>c.name==='Connector updated'),false);
 // Skills import/promote/reload use the real local state and disk.
 await post('/api/settings',{activeView:'customize',selectedCustomizeSection:'skills'});await page.reload();
 await page.locator('[data-action=manage-import-skill]').click();await dialog.locator('[name=file]').setInputFiles({name:'SKILL.md',mimeType:'text/markdown',buffer:Buffer.from('---\nname: ui-fixture-skill\ndescription: Local fixture\n---\nDo fixture work.\n')});
 await dialog.getByRole('button',{name:'导入',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
 const imported=(await boot()).customize.skills.find(s=>s.name==='ui-fixture-skill' || s.id==='ui-fixture-skill');assert.ok(imported);
 await page.locator('[data-action=manage-promote-skill]').waitFor({timeout:10000}).catch(async error=>{const snapshot=await boot();t.diagnostic(JSON.stringify({selectedSkill:snapshot.settings.selectedSkillId,imported,errors,body:(await page.locator('body').innerText()).slice(-4000)}));throw error;});
 await page.locator('[data-action=manage-promote-skill]').click();await dialog.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
 await page.locator('[data-action=manage-reload-skills]').click();
 assert.ok((await boot()).customize.skills.find(s=>s.id===imported.id));
 assert.match(await readFile(join(home,'desktop','skills',imported.id,'SKILL.md'),'utf8'),/Do fixture work/);
 const permissionChat=await post('/api/chats',{projectId:null,mode:'chat'});
 await advanced();await page.locator('[data-action=manage-session-permissions]').click();await dialog.getByRole('button',{name:'查看授权',exact:true}).click();await dialog.locator('[role=status]').filter({hasText:'allow'}).waitFor();
 const revoked=page.waitForRequest(r=>r.url().includes('/api/tools/session-permissions/clear'));
 await dialog.getByRole('button',{name:'撤销此对话的临时授权',exact:true}).click();assert.equal(new URL((await revoked).url()).searchParams.get('chatId'),permissionChat.activeChat.id);
 await dialog.getByRole('button',{name:'关闭',exact:true}).click();
 await post('/api/mcp/connect',{name:'unknown-fixture'},400);
 assert.deepEqual(errors,[]);
});
