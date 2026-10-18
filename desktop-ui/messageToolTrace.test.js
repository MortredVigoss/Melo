import test from 'node:test';
import assert from 'node:assert/strict';
import { isToolTraceMessage, renderToolTraceMessage } from './messageToolTrace.js';

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
