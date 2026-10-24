import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { launchTestChrome } from '../src/testSupport/testChrome.js';
import { createMediaRoutes } from '../src/http/mediaRoutes.js';
import { updateStateAtomically } from '../src/state/stateStore.js';
import { renderAttachmentCards } from './attachmentCards.js';
import { archiveSceneImages } from '../src/media/imageRecords.js';

for (const projected of [false, true]) test(`historical ${projected ? 'scene-projected' : 'saved'} image cards, preview and native save share bounded recovery and original bytes`, { timeout: 30000 }, async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'image-recovery-ui-')));
  const ws = projected ? join(home, 'old-project') : join(home, 'workspaces', 'chats', 'chat');
  await mkdir(join(ws, 'generated'), { recursive: true });
  const path = join(ws, 'generated', 'old.png');
  const bytes = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#9e876b' } }).png().toBuffer();
  await writeFile(path, bytes);
  // Deliberately expired, unverifiable and from an old port. No scene remains.
  const oldUrl = `http://127.0.0.1:1/api/files/signed/old.png?p=${Buffer.from(path).toString('base64url')}&e=1&s=expired`;
  const message = { id: 'reply', role: 'assistant', content: '', metadata: { chatId: 'chat', runId: 'old-run' },
    attachments: [{ id: 'image', kind: 'image', url: oldUrl, title: '旧图片' }] };
  await updateStateAtomically(state => { state.chats.push({ id: 'chat', title: 'fixture', messages: [message] }); }, { home });
  // selectedMessagePresentation replaces the persisted attachment id and URL
  // with the scene artifact id and a newly signed URL when replay is loaded.
  const displayMessage = projected ? { ...message, attachments: [{ ...message.attachments[0], id: 'scene-image', url: oldUrl.replace('e=1', 'e=2') }] } : message;
  if (projected) await archiveSceneImages(home, { runId: 'old-run', chatId: 'chat',
    artifacts: [{ id: 'scene-image', kind: 'image', path, url: oldUrl }] }, join(home, 'workspaces', 'chats', 'chat'));
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cards = renderAttachmentCards(displayMessage, { escapeHtml: esc, attachmentLabel: a => a.title });
  const media = createMediaRoutes({ home });
  let resolutions = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/api/media/images/resolve') resolutions++;
    if (await media.handle(req, res, url, () => true)) return;
    if (['/shared/agent/runtimeMessages.js','/shared/agent/locale.js'].includes(new URL(req.url,'http://fixture').pathname)) {
      res.writeHead(200, {'content-type':'text/javascript'}); res.end(await readFile(resolve('.' + new URL(req.url,'http://fixture').pathname))); return;
    }
    if (['/imagePreview.js', '/imageResource.js', '/imageZoom.js', '/i18n.js', '/translations.js', '/styles.css'].includes(url.pathname)) {
      res.writeHead(200, { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css' });
      res.end(await readFile(resolve('desktop-ui' + url.pathname))); return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><head><link rel="stylesheet" href="/styles.css"></head><body><main id="app">${cards}</main><script type="module">import {installImagePreview} from '/imagePreview.js';installImagePreview({saveNativeImage:async data=>{window.savedImage=data;return {};}});window.ready=true;</script></body></html>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchTestChrome(chromium);
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(5000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base); await page.waitForFunction(() => window.ready);
    await page.waitForFunction(() => document.querySelector('.message-image').naturalWidth === 320);
    assert.equal(resolutions, 1, 'chat resolves exactly once despite the old-port failure');
    await page.locator('[data-image-preview]').click();
    const dialog = page.getByRole('dialog', { name: '图片预览' });
    await page.waitForFunction(() => document.querySelector('.image-preview-stage img').naturalWidth === 320);
    await dialog.getByRole('button', { name: '下载原图' }).click();
    await dialog.getByRole('status').filter({ hasText: '原图已保存' }).waitFor();
    assert.deepEqual(Buffer.from((await page.evaluate(() => window.savedImage)).data, 'base64'), bytes);
    assert.equal(resolutions, 1, 'preview and save reuse the resolved identity');
    await dialog.getByRole('button', { name: '关闭预览' }).click();
    await writeFile(path, 'damaged');
    await page.reload();
    await page.locator('figcaption').filter({ hasText: '损坏' }).waitFor();
    assert.equal(resolutions, 2);
    await page.waitForTimeout(350);
    assert.equal(resolutions, 2, 'decode/resolve failure does not retry indefinitely');
    await rm(path);
    await page.reload();
    await page.locator('figcaption').filter({ hasText: '不存在' }).waitFor();
    assert.equal(resolutions, 3);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
    await rm(home, { recursive: true, force: true });
  }
});
