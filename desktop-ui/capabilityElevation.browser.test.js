import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { launchTestChrome } from '../src/testSupport/testChrome.js';
import { updateStateAtomically } from '../src/state/stateStore.js';
import { capabilitiesFromAtoms } from '../src/domain/agent/capabilityElevation.js';

// Capability elevation end to end (2026-10-20): Melo (main) delegates to
// Builder; Builder needs 『知识与记忆』, which main lacks but Builder's own
// settings allow → the prompt card appears in the chat → «本对话 24 小时» →
// the tool runs and the reply completes → the grant is listed on Builder's
// Agent page → revoke empties the list and the ledger.
test('beyond-parent prompt → approve → tool runs → grant listed → revoke', { timeout: 120000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-capability-browser-'));
  const proof = '.tmp/capability-elevation-20261020/screenshots';
  await mkdir(proof, { recursive: true });
  let browser;
  const requests = [];
  const respond = (res, output) => res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `fixture-${requests.length}`, model: 'fixture-model', status: 'completed', output } })}\n\n`);
  const text = value => [{ type: 'message', role: 'assistant', id: `m-${requests.length}`, status: 'completed', content: [{ type: 'output_text', text: value, annotations: [] }] }];
  const call = (name, args) => [{ type: 'function_call', id: `item-${requests.length}`, call_id: `call-${requests.length}`, name, arguments: JSON.stringify(args), status: 'completed' }];
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const tools = (body.tools || []).map(tool => tool.name || tool.function?.name);
    const outputs = (body.input || []).filter(item => item.type === 'function_call_output');
    requests.push({ tools, outputs: outputs.length, body: raw });
    res.setHeader('content-type', 'text/event-stream');
    if (!req.url.endsWith('/responses')) { res.end('data: [DONE]\n\n'); return; }
    if (tools.includes('delegate')) return respond(res, outputs.length ? text('主 Agent 已完成。') : call('delegate', { agentId: 'builder', task: '查一下以前的对话', instructions: null }));
    // Builder's member loop (no delegate tool at depth 1); anything else (titles…) gets plain text.
    if (tools.includes('search_history')) return respond(res, outputs.length ? text('Builder 查完了。') : call('search_history', { query: '月亮', limit: null, after: null, chatId: null, scope: null }));
    return respond(res, text('好的'));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  await writeFile(join(home, 'config.json'), JSON.stringify({ authMode: 'api-key', apiProtocol: 'responses', apiKey: 'fixture-key', model: 'fixture-model', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, conversationModelSelected: true }));
  await updateStateAtomically(state => {
    state.agentProfiles.main.capabilities = capabilitiesFromAtoms(['readFiles', 'delegate']);
    state.agentProfiles.main.collaboration = { ...state.agentProfiles.main.collaboration, canDelegate: true, delegateTargets: ['builder'] };
    state.agentProfiles.builder.capabilities = capabilitiesFromAtoms(['readFiles', 'knowledgeMemory']);
    return state;
  }, { home });
  const child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], { env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_MEMORY_RUNTIME: '0', MELO_DREAMING_ENABLED: '0',
    MELO_AUTH_MODE: 'api-key', MELO_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, MELO_API_KEY: 'fixture-key', MELO_MODEL: 'fixture-model' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'exit');
  t.after(async () => { try { await browser?.close(); } finally { model.closeAllConnections(); model.close(); const kill = setTimeout(() => child.kill('SIGKILL'), 5000); child.kill('SIGTERM'); await closed; clearTimeout(kill); await rm(home, { recursive: true, force: true, maxRetries: 5 }); } });
  const base = await new Promise((resolve, reject) => { let log = ''; const timer = setTimeout(() => reject(Error(`Startup timeout ${log}`)), 15000); child.stdout.on('data', chunk => { log += chunk; const m = log.match(/listening at (http:\/\/[^\s]+)/i); if (m) { clearTimeout(timer); resolve(m[1].replace(/\/$/, '')); } }); child.stderr.on('data', chunk => { log += chunk; }); });
  const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.status, 200, path); return r.json(); };
  const chatId = (await post('/api/chats', { projectId: null, mode: 'chat' })).activeChat.id;
  await post('/api/settings', { activeMode: 'chat', activeView: 'chat', selectedChatId: chatId });

  browser = await launchTestChrome(chromium);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Headless Chrome asks for /favicon.ico on its own (the native WebView does not); that 404 is not the page's.
  page.on('console', message => { if (message.type() === 'error' && !/favicon\.ico$/.test(message.location()?.url || '')) errors.push(`${message.text()} ${message.location()?.url || ''}`); });
  const failed = [];
  page.on('response', response => { if (response.status() >= 400) failed.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  // This fixture asserts Chinese labels; set the preference explicitly, independent of the host locale.
    assert.equal((await fetch(base + '/api/settings/local', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({preferences:{interfaceLanguage:'zh-CN'}})})).status,200);
    await page.goto(base);
  const composer = page.locator('#composer');
  await composer.waitFor();
  await composer.fill('请让 Builder 查一下以前的对话');
  await composer.press('Enter');

  // The prompt card: beyond the parent, inside Builder's own settings.
  const card = page.locator('.capability-prompt-shell');
  await card.waitFor({ timeout: 20000 });
  assert.match(await card.textContent(), /需要『知识与记忆』，.*没有这个能力/);
  const options = await card.locator('[data-action="capability-request-respond"]').allTextContents();
  assert.deepEqual(options.map(s => s.trim()), ['仅本次任务', '本对话 24 小时', '拒绝']);
  assert.equal(await page.locator('[role=dialog][aria-labelledby^="capability-prompt-title"]').count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.decision), 'run', 'the first option has keyboard focus');
  await page.screenshot({ path: join(proof, 'prompt.png') });
  await card.locator('[data-decision="project"]').click();
  await card.waitFor({ state: 'detached', timeout: 10000 });

  // The tool ran inside Builder's loop and the turn finished.
  await page.locator('[data-action=stop-send]').waitFor({ state: 'detached', timeout: 30000 });
  assert.ok(requests.some(r => !r.tools.includes('delegate') && r.outputs > 0), 'Builder got the search_history result');
  const boot = async () => (await fetch(base + '/api/bootstrap')).json();
  const chat = (await boot()).activeChat;
  assert.equal(chat.messages.at(-1).role, 'assistant');
  let grants = (await (await fetch(`${base}/api/capability-grants`)).json()).grants;
  assert.equal(grants.length, 1);
  assert.deepEqual([grants[0].agentId, grants[0].scope, grants[0].atoms.join()], ['builder', 'chat', 'knowledgeMemory']);

  // Builder's Agent page lists it; revoke empties the list and the ledger.
  await post('/api/settings', { activeView: 'agent', selectedAgentId: 'builder', selectedAgentScope: 'global' });
  await page.reload();
  const row = page.locator('.capability-grant-row');
  await row.first().waitFor({ timeout: 10000 });
  assert.match(await row.first().textContent(), /知识与记忆[\s\S]*本对话 24 小时/);
  await page.screenshot({ path: join(proof, 'grant-listed.png') });
  await row.first().locator('[data-action="capability-grant-revoke"]').click();
  await row.first().waitFor({ state: 'detached', timeout: 10000 });
  await page.locator('.capability-grants').filter({ hasText: '这个 Agent 还没有临时授权' }).waitFor({ timeout: 10000 });
  grants = (await (await fetch(`${base}/api/capability-grants`)).json()).grants;
  assert.deepEqual(grants, []);
  assert.deepEqual(failed, []);
  assert.deepEqual(errors, []);
});
