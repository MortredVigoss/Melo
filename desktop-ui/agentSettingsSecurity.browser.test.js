import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {launchTestChrome} from '../src/testSupport/testChrome.js';
import {putWorkspace,stableJSON} from '../mobile-sync/workspaceProtocol.js';

test('sync token cannot approve capability grants; only explicit desktop approval survives cold restart', {timeout:60000},async t=>{
 const home=await mkdtemp(join(tmpdir(),'melo-capability-confirm-')),token='fixture-settings-secret-'.repeat(3);
 let child,closed,base,browser;
 async function stop(){if(!child)return;const timer=setTimeout(()=>child.kill('SIGKILL'),3000);child.kill('SIGTERM');await closed;clearTimeout(timer);child=null;}
 t.after(async()=>{await browser?.close();await stop();await rm(home,{recursive:true,force:true});});
 async function start(){
  child=spawn(process.execPath,['src/server.js','--host','127.0.0.1','--port','0'],{env:{...process.env,MELO_HOME:home,MELO_SYNC_TOKEN:token,MELO_TEST_MODE:'1',MELO_DREAMING_ENABLED:'0',MELO_MEMORY_RUNTIME:'0'},stdio:['ignore','pipe','pipe']});closed=once(child,'exit');
  base=await new Promise((resolve,reject)=>{let log='';const timeout=setTimeout(()=>reject(new Error(log.slice(-2000))),15000);child.stderr.on('data',s=>log+=s);child.stdout.on('data',s=>{log+=s;const match=log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});child.once('exit',()=>{clearTimeout(timeout);reject(new Error(log.slice(-2000)));});});
 }
 async function request(path,body,{auth=false,origin}={}){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer '+token}:{}),...(origin?{origin}: {})},body:body?JSON.stringify(body):undefined});return r;}
 async function boot(){return (await request('/api/bootstrap')).json();}
 const profile=b=>b.customize.agents.find(p=>p.id==='research');
 await start();
 const current=profile(await boot());assert.equal(current.capabilities.runCommands,false);
 await request('/api/settings',{activeView:'agent',selectedAgentId:'research'});
 const workspace=await (await request('/api/agent-settings-sync',null,{auth:true})).json();
 const row=workspace.records.find(row=>JSON.parse(row.versions[0].value.content).agentId==='research');
 const value=JSON.parse(row.versions[0].value.content);value.capabilities.runCommands=true;value.capabilities.readFiles=false;value.capabilities.mcpServers=['unapproved-server'];
 putWorkspace(workspace,'knowledge',row.id,{...row.versions[0].value,content:stableJSON(value)},'phone');
 assert.equal((await request('/api/agent-settings-sync',workspace,{auth:true})).status,200);
 let updated=profile(await boot());assert.equal(updated.capabilities.runCommands,false);assert.equal(updated.capabilities.readFiles,false);assert.deepEqual(updated.capabilities.mcpServers,[]);assert.ok(updated.pendingCapabilityChange);
 const body={id:updated.pendingCapabilityChange.id,expected:updated.pendingCapabilityChange.fingerprint,accept:true};
 assert.equal((await request('/api/agent-settings-sync/confirm',body,{auth:true,origin:base})).status,403);
 assert.equal((await request('/api/agent-settings-sync/confirm',body)).status,403);
 assert.equal((await request('/api/agent-settings-sync/confirm',{...body,expected:'stale'},{origin:base})).status,409);
 await stop();await start();updated=profile(await boot());assert.equal(updated.capabilities.runCommands,false);assert.ok(updated.pendingCapabilityChange);
 assert.equal((await request('/api/settings',{activeView:'agent',selectedAgentId:'research'})).status,200);
 browser=await launchTestChrome(chromium);
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
 await page.getByText('同步权限变更待桌面确认',{exact:true}).first().waitFor();
 const confirm=page.locator('[data-action="confirm-agent-settings"][data-accept="true"]').first();
 assert.equal(await confirm.isEnabled(),true);
 const form=page.locator('form[data-form=agent-profile-update]').first();
 await form.locator('[data-action=form-settings-edit]').click();
 assert.equal(await confirm.isEnabled(),false,'Do not apply a remote proposal over an editing draft');
 await form.locator('[data-action=form-settings-cancel]').click();
 assert.equal(await confirm.isEnabled(),true);
 await confirm.click();
 await page.waitForFunction(()=>!document.querySelector('[data-action="confirm-agent-settings"]'));
 updated=profile(await boot());assert.equal(updated.capabilities.runCommands,true);assert.deepEqual(updated.capabilities.mcpServers,['unapproved-server']);assert.equal(updated.pendingCapabilityChange,null);
 assert.deepEqual(errors,[]);await browser.close();browser=null;await stop();await start();
 assert.equal(profile(await boot()).capabilities.runCommands,true);
});
