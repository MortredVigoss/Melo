// Plan C (2026-11-05): the task-space board, rail and camera views in a real
// browser against a real Melo server. Every figure on the board is compared
// with the value the shared ledger computed for the same fixture.
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
import { createExecutionScene, applyExecutionEvent } from '../src/shared/executionScene.js';
import { updateTaskEvaluation, taskEvaluationSnapshot } from '../shared/agent/taskEvaluation.js';

const goal = 'Find weekend music or outdoor events in Melbourne for two people';
const observations = [
  { id: 'job-1:r1', name: 'fetch_url', ok: true, executed: true, reading: 'extracted', url: 'https://a.example/1', text: 'Twilight Sessions. Saturday 8 November 2026 7:00pm. Sidney Myer Music Bowl. Free public entry, all welcome.' },
  { id: 'job-1:r2', name: 'fetch_url', ok: true, executed: true, reading: 'extracted', url: 'https://a.example/2', text: 'Heritage Walk. Sunday 9 November 2026 10:00am. Royal Botanic Gardens. Bookings open to the public.' },
];
const event = (name, startsAt, place, quote, id, match, tags) => ({ evidence: [{ id, quote }], fields: { name, startsAt, place, participation: 'public' }, match, diversity: 8, reason: 'fits two people', tags });
function ledger() {
  const steps = [
    { action: 'contract', data: JSON.stringify({ category: 'events', unit: 'events', coverage: ['music', 'outdoor'] }) },
    { action: 'batch', data: JSON.stringify({ items: [event('Twilight Sessions', '2026-11-08T19:00:00+11:00', 'Sidney Myer Music Bowl', 'Saturday 8 November 2026 7:00pm. Sidney Myer Music Bowl. Free public entry', 'job-1:r1', 34, ['music', 'outdoor']), { fields: { name: 'Laneway Jazz' }, match: 20, diversity: 5, reason: 'title only', tags: [] }], gaps: [] }) },
    { action: 'batch', data: JSON.stringify({ items: [event('Heritage Walk', '2026-11-09T10:00:00+11:00', 'Royal Botanic Gardens', 'Sunday 9 November 2026 10:00am. Royal Botanic Gardens. Bookings open to the public', 'job-1:r2', 30, ['outdoor'])], gaps: [] }) },
  ];
  let state; return steps.map(step => (state = updateTaskEvaluation(state, step, { goal, revision: 1, observations, resourceUse: { elapsedMs: 9000, toolCalls: 4, inputTokens: 3000 } }), taskEvaluationSnapshot(state)));
}
const snapshots = ledger();
const T0 = Date.now() - 90000, at = s => new Date(T0 + s * 1000).toISOString();
function events(upTo = Infinity) {
  return [
    { kind: 'pipeline', id: 'task-evaluation:1', module: 'compute', name: 'Task evaluation', status: 'completed', evaluation: snapshots[0], at: at(2) },
    { kind: 'pipeline', id: 'internal:1', module: 'compute', name: '检索成员', role: 'research', limits: { rounds: 4 }, status: 'running', input: 'Find public weekend events and read the official pages', at: at(3) },
    { kind: 'operation', id: 'job-1:s1', module: 'search', name: 'web_search', status: 'running', query: 'Melbourne weekend music', at: at(4) },
    { kind: 'operation', id: 'job-1:s1', module: 'search', name: 'web_search', status: 'completed', resultSummary: '2 sources', at: at(6) },
    { kind: 'operation', id: 'job-1:f1', module: 'search', name: 'fetch_url', status: 'running', input: 'https://a.example/1', at: at(7) },
    { kind: 'pipeline', id: 'task-evaluation:2', module: 'compute', name: 'Task evaluation', status: 'completed', evaluation: snapshots[1], at: at(9) },
    { kind: 'operation', id: 'job-1:f1', module: 'search', name: 'fetch_url', status: 'completed', at: at(11) },
    { kind: 'pipeline', id: 'internal:1', status: 'completed', output: 'Two official pages read', at: at(12) },
    { kind: 'pipeline', id: 'task-evaluation:3', module: 'compute', name: 'Task evaluation', status: 'completed', evaluation: snapshots[2], at: at(14) },
    { kind: 'pipeline', id: 'goal-check:4', module: 'compute', messageId: 'stage.delivery', status: 'completed', output: 'Both picks verified against their pages', at: at(16) },
  ].slice(0, upTo);
}

test('task space board, rail and views show only recorded facts, rotate without misclicks and fit a phone', { timeout: 90000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'melo-task-space-'));
  const proof = resolve('.tmp/task-space-c-20261105');
  await mkdir(proof, { recursive: true });
  const recorder = createExecutionRecorder({ home, runId: 'board-run', chatId: 'board-chat' }, goal);
  recorder.scene.startedAt = at(0);
  for (const row of events()) recorder.event(row);
  await recorder.finish('completed', { id: 'answer' });
  const plain = createExecutionRecorder({ home, runId: 'plain-run', chatId: 'plain-chat' }, 'What is 2 + 2?');
  plain.event({ kind: 'operation', id: 'calc', module: 'compute', name: 'calculator', status: 'completed', expression: '2 + 2', result: '4' });
  await plain.finish('completed', { id: 'plain-answer' });
  await new Promise(r => setTimeout(r, 300));
  await writeFile(join(home, 'desktop/state.json'), JSON.stringify({ chats: [
    { id: 'board-chat', title: 'board', messages: [{ id: 'answer', role: 'assistant', content: 'ok', metadata: { runId: 'board-run' } }] },
    { id: 'plain-chat', title: 'plain', messages: [{ id: 'plain-answer', role: 'assistant', content: '4', metadata: { runId: 'plain-run' } }] }],
    chatRuns: [{ runId: 'board-run', chatId: 'board-chat', status: 'completed', createdAt: at(0) }, { runId: 'plain-run', chatId: 'plain-chat', status: 'completed', createdAt: at(0) }] }));
  let browser;
  const child = spawn(process.execPath, ['src/server.js', '--host', '127.0.0.1', '--port', '0'], { cwd: resolve('.'), env: { ...process.env, MELO_HOME: home, MELO_TEST_MODE: '1', MELO_DREAMING_ENABLED: '0', MELO_MEMORY_RUNTIME: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let log = ''; child.stderr.on('data', c => { log += c; });
  try {
    const base = await new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(log.slice(-1500))), 15000);
      child.stdout.on('data', c => { log += c; const match = log.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); ok(match[1]); } });
      child.once('exit', () => { clearTimeout(timer); fail(new Error(log.slice(-1500))); });
    });
    browser = await launchTestChrome(chromium);
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const index = await readFile('desktop-ui/index.html', 'utf8');
    const importmap = index.match(/<script type="importmap">[\s\S]*?<\/script>/)[0];
    const sheets = [...index.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => `<link rel="stylesheet" href="${m[1]}">`).join('');
    await page.route('**/task-space-fixture*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${sheets}${importmap}<style>body{margin:0;padding:18px;box-sizing:border-box;background:var(--bg)}</style></head><body><main class="chat-thread" id="fixture"></main><script type="module">
      import * as panel from '/executionPanel.js'; window.panel = panel;
      const chat = new URL(location.href).searchParams.get('chat');
      document.querySelector('#fixture').innerHTML = panel.renderExecutionPanel();
      panel.syncExecutionPanel({ chat: { id: chat, messages: [{ id: chat === 'plain-chat' ? 'plain-answer' : 'answer', role: 'assistant', content: 'x', metadata: { runId: chat === 'plain-chat' ? 'plain-run' : 'board-run' } }] }, autoCollapse: false, leadName: 'Fixture Lead' });
      window.fixtureReady = true;
    </script></body></html>` }));
    const open = async chat => {
      await page.goto(`${base}/task-space-fixture?chat=${chat}`); await page.waitForFunction(() => window.fixtureReady);
      const toggle = page.locator('[data-execution-action="toggle"]'); await toggle.waitFor();
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      await page.locator('.execution-webgl canvas').waitFor();
    };
    await open('board-chat');
    const board = page.locator('.execution-board-host');
    await board.locator('[data-card="score"]').waitFor();
    // Rail: only phases that happened, delivery last.
    assert.deepEqual(await page.locator('.execution-rail li').evaluateAll(rows => rows.map(row => row.dataset.phase)), ['contract', 'evaluate', 'dispatch', 'review', 'deliver']);
    // Board figures equal the shared ledger's own numbers.
    const last = snapshots.at(-1), top = Math.max(...last.candidates.filter(r => ['primary', 'alternative', 'eligible'].includes(r.tier)).map(r => r.total));
    assert.deepEqual(await board.locator('.execution-board-card').evaluateAll(cards => cards.map(card => card.dataset.card)), ['log', 'dispatch', 'score', 'heat', 'coverage', 'spec']);
    assert.equal(await board.locator('.execution-gauge .value').textContent(), String(top));
    assert.equal(await board.locator('.execution-ledger-total dd').textContent(), String(last.summary.discovered));
    assert.equal(await board.locator('.execution-heat tbody tr').count(), last.candidates.length);
    assert.equal(await board.locator('.execution-heat td[data-state="verified"]').count(), last.candidates.reduce((sum, row) => sum + Object.values(row.fields).filter(v => v === 'verified').length, 0));
    assert.match(await board.locator('[data-card="score"]').innerText(), new RegExp(`${last.policy.primaryScore}`));
    assert.match(await board.locator('[data-card="dispatch"]').innerText(), /#1/);
    assert.equal(await board.locator('.execution-log li').first().getAttribute('data-verb'), 'deliver');
    assert.equal(await board.locator('.execution-log li[data-verb="evaluate"]').count(), 3);
    assert.match(await board.locator('.execution-contract').innerText(), /name · startsAt · place · participation/);
    assert.match(await page.locator('.execution-core').innerText(), /Fixture Lead/);
    await page.screenshot({ path: join(proof, 'board-1280.png') });
    // Views: follow, free and global; a drag rotates and never selects a module.
    const webgl = page.locator('.execution-webgl');
    await page.locator('[data-execution-action="view"][data-view="follow"]').click();
    await page.waitForFunction(() => document.querySelector('.execution-webgl').dataset.viewMode === 'follow');
    assert.equal(await page.locator('[data-view="follow"]').getAttribute('aria-checked'), 'true');
    await page.locator('[data-execution-action="view"][data-view="global"]').click();
    await page.waitForFunction(() => document.querySelector('.execution-webgl').dataset.viewMode === 'global');
    const box = await page.locator('.execution-webgl canvas').boundingBox();
    // Start on empty space (labels are clickable and sit above the canvas).
    assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [box.x + 60, box.y + box.height - 70]), 'CANVAS');
    await page.mouse.move(box.x + 60, box.y + box.height - 70); await page.mouse.down();
    await page.mouse.move(box.x + 240, box.y + box.height - 100, { steps: 10 }); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.execution-webgl').dataset.viewMode === 'free');
    assert.notEqual(Number(await webgl.getAttribute('data-yaw')), 0);
    assert.equal(await page.locator('.execution-panel-stage').getAttribute('data-focus'), '', 'a drag is not a click');
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('melo-task-space-view'))).mode, 'free', 'the view is remembered on this device');
    await page.screenshot({ path: join(proof, 'free-1280.png') });
    // A zoomed-in detail is locked straight on: arrows do not rotate it.
    await page.locator('[data-execution-action="focus"][data-module="search"]').click();
    await page.waitForFunction(() => document.querySelector('.execution-panel-stage').dataset.wide === 'false');
    const yaw = await webgl.getAttribute('data-yaw');
    await page.locator('.execution-panel-stage').focus(); await page.keyboard.press('ArrowLeft');
    assert.equal(await webgl.getAttribute('data-yaw'), yaw);
    assert.equal(await page.locator('.execution-rail').count(), 0, 'the rail steps aside for a locked detail');
    await page.locator('[data-execution-action="view"][data-view="global"]').click();
    assert.equal(await page.locator('.execution-panel-stage').getAttribute('data-zoom'), '1.000');
    // Live updates: a new ledger batch flies candidates to the board; reduced motion does not.
    const live = async reduced => {
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await page.evaluate(() => document.querySelectorAll('.execution-candidate-flight').forEach(node => node.remove()));
      const scene = createExecutionScene({ runId: reduced ? 'live-reduced' : 'live-motion', chatId: 'board-chat', query: 'live', startedAt: at(0) });
      for (const row of events(5)) applyExecutionEvent(scene, row);
      await page.evaluate(scene => window.panel.receiveExecutionScene(scene), JSON.parse(JSON.stringify(scene)));
      await page.locator('[data-card="heat"]').waitFor();
      await page.waitForTimeout(400);
      applyExecutionEvent(scene, events(6)[5]);
      await page.evaluate(scene => window.panel.receiveExecutionScene(scene), JSON.parse(JSON.stringify(scene)));
      await page.waitForTimeout(250);
      return page.locator('.execution-candidate-flight').count();
    };
    assert.ok(await live(false) >= 1, 'new candidates fly to the board');
    assert.ok(await page.locator('.execution-webgl').getAttribute('data-actors').then(v => v.includes('member:1')), 'the running member has its own actor');
    assert.equal(await live(true), 0, 'reduced motion: no flights');
    // Phone width: one row of cards, no horizontal page overflow.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 393, height: 852 });
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(proof, 'board-393.png') });
    // An ordinary chat shows no board, rail or core label.
    await page.setViewportSize({ width: 1280, height: 1000 });
    await open('plain-chat');
    await page.locator('.execution-module').first().waitFor();
    assert.equal(await page.locator('.execution-board-host').isHidden(), true);
    assert.equal(await page.locator('.execution-rail').count(), 0);
    assert.equal(await page.locator('.execution-core').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited; clearTimeout(timeout);
    await rm(home, { recursive: true, force: true });
  }
});
