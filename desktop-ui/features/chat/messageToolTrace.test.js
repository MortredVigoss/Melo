// This fixture asserts Chinese copy explicitly; production defaults follow the device.
import { setLanguage as setFixtureLanguage } from '../../i18n.js';
setFixtureLanguage('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isToolTraceMessage, renderToolTraceMessage, TOOL_TRACE_PREFIX } from './messageToolTrace.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Bug audit 2026-10-18 U12: tool-trace records are not replies.
test('only assistant messages of kind tool-trace are tool traces', () => {
  assert.equal(isToolTraceMessage({ role: 'assistant', kind: 'tool-trace' }), true);
  assert.equal(isToolTraceMessage({ role: 'assistant', content: 'hi' }), false);
  assert.equal(isToolTraceMessage({ role: 'user', kind: 'tool-trace' }), false);
  assert.equal(isToolTraceMessage(null), false);
});

test('renders a compact status chip plus the escaped trace text, without avatar / receipt / read-aloud markup', () => {
  const message = { id: 't1', role: 'assistant', kind: 'tool-trace', content: '[工具轨迹] 已取消\nfile_read <a.js>；bash "npm test"', metadata: { runId: 'r', toolTrace: { status: 'cancelled' } } };
  const html = renderToolTraceMessage(message, escape);
  assert.match(html, /class="tool-trace-body"/);
  assert.match(html, /tool-trace-status">已取消</);
  assert.match(html, /tool-trace-text">\[工具轨迹\] 已取消\nfile_read &lt;a\.js&gt;；bash &quot;npm test&quot;</);
  assert.doesNotMatch(html, /message-role|model-receipt|speak-message|message-actions/);
  assert.match(renderToolTraceMessage({ ...message, metadata: { toolTrace: { status: 'failed' } } }, escape), /tool-trace-status">失败</);
  assert.match(renderToolTraceMessage({ ...message, metadata: {} }, escape), /tool-trace-status">已取消</, 'missing status defaults to cancelled');
  assert.equal(renderToolTraceMessage({ role: 'assistant', content: 'plain reply' }, escape), '');
});

// 2026-10-19: a trace written on the iPhone syncs as plain id/role/content.
test('a synced phone trace is recognised by the shared prefix and its header label', () => {
  const contract = JSON.parse(readFileSync(new URL('../../../shared/protocol/agent-loop.json', import.meta.url), 'utf8'));
  assert.equal(TOOL_TRACE_PREFIX, contract.toolTrace.prefix);
  assert.equal(isToolTraceMessage({ role: 'assistant', content: '[工具轨迹] 本轮已取消，之前已执行 1 次工具调用（可据此继续，不必重复）：\n1. open_url(url=https://a.example) ✓' }), true);
  assert.equal(isToolTraceMessage({ role: 'user', content: '[工具轨迹] x' }), false);
  assert.equal(isToolTraceMessage({ role: 'assistant', content: '回答里提到 [工具轨迹]' }), false);
  const failed = { role: 'assistant', content: `${TOOL_TRACE_PREFIX} ${contract.toolTrace.statusLabels.failed}，之前已执行 1 次工具调用（可据此继续，不必重复）：\n1. contacts_search(query=x) ✗ TIMEOUT` };
  assert.match(renderToolTraceMessage(failed, escape), /tool-trace-status">失败</);
  assert.match(renderToolTraceMessage({ ...failed, content: failed.content.replace(contract.toolTrace.statusLabels.failed, contract.toolTrace.statusLabels.cancelled) }, escape), /tool-trace-status">已取消</);
});
