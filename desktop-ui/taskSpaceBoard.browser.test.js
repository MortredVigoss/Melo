// Plan C (2026-11-05), layout A (2026-11-06): the full-screen war room in a
// real browser against a real Melo server. Every figure on the band is
// compared with the value the shared ledger computed for the same fixture,
// every number opens exactly the records it counts, the war room opens by
// itself for a live run, spiders hand finished calls to their rows, and the
// space rotates and zooms by drag, wheel, pinch, keys and buttons.
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
import { deliveryGate } from '../src/shared/warRoom.js';
import { stageMargin } from './warRoomLayout.js';

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

test('war room shows only recorded facts, traces every number, opens by itself, rotates and zooms without misclicks and fits a phone', { timeout: 120000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'melo-task-space-'));
  const proof = resolve('.tmp/task-space-board-20261105');
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
      const toggle = page.locator('#execution-panel [data-execution-action="toggle"]'); await toggle.waitFor();
      if (await page.locator('#execution-war-room').evaluate(el => el.hidden)) await toggle.click();
      await page.locator('#execution-war-room .war-gl canvas').waitFor();
    };
    const room = page.locator('#execution-war-room'), gl = room.locator('.war-gl'), band = room.locator('.war-band'), detail = room.locator('[data-cell="detail"]');
    const count = async () => Number((await detail.locator('.war-count').innerText()).match(/\d+/)[0]);
    const back = () => detail.locator('[data-war-back]').click();
    // The global view's promise: every region's outline on the stage, its labels' room kept.
    const framed = async label => {
      const value = await page.waitForFunction(() => { const el = document.querySelector('#execution-war-room .war-gl'), b = el?.dataset.bounds?.split(',').map(Number); return b && b[4] === el.clientWidth && b[5] === el.clientHeight && el.dataset.bounds; }).then(handle => handle.jsonValue());
      const [x0, y0, x1, y1, width, height] = value.split(',').map(Number), margin = stageMargin(width, height);
      assert.ok(x0 >= margin.x - 3 && x1 <= width - margin.x + 3 && y0 >= margin.y - 3 && y1 <= height - margin.y + 3, `${label}: outlines span ${x0},${y0} – ${x1},${y1} on a ${width}×${height} stage`);
    };
    await open('board-chat');
    await framed('the opening frame');
    await band.locator('[data-cell="gate"] .war-gate').waitFor();
    // Rail: only phases that happened, delivery last.
    assert.deepEqual(await room.locator('.war-rail li').evaluateAll(rows => rows.map(row => row.dataset.phase)), ['contract', 'evaluate', 'dispatch', 'review', 'deliver']);
    // Band figures equal the shared ledger's own numbers.
    const last = snapshots.at(-1), qualified = last.candidates.filter(r => ['primary', 'alternative', 'eligible'].includes(r.tier)), top = Math.max(...qualified.map(r => r.total));
    assert.deepEqual(await band.locator('.war-cell').evaluateAll(cells => cells.map(cell => cell.dataset.cell)), ['log', 'dispatch', 'gate', 'heat', 'coverage', 'contract']);
    const gate = deliveryGate(last);
    assert.deepEqual(await band.locator('.war-gate li .war-num').evaluateAll(rows => rows.map(row => row.textContent.replace(' ✓', ''))), gate.rows.map(row => row.value));
    assert.equal(await band.locator('.war-heat tbody tr[data-row-key]').count(), last.candidates.length);
    assert.equal(await band.locator('.war-heat td[data-s="verified"]').count(), last.candidates.reduce((sum, row) => sum + Object.values(row.fields).filter(v => v === 'verified').length, 0));
    assert.match(await band.locator('[data-war-trace="candidates:top"]').innerText(), new RegExp(String(top)));
    assert.match(await band.locator('[data-cell="dispatch"]').innerText(), /#1/);
    assert.equal(await band.locator('.war-log li').first().getAttribute('data-verb'), 'deliver');
    assert.equal(await band.locator('.war-log li[data-verb="evaluate"]').count(), 3);
    assert.match(await band.locator('.war-contract').innerText(), /名称 · 时间 · 地点 · 参与方式/);
    await room.locator('.war-caption.is-core').waitFor();
    assert.match(await room.locator('.war-caption.is-core').innerText(), /Fixture Lead/);
    await page.screenshot({ path: join(proof, 'war-room-1280.png') });
    // Every number opens exactly the records it counts.
    const statusCalls = Number((await room.locator('.war-status [data-war-trace="calls"]').innerText()).match(/\d+/)[0]);
    await room.locator('.war-status [data-war-trace="calls"]').click();
    assert.equal(await count(), statusCalls); assert.equal(await detail.locator('.war-trace > li').count(), statusCalls); await back();
    await band.locator('[data-war-trace="candidates:all"]').click();
    assert.equal(await count(), last.candidates.length); await back();
    await band.locator('[data-war-trace="gate:count"]').click();
    assert.equal(await count(), qualified.length); await back();
    const memberCalls = Number((await band.locator('[data-war-trace="member:1"]').innerText()).match(/\d+/)[0]);
    await band.locator('[data-war-trace="member:1"]').click();
    assert.equal(await count(), memberCalls); await back();
    const regionCalls = [];
    for (const id of ['search', 'files', 'compute', 'tools', 'create']) {
      await room.locator(`.war-caption.is-region[data-war-region="${id}"]`).click();
      const calls = await detail.locator('.war-trace > li[data-status] button[data-war-record]').evaluateAll(rows => rows.filter(row => !/^(model|reply|task-evaluation|goal-check|internal)/.test(row.dataset.warRecord)).length);
      regionCalls.push(calls);
      await page.waitForFunction(id => document.querySelector('#execution-war-room .war-gl').dataset.view === `region:${id}`, id); // a region click focuses the camera on it
      await back();
    }
    assert.equal(regionCalls.reduce((a, b) => a + b, 0), statusCalls, 'the regions add up to the total; nothing counts twice');
    assert.equal(regionCalls[3], 0, 'no web search counts under 工具调用');
    // Views: follow, free and global; a drag rotates and never opens a region.
    await room.locator('[data-war-view="follow"]').click();
    await page.waitForFunction(() => document.querySelector('#execution-war-room .war-gl').dataset.view === 'follow');
    await room.locator('[data-war-view="global"]').click();
    await page.waitForFunction(() => document.querySelector('#execution-war-room .war-gl').dataset.view === 'global');
    const box = await room.locator('.war-gl canvas').boundingBox();
    assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [box.x + 30, box.y + box.height - 40]), 'CANVAS');
    const camera = await gl.getAttribute('data-camera');
    await page.mouse.move(box.x + 30, box.y + box.height - 40); await page.mouse.down();
    await page.mouse.move(box.x + 260, box.y + box.height - 90, { steps: 12 }); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('#execution-war-room .war-gl').dataset.view === 'free');
    await page.waitForFunction(c => document.querySelector('#execution-war-room .war-gl').dataset.camera !== c, camera);
    assert.equal(await band.getAttribute('data-mode'), 'board', 'a drag is not a click');
    // Wheel, trackpad pinch (ctrl + wheel), two-finger pinch, keys and buttons all zoom.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -300);
    await page.waitForFunction(() => Number(document.querySelector('#execution-war-room .war-gl').dataset.zoom) > 1.2);
    await page.evaluate(() => { const canvas = document.querySelector('#execution-war-room .war-gl canvas'), r = canvas.getBoundingClientRect(), y = r.top + r.height / 2;
      const fire = (type, id, x) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, isPrimary: id === 11 }));
      fire('pointerdown', 11, r.left + 300); fire('pointerdown', 12, r.left + 400); fire('pointermove', 11, r.left + 340); fire('pointermove', 12, r.left + 360); fire('pointerup', 11, r.left + 340); fire('pointerup', 12, r.left + 360); });
    await page.waitForFunction(() => Number(document.querySelector('#execution-war-room .war-gl').dataset.zoom) < 1.2); // pinching in zooms out
    await room.locator('[data-war-zoom="in"]').click();
    assert.match(await room.locator('.war-zoom-value').innerText(), /%/);
    await room.locator('.war-stage').focus(); const before = await gl.getAttribute('data-camera');
    await page.keyboard.press('ArrowLeft'); await page.waitForFunction(c => document.querySelector('#execution-war-room .war-gl').dataset.camera !== c, before);
    await page.keyboard.press('0'); await page.waitForFunction(() => document.querySelector('#execution-war-room .war-gl').dataset.view === 'global');
    await page.screenshot({ path: join(proof, 'war-room-free-1280.png') });
    // Back in the default view, any window size keeps all five regions on the stage.
    for (const [width, height] of [[1024, 700], [1440, 900], [1920, 1080], [1280, 1000]]) { await page.setViewportSize({ width, height }); await framed(`${width}×${height}`); }
    // A live run opens the war room by itself; its spider hands each finished call to its row.
    const live = async reduced => {
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await open('board-chat'); await room.locator('[data-war-close]').click();
      assert.equal(await room.evaluate(el => el.hidden), true);
      const scene = createExecutionScene({ runId: reduced ? 'live-reduced' : 'live-motion', chatId: 'board-chat', query: 'live', startedAt: at(0) });
      for (const row of events(5)) applyExecutionEvent(scene, row);
      await page.evaluate(scene => window.panel.receiveExecutionScene(scene), JSON.parse(JSON.stringify(scene)));
      await page.waitForFunction(() => !document.querySelector('#execution-war-room').hidden);
      await page.waitForTimeout(1500);
      const spiders = Number(await gl.getAttribute('data-spiders'));
      for (const row of events(7).slice(5)) applyExecutionEvent(scene, row);
      await page.evaluate(scene => window.panel.receiveExecutionScene(scene), JSON.parse(JSON.stringify(scene)));
      // A chip of the call's own region: from the spider's claw, not a candidate from the core.
      const flew = await page.waitForFunction(() => document.querySelectorAll('.war-chip[data-kind="search"]').length > 0, null, { timeout: 7000 }).then(() => true, () => false);
      await page.waitForFunction(() => document.querySelector('[data-row-key="op:job-1:f1"]')?.dataset.pending === 'false', null, { timeout: 9000 });
      return { spiders, flew };
    };
    const motion = await live(false);
    assert.ok(motion.spiders >= 1, 'the running member is out as a spider');
    assert.equal(motion.flew, true, 'finished calls and newly admitted candidates fly to their rows');
    const still = await live(true);
    assert.equal(still.flew, false, 'reduced motion: rows appear without flights');
    // Phone width: the band scrolls sideways, no horizontal page overflow.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 393, height: 852 });
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.waitForTimeout(2500); // the regions glide into the tall layout
    await framed('393×852');
    // The band below is a row of cards swiped left and right by touch, each coming to rest whole.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const strip = await band.boundingBox();
    const shown = () => band.evaluate(el => { const box = el.getBoundingClientRect(); const seen = [...el.querySelectorAll('.war-cell')].map(cell => { const r = cell.getBoundingClientRect(); return { part: Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left)), width: r.width }; }); const i = seen.reduce((best, row, k) => row.part > seen[best].part ? k : best, 0); return { index: i, whole: seen[i].part >= seen[i].width - 2 }; });
    const swipe = async dx => { await cdp.send('Input.synthesizeScrollGesture', { x: Math.round(strip.x + strip.width / 2), y: Math.round(strip.y + 40), xDistance: dx, yDistance: 0, gestureSourceType: 'touch', speed: 1400 }); await page.waitForTimeout(800); };
    assert.deepEqual(await shown(), { index: 0, whole: true });
    await swipe(-Math.round(strip.width * .55));
    assert.deepEqual(await shown(), { index: 1, whole: true }, 'a swipe brings the next card in and it settles whole');
    await swipe(Math.round(strip.width * .55));
    assert.deepEqual(await shown(), { index: 0, whole: true }, 'and back');
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await cdp.detach();
    await page.screenshot({ path: join(proof, 'war-room-393.png') });
    // An ordinary chat: no evaluation cells, no invented phases.
    await page.setViewportSize({ width: 1280, height: 1000 });
    await open('plain-chat');
    await band.locator('[data-cell="regions"]').waitFor();
    assert.equal(await band.getAttribute('data-mode'), 'plain');
    assert.equal(await band.locator('[data-cell="gate"], [data-cell="heat"]').count(), 0);
    assert.deepEqual(await room.locator('.war-rail li').evaluateAll(rows => rows.map(row => row.dataset.phase).filter(key => key !== 'deliver')), []);
    assert.match(await band.locator('[data-cell="regions"]').innerText(), /分析与计算\s*1 次调用/);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited; clearTimeout(timeout);
    await rm(home, { recursive: true, force: true });
  }
});
