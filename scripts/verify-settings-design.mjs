import { chromium } from 'playwright-core';
import { launchTestChrome } from '../src/testSupport/testChrome.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir,writeFile,mkdtemp } from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const dir=resolve('.tmp/settings-design-check');await mkdir(dir,{recursive:true});const home=await mkdtemp(join(dir,'home-'));await mkdir(join(home,'desktop'));
await writeFile(join(home,'desktop/state.json'),JSON.stringify({chats:[{id:'fixture-chat',source:'desktop',title:'交互验收',agentId:'main',messages:[{id:'user-msg',role:'user',content:'验收',createdAt:new Date().toISOString()},{id:'assistant-msg',role:'assistant',content:'原角色的历史回复',createdAt:new Date().toISOString(),metadata:{agent:{id:'main',name:'Main agent'}}}]}],settings:{activeView:'settings'}}));
const child=spawn(process.execPath,['src/server.js','--host','127.0.0.1','--port','0'],{env:{...process.env,MELO_HOME:home,MELO_TEST_MODE:'1',MELO_MOCK_RESPONSE:'fixture response',MELO_DREAMING_ENABLED:'0',MELO_MEMORY_RUNTIME:'0'},stdio:['ignore','pipe','pipe']});
let logs='',browser;child.stderr.on('data',b=>logs+=b);const closed=once(child,'exit');
try {
 const base=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error(logs)),15000);child.stdout.on('data',b=>{logs+=b;const m=logs.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);if(m){clearTimeout(t);resolve(m[1]);}});child.once('exit',()=>{clearTimeout(t);reject(new Error(logs));});});
 const post=async(path,body)=>{const res=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!res.ok)throw new Error(await res.text());return res.json();};
 const bootstrap=async()=>{const r=await fetch(base+'/api/bootstrap');return r.json();};
 const created=await post('/api/agents/create-custom',{});const custom=created.customize.agents.find(a=>a.isCustom).id;
 await post('/api/agents/update',{agentId:custom,patch:{name:'验收角色',description:'修改前描述',rolePrompt:'使用简短中文回复'}});
 await post('/api/settings',{activeView:'settings'});
 browser=await launchTestChrome(chromium);const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));

 const out={};
 async function go(settings){await post('/api/settings',settings);await page.reload();await page.locator('#app').waitFor();await page.waitForTimeout(900);}
 await page.goto(base);await page.locator('.local-settings').waitFor();
 const consent=page.getByRole('dialog',{name:'Productivity MCP consent'});if(await consent.isVisible())await consent.getByRole('button',{name:/暂不启用/}).click();
 await page.locator('[data-action=settings-edit]').click();await page.locator('[name=localName]').fill('未保存昵称');let dialogs=0;page.on('dialog',async d=>{dialogs++;await d.dismiss();});await page.reload({timeout:2000}).catch(e=>{if(dialogs!==1)throw e;});await page.locator('[name=localName]').waitFor();out.reloadDraft={dialogs,value:await page.locator('[name=localName]').inputValue()};
 assert.equal(out.reloadDraft.dialogs,1);assert.equal(out.reloadDraft.value,'未保存昵称');await page.locator('[data-action=settings-cancel]').click();
 await go({activeView:'agent',selectedAgentId:custom});
 const form=page.locator('form[data-form=agent-profile-update]').first();await form.locator('[data-action=form-settings-edit]').click();
 await form.locator('.agent-capabilities > summary').click();
 const toolsInput=form.locator('[name=cap_readFiles]');out.roleDraft={before:await toolsInput.isChecked()};
 await form.locator('[name=description]').fill('未保存的描述');await toolsInput.setChecked(!out.roleDraft.before);out.roleDraft.edited=await toolsInput.isChecked();
 await page.locator('.neural-branches [data-action=select-agent-profile][data-agent-id=main]').click();await page.waitForTimeout(500);
 await page.locator(`.neural-branches [data-action=select-agent-profile][data-agent-id="${custom}"]`).click();await page.waitForTimeout(500);
 out.roleDraft.returned=await toolsInput.isChecked();out.roleDraft.description=await form.locator('[name=description]').inputValue();out.roleDraft.status=await form.locator('.settings-edit-toolbar').getAttribute('data-edit-status');
 assert.equal(out.roleDraft.returned,out.roleDraft.edited);assert.equal(out.roleDraft.description,'未保存的描述');
 await form.locator('[data-action=form-settings-save]').click();await form.locator('[data-edit-status=saved]').waitFor();assert.equal((await bootstrap()).customize.agents.find(a=>a.id===custom).capabilities.readFiles,out.roleDraft.edited);
 await page.screenshot({path:join(dir,'role-draft.png')});
 await form.locator('[data-action=form-settings-edit]').click();await toolsInput.setChecked(!out.roleDraft.edited);await form.locator('[data-action=form-settings-cancel]').click();assert.equal(await toolsInput.isChecked(),out.roleDraft.edited);
 await go({activeView:'model'});
 const defaults=page.locator('[data-form=default-model-config]'),modelSelect=defaults.locator('[name=model]');
 assert.equal(await modelSelect.isDisabled(),true);
 assert.ok((await modelSelect.locator('option').allTextContents()).some(s=>s.includes('Astra 6')));
 await defaults.locator('[data-action=form-settings-edit]').click();await modelSelect.selectOption('gpt-6-astra');
 assert.equal((await bootstrap()).settings.config.model,'gpt-6.1-sol','draft must not autosave');
 await page.route('**/api/settings/model',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'fixture save unavailable'})}),{times:1});
 await defaults.locator('[data-action=form-settings-save]').click();await defaults.locator('[data-edit-status=error]').waitFor();
 assert.equal(await modelSelect.inputValue(),'gpt-6-astra','failed save keeps the selected model');
 await defaults.locator('[data-action=form-settings-save]').click();await defaults.locator('[data-edit-status=saved]').waitFor();
 assert.equal((await bootstrap()).settings.config.model,'gpt-6-astra');assert.equal(await modelSelect.isDisabled(),true);
 await go({activeView:'model'});assert.equal(await modelSelect.inputValue(),'gpt-6-astra');
 await defaults.locator('[data-action=form-settings-edit]').click();await modelSelect.selectOption('gpt-6.1-sol');
 await defaults.locator('[data-action=form-settings-cancel]').click();assert.equal(await modelSelect.inputValue(),'gpt-6-astra');
 await page.setViewportSize({width:390,height:844});await modelSelect.scrollIntoViewIfNeeded();
 const defaultBounds=await modelSelect.boundingBox();assert.ok(defaultBounds.x>=0&&defaultBounds.x+defaultBounds.width<=390);
 await page.screenshot({path:join(dir,'default-model-mobile.png')});
 out.defaultModel={persisted:'gpt-6-astra',failedSaveRetained:true,cancelRestored:true,mobileFits:true};
 await page.setViewportSize({width:1440,height:1000});
 await page.screenshot({path:join(dir,'default-model-desktop.png')});
 await post('/api/settings/llm/save',{providerId:'local',id:'local',baseUrl:base+'/v1',model:'fixture-original'});await post('/api/settings/llm/activate',{id:'local'});
 await go({activeView:'model'});const llm=page.locator('[data-llm-connections]');await llm.waitFor();out.connection={before:await llm.locator('[name=model]').inputValue()};
 await page.locator('.model-prompt-settings>summary').click();const legacy=page.locator('#model-config-form');await legacy.locator('[data-action=form-settings-edit]').click();
 await legacy.locator('[name=systemPrompt]').fill('只修改系统提示词');await legacy.locator('[data-action=form-settings-save]').click();await legacy.locator('[data-edit-status=saved]').waitFor();
 out.connection.afterSavedPrompt=(await bootstrap()).settings.config.model;out.connection.activeBefore='local';out.connection.activeAfterPrompt=(await bootstrap()).settings.config.llmConnections.activeId;assert.equal(out.connection.activeAfterPrompt,'local');
 // Change the same provider in another settings surface, then use the cached form.
 await post('/api/settings/model',{model:'fixture-updated'});
 await page.locator('[data-action=refresh-model-status]').count().then(async n=>{if(n)await page.locator('[data-action=refresh-model-status]').first().click();else await page.locator('[data-action=open-view][data-view=settings]').first().click();}).catch(()=>{});
 // A navigation bootstrap refresh must be reflected when returning to model management.
 await page.locator('.neural-cluster[data-group=system]').click();await page.waitForTimeout(900);
 const modelEntry=page.locator('.neural-branches [data-action=open-view][data-view=model]');await modelEntry.click();await page.waitForTimeout(900);
 out.connection.apiModel=(await bootstrap()).settings.config.llmConnections.profiles.find(p=>p.id==='local').model;out.connection.displayedModel=await llm.locator('[name=model]').inputValue();assert.equal(out.connection.displayedModel,out.connection.apiModel);
 await llm.locator('[data-action=llm-edit]').click();await llm.locator('[name=model]').fill('fixture-third');await llm.locator('[data-action=llm-save]').click();await page.waitForTimeout(500);out.connection.saveStatus=await llm.locator('.settings-edit-toolbar').getAttribute('data-edit-status');out.connection.message=await llm.locator('.settings-edit-toolbar').innerText();
 assert.equal(out.connection.saveStatus,'saved');
 await llm.locator('[data-action=llm-edit]').click();await llm.locator('[name=model]').fill('unsaved-conflict');await post('/api/settings/model',{model:'changed-elsewhere'});await llm.locator('[data-action=llm-save]').click();await llm.locator('[data-action=llm-reload]').waitFor();assert.equal(await llm.locator('[name=model]').inputValue(),'unsaved-conflict');assert.equal(await llm.locator('[data-action=llm-save]').isDisabled(),true);await llm.locator('[data-action=llm-reload]').click();await llm.locator('[data-action=llm-edit]').waitFor();assert.equal(await llm.locator('[name=model]').inputValue(),'changed-elsewhere');
 await page.screenshot({path:join(dir,'connection-stale.png')});
 await go({activeView:'chat',selectedChatId:'fixture-chat'});
 out.historicalBefore=await page.locator('.message.assistant .message-role').innerText();await page.locator('[data-action=toggle-agent-selector]').click();await page.locator(`#agent-selector-panel [data-agent-id="${custom}"]`).click();await page.waitForTimeout(500);out.historicalAfter=await page.locator('.message.assistant .message-role').innerText();
 out.layout=[];
 for(const viewport of [{width:1440,height:1000},{width:900,height:660},{width:390,height:844},{width:320,height:740}]){
 await page.setViewportSize(viewport);await page.waitForTimeout(1000);
 const metrics=await page.evaluate(()=>{const btn=document.querySelector('[data-form=composer] button[type=submit]'),card=document.querySelector('.composer-card');const r=btn.getBoundingClientRect(),c=card.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {send:{x:r.x,y:r.y,width:r.width,height:r.height},card:{x:c.x,y:c.y,width:c.width,height:c.height,scrollWidth:card.scrollWidth},centerReceivesClick:btn.contains(document.elementFromPoint(x,y)),fitsScreen:r.right<=innerWidth&&r.bottom<=innerHeight};});out.layout.push({viewport,...metrics});assert.equal(metrics.fitsScreen,true,JSON.stringify({viewport,...metrics}));assert.equal(metrics.centerReceivesClick,true);await page.screenshot({path:join(dir,`chat-${viewport.width}.png`)});
 }
 await page.locator('#composer').fill('窄屏真实点击发送验收');await page.locator('[data-form=composer] button[type=submit]').click();await page.waitForFunction(()=>document.body.textContent.includes('fixture response'));
 await page.setViewportSize({width:1440,height:1000});await go({activeView:'settings'});await page.locator('[data-tab=voice]').click();
 out.voice={openOptionsDisabled:await page.locator('[data-action=settings-voice-options]').isDisabled(),configLinkDisabled:await page.locator('[data-action=select-customize-item][data-id=openai-compatible]').isDisabled()};
 await page.screenshot({path:join(dir,'voice-readonly.png')});
 assert.deepEqual(out.voice,{openOptionsDisabled:false,configLinkDisabled:false});
 await page.locator('[data-action=select-customize-item][data-id=openai-compatible]').click();const audio=page.locator('#connector-config-form');await audio.waitFor();assert.equal(await audio.locator('[name=authMode],[name=baseUrl],[name=model],[name=systemPrompt]').count(),0);await audio.locator('[data-action=form-settings-edit]').click();await audio.locator('[name=whisperBaseUrl]').fill(base+'/whisper');await audio.locator('[data-action=form-settings-save]').click();await audio.locator('[data-edit-status=saved]').waitFor();assert.equal((await bootstrap()).settings.config.llmConnections.activeId,'local');assert.deepEqual(errors,[]);
 out.errors=errors;await writeFile(join(dir,'findings.json'),JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));
}catch(e){console.error(e.stack);if(browser){const pages=browser.contexts().flatMap(c=>c.pages());await pages[0]?.screenshot({path:join(dir,'failure.png')});}process.exitCode=1;}
finally{await browser?.close();child.kill('SIGTERM');await closed;await writeFile(join(dir,'server.log'),logs);}
