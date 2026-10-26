// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage as setFixtureLanguage } from './i18n.js';
setFixtureLanguage('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderModelReceipt } from './modelPresentation.js';
test('reply receipts distinguish the judge call from the answer model', () => {
  const dom = new JSDOM(renderModelReceipt({ role: 'assistant', id: 'fixture', metadata: { modelResponses: [
    { requestedModel: 'mini', reportedModel: 'mini', purpose: 'intent-judge' },
    { requestedModel: 'sol', reportedModel: 'sol' },
  ] } }, value => String(value)));
  const rows = dom.window.document.querySelectorAll('.model-receipt-row');
  assert.match(rows[0].textContent, /意图判断/);
  assert.doesNotMatch(rows[1].textContent, /额外快速/);
  dom.window.close();
});
