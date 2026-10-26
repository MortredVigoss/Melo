import test from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage, escapeHtml } from '../../i18n.js';
import { renderDevelopmentPanel, handleDevelopment, refreshDevelopment } from './panel.js';

test('development panel displays real stages and exposes no automatic merge or install action', async () => {
  setLanguage('zh-CN');
  const context = { api: async () => ({ jobs: [{ id: 'dev_fixture', goal: '<script>bad</script>', status: 'blocked' }] }), render: () => {} };
  await refreshDevelopment(context);
  const html = renderDevelopmentPanel({ ...context, escapeHtml, profiles: [] });
  assert.match(html, /隔离开发/); assert.match(html, /&lt;script&gt;/); assert.ok(!html.includes('<script>'));
  assert.match(html, /data-action="development-create"/); assert.ok(!html.includes('data-action="development-merge"'));
});
test('double clicks cannot start duplicate development mutations', async () => {
  let requests = 0, finish;
  const response = new Promise(resolve => { finish = resolve; });
  const context = { api: async path => { if (path.endsWith('/start')) { requests++; await response; return {}; } return { jobs: [] }; }, render: () => {} };
  const first = handleDevelopment('development-start', { dataset: { id: 'dev_fixture' } }, context);
  const second = handleDevelopment('development-start', { dataset: { id: 'dev_fixture' } }, context);
  finish(); await Promise.all([first, second]); assert.equal(requests, 1);
});
