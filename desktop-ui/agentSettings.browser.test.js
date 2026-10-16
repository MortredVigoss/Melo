import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';

test('Agent editor: visible creation, shared routes, saved capabilities/channels and responsive layout', {timeout:90000}, async t=>{
  const home=await mkdtemp(join(tmpdir(),'melo-agent-settings-'));
  const child=spawn(process.execPath,['src/server.js','--host','127.0.0.1','--port','0'],{env:{...process.env,MELO_HOME:home,MELO_TEST_MODE:'1',MELO_MEMORY_RUNTIME:'0',MELO_DREAMING_ENABLED:'0'},stdio:['ignore','pipe','pipe']});
  const closed=once(child,'exit');let browser;
  t.after(async()=>{await browser?.close();child.kill('SIGTERM');await closed;await rm(home,{recursive:true,force:true});});
  const base=await new Promise((resolve,reject)=>{
    let log='';const timer=setTimeout(()=>reject(new Error('Server startup timed out')),15000);
    child.stdout.on('data',chunk=>{log+=chunk;const match=log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Server exited before startup'));});
  });
  const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
  const boot=async()=> (await fetch(base+'/api/bootstrap')).json();
  await post('/api/agents/update',{agentId:'research',patch:{mood:'sharp',instructions:'Keep my own warm writing style.',model:'fixture-model'}});
  const initial=(await boot()).customize.agents.find(a=>a.id==='research');
  await post('/api/settings',{activeView:'customize',selectedCustomizeSection:'agents',selectedAgentId:'research'});
  browser=await chromium.launch({executablePath:process.env.MELO_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
  const form=page.locator('form[data-form=agent-profile-update]');await form.waitFor();
  assert.equal(await form.count(),1);
  assert.equal(await page.locator('[name=mood],[data-action=set-agent-mood],.agent-selector-mood,[name=tools],[data-action=import-agent-preset]').count(),0);
  assert.equal(await form.locator('[name=instructions]').inputValue(),initial.instructions,'User-authored style survives');
  assert.equal(await form.locator('[name=model]').inputValue(),'fixture-model');
  const add=page.locator('[data-action=create-custom-agent]');
  const bounds=await add.boundingBox();assert.ok(bounds&&bounds.y>=0&&bounds.y+bounds.height<1000,'Creation is visible without scrolling');
  // Rename with collapsed capability/channel sections: all saved configuration survives.
  await form.locator('[data-action=form-settings-edit]').click();
  await form.locator('[name=name]').fill('Research renamed');
  await form.locator('[data-action=form-settings-save]').click();await form.locator('[data-edit-status=saved]').waitFor();
  const renamed=(await boot()).customize.agents.find(a=>a.id==='research');
  for(const key of ['capabilities','collaboration','contextSources','model','instructions','mood','enabledMcpServerIds'])assert.deepEqual(renamed[key],initial[key],key);
  // A failed creation does not add a phantom entry, and the button can be retried.
  const before=(await boot()).customize.agents.length;
  await page.route('**/api/agents/create-custom',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'fixture creation unavailable'})}),{times:1});
  await add.click();await page.getByText('fixture creation unavailable',{exact:true}).waitFor();
  assert.equal(await add.isEnabled(),true);assert.equal((await boot()).customize.agents.length,before);
  // Start from a project override; a new Agent must edit its global profile.
  const project=await post('/api/projects',{name:'Fixture project',goal:'',workspacePath:''});
  await post('/api/settings',{activeView:'agent',selectedAgentId:'research',selectedProjectId:project.settings.selectedProjectId,selectedAgentScope:'project'});
  await page.reload();await form.waitFor();
  let creations=0;page.on('request',r=>{if(r.url().endsWith('/api/agents/create-custom'))creations++;});
  await page.route('**/api/agents/create-custom',async route=>{await new Promise(resolve=>setTimeout(resolve,150));await route.continue();},{times:1});
  await add.evaluate(button=>{button.click();button.click();});
  await page.waitForFunction(()=>document.querySelector('form[data-form=agent-profile-update]')?.dataset.agentId?.startsWith('custom-'));
  await page.waitForFunction(()=>document.querySelector('form[data-form=agent-profile-update] [name=name]')?.disabled===false);
  assert.equal(creations,1);
  const created=await boot(),id=created.settings.selectedAgentId;
  assert.equal(created.customize.agents.length,before+1);assert.equal(created.settings.selectedAgentScope,'global');
  await form.locator('[name=name]').fill('Settings regression');
  await form.locator('[name=instructions]').fill('My instructions');
  await form.locator('.agent-capabilities>summary').click();
  await form.locator('[name=cap_readFiles]').check();
  await form.locator('[name=cap_mcpServers][value=playwright]').check();
  await form.locator('[name=canDelegate]').check();
  await form.locator('[name=canDelegate]').uncheck();
  await form.locator('.agent-channels>summary').click();
  assert.equal(await form.locator('[name^=telegram],[data-channel-id=telegram]').count(),0);
  await form.locator('[data-action=switch-agent-channel-tab][data-channel-id=discord]').click();
  assert.equal(await form.locator('.agent-channels').getAttribute('open'),'');
  assert.equal(await form.locator('[name=canDelegate]').isChecked(),false);
  await form.locator('[name=discordChannelId]').fill('fixture-channel');
  await form.locator('[data-action=form-settings-save]').click();await form.locator('[data-edit-status=saved]').waitFor();
  const saved=(await boot()).customize.agents.find(a=>a.id===id);
  assert.equal(saved.name,'Settings regression');assert.equal(saved.instructions,'My instructions');
  assert.equal(saved.capabilities.readFiles,true);assert.deepEqual(saved.capabilities.mcpServers,['playwright']);
  assert.equal(saved.collaboration.canDelegate,false);
  assert.equal(saved.channels.find(c=>c.id==='telegram').archived,true);
  assert.equal(saved.channels.find(c=>c.id==='discord').channelId,'fixture-channel');
  await page.reload();await form.waitFor();assert.equal(await form.locator('[name=name]').inputValue(),'Settings regression');
  const proof=resolve('.tmp/agent-settings-20261015');await mkdir(proof,{recursive:true});
  for (const [width,height] of [[1440,1000],[1100,800],[390,844]]) {
    await page.setViewportSize({width,height});
    await add.scrollIntoViewIfNeeded();
    const visible=await add.boundingBox();assert.ok(visible.x>=0&&visible.x+visible.width<=width+1);
    const overflow=await page.locator('.agent-page').evaluate(el=>el.scrollWidth>el.clientWidth+1);assert.equal(overflow,false,`Agent width ${width}`);
    await page.screenshot({path:join(proof,`editor-${width}.png`)});
  }
  for (const [locale,label] of [['en','Add Agent'],['ja','Agent を追加'],['ko','Agent 추가'],['es','Añadir Agent']]) {
    await post('/api/settings/local',{preferences:{interfaceLanguage:locale}});
    await post('/api/settings',{activeView:'customize',selectedCustomizeSection:'agents'});
    await page.reload();await form.waitFor();assert.equal(await add.innerText(),label);
    assert.equal(await form.locator('[name=instructions]').inputValue(),'My instructions');
  }
  assert.deepEqual(errors,[]);
});
