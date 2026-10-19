import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { launchTestChrome } from '../src/testSupport/testChrome.js';

test('startup has no MCP dialog or enable requests, and manual disable survives server restart', { timeout: 90000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'melo-mcp-browser-'));
  await writeFile(join(home, 'config.json'), JSON.stringify({ productivityMcpsConsented: false,
    enableAntvChartMcp: false, enableMarkdown2PdfMcp: false, enableMermaidMcp: false,
    imageSettings: { quality: 'high' },
  }));
  let child, exited, browser, log = '';
  const start = async () => {
    child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], {
      cwd: resolve('.'), env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_DREAMING_ENABLED: '0', MELO_MEMORY_RUNTIME: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    exited = once(child, 'exit');
    child.stderr.on('data', c => { log += c; });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(log.slice(-1500))), 20000);
      child.stdout.on('data', c => { const match = String(c).match(/listening at (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(log.slice(-1500))); });
    });
  };
  const stop = async () => { child?.kill('SIGTERM'); await exited; child = null; };
  try {
    let base = await start();
    browser = await launchTestChrome(chromium);
    const page = await browser.newPage();
    const writes = [], errors = [];
    page.on('request', r => { if (r.method() === 'POST' && /\/api\/(mcp|settings\/model)/.test(r.url())) writes.push(r.url()); });
    page.on('pageerror', e => errors.push(e.message));
    // Even a stale bootstrap from an old server must not revive the retired UI.
    await page.route('**/api/bootstrap*', async route => {
      const response = await route.fetch();
      const body = await response.json();
      if (body.settings?.config) body.settings.config.productivityMcpsConsented = false;
      await route.fulfill({ response, json: body });
    });
    for (let i = 0; i < 2; i++) {
      await page.goto(base);
      await page.locator('#composer').waitFor();
      assert.equal(await page.locator('[aria-label="Productivity MCP consent"]').count(), 0);
      assert.equal(await page.locator('[data-action^="productivity-mcps-"]').count(), 0);
    }
    assert.deepEqual(writes, [], 'rendering must never run the old three sequential enable calls');
    const response = await fetch(base + '/api/mcp/preset-toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flag: 'enableMermaidMcp', enabled: false }) });
    assert.equal(response.ok, true);
    const saved = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    assert.equal(saved.enableMermaidMcp, false);
    assert.equal(saved.enableAntvChartMcp, true);
    assert.equal(saved.enableMarkdown2PdfMcp, true);
    assert.equal(saved.productivityMcpsConsented, true);
    assert.equal(saved.enableBrowserlessMcp, false);
    assert.equal(saved.imageSettings.quality, 'high');
    await stop(); base = await start();
    await page.goto(base); await page.locator('#composer').waitFor();
    assert.equal(await page.locator('[aria-label="Productivity MCP consent"]').count(), 0);
    assert.equal(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).enableMermaidMcp, false);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); await stop(); await rm(home, { recursive: true, force: true });
  }
});
