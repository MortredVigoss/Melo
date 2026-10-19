import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { launchTestChrome } from '../src/testSupport/testChrome.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createExecutionRecorder } from '../src/services/chat/executionScenes.js';
import { observeModelReplies } from '../src/services/chat/executionPipeline.js';
import { readCodexSseResponse } from '../src/providers/streams.js';

test('real browser loads saved API telemetry through Melo routes, reads summaries and preserves scroll at narrow width', { timeout: 45000 }, async () => {
  const env = { ...process.env };
  const home = await mkdtemp(join(tmpdir(), 'melo-neural-browser-'));
  const proof = resolve('.tmp/neural-api-20261014');
  await mkdir(proof, { recursive: true });
  const recorder = createExecutionRecorder({ home, runId: 'telemetry-browser', chatId: 'telemetry-chat' }, 'API 观察验收样本');
  const summary = ['核对任务的输入条件，确认需要读取的资料范围。', '比较已返回的证据，区分服务提供的信息与尚未确认的内容。', '整理结果，并保留可核对的来源与限制。'].join('\n\n');
  const call = observeModelReplies(options => readCodexSseResponse(new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {
    id: 'resp-fixture-001', status: 'completed', model: 'fixture-reasoning-model', usage: { input_tokens: 2840, output_tokens: 620, total_tokens: 3460, input_tokens_details: { cached_tokens: 1600 }, output_tokens_details: { reasoning_tokens: 420 } },
    output: [{ type: 'reasoning', id: 'rs-1', summary: [{ type: 'summary_text', text: summary }] }, { type: 'message', content: [{ type: 'output_text', text: '验收样本' }] }],
  } })}\n\n`), options), (_, event) => recorder.event(event));
  await call({ model: 'fixture-requested-model', onDelta() {} });
  recorder.event({ kind: 'operation', id: 'calc', module: 'compute', name: 'calculator', status: 'completed', expression: '15 * 15', result: '225' });
  await recorder.finish('completed', { id: 'answer' });
  await writeFile(join(home, 'desktop/state.json'), JSON.stringify({ chats: [{ id: 'telemetry-chat', title: 'fixture', messages: [{ id: 'answer', role: 'assistant', content: 'fixture', metadata: { runId: 'telemetry-browser' } }] }], chatRuns: [{ runId: 'telemetry-browser', chatId: 'telemetry-chat', status: 'completed', createdAt: new Date().toISOString() }] }));
  let browser;
  const child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], { cwd: resolve('.'), env: { ...env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_DREAMING_ENABLED: '0', MELO_MEMORY_RUNTIME: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let log = '';
  child.stderr.on('data', c => { log += c; });
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(log.slice(-1500))), 15000);
      child.stdout.on('data', c => { log += c; const match = log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(log.slice(-1500))); });
    });
    browser = await launchTestChrome(chromium);
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const index = await readFile('desktop-ui/index.html', 'utf8');
    const importmap = index.match(/<script type="importmap">[\s\S]*?<\/script>/)[0];
    await page.route('**/telemetry-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/executionPanel.css"><link rel="stylesheet" href="/neuralGlass.css">${importmap}<style>body{margin:0;background:#090c12;color:#d8c8af;font-family:system-ui;padding:24px;box-sizing:border-box}h1{font-size:17px;font-weight:500}body>p{font-size:11px;color:#8b98a5}.execution-panel-stage{height:510px!important}.execution-panel{margin-top:22px}@media(max-width:500px){body{padding:10px}.execution-panel-stage{height:520px!important}}</style></head><body><h1>NEURAL / API 观察验收</h1><p>本地协议样本 · 非真实模型调用</p><main id="fixture"></main><script type="module">
      import * as panel from '/executionPanel.js';
      document.querySelector('#fixture').innerHTML=panel.renderExecutionPanel();
      panel.syncExecutionPanel({chat:{id:'telemetry-chat',messages:[]},autoCollapse:false});
      window.fixtureReady=true;
    </script></body></html>` }));
    await page.goto(base + '/telemetry-fixture');
    await page.waitForFunction(() => window.fixtureReady);
    await page.getByRole('button', { name: /展开回看/ }).click();
    await page.locator('.execution-signal').waitFor();
    assert.match(await page.locator('.execution-signal').innerText(), /2,840/);
    await page.locator('.execution-webgl canvas').waitFor();
    await page.screenshot({ path: join(proof, 'overview.png') });
    await page.locator('.execution-signal').click();
    await page.locator('.execution-inspector').waitFor();
    assert.match(await page.locator('.execution-inspector').innerText(), /resp-fixture-001/);
    assert.match(await page.locator('.execution-inspector').innerText(), /推理 token/);
    await page.screenshot({ path: join(proof, 'api-detail.png') });
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '进入分析与计算' }).click();
    const records = page.locator('.execution-reasoning-records');
    await records.waitFor(); assert.match(await records.innerText(), /225/); assert.match(await records.innerText(), /15 \* 15/);
    const zoom = await page.locator('.execution-panel-stage').getAttribute('data-zoom');
    await records.hover(); await page.mouse.wheel(0, 200);
    assert.equal(await page.locator('.execution-panel-stage').getAttribute('data-zoom'), zoom);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(proof, 'narrow-summary.png') });
    await records.getByRole('button').first().click();
    assert.match(await page.locator('.execution-inspector').innerText(), /整理结果/);
    await page.screenshot({ path: join(proof, 'narrow-detail.png') });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited; clearTimeout(timeout);
    await rm(home, { recursive: true, force: true });
  }
});
