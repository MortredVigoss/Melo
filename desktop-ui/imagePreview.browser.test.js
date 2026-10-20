import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { launchTestChrome } from '../src/testSupport/testChrome.js';
import { renderAttachmentCards } from './attachmentCards.js';
import { imageDownloadName } from './imagePreview.js';

test('image preview preserves original downloads, focus, zoom and retry feedback', { timeout: 30000 }, async () => {
  const bytes = await sharp({ create: { width: 2000, height: 1200, channels: 3, background: '#617da0' } }).png().toBuffer();
  const proof = resolve('.tmp/chat-density-20261014'); await mkdir(proof, { recursive: true });
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cards = renderAttachmentCards({ attachments: [{ kind: 'image', url: '/original.png', title: '生成图片' }] }, { escapeHtml: esc, attachmentLabel: a => a.title });
  let unavailable = false;
  const server = createServer(async (req, res) => {
    if (req.url === '/original.png') { res.writeHead(unavailable ? 404 : 200, { 'content-type': 'image/png' }); res.end(unavailable ? '' : bytes); return; }
    if (['/imagePreview.js', '/imageResource.js', '/imageZoom.js', '/i18n.js', '/translations.js', '/styles.css'].includes(req.url)) {
      res.writeHead(200, { 'content-type': req.url.endsWith('.js') ? 'text/javascript' : 'text/css' });
      res.end(await readFile(resolve('desktop-ui' + req.url))); return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><head><link rel="stylesheet" href="/styles.css"></head><body style="padding:24px"><main id="app">${cards}<textarea id="composer"></textarea></main><script type="module">import {installImagePreview} from '/imagePreview.js';installImagePreview(location.search ? {saveNativeImage: async payload => {window.savedImage=payload;if(window.saveError)throw new Error(window.saveError);return {cancelled:window.cancelSave};}} : {});window.previewReady=true;</script></body></html>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchTestChrome(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    page.setDefaultTimeout(5000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base); await page.waitForFunction(() => window.previewReady);
    const trigger = page.locator('[data-image-preview]'), dialog = page.getByRole('dialog', { name: '图片预览' });
    await trigger.focus(); await page.keyboard.press('Enter');
    await dialog.waitFor();
    // Intrinsic metadata can arrive before the load listener applies the fitted
    // dimensions. Wait for that real initialization, then keep the bounds check.
    await page.waitForFunction(() => {
      const image = document.querySelector('.image-preview-stage img');
      return image.complete && image.naturalWidth === 2000 && image.style.width !== '';
    });
    const fit = await dialog.locator('img').boundingBox();
    assert.ok(fit.width <= 1152 && fit.height <= 700, 'whole image fits inside preview');
    await page.screenshot({ path: resolve(proof, 'image-preview-desktop.png') });
    await dialog.getByRole('button', { name: '原始尺寸' }).click();
    assert.equal((await dialog.locator('img').boundingBox()).width, 2000);
    await dialog.getByRole('button', { name: '适合窗口' }).click();
    const stage = dialog.locator('.image-preview-stage');
    await stage.hover(); await page.mouse.wheel(0, -170);
    await page.waitForTimeout(400);
    const firstZoom = Number(await stage.getAttribute('data-zoom')); assert.ok(firstZoom > 1 && firstZoom < 2);
    await page.mouse.wheel(0, -170); await page.waitForTimeout(400);
    const nextZoom = Number(await stage.getAttribute('data-zoom')); assert.ok(nextZoom > firstZoom + .2);
    await page.mouse.wheel(0, -2000);
    await page.waitForFunction(() => Number(document.querySelector('.image-preview-stage').dataset.zoom) > 4);
    await page.waitForFunction(() => Number(document.querySelector('.image-preview-stage').dataset.zoom) === 4);
    // Pointer pinch and subsequent pinch both use the current scale. A new
    // gesture must not jump back to its first gesture's baseline.
    await stage.focus(); await page.keyboard.press('0'); await page.waitForTimeout(300);
    await stage.evaluate(el => {
      el.setPointerCapture = () => {}; // synthetic pointer fixture has no native capture
      const r = el.getBoundingClientRect(); const cy = r.top + r.height/2, cx = r.left+r.width/2;
      const emit = (type,id,x) => el.dispatchEvent(new PointerEvent(type,{pointerId:id,pointerType:'touch',clientX:x,clientY:cy,button:0,bubbles:true}));
      emit('pointerdown',1,cx-50);emit('pointerdown',2,cx+50);emit('pointermove',2,cx+100);
      emit('pointerup',2,cx+100);emit('pointerup',1,cx-50);
    });
    await page.waitForTimeout(300); assert.equal(Number(await stage.getAttribute('data-zoom')),1.5);
    await stage.evaluate(el => {
      const r = el.getBoundingClientRect(); const cy = r.top+r.height/2,cx=r.left+r.width/2;
      const emit = (type,id,x) => el.dispatchEvent(new PointerEvent(type,{pointerId:id,pointerType:'touch',clientX:x,clientY:cy,button:0,bubbles:true}));
      emit('pointerdown',3,cx-50);emit('pointerdown',4,cx+50);emit('pointermove',4,cx+100);
      emit('pointerup',4,cx+100);emit('pointerup',3,cx-50);
    });
    await page.waitForTimeout(300); assert.equal(Number(await stage.getAttribute('data-zoom')),2.25);
    await stage.focus(); await page.keyboard.press('0'); await page.waitForTimeout(300);
    const downloadEvent = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '下载原图' }).click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), '生成图片.png');
    assert.deepEqual(await readFile(await download.path()), bytes, 'download keeps the original bytes');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    await trigger.click(); unavailable = true;
    await dialog.getByRole('button', { name: '下载原图' }).click();
    await dialog.getByRole('status').filter({ hasText: '无法下载' }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: '下载原图' }).isEnabled(), true);
    unavailable = false;
    const retry = page.waitForEvent('download'); await dialog.getByRole('button', { name: '下载原图' }).click(); await retry;
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await dialog.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    await page.screenshot({ path: resolve(proof, 'image-preview-narrow.png') });
    // A chat refresh must not remove the modal; closing still returns keyboard focus.
    await page.locator('#app').evaluate(el => { el.innerHTML = '<textarea id="composer"></textarea>'; });
    assert.equal(await dialog.isVisible(), true);
    await dialog.getByRole('button', { name: '关闭预览' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('#composer') === document.activeElement);
    assert.equal(await page.locator('#composer').evaluate(el => el === document.activeElement), true);
    await page.goto(base + '?native'); await page.waitForFunction(() => window.previewReady);
    await page.locator('[data-image-preview]').click();
    await page.evaluate(() => { window.cancelSave = true; });
    await dialog.getByRole('button', { name: '下载原图' }).click();
    await dialog.getByRole('status').filter({ hasText: '已取消保存' }).waitFor();
    const payload = await page.evaluate(() => window.savedImage);
    assert.deepEqual(Buffer.from(payload.data, 'base64'), bytes);
    assert.equal(payload.mimeType, 'image/png');
    await page.evaluate(() => { window.cancelSave = false; window.saveError = '磁盘写入失败'; });
    await dialog.getByRole('button', { name: '下载原图' }).click();
    await dialog.getByRole('status').filter({ hasText: '磁盘写入失败' }).waitFor();
    await page.evaluate(() => { window.saveError = ''; });
    await dialog.getByRole('button', { name: '下载原图' }).click();
    await dialog.getByRole('status').filter({ hasText: '原图已保存' }).waitFor();
    assert.equal(imageDownloadName('../图:<script>.jpg', 'image/png'), '..-图--script-.png');
    assert.deepEqual(errors, []);
  } catch (error) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) { await page.screenshot({ path: resolve(proof, 'image-preview-failure.png') }); console.error(await page.locator('body').innerText()); }
    throw error;
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
