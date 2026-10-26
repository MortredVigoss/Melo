import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { launchTestChrome } from '../src/testSupport/testChrome.js';

test('task file consent: one visible scope approval covers two actual writes', { timeout: 90000 }, async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'melo-task-consent-ui-')));
  let browser, work = 0; const requests = [];
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw || '{}');
    const names = (body.tools || []).map(tool => tool.name || tool.function?.name); requests.push({url:req.url,names});
    const text = value => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] }];
    let output = text('Fixture response');
    if (names.includes('file_write')) {
      work++;
      output = work <= 2 ? [{ type: 'function_call', call_id: `write-${work}`, name: 'file_write', arguments: JSON.stringify({ path: work === 1 ? 'a.txt' : 'b.txt', content: 'new' }) }] : text('已修改两份文件。');
    }
    res.setHeader('content-type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `fixture-${work}`, model: 'fixture-model', status: 'completed', output } })}\n\n`);
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const baseUrl = `http://127.0.0.1:${model.address().port}/v1`;
  await writeFile(join(home, 'config.json'), JSON.stringify({ authMode: 'api-key', apiProtocol: 'responses', apiKey: 'fixture-key', model: 'fixture-model', baseUrl, conversationModelSelected: true }));
  const child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], { env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_MEMORY_RUNTIME: '0', MELO_DREAMING_ENABLED: '0', MELO_AUTH_MODE: 'api-key', MELO_BASE_URL: baseUrl, MELO_API_KEY: 'fixture-key', MELO_MODEL: 'fixture-model' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'exit');
  t.after(async () => { await browser?.close(); model.closeAllConnections(); model.close(); child.kill('SIGTERM'); await closed; await rm(home, { recursive: true, force: true }); });
  const base = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(Error('Server startup timed out')), 15000);
    child.stdout.on('data', chunk => { log += chunk; const match = log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const post = async (path, body) => { const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(response.status, 200); return response.json(); };
  const chatId = (await post('/api/chats', { projectId: null, mode: 'chat' })).activeChat.id;
  const workspace = join(home, 'workspaces', 'chats', chatId); await mkdir(workspace, { recursive: true });
  await Promise.all(['a.txt', 'b.txt'].map(name => writeFile(join(workspace, name), 'old')));
  await post('/api/settings', { activeMode: 'chat', activeView: 'chat', selectedChatId: chatId });
  await post('/api/settings/local', { preferences: { interfaceLanguage: 'en' } });
  browser = await launchTestChrome(chromium);
  const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base); const composer = page.locator('#composer'); await composer.waitFor();
  await composer.fill('Update a.txt and b.txt to new. Do not use the network.'); await composer.press('Enter');
  const grant = page.locator('[data-action=file-safety-allow][data-scope=task]'); await grant.waitFor().catch(async error => { console.error(JSON.stringify({ requests, body: await page.locator('body').innerText() })); throw error; });
  assert.equal(await page.locator('[data-action=file-safety-allow][data-scope=once]').count(), 1);
  assert.equal(await page.locator('[data-action=file-safety-deny]').count(), 1);
  assert.equal(await page.locator('[data-action=file-safety-allow][data-persistent="1"]').count(), 1);
  assert.match(await grant.textContent(), /Allow.*task/i);
  assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'old', 'no write before approval');
  await grant.click();
  await page.locator('[data-action=stop-send]').waitFor({ state: 'detached', timeout: 30000 });
  for (const name of ['a.txt', 'b.txt']) assert.equal(await readFile(join(workspace, name), 'utf8'), 'new');
  assert.equal(await grant.count(), 0); assert.deepEqual(errors, []);
});
