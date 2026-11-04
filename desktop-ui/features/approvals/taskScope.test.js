// Plan A phase A4-1 (2026-11-04): the task-scope card lists a member's gated
// tools and offers this-task / this-chat / deny, posted through app.js's
// existing permission response handler.
import { setLanguage } from '../../i18n.js';
setLanguage('zh-CN');
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
for (const name of ['document', 'HTMLElement']) globalThis[name] = dom.window[name];
globalThis.window = dom.window;
const { installApprovalsFeature } = await import('./index.js');
const feature = installApprovalsFeature({
  getBootstrap: () => ({ customize: { agents: [{ id: 'main', name: 'Melo' }] } }), app: document.body, api: async () => ({ ok: true }),
  render: () => {}, bgRender: () => {}, notify: () => {}, refreshBootstrap: async () => {},
  toolPermissions: () => [], setToolPermissions: () => {},
  escapeHtml: value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  icon: { chip: '<svg></svg>' },
});
const renderTaskScopePrompt = feature.renderTaskScopePrompt;

test('the task-scope card shows the member, its subtask, every gated tool and the three decisions', () => {
  const html = renderTaskScopePrompt({ requestId: 'req-1', kind: 'task_scope', toolIds: ['reminders_create', 'clipboard'], task: 'Save the plan as a reminder', label: '执行成员', agentId: 'main' });
  document.body.innerHTML = html;
  const shell = document.querySelector('[data-task-scope-request="req-1"]');
  assert.ok(shell, 'card keyed by request id');
  assert.match(shell.textContent, /执行成员需要以下工具/);
  assert.match(shell.textContent, /Save the plan as a reminder/);
  assert.deepEqual([...shell.querySelectorAll('.task-scope-tools code')].map(node => node.textContent), ['reminders_create', 'clipboard']);
  const actions = [...shell.querySelectorAll('button')].map(button => [button.dataset.action, button.dataset.requestId, button.dataset.toolId]);
  assert.deepEqual(actions, [['tool-permission-allow-task', 'req-1', ''], ['tool-permission-allow-session', 'req-1', ''], ['tool-permission-deny', 'req-1', '']]);
  assert.match(shell.textContent, /文件改动仍逐项确认/);
  const busy = renderTaskScopePrompt({ requestId: 'req-2', toolIds: ['bash'], submitting: true, confirmError: '网络错误' });
  assert.match(busy, /disabled aria-busy="true"/);
  assert.match(busy, /网络错误/);
});
