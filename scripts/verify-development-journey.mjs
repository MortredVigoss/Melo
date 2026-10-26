// Real UI, HTTP, executor and Docker; only the model provider is a deterministic
// fixture. No real credentials, repository, application or account are changed.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { launchTestChrome } from '../src/testSupport/testChrome.js';
import { createGit } from '../src/development/git.js';
import { digest } from '../src/development/runner.js';

const root = await mkdtemp(join(tmpdir(), 'melo-dev-journey-')), home = join(root, 'home'), repo = join(root, 'repo');
await mkdir(repo); await mkdir(home);
const git = createGit(process.env);
await git.invoke(['init', '-b', 'main'], repo);
await writeFile(join(repo, 'app.cjs'), 'module.exports = 1;\n');
await writeFile(join(repo, 'check.cjs'), "require('node:assert/strict').equal(require('./app.cjs'),2);\n");
await git.invoke(['add', '.'], repo); await git.invoke(['commit', '-m', 'fixture baseline'], repo);
const baseline = await git.invoke(['rev-parse', 'HEAD'], repo);
let builds = 0, reviews = 0;
const model = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const checking = JSON.stringify(body.messages).includes("Melo's task completion checker");
  const checkingInput = checking ? body.messages.filter(message => message.role === 'user').map(message => { try { return JSON.parse(message.content); } catch { return {}; } }).find(value => value.observations) : null;
  const reviewing = JSON.stringify(body.messages).includes('Review the fixed candidate');
  const turn = checking ? 0 : reviewing ? ++reviews : ++builds;
  const content = checking ? JSON.stringify({ decision: 'complete', reasonType: 'fulfilled', reason: 'Fixture evidence satisfies this bounded stage', nextStep: '', requirements: [{ text: checkingInput.goal, status: 'met', evidenceIds: checkingInput.observations.filter(row => row.ok && row.executed).map(row => row.id) }] }) : reviewing
    ? turn === 1 ? '<tool_call>{"name":"candidate_read","arguments":{"path":"@evidence"}}</tool_call>' : JSON.stringify({ status: 'completed', review: 'approve', conclusion: 'Fixture reviewer checked fixed source and passing verification receipt', evidence: ['@evidence'], unfinished: [] })
    : turn === 1 ? `<tool_call>${JSON.stringify({ name: 'candidate_write', arguments: { path: 'app.cjs', expectedHash: digest('module.exports = 1;\n'), content: 'module.exports = 2;\n' } })}</tool_call>` : JSON.stringify({ status: 'completed', conclusion: 'Changed the candidate to return 2', changedFiles: ['app.cjs'], unfinished: [] });
  if (!body.stream) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'fixture', model: body.model, choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ id: 'fixture', model: body.model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');
await writeFile(join(home, 'config.json'), JSON.stringify({ authMode: 'api-key', apiKey: 'fixture-only', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'fixture', apiProtocol: 'chat-completions', toolCalling: 'legacy', modelCatalogs: { 'api-key': ['fixture'] } }));
const child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], { cwd: process.cwd(), env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_FUNCTION_CALLING: 'legacy', MELO_MEMORY_RUNTIME: '0', MELO_DREAMING_ENABLED: '0', MELO_MOCK_RESPONSE: '', MELO_API_KEY: '', OPENAI_API_KEY: '', MELO_BASE_URL: '', OPENAI_BASE_URL: '', MELO_MODEL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
const closed = once(child, 'exit'); let log = '', browser;
child.stderr.on('data', chunk => { log += chunk; });
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(log.slice(-4000))), 25000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(log.slice(-4000))); });
    child.stdout.on('data', chunk => { log += chunk; const match = log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const post = async (path, body) => { const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result; };
  await post('/api/settings', { activeView: 'customize', selectedCustomizeSection: 'advanced' });
  browser = await launchTestChrome(chromium);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-development-panel]').waitFor({ timeout: 25000 });
  await page.locator('[data-development-panel] > details > summary').click();
  const form = page.locator('[data-development-form]');
  await form.locator('[name=repository]').fill(repo); await form.locator('[name=goal]').fill('Make the candidate return 2 and preserve the original repository');
  await form.locator('[name=agentId]').selectOption('builder'); await form.locator('[name=reviewerId]').selectOption('reviewer');
  await form.locator('[name=commands]').fill('[["node","check.cjs"]]');
  await form.locator('[name=image]').fill('node:22-bookworm');
  await page.locator('[data-action=development-create]').click();
  await page.locator('[data-action=development-start]').waitFor({ timeout: 15000 });
  const id = await page.locator('[data-action=development-start]').getAttribute('data-id');
  await page.locator('[data-action=development-start]').click();
  const deadline = Date.now() + 60000; let detail;
  while (Date.now() < deadline) {
    detail = await (await fetch(`${base}/api/development/job?id=${id}`)).json();
    if (!['created', 'implementing', 'testing', 'reviewing'].includes(detail.job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(detail.job.status, 'awaiting_merge', JSON.stringify(detail));
  await page.locator('[data-action=development-refresh]').click();
  await page.locator('[data-action=development-export]').waitFor({ timeout: 10000 });
  await page.locator('[data-action=development-export]').click();
  await page.waitForFunction(() => document.querySelector('[data-development-panel]')?.textContent.includes('candidate-bundle.json'));
  await page.screenshot({ path: join(root, 'development-panel.png'), fullPage: true });
  assert.deepEqual(errors, []);
  assert.equal(await readFile(join(repo, 'app.cjs'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(await git.invoke(['rev-parse', 'HEAD'], repo), baseline);
  const receipt = { root, id, status: detail.job.status, baseSha: baseline, headSha: detail.job.headSha, tests: detail.job.tests, review: detail.job.review, builds, reviews, browserErrors: errors, model: 'deterministic fixture', container: 'real Docker', merged: false };
  await writeFile(join(root, 'acceptance.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser?.close(); model.close();
  const kill = setTimeout(() => child.kill('SIGKILL'), 5000); child.kill('SIGTERM'); await closed; clearTimeout(kill);
  await writeFile(join(root, 'server.log'), log);
}
