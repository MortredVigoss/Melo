import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { launchTestChrome } from '../src/testSupport/testChrome.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';

test('chat composer grows from two to four visual lines and scrolls without losing its draft', { timeout: 90000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'melo-density-'));
  const proof = resolve('.tmp/chat-density-20261014');
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
    browser = await launchTestChrome(chromium);
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const composer = page.locator('#composer');
    const metrics = () => page.evaluate(() => {
      const c = document.querySelector('#composer'), s = getComputedStyle(c), reply = document.querySelector('.message.assistant .message-bubble');
      return { height: c.clientHeight, scroll: c.scrollHeight, top: c.scrollTop, font: s.fontSize, line: parseFloat(s.lineHeight), overflow: s.overflowY, value: c.value,
        replyFont: reply ? getComputedStyle(reply).fontSize : null, replyHeight: reply?.clientHeight,
        readingWidth: document.querySelector('.chat-thread')?.clientWidth,
        readingHeight: document.querySelector('.thread-scroll-region')?.clientHeight,
        composerHeight: document.querySelector('.composer-shell').clientHeight };
    });
    const ready = async () => {
      await composer.waitFor();
      const consent = page.getByRole('dialog', { name: 'Productivity MCP consent' });
      if (await consent.isVisible()) await consent.getByRole('button', { name: /暂不启用/ }).click();
      await page.locator('.message.assistant').waitFor();
    };
    const report = {};
    if (process.env.MELO_DENSITY_COMPARE === '1') {
      const names = ['app.js', 'styles.css', 'neural.css', 'neuralGlass.css', 'localSettings.css', 'executionPanel.css'];
      const intercept = async route => {
        const name = basename(new URL(route.request().url()).pathname);
        if (!names.includes(name)) return route.continue();
        await route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : 'text/css', body: await readFile(join(proof, 'before/desktop-ui', name), 'utf8') });
      };
      await page.route('**/*', intercept); await page.goto(base); await ready();
      report.before = await metrics(); await page.screenshot({ path: join(proof, 'desktop-before.png') });
      await page.unroute('**/*', intercept);
    }
    await page.goto(base); await ready();
    report.after = await metrics(); assert.equal(report.after.replyFont, '14px'); assert.equal(report.after.height, 48);
    assert.equal(await page.locator('.neural-dashboard .topbar').count(), 0);
    await page.keyboard.press('Meta+k');
    await page.locator('#command-palette-input').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#command-palette-input').waitFor({ state: 'hidden' });
    const roleBounds = await page.locator('.composer-conversation-choice').boundingBox();
    const optionsBounds = await page.locator('.image-task-options > button').boundingBox();
    assert.ok(Math.abs(roleBounds.y - optionsBounds.y) < 2, 'image options share the role row instead of covering the textarea');
    await page.screenshot({ path: join(proof, 'desktop-after.png') });
    const setLines = async count => { await composer.fill(Array.from({ length: count }, (_, i) => `第 ${i + 1} 行`).join('\n')); return metrics(); };
    const two = await setLines(2), three = await setLines(3), four = await setLines(4), long = await setLines(12);
    assert.equal(two.height, 48); assert.equal(three.height - two.height, two.line);
    assert.equal(four.height - three.height, two.line); assert.equal(long.height, four.height);
    assert.equal(long.overflow, 'auto'); assert.ok(long.scroll > long.height);
    // Wheel input must move the text, without moving the reply area behind it.
    await composer.evaluate(el => { el.blur(); el.scrollTop = 0; });
    const threadTop = await page.locator('.thread-scroll-region').evaluate(el => el.scrollTop);
    await composer.hover(); await page.mouse.wheel(0, 80);
    await page.waitForFunction(() => document.querySelector('#composer').scrollTop > 0);
    assert.equal(await page.locator('.thread-scroll-region').evaluate(el => el.scrollTop), threadTop);
    // Opening a control re-renders the full app, including an unfocused composer.
    const scrolled = (await metrics()).top;
    await page.locator('[data-action=toggle-agent-selector]').click();
    assert.equal((await metrics()).value, long.value); assert.equal((await metrics()).top, scrolled);
    await page.locator('[data-action=toggle-agent-selector]').click();
    assert.equal((await setLines(1)).height, two.height);
    // Wrapping uses the rendered width; widening must shrink the same draft again.
    const wrappedDraft = '自动换行内容 '.repeat(14);
    await composer.fill(wrappedDraft); const wide = await metrics();
    await page.setViewportSize({ width: 560, height: 850 });
    await page.waitForFunction(() => document.querySelector('#composer').clientHeight === 88);
    assert.equal((await metrics()).value, wrappedDraft);
    await page.setViewportSize({ width: 1600, height: 950 });
    await page.waitForFunction(() => document.querySelector('#composer').clientHeight < 88);
    assert.equal((await metrics()).value, wrappedDraft);
    assert.ok((await metrics()).readingWidth >= 950, 'large windows provide a wider reading area');
    // Shift+Enter remains a newline, and composing Enter never sends a draft.
    await composer.fill('中文输入'); await composer.press('End'); await composer.press('Shift+Enter');
    assert.equal(await composer.inputValue(), '中文输入\n');
    await composer.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
    assert.equal(await composer.inputValue(), '中文输入\n');
    await page.setViewportSize({ width: 390, height: 844 }); await setLines(12);
    const send = await page.locator('[data-form=composer] button[type=submit]').boundingBox();
    assert.ok(send.x >= 0 && send.x + send.width <= 390 && send.y + send.height <= 844);
    await page.screenshot({ path: join(proof, 'narrow-four-lines.png') });
    // The compact image options open as a popover, keeping the reply area stable.
    const heightBeforeOptions = (await metrics()).readingHeight;
    await page.locator('.image-task-options > button').click();
    await page.locator('.image-task-fields').waitFor();
    assert.equal((await metrics()).readingHeight, heightBeforeOptions);
    const imageOptions = await page.locator('.image-task-fields').boundingBox();
    assert.ok(imageOptions.x >= 0 && imageOptions.x + imageOptions.width <= 390);
    await page.locator('.image-task-options > button').click();
    await page.setViewportSize({ width: 1200, height: 850 });
    await setLines(3);
    await page.locator('.atomic-button[data-execution-action=toggle]').click();
    await page.locator('.execution-panel:not(.is-collapsed):not([hidden])').waitFor();
    assert.equal((await metrics()).height, 68, 'task-space layout uses the same line bounds');
    assert.equal((await setLines(12)).height, 88);
    await page.locator('[data-action=neural-overview]').click();
    await page.locator('.neural-home-composer').waitFor();
    assert.equal((await setLines(2)).height, 48); assert.equal((await setLines(3)).height, 68);
    assert.equal((await setLines(12)).height, 88, 'home composer also caps at four lines');
    await composer.fill('');
    report.lines = { two, three, four, long }; report.widthBefore = wide;
    assert.deepEqual(errors, []);
    await writeFile(join(proof, process.env.MELO_DENSITY_COMPARE === '1' ? 'comparison.json' : 'browser-results.json'), JSON.stringify(report, null, 2));
  } catch (error) {
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) {
      await page.screenshot({ path: join(proof, 'browser-failure.png') }).catch(() => {});
      await writeFile(join(proof, 'browser-failure.txt'), await page.locator('body').innerText().catch(() => 'closed'));
    }
    throw error;
  } finally {
    // End live SSE connections before disposing the browser context.
    child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited; clearTimeout(timer);
    await browser?.close();
    await rm(home, { recursive: true, force: true });
  }
});
