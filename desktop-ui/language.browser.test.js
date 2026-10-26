import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { launchTestChrome } from '../src/testSupport/testChrome.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';

test('interface language switches, persists, and never rewrites user content or drafts', { timeout: 90000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'melo-language-'));
  const proof = resolve('.tmp/language-20261015');
  await mkdir(proof, { recursive: true }); await mkdir(join(home, 'desktop'));
  await writeFile(join(home, 'desktop/state.json'), JSON.stringify({
    chats: [{ id: 'density-chat', source: 'desktop', title: '阅读密度验收', agentId: 'main', messages: [
      { id: 'question', role: 'user', content: '请用几段文字说明今天的工作安排。', createdAt: new Date().toISOString() },
      { id: 'answer', role: 'assistant', content: Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 项：先核对任务的目标与资料，再按顺序完成、检查并保存结果。每一步保留必要的记录，方便后续回看和继续处理。`).join('\n\n'), createdAt: new Date().toISOString() },
    ] }], settings: { activeView: 'chat', selectedChatId: 'density-chat' },
  }));
  const child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], {
    cwd: resolve('.'), env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_DREAMING_ENABLED: '0', MELO_MEMORY_RUNTIME: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit'); let log = '', browser;
  child.stderr.on('data', c => { log += c; });
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(log.slice(-1500))), 20000);
      child.stdout.on('data', c => { log += c; const match = log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(log.slice(-1500))); });
    });
    await fetch(base + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ activeView: 'chat', selectedChatId: 'density-chat' }) });
    browser = await launchTestChrome(chromium);
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    // This fixture asserts Chinese labels; set the preference explicitly, independent of the host locale.
    assert.equal((await fetch(base + '/api/settings/local', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({preferences:{interfaceLanguage:'zh-CN'}})})).status,200);
    await page.goto(base);
    await page.locator('#composer').waitFor();
    await page.locator('#composer').fill('系统设置\nMy draft 日本語 한국어');
    const userBefore = await page.locator('.message.user').innerText();
    const switchTo = async language => {
      await page.locator('.language-switcher summary').click();
      await page.locator(`[data-interface-language="${language}"]`).click();
      await page.waitForFunction(language => document.documentElement.lang === language, language);
      await page.waitForFunction(() => !document.querySelector('[data-interface-language]')?.disabled);
    };
    for (const [language,label] of [['en','Chats'],['ko','대화'],['ja','チャット'],['es','Chats'],['zh-CN','对话']]) {
      await switchTo(language);
      assert.equal(await page.locator('[data-action=neural-group][data-group=chat] strong').textContent(),label);
      assert.equal(await page.locator('#composer').inputValue(),'系统设置\nMy draft 日本語 한국어');
      assert.equal(await page.locator('.message.user').innerText(),userBefore);
    }
    await switchTo('en');
    await page.reload(); await page.locator('#composer').waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'),'en');
    // Real HTTP boundary: the shared API sends the selected locale and the
    // server renders errors in that request's language, not the machine's.
    const localizedError = await page.evaluate(async () => {
      const {createChatApi} = await import('/features/chat/api.js');
      const response = await createChatApi(() => {}).postSupplement('density-chat', 'extra');
      return {status:response.status,body:await response.json()};
    });
    assert.equal(localizedError.status,409);
    assert.equal(localizedError.body.error,'This conversation has no reply in progress.');
    await page.evaluate(async () => {
      const panel=await import('/executionPanel.js');
      const {createExecutionScene,applyExecutionEvent}=await import('/shared/executionScene.js');
      const scene=createExecutionScene({runId:'language-events',chatId:'density-chat',query:'Please explain the result'});
      applyExecutionEvent(scene,{kind:'pipeline',id:'model:1',messageId:'stage.model',status:'completed',model:'fixture-model',outputMessageId:'output.modelCompleted',outputMessageParams:{characters:42,tools:0,model:{messageId:'value.unreported'}},api:{outputCharacters:42,durationMs:15}});
      applyExecutionEvent(scene,{kind:'pipeline',id:'model:1:summary',channel:'reasoning-summary',messageId:'stage.summary',messageParams:{round:1},status:'completed',output:'Public summary from the fixture'});
      panel.syncExecutionPanel({chat:{id:'density-chat',messages:[]},autoCollapse:false,still:true});
      panel.receiveExecutionScene(scene);
    });
    await page.locator('#execution-panel:not([hidden])').waitFor();
    if(await page.locator('#execution-panel').evaluate(el=>el.classList.contains('is-collapsed'))) await page.locator('[data-execution-action=toggle]').click();
    await page.locator('[data-module=create]').click();
    await page.locator('.execution-pipeline [data-operation="model:1"]').click();
    await page.locator('.execution-detail-output').waitFor();
    assert.match(await page.locator('.execution-detail-output').innerText(),/42 characters.*Not reported/);
    assert.doesNotMatch(await page.locator('#execution-panel').innerText(),/\p{Script=Han}/u,'authored execution UI is fully English');
    await page.screenshot({path:resolve(proof,'execution-english.png')});
    await page.locator('[data-action=settings-open]').click();
    await page.locator('[data-tab=general]').click();
    assert.equal(await page.locator('.local-settings h1').textContent(),'Settings');
    const languageSelect = page.locator('[data-local-pref=interfaceLanguage]');
    assert.equal(await languageSelect.isDisabled(),true);
    await page.locator('[data-action=settings-edit]').click();
    await languageSelect.selectOption('ja');
    assert.equal(await page.locator('html').getAttribute('lang'),'en','draft does not apply before saving');
    await page.locator('[data-action=settings-save]').click();
    await page.waitForFunction(()=>document.documentElement.lang==='ja');
    assert.equal(await page.locator('.local-settings h1').textContent(),'設定');
    await page.screenshot({path:resolve(proof,'settings-japanese.png')});
    await switchTo('es');
    assert.equal(await page.locator('.local-notice').textContent(),'Cambios guardados en este dispositivo.');
    await page.screenshot({path:resolve(proof,'settings-spanish.png')});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.route('**/api/settings/local',route=>route.fulfill({status:500,contentType:'application/json',body:'{"error":"fixture failure"}'}));
    await page.locator('.language-switcher summary').click();
    await page.locator('[data-interface-language=ko]').click();
    await page.locator('.language-menu [role=alert]').waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'),'es','failed save keeps prior language');
    await page.unroute('**/api/settings/local');
    await page.locator('[data-interface-language=ko]').click();
    await page.waitForFunction(()=>document.documentElement.lang==='ko');
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:resolve(proof,'settings-korean-narrow.png')});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close(); child.kill('SIGTERM'); await exited;
    await rm(home,{recursive:true,force:true});
  }
});
