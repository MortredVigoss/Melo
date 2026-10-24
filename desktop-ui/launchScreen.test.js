import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { buildLaunchScreen } from '../scripts/build-launch-screen.js';

const script = await readFile(new URL('./launchScreen.js', import.meta.url), 'utf8');
function fixture({ reduced = false, native = false, canvas = true, language = 'zh-CN' } = {}) {
  const dom = new JSDOM(`<body ${native ? 'data-native-launch="true"' : ''}><div id="app"></div></body>`, { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, frames = new Map(), messages = [];
  let id = 0;
  w.matchMedia = () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  w.cancelAnimationFrame = key => frames.delete(key);
  w.HTMLCanvasElement.prototype.getContext = () => canvas ? new Proxy({}, { get: () => () => {} }) : null;
  if (native) w.webkit = { messageHandlers: { meloVoice: { postMessage: value => messages.push(value) } } };
  Object.defineProperty(w.navigator,"language",{value:language,configurable:true});
  w.eval(script);
  return { w, dom, frames, messages, page: w.document.querySelector('.melo-launch') };
}

test('startup stages reflect supplied state; no timer invents completed stages or percentages', () => {
  const f = fixture();
  f.w.MeloLaunch.show({ phase: 'service' });
  assert.match(f.page.textContent, /正在启动 Melo/);
  assert.equal(f.page.getAttribute('aria-busy'), 'true');
  f.w.MeloLaunch.show({ phase: 'workspace' });
  assert.match(f.page.textContent, /载入对话与偏好设置/);
  assert.equal(f.page.querySelector('progress,[role="progressbar"]'), null);
  f.w.MeloLaunch.dismiss(); assert.equal(f.frames.size, 0); f.dom.window.close();
});
test('failure details are inert text and retry invokes the supplied recovery once', () => {
  const f = fixture(); let retries = 0;
  f.w.MeloLaunch.show({ phase: 'error', detail: '<img src=x onerror=alert(1)>\nfailed' }, () => retries++);
  assert.equal(f.page.dataset.phase, 'error'); assert.equal(f.page.getAttribute('aria-busy'), 'false');
  assert.equal(f.page.querySelector('pre img'), null); assert.match(f.page.querySelector('pre').textContent, /<img/);
  f.page.querySelector('button').click(); f.page.querySelector('button').click();
  assert.equal(retries, 1);
  f.w.MeloLaunch.show({ phase: 'workspace' }); assert.equal(f.page.querySelector('[data-launch-recovery]').hidden, true);
  f.w.MeloLaunch.dismiss(); f.dom.window.close();
});
test('native retry uses the existing native bridge instead of reloading a disconnected HTML page', () => {
  const f = fixture({ native: true });
  f.w.MeloLaunch.show({ phase: 'error' }); f.page.querySelector('button').click();
  assert.deepEqual(JSON.parse(JSON.stringify(f.messages)), [{ action: 'retryLaunch' }]);
  f.w.MeloLaunch.dismiss(); f.dom.window.close();
});
test('hidden and reduced-motion loading screens do not keep rendering', () => {
  const f = fixture(); assert.ok(f.frames.size > 0);
  Object.defineProperty(f.w.document, 'hidden', { configurable: true, value: true });
  f.w.document.dispatchEvent(new f.w.Event('visibilitychange')); assert.equal(f.frames.size, 0);
  Object.defineProperty(f.w.document, 'hidden', { configurable: true, value: false });
  f.w.document.dispatchEvent(new f.w.Event('visibilitychange')); assert.equal(f.frames.size, 1);
  f.w.MeloLaunch.dismiss(); assert.equal(f.frames.size, 0); f.dom.window.close();
  const still = fixture({ reduced: true }); assert.equal(still.frames.size, 0);
  still.w.MeloLaunch.dismiss(); still.dom.window.close();
});
test('content remains usable when canvas is unavailable, and replacing the page disposes animation', async () => {
  const f = fixture({ canvas: false }); assert.match(f.page.textContent, /工作空间/);
  f.w.MeloLaunch.show({ phase: 'error', detail: 'offline' }); assert.equal(f.page.querySelector('button').disabled, false);
  f.w.MeloLaunch.dismiss(); f.dom.window.close();
  const running = fixture(); running.w.document.getElementById('app').replaceChildren();
  await Promise.resolve(); assert.equal(running.frames.size, 0); running.dom.window.close();
});
test('native bundle contains the same startup assets without network dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'melo-launch-'));
  try {
    const path = join(directory, 'Launch.html'); await buildLaunchScreen(path);
    const html = await readFile(path, 'utf8');
    assert.ok(html.includes(script)); assert.match(html, /__MELO_LAUNCH_STATE__/);
    assert.doesNotMatch(html, /<(script|link)[^>]+(?:src|href)=/);
    assert.match(html, /data-native-launch="true"/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('standalone startup uses system language and can adopt saved interface language',()=>{
 const f=fixture({language:'en-US'});assert.match(f.page.textContent,/Loading conversations/);
 f.w.MeloLaunch.setLanguage('ja');assert.match(f.page.textContent,/会話と設定/);
 f.w.MeloLaunch.dismiss();f.w.MeloLaunch.setLanguage('es');assert.equal(f.w.document.querySelector('.melo-launch'),null);f.dom.window.close();
});
