import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderExtraFast, editExtraFast, handleExtraFast } from './extraFast.js';
import { renderModelReceipt } from './modelPresentation.js';

test('reply receipts distinguish the judge call from the answer model', () => {
  const dom = new JSDOM(renderModelReceipt({ role: 'assistant', id: 'fixture', metadata: { modelResponses: [
    { requestedModel: 'mini', reportedModel: 'mini', purpose: 'intent-judge' },
    { requestedModel: 'sol', reportedModel: 'sol' },
  ] } }, value => String(value)));
  const rows = dom.window.document.querySelectorAll('.model-receipt-row');
  assert.match(rows[0].textContent, /额外快速 · 意图判断/);
  assert.doesNotMatch(rows[1].textContent, /额外快速/);
  dom.window.close();
});

test('opt-in setting stays read-only, saves explicitly, retains failed drafts and reports actual assignment', async () => {
  const config = { model: 'answer', extraFast: { enabled: false, revision: 0, assignments: {} } };
  let dom, saves = 0, probes = 0, fail = true;
  const render = () => { dom?.window.close(); dom = new JSDOM(renderExtraFast(config)); };
  const hooks = { config, render, refresh: async () => {}, api: async (url, { body }) => {
    if (url.endsWith('/test')) { probes++; return { ...config.extraFast, assignments: { intent: { name: '连接 A', model: 'mini', reportedModel: 'mini-actual', basis: 'measured', latencyMs: 80 } } }; }
    saves++; if (fail) throw new Error('网络断开');
    assert.equal(body.enabled, true); return { enabled: body.enabled, revision: body.revision + 1, assignments: {} };
  } };
  render(); const field = () => dom.window.document.querySelector('input');
  assert.equal(field().disabled, true); assert.equal(field().checked, false);
  await handleExtraFast('extra-fast-save', hooks); assert.equal(saves, 0);
  await handleExtraFast('extra-fast-test', hooks); assert.equal(probes, 0);
  await handleExtraFast('extra-fast-edit', hooks);
  assert.equal(field().disabled, false); field().checked = true; editExtraFast(field());
  const button = dom.window.document.querySelector('[data-action=extra-fast-save]');
  editExtraFast(field()); assert.equal(dom.window.document.querySelector('[data-action=extra-fast-save]'), button);
  await handleExtraFast('extra-fast-save', hooks);
  assert.equal(saves, 1); assert.equal(probes, 0); assert.equal(field().checked, true); assert.equal(field().disabled, false);
  assert.match(dom.window.document.body.textContent, /重试保存/);
  fail = false; await handleExtraFast('extra-fast-save', hooks);
  assert.equal(saves, 2); assert.equal(probes, 1); assert.equal(field().disabled, true); assert.equal(field().checked, true);
  assert.match(dom.window.document.body.textContent, /已保存/); assert.match(dom.window.document.body.textContent, /mini-actual/);
  assert.equal(config.model, 'answer');
  await handleExtraFast('extra-fast-edit', hooks); field().checked = false; editExtraFast(field());
  await handleExtraFast('extra-fast-cancel', hooks); assert.equal(field().checked, true); assert.equal(saves, 2);
  dom.window.close();
});

test('revision conflict can rebase while retaining the toggle draft', async () => {
  const config = { extraFast: { enabled: false, revision: 1, assignments: {} } };
  let dom, attempt = 0;
  const render = () => { dom?.window.close(); dom = new JSDOM(renderExtraFast(config)); };
  const hooks = { config, render, refresh: async () => {}, api: async (url, options) => {
    if (url === '/api/bootstrap') return { settings: { config: { extraFast: { enabled: false, revision: 2 } } } };
    if (url.endsWith('/test')) return config.extraFast;
    if (++attempt === 1) throw new Error('加速设置已被更新');
    assert.equal(options.body.revision, 2); assert.equal(options.body.enabled, true);
    return { ...options.body, revision: 3, assignments: {} };
  } };
  render(); await handleExtraFast('extra-fast-edit', hooks);
  const field = dom.window.document.querySelector('input'); field.checked = true; editExtraFast(field);
  await handleExtraFast('extra-fast-save', hooks);
  assert.equal(dom.window.document.querySelector('[data-action=extra-fast-save]').disabled, true);
  await handleExtraFast('extra-fast-rebase', hooks);
  assert.equal(dom.window.document.querySelector('input').checked, true);
  assert.equal(dom.window.document.querySelector('[data-action=extra-fast-save]').disabled, false);
  await handleExtraFast('extra-fast-save', hooks); assert.equal(config.extraFast.enabled, true);
  dom.window.close();
});
