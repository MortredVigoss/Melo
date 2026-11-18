import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { launchTestChrome } from '../src/testSupport/testChrome.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createExecutionRecorder } from '../src/services/chat/executionScenes.js';

test('desktop controls remain reachable through short windows, long content, overlays and zoom', { timeout: 120000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-ui-reachability-'));
  const proof = resolve(process.env.MELO_UI_PROOF || '.tmp/desktop-ui-reachability-20261118');
  await mkdir(proof, { recursive:true }); await mkdir(join(home, 'desktop'));
  const run = createExecutionRecorder({home, chatId:'layout-chat', runId:'layout-run'}, '核对布局与长记录');
  for (let i=0;i<24;i++) run.event({kind:'operation',id:`step-${i}`,module:'search',name:'fetch_url',status:'completed',input:`https://fixture.invalid/${i}`,resultSummary:`第 ${i+1} 份记录：${'可滚动的长记录。'.repeat(60)}`});
  await run.finish('completed', {id:'layout-answer'});
  await writeFile(join(home, 'desktop/state.json'), JSON.stringify({
    chats:[{id:'layout-chat', source:'desktop', agentId:'main', title:'布局验收 · '+ '较长的聊天标题'.repeat(12), messages:[
      {id:'layout-question',role:'user',content:'检查聊天、输入与浮层'},
      {id:'layout-answer',role:'assistant',content:'阅读验收内容。'.repeat(120)+'\n\n```text\n'+'long_path_'.repeat(90)+'\n```',metadata:{runId:'layout-run'}},
    ]}],
    artifacts:Array.from({length:30},(_,i)=>({id:`knowledge-${i}`,title:`知识 ${i+1} · ${'较长的名称'.repeat(8)}`,type:'note',content:'供本地 UI 夹具选择的知识内容',createdAt:new Date().toISOString()})),
    chatRuns:[{chatId:'layout-chat',runId:'layout-run',status:'completed',createdAt:new Date().toISOString()}],
    settings:{activeView:'chat',selectedChatId:'layout-chat',localPreferences:{interfaceLanguage:'zh-CN'}},
  }));
  const child = spawn(process.execPath,['src/server.js','--host','127.0.0.1','--port','0'],{cwd:resolve('.'),env:{...process.env,MELO_HOME:home,MELO_TEST_MODE:'1',MELO_DREAMING_ENABLED:'0',MELO_MEMORY_RUNTIME:'0'},stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit'); let log='', browser;
  child.stderr.on('data', chunk=>{ log+=chunk; });
  t.after(async()=>{ const lastPage=browser?.contexts()[0]?.pages()[0]; if(lastPage) await lastPage.screenshot({path:join(proof,'final-state.png')}).catch(()=>{}); await browser?.close(); const timer=setTimeout(()=>child.kill('SIGKILL'),3000); child.kill('SIGTERM'); await exited;clearTimeout(timer);await rm(home,{recursive:true,force:true}); });
  const base=await new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(new Error(`UI server startup: ${log.slice(-1600)}`)),20000);child.stdout.on('data',chunk=>{log+=chunk;const match=log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);ok(match[1]);}});child.once('exit',()=>{clearTimeout(timer);fail(new Error(log.slice(-1600)));});});
  const post=async(url,body)=>{const response=await fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);};
  await post('/api/settings/model',{productivityMcpsConsented:true});
  await post('/api/settings/local',{preferences:{interfaceLanguage:'zh-CN'}});
  browser=await launchTestChrome(chromium);
  const page=await browser.newPage({viewport:{width:800,height:500},reducedMotion:'no-preference'});
  page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  // Render the installed Mac's labelled Call control, without recording audio.
  await page.addInitScript(()=>{window.webkit={messageHandlers:{meloVoice:{postMessage(){}}}};});
  await page.goto(base);await page.locator('#composer').waitFor();
  const visibleHit=async(locator,label)=>{
    await locator.scrollIntoViewIfNeeded();
    const metric=await locator.evaluate(el=>{const r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return {rect:r.toJSON(),viewport:[innerWidth,innerHeight],hit:!!hit&&(hit===el||el.contains(hit)),intercept:hit?.className};});
    assert.ok(metric.rect.width>0&&metric.rect.height>0&&metric.rect.x>=-1&&metric.rect.y>=-1&&metric.rect.right<=metric.viewport[0]+1&&metric.rect.bottom<=metric.viewport[1]+1&&metric.hit,`${label}: ${JSON.stringify(metric)}`);
    return metric;
  };
  const draft=Array.from({length:12},(_,i)=>`第 ${i+1} 行：保留输入中的草稿`).join('\n');
  const openChat=async()=>{
    await page.locator('[data-action=neural-group][data-group=chat]').click();
    await page.waitForFunction(()=>{const shell=document.querySelector('.neural-shell');return shell.dataset.neuralStage==='module'&&shell.dataset.flight!=='true';});
    const history=page.locator('[data-action=open-chat][data-chat-id=layout-chat]');
    await visibleHit(history,'small-window history entry');
    await page.screenshot({path:join(proof,'after-chat-branches-800x500.png')});
    await history.click();await page.locator('.message.assistant').waitFor();
  };
  await openChat();await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#composer').fill(draft);
  const metrics=[];
  for(const [width,height] of [[1440,900],[1280,800],[900,600],[800,500],[1024,640]]) {
    await page.setViewportSize({width,height});
    await page.waitForFunction(([w,h])=>{const shell=document.querySelector('.neural-shell'),dashboard=document.querySelector('.neural-dashboard');return shell.clientWidth===w&&shell.clientHeight===h&&Math.abs(dashboard.getBoundingClientRect().right-(w-16))<2;},[width,height]);
    for(const [selector,label] of [['[data-action=toggle-model-picker]','模型'],['.atomic-button','任务空间'],['[data-action=toggle-voice-call]','通话'],['[data-action=toggle-voice-input]','听写'],['[data-form=composer] button[type=submit]','发送'],['.conversation-context:last-of-type > summary','项目与知识']]) await visibleHit(page.locator(selector),`${width}×${height} ${label}`);
    assert.equal(await page.locator('#composer').inputValue(),draft);
    const reading=await page.locator('.thread-scroll-region').evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth,height:el.clientHeight}));
    assert.ok(reading.height>=60,`reading space ${width}×${height}: ${JSON.stringify(reading)}`);
    assert.ok(reading.scrollWidth<=reading.width+1,'long code scrolls inside its own block');
    const controls=await page.locator('.composer-bottom-right > *').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().toJSON()));
    for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++){const a=controls[i],b=controls[j];assert.ok(Math.min(a.right,b.right)-Math.max(a.left,b.left)<=1||Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)<=1,`composer hit targets ${i}/${j} overlap`);}
    await page.screenshot({path:join(proof,`after-chat-${width}x${height}.png`)});
    metrics.push({width,height,reading});
  }
  await page.setViewportSize({width:800,height:500});
  await page.locator('[data-action=toggle-model-picker]').click();
  await visibleHit(page.locator('.model-picker-option').first(),'model option');
  await page.screenshot({path:join(proof,'after-model-picker.png')});
  await page.locator('.model-picker-option').first().click();
  await page.locator('.model-picker-panel').waitFor({state:'hidden'});
  assert.equal(await page.locator('#composer').inputValue(),draft);
  await page.locator('[data-action=toggle-agent-selector]').click();
  await visibleHit(page.locator('.agent-selector-row').first(),'Agent option');
  await page.keyboard.press('Escape');
  await page.locator('.agent-selector-dropdown').waitFor({state:'hidden'});
  const context=page.locator('.conversation-context').last();
  await context.locator('summary').click();
  const menu=context.locator('.conversation-context-menu');
  await visibleHit(menu.locator('select'),'project select outside clipped shell');
  await visibleHit(menu.locator('input[type=checkbox]').last(),'last knowledge checkbox');
  await menu.locator('input[type=checkbox]').last().check();
  await page.screenshot({path:join(proof,'after-context-scrolled.png')});
  await page.keyboard.press('Escape');
  assert.equal(await context.getAttribute('open'),null);
  assert.equal(await page.locator('#composer').inputValue(),draft);
  await page.locator('[data-action=image-task-toggle]').click();
  await visibleHit(page.locator('.image-task-fields input[type=number]'),'image options');
  await page.locator('.image-task-fields input[type=number]').fill('2');
  await page.keyboard.press('Escape');
  await page.locator('.image-task-fields').waitFor({state:'hidden'});
  await page.locator('[data-action=toggle-composer-attachment-menu]').click();
  await visibleHit(page.locator('.composer-attachment-menu button').last(),'last attachment type');
  await page.keyboard.press('Escape');
  await page.locator('.composer-attachment-menu').waitFor({state:'hidden'});
  await page.keyboard.press('Meta+k');
  await page.locator('#command-palette-input').fill('');
  await visibleHit(page.locator('.palette-list button').first(),'command palette result');
  await page.screenshot({path:join(proof,'after-palette.png')});
  await page.keyboard.press('Escape');
  await page.locator('.palette-backdrop').waitFor({state:'hidden'});
  // Short-window primary rail and model method switching, without saving keys.
  for(const group of ['chat','projects','agents','knowledge','system'])await visibleHit(page.locator(`[data-action=neural-group][data-group=${group}]`),`rail ${group}`);
  await page.locator('[data-action=neural-group][data-group=system]').click();
  await page.locator('.neural-branch[data-view=model]').click();
  const method=page.locator('[data-action=llm-method]');
  await visibleHit(method,'connection method');
  await method.selectOption('api-key');
  await page.locator('[data-connection-method=api-key]').waitFor();
  await visibleHit(page.locator('[data-llm-connections] [data-action=llm-new]'),'add connection');
  await method.selectOption('local');await page.locator('[data-connection-method=local]').waitFor();
  await method.selectOption('codex');await page.locator('[data-connection-method=codex]').waitFor();
  assert.equal(await page.locator('.neural-dashboard').evaluate(el=>el.scrollLeft),0,'focus never shifts the entire surface sideways');
  await page.screenshot({path:join(proof,'after-settings.png')});
  await openChat();await page.locator('.atomic-button').click();
  const room=page.locator('#execution-war-room');await room.locator('.war-gl canvas').waitFor();
  await visibleHit(room.locator('[data-war-close]'),'task close');
  await room.locator('.war-status [data-war-trace=calls]').click();
  await visibleHit(room.locator('[data-war-back]'),'task detail back');
  await visibleHit(room.locator('.war-trace button').last(),'last of 24 tool records');
  await room.locator('[data-war-back]').click();
  const zoom=await room.locator('.war-zoom-value').innerText();await room.locator('[data-war-zoom=in]').click();
  await page.waitForFunction(previous=>document.querySelector('.war-zoom-value').textContent!==previous,zoom);
  await page.screenshot({path:join(proof,'after-task-space.png')});
  await room.locator('[data-war-close]').click();await room.waitFor({state:'hidden'});
  // Real animated and stationary projections both keep the core away from names.
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.mouse.move(790,5);
  const neural=page.locator('.neural-cosmos canvas');
  await page.waitForFunction(()=>document.querySelector('.neural-cosmos canvas')?.dataset.animating==='true');
  const clearRail=async mode=>{
    await page.waitForFunction(()=>{const canvas=document.querySelector('.neural-cosmos canvas'),labels=[...document.querySelectorAll('.neural-cluster-copy')],regions=JSON.parse(canvas?.dataset.coreRegions||'[]');return regions.length===5&&regions.every(r=>labels.every(el=>r.x+r.rx+8<el.getBoundingClientRect().left));});
    for(const group of ['chat','projects','agents','knowledge','system']) {
      const label=page.locator(`[data-action=neural-group][data-group=${group}] .neural-cluster-copy`);
      await visibleHit(label,`${mode} label ${group}`);
      assert.equal(await label.evaluate(e=>getComputedStyle(e.closest('.neural-cluster')).opacity),'1');
    }
    await page.mouse.move(790,5);
    await page.screenshot({path:join(proof,`after-sidebar-${mode}.png`)});
  };
  await clearRail('animated');
  await page.locator('[data-action=neural-motion]').click();
  await page.waitForFunction(()=>document.querySelector('.neural-cosmos canvas')?.dataset.animating==='false');
  await clearRail('static');
  for(const group of ['projects','agents','knowledge','system','chat']) {
    await page.locator(`[data-action=neural-group][data-group=${group}] .neural-cluster-copy`).click();
    await page.waitForFunction(id=>document.querySelector('.neural-shell').dataset.neuralGroup===id,group);
  }
  assert.deepEqual(errors,[]);
  await writeFile(join(proof,'interaction-metrics.json'),JSON.stringify({sizes:metrics,passed:['small-window cold start and history entry','composer hit targets','draft retention','long code','model selection','Agent picker','knowledge menu scroll','image options','attachments','command palette','five primary modules','connection methods','task records','task zoom and close','animated and static sidebar labels'],unverified:['native microphone','real model requests','installed app','physical phone'],errors},null,2));
});
