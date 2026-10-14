import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const dir = resolve('.tmp/extra-fast-browser');
await mkdir(dir, { recursive: true });
const home = await mkdtemp(join(dir, 'home-'));
const calls = [];
const provider = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); calls.push({ model: body.model, budget: body.max_tokens });
  const text = body.messages[0].content;
  const answer = text.includes('Medical dosage') ? 'high-stakes' : text.includes('group message') ? 'no' : 'creative';
  await new Promise(resolve => setTimeout(resolve, body.model === 'fixture-mini' ? 5 : 80));
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ model: `${body.model}-actual`, choices: [{ message: { content: answer }, finish_reason: 'stop' }] }));
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;
const profiles = Object.fromEntries(['main', 'mini'].map(id => [id, { id, name: id === 'main' ? '回答模型' : '短判断模型',
  authMode: 'local', providerId: 'local', baseUrl: providerUrl, model: `fixture-${id}`, revision: 1 }]));
await writeFile(join(home, 'config.json'), JSON.stringify({ authMode: 'local', baseUrl: providerUrl,
  model: 'fixture-main', activeLlmProfileId: 'main', llmProfiles: profiles }));
await mkdir(join(home, 'desktop'));
await writeFile(join(home, 'desktop/state.json'), JSON.stringify({ settings: { activeView: 'model' } }));
const child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], {
  env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_MOCK_RESPONSE: '', MELO_DREAMING_ENABLED: '0', MELO_MEMORY_RUNTIME: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '', browser;
child.stderr.on('data', chunk => { logs += chunk; });
const closed = once(child, 'exit');
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(logs)), 15000);
    child.stdout.on('data', chunk => { logs += chunk; const match = logs.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(logs)); });
  });
  browser = await chromium.launch({ executablePath: process.env.MELO_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  const consent = page.getByRole('dialog', { name: 'Productivity MCP consent' });
  if (await consent.isVisible()) await consent.getByRole('button', { name: /暂不启用/ }).click();
  await page.locator('.neural-cluster[data-group=system]').click();
  await page.locator('.neural-branches [data-action=open-view][data-view=model]').click();
  const card = page.locator('[data-extra-fast]'); await card.waitFor();
  const checkbox = card.locator('[name=extraFastEnabled]');
  assert.equal(await checkbox.isDisabled(), true); assert.equal(await checkbox.isChecked(), false); assert.equal(calls.length, 0);
  await card.locator('[data-action=extra-fast-edit]').click();
  await checkbox.check();
  await page.route('**/api/settings/extra-fast', route => route.abort(), { times: 1 });
  await card.locator('[data-action=extra-fast-save]').click();
  await card.locator('[data-edit-status=error]').waitFor(); assert.equal(await checkbox.isChecked(), true); assert.equal(calls.length, 0);
  await card.locator('[data-action=extra-fast-save]').click();
  await card.getByText('检测完成，按有效实测结果自动分配。', { exact: true }).waitFor();
  assert.equal(await checkbox.isDisabled(), true); assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.budget === 1024));
  const status = await (await fetch(base + '/api/bootstrap')).json();
  assert.equal(status.settings.config.model, 'fixture-main');
  assert.equal(status.settings.config.extraFast.assignments.intent.model, 'fixture-mini');
  await page.reload(); await card.waitFor(); assert.equal(await checkbox.isChecked(), true);
  await card.screenshot({ path: join(dir, 'desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  assert.equal(await card.locator('[data-action=extra-fast-edit]').isVisible(), true);
  await card.screenshot({ path: join(dir, 'mobile-web.png') });
  await card.locator('[data-action=extra-fast-edit]').click(); await checkbox.uncheck();
  await card.locator('[data-action=extra-fast-save]').click(); await card.locator('[data-edit-status=saved]').waitFor();
  assert.equal(calls.length, 4); assert.equal(await checkbox.isChecked(), false);
  await card.locator('[data-action=extra-fast-edit]').click(); await checkbox.check();
  const current = (await (await fetch(base + '/api/bootstrap')).json()).settings.config.extraFast;
  const changed = await fetch(base + '/api/settings/extra-fast', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, revision: current.revision }) });
  assert.equal(changed.ok, true);
  await card.locator('[data-action=extra-fast-save]').click(); await card.locator('[data-edit-status=error]').waitFor();
  assert.equal(await checkbox.isChecked(), true);
  await card.locator('[data-action=extra-fast-rebase]').click();
  assert.equal(await checkbox.isChecked(), true);
  await card.locator('[data-action=extra-fast-save]').click();
  await card.getByText('检测完成，按有效实测结果自动分配。', { exact: true }).waitFor();
  assert.equal(calls.length, 8);
  assert.deepEqual(errors, []);
  await writeFile(join(dir, 'result.json'), JSON.stringify({ calls, errors, assignment: status.settings.config.extraFast, home }, null, 2));
  console.log('PASS: opt-in, failed save/retry, real HTTP probe, measured assignment, reload, narrow screen, disable and conflict rebase.');
} catch (error) {
  console.error(error.stack); process.exitCode = 1;
  await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(dir, 'failure.png') });
} finally {
  await browser?.close(); child.kill('SIGTERM'); await closed;
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  await writeFile(join(dir, 'server.log'), logs);
}
