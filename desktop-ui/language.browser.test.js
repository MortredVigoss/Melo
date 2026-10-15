import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
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
    // Equivalent to “暂不启用” in this disposable test home; no MCP is enabled.
    await fetch(base + '/api/settings/model', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ productivityMcpsConsented: true }) });
    browser = await chromium.launch({ executablePath: process.env.MELO_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
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
