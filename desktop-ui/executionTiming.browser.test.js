import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { launchTestChrome } from '../src/testSupport/testChrome.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('chat and task timers advance without events, preserve live DOM, freeze and survive replay at phone width', { timeout: 45000 }, async () => {
  const env = { ...process.env }, home = await mkdtemp(join(tmpdir(), 'melo-timing-'));
  const proof = resolve('.tmp/execution-timing-20261016'); await mkdir(proof, { recursive: true });
  const child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], { cwd: resolve('.'), env: { ...env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_DREAMING_ENABLED: '0', MELO_MEMORY_RUNTIME: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let browser, log = '';
  child.stderr.on('data', c => { log += c; });
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(log.slice(-1500))), 15000);
      child.stdout.on('data', c => { log += c; const found = log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/); if (found) { clearTimeout(timer); resolve(found[1]); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(log.slice(-1500))); });
    });
    browser = await launchTestChrome(chromium);
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    // pauseAt must be in the future even under a busy parallel test runner.
    await page.clock.install({ time: new Date('2026-10-15T02:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-16T02:00:00Z'));
    const importmap = (await readFile('desktop-ui/index.html', 'utf8')).match(/<script type="importmap">[\s\S]*?<\/script>/)[0];
    await page.route('**/timing-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/executionPanel.css">${importmap}<style>body{background:#090c12;color:#d8c8af;font:14px system-ui;margin:0;padding:16px;box-sizing:border-box}.message{padding:16px;border:1px solid #a4987e33;border-radius:16px;margin-top:16px}.message-scene-replay{background:none;color:#d8c8af;border:0;padding:8px 0}</style></head><body><p>计时与图片进度 · 本地验收样本</p><main></main><article class="message" data-message-id="answer"><p>这里保留回复内容和图片，不因秒表更新而重新创建。</p></article><script type="module">
      import * as panel from '/executionPanel.js';
      import {createExecutionScene,applyExecutionEvent,finishExecutionScene} from '/shared/executionScene.js';
      window.panel=panel;window.apply=applyExecutionEvent;window.finish=finishExecutionScene;
      document.querySelector('main').innerHTML=panel.renderExecutionPanel();
      panel.syncExecutionPanel({chat:{id:'timing',messages:[]},autoCollapse:false});
      window.run=createExecutionScene({runId:'timed-run',chatId:'timing',startedAt:new Date(Date.now()-5000).toISOString()});
      applyExecutionEvent(run,{kind:'pipeline',id:'model:1',status:'running',name:'模型请求',at:run.startedAt});
      applyExecutionEvent(run,{kind:'image-task',task:{action:'generate',count:2}});
      applyExecutionEvent(run,{kind:'operation',id:'image-1',name:'image',module:'create',status:'running',at:run.startedAt});
      panel.receiveExecutionScene(structuredClone(run));
      document.querySelector('.message').insertAdjacentHTML('beforeend',panel.renderSceneReplay({role:'assistant',metadata:{runId:run.runId}}));
      window.ready=true;
    </script></body></html>` }));
    await page.goto(base + '/timing-fixture'); await page.waitForFunction(() => window.ready);
    await page.clock.fastForward(1000);
    const timer = page.locator('.execution-timing-host');
    assert.match(await timer.innerText(), /已用时 6 秒/);
    await page.evaluate(() => { window.originalStage = document.querySelector('.execution-panel-stage'); window.originalReply = document.querySelector('.message > p'); });
    await page.clock.fastForward(4000);
    assert.match(await timer.innerText(), /已用时 10 秒/);
    assert.match(await page.locator('[data-execution-timing-run]').innerText(), /思考与回复 10 秒/);
    assert.equal(await page.evaluate(() => originalStage === document.querySelector('.execution-panel-stage') && originalReply === document.querySelector('.message > p')), true);
    assert.equal(await timer.locator('progress').getAttribute('value'), '0');
    await page.evaluate(() => { apply(run,{kind:'operation',id:'image-1',status:'completed',artifacts:[{id:'saved',kind:'image',url:'https://example.test/result.png'}]}); panel.receiveExecutionScene(structuredClone(run)); });
    assert.equal(await timer.locator('progress').getAttribute('value'), '50');
    await page.screenshot({ path: join(proof, 'desktop-live.png') });
    await page.evaluate(() => { finish(run,{status:'cancelled',message:{id:'answer'}}); panel.receiveExecutionScene(structuredClone(run)); });
    const frozen = await timer.innerText(); await page.clock.fastForward(90000);
    assert.equal(await timer.innerText(), frozen); assert.match(frozen, /停止于/); assert.match(frozen, /50%/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(proof, 'phone-width-stopped.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const saved = await page.evaluate(() => JSON.stringify(run));
    await page.reload(); await page.waitForFunction(() => window.ready);
    await page.evaluate(value => { panel.receiveExecutionScene(JSON.parse(value)); }, saved);
    assert.match(await timer.innerText(), /本轮用时 10 秒/);
    assert.equal(await timer.locator('progress').getAttribute('value'), '50');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await exited; clearTimeout(timer);
    await rm(home, { recursive: true, force: true });
  }
});

test('shared popup and dialog materials keep secondary text distinct', {timeout:30000}, async()=>{
 const browser=await launchTestChrome(chromium);
 try {
  const page=await browser.newPage({viewport:{width:1100,height:750}});
  const html=await readFile('desktop-ui/index.html','utf8');
  const sheets=[...html.matchAll(/<link[^>]+href="([^"?]+\.css)[^"]*"/g)].map(m=>m[1].replace(/^\//,''));
  const css=(await Promise.all(sheets.map(p=>readFile(join('desktop-ui',p),'utf8')))).join('\n');
  await page.setContent(`<style>${css}</style><body style="background:#080b10"><div id="app"><div class="neural-dashboard"><h1>Shared surfaces</h1></div></div><div class="conversation-context"><div class="conversation-context-menu" style="position:relative;bottom:auto;right:auto"><strong>Project and team</strong><p>Supporting description</p></div></div><div class="language-menu" style="position:relative;bottom:auto;left:auto">Language</div><dialog class="chat-file-dialog management-dialog"><h2>Manage connection</h2><p>Shared dialog material</p><button>Close</button></dialog></body>`);
  const before=await page.evaluate(()=>{
   const menu=getComputedStyle(document.querySelector('.conversation-context-menu')),lang=getComputedStyle(document.querySelector('.language-menu'));
   return {menu:menu.backgroundImage,lang:lang.backgroundImage,blur:menu.backdropFilter,langBlur:lang.backdropFilter,radius:menu.borderRadius,langRadius:lang.borderRadius,text:getComputedStyle(document.querySelector('strong')).color,muted:getComputedStyle(document.querySelector('.conversation-context-menu p')).color};
  });
  assert.equal(before.menu,before.lang);assert.notEqual(before.menu,'none');assert.equal(before.blur,'blur(4px)');assert.equal(before.langBlur,before.blur);assert.equal(before.radius,'16px');assert.equal(before.langRadius,before.radius);assert.notEqual(before.text,before.muted);
  await page.evaluate(()=>document.querySelector('dialog').showModal());
  const opened=await page.evaluate(()=>({radius:getComputedStyle(document.querySelector('dialog')).borderRadius,bg:getComputedStyle(document.querySelector('dialog')).backgroundImage,dim:getComputedStyle(document.querySelector('.neural-dashboard')).filter}));
  assert.equal(opened.radius,'22px');assert.notEqual(opened.bg,'none');assert.equal(opened.dim,'brightness(0.45)');
  await mkdir('.tmp/ios-align-release-20261016',{recursive:true});await page.screenshot({path:'.tmp/ios-align-release-20261016/desktop-surfaces.png'});
  await page.evaluate(()=>document.querySelector('dialog').close());
  assert.equal(await page.locator('.neural-dashboard').evaluate(el=>getComputedStyle(el).filter),'none');
 } finally {await browser.close();}
});
