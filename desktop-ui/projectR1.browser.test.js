import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';

test('project launch uses one POST; returning home clears membership; source-folder confirmation is explicit', {timeout:60000},async t=>{
 const home=await mkdtemp(join(tmpdir(),'melo-project-browser-'));let browser;
 const child=spawn(process.execPath,['src/server.js','--host','127.0.0.1','--port','0'],{env:{...process.env,MELO_HOME:home,MELO_TEST_MODE:'1',MELO_DREAMING_ENABLED:'0',MELO_MEMORY_RUNTIME:'0'},stdio:['ignore','pipe','pipe']});const closed=once(child,'exit');
 t.after(async()=>{await browser?.close();const timer=setTimeout(()=>child.kill('SIGKILL'),3000);child.kill('SIGTERM');await closed;clearTimeout(timer);await rm(home,{recursive:true,force:true});});
 const base=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(new Error(log.slice(-2000))),15000);child.stderr.on('data',s=>log+=s);child.stdout.on('data',s=>{log+=s;const m=log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});child.once('exit',()=>{clearTimeout(timer);reject(new Error(log.slice(-2000)));});});
 async function api(path,body){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',origin:base},body:body?JSON.stringify(body):undefined});assert.equal(response.status,200,await response.clone().text());return response.json();}
 const created=await api('/api/projects',{name:'Workspace test',workspacePath:resolve('.')});const id=created.activeProject.id;
 browser=await chromium.launch({executablePath:process.env.MELO_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
 const form=page.locator('form[data-form=project-update]');await form.waitFor();const confirm=form.locator('[name=confirmWorkspace]');assert.equal(await confirm.isChecked(),false);assert.equal((await api('/api/bootstrap')).workspace.rootPath,null);
 await form.locator('[data-action=form-settings-edit]').click();await confirm.check();await form.locator('[data-action=form-settings-save]').click();await page.waitForFunction(()=>!document.querySelector('[name=confirmWorkspace]'));
 assert.equal((await api('/api/bootstrap')).workspace.rootPath,resolve('.'));
 const posts=[];page.on('request',r=>{if(r.method()==='POST')posts.push(new URL(r.url()).pathname);});
 await page.locator('[data-action=chat-from-project]').click();await page.waitForFunction(()=>!!document.querySelector('[data-action=new-chat]'));
 await page.waitForTimeout(200);let boot=await api('/api/bootstrap');assert.equal(boot.activeChat.projectId,id);assert.deepEqual(posts,['/api/chats']);
 await page.locator('[data-action=new-chat]').first().click();await page.waitForTimeout(200);
 await page.keyboard.press('Meta+k');
 const newChatResponse=page.waitForResponse(r=>r.url().endsWith('/api/chats') && r.request().method()==='POST');
 await page.locator('#command-palette-input').press('Enter');
 assert.equal((await newChatResponse).status(),200);boot=await api('/api/bootstrap');assert.ok(boot.activeChat);assert.equal(boot.activeChat.projectId,null);
 assert.deepEqual(errors,[]);
});
