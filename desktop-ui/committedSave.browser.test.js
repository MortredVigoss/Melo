import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { launchTestChrome } from '../src/testSupport/testChrome.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'melo-committed-save-'));
  const child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], {
    env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_MEMORY_RUNTIME: '0', MELO_DREAMING_ENABLED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'exit');
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.kill('SIGTERM'); await closed; clearTimeout(timer);
      await rm(home, { recursive: true, force: true });
    }
  });
  const base = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error(log.slice(-2000))), 15000);
    child.stderr.on('data', value => { log += value; });
    child.stdout.on('data', value => {
      log += value;
      const match = log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Server stopped')); });
  });
  const api = async (path, body) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin: base }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, 200);
    return response.json();
  };
  browser = await launchTestChrome(chromium);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  return { page, api, open: () => page.goto(base) };
}

// The mutation really runs and commits. Only its response is replaced with
// the server's post-commit fallback; GET failures affect this browser alone.
async function failPageReadsAfterCommit(page, api, path, receiptFor) {
  let posts = 0, receipt;
  await page.route(`**${path}`, async route => {
    posts++;
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const bootstrap = await api('/api/bootstrap');
    receipt = { revision: bootstrap.stateRevision, changedIds: [], removedIds: [], ...receiptFor(bootstrap) };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, receipt, bootstrapError: { code: 'BOOTSTRAP_UNAVAILABLE', message: 'fixture rebuild failed' } }) });
  });
  const failRead = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture reload unavailable' }) });
  await page.route('**/api/bootstrap', failRead);
  return { posts: () => posts, receipt: () => receipt, recover: () => page.unroute('**/api/bootstrap', failRead) };
}

const retryButton = page => page.locator('[data-action=retry-committed-save]');

test('committed Agent create: repeated read failures never edit the old Agent or repeat the create', { timeout: 60000 }, async t => {
  const { page, api, open } = await fixture(t);
  await api('/api/settings', { activeView: 'agent', selectedAgentId: 'research', selectedAgentScope: 'global' });
  const before = await api('/api/bootstrap');
  await open();
  const form = page.locator('form[data-form=agent-profile-update]');
  await form.waitFor();
  const failures = await failPageReadsAfterCommit(page, api, '/api/agents/create-custom', boot => ({ agentId: boot.settings.selectedAgentId, scope: 'global' }));
  await page.locator('[data-action=create-custom-agent]').click();
  await retryButton(page).waitFor();
  assert.equal(await form.getAttribute('data-agent-id'), 'research');
  assert.equal(await form.locator('[name=name]').isDisabled(), true);
  assert.equal(await page.locator('[data-action=create-custom-agent]').isDisabled(), true);
  const failedReload = page.waitForResponse(r => r.url().endsWith('/api/bootstrap') && r.status() === 503);
  await retryButton(page).click(); await failedReload;
  await page.waitForFunction(() => document.querySelector('[data-action=retry-committed-save]')?.disabled === false);
  assert.equal(failures.posts(), 1);
  assert.equal(await form.locator('[name=name]').isDisabled(), true);
  await failures.recover(); await retryButton(page).click();
  await page.waitForFunction(id => document.querySelector('form[data-form=agent-profile-update]')?.dataset.agentId === id && !document.querySelector('form[data-form=agent-profile-update] [name=name]')?.disabled, failures.receipt().agentId);
  await form.locator('[name=name]').fill('The newly created Agent');
  await form.locator('[data-action=form-settings-save]').click();
  await form.locator('[data-edit-status=saved]').waitFor();
  const after = await api('/api/bootstrap');
  assert.equal(after.customize.agents.length, before.customize.agents.length + 1);
  assert.deepEqual(after.customize.agents.find(a => a.id === 'research'), before.customize.agents.find(a => a.id === 'research'));
  assert.equal(after.customize.agents.find(a => a.id === failures.receipt().agentId).name, 'The newly created Agent');
  assert.equal(failures.posts(), 1);
});

test('committed Agent update: saved values remain visible until a read-only retry recovers the page', { timeout: 60000 }, async t => {
  const { page, api, open } = await fixture(t);
  await api('/api/settings', { activeView: 'agent', selectedAgentId: 'research', selectedAgentScope: 'global' });
  await open();
  const form = page.locator('form[data-form=agent-profile-update]'); await form.waitFor();
  await form.locator('[data-action=form-settings-edit]').click();
  await form.locator('[name=instructions]').fill('Keep these committed instructions.');
  const failures = await failPageReadsAfterCommit(page, api, '/api/agents/update', () => ({ agentId: 'research', scope: 'global' }));
  await form.locator('[data-action=form-settings-save]').click();
  await retryButton(page).waitFor();
  assert.equal(await form.locator('[name=instructions]').inputValue(), 'Keep these committed instructions.');
  assert.equal(await form.locator('[data-action=form-settings-save]').isDisabled(), true);
  assert.equal((await api('/api/bootstrap')).customize.agents.find(a => a.id === 'research').instructions, 'Keep these committed instructions.');
  await failures.recover(); await retryButton(page).click();
  await form.locator('[data-edit-status=saved]').waitFor();
  assert.equal(await form.locator('[name=instructions]').inputValue(), 'Keep these committed instructions.');
  assert.equal(failures.posts(), 1);
});

test('committed project create: repeated submit and refresh perform only one create', { timeout: 60000 }, async t => {
  const { page, api, open } = await fixture(t);
  await api('/api/settings', { activeView: 'projects', selectedProjectId: null });
  const before = await api('/api/bootstrap');
  await open();
  await page.locator('[data-action=toggle-project-form]').click();
  const form = page.locator('form[data-form=project-create]');
  await form.locator('[name=name]').fill('Committed project');
  const failures = await failPageReadsAfterCommit(page, api, '/api/projects', boot => ({ projectId: boot.activeProject.id }));
  await form.evaluate(node => node.requestSubmit());
  await retryButton(page).waitFor();
  await form.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await failures.recover(); await retryButton(page).click();
  await page.locator(`form[data-form=project-update][data-project-id="${failures.receipt().projectId}"]`).waitFor();
  const after = await api('/api/bootstrap');
  assert.equal(after.projects.length, before.projects.length + 1);
  assert.equal(after.activeProject.name, 'Committed project');
  assert.equal(failures.posts(), 1);
});
