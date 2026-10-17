import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemberBackground } from './memberBackground.js';
import { createHandoff } from './handoff.js';

test('members receive project, summary and the last turns, bounded and labelled', () => {
  const chat = {
    compactSummary: 'Earlier the user decided on PostgreSQL and a Friday deploy.',
    messages: [
      ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'x'.repeat(500) })),
      { role: 'assistant', content: 'tool output', isToolResult: true },
      { role: 'user', content: '按上面方案实施' },
    ],
  };
  const block = buildMemberBackground({ chat, projectContext: 'Active project: Melo\nInstructions: keep Chinese' });
  assert.match(block, /^Project:\nActive project: Melo/);
  assert.match(block, /Conversation so far \(summary\):\nEarlier the user decided/);
  assert.match(block, /Recent turns:/);
  assert.match(block, /User: 按上面方案实施$/);
  assert.doesNotMatch(block, /tool output/, 'tool results are not background');
  assert.doesNotMatch(block, /turn 0 /, 'only the last turns are included');
  assert.ok(!block.includes('x'.repeat(400)), 'turns are truncated');
  assert.equal(buildMemberBackground({}), '');
});

test('a member that reaches a conclusion is ok even when a tool failed; its own status wins', () => {
  const okWithFailure = createHandoff('t', { ok: true, output: JSON.stringify({ conclusion: 'file missing, nothing to do', status: 'completed' }), meta: { failedTools: 1, toolResults: [] } }, null);
  assert.equal(okWithFailure.status, 'completed');
  assert.deepEqual(okWithFailure.unfinished, []);
  const selfFailed = createHandoff('t', { ok: true, output: JSON.stringify({ conclusion: 'could not finish', status: 'failed', unfinished: ['step 2'] }), meta: {} }, null);
  assert.equal(selfFailed.status, 'failed');
  assert.deepEqual(selfFailed.unfinished, ['step 2']);
  const exhausted = createHandoff('t', { ok: false, output: '(no output)', meta: { exhausted: true } }, null);
  assert.equal(exhausted.status, 'failed');
  const cancelled = createHandoff('t', { ok: true, output: JSON.stringify({ status: 'completed' }), meta: { aborted: true } }, null);
  assert.equal(cancelled.status, 'cancelled', 'runner facts beat self-reported status');
});
