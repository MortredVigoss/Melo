import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMessageMemoryRefs } from './messageMemoryRefs.js';

const message = { id: 'm1', role: 'assistant', metadata: { memoryUsage: [
  { id: 'f1', kind: 'session-fact', text: 'prefers pnpm' },
  { id: 'a1', kind: 'attic', text: 'old summary <b>' },
] } };

test('renders nothing for user messages or messages without usage', () => {
  assert.equal(renderMessageMemoryRefs({ role: 'user', metadata: { memoryUsage: [{ id: 'x' }] } }), '');
  assert.equal(renderMessageMemoryRefs({ role: 'assistant', metadata: {} }), '');
});

test('lists every referenced memory, escaped, with actions only on facts', () => {
  const html = renderMessageMemoryRefs(message);
  assert.match(html, /data-message-memory-refs="m1"/);
  assert.match(html, /（2）/);
  assert.match(html, /old summary &lt;b&gt;/);
  assert.equal((html.match(/data-action="memory-ref-scope"/g) || []).length, 2);
  assert.equal((html.match(/data-action="memory-ref-forget"/g) || []).length, 1);
  assert.match(html, /data-memory-id="f1" data-scope="project"/);
});

test('shows feedback in place of actions and disables buttons while busy', () => {
  const done = renderMessageMemoryRefs(message, { feedback: { id: 'f1', message: 'saved' } });
  assert.match(done, /✓ saved/);
  assert.doesNotMatch(done, /memory-ref-forget/);
  const busy = renderMessageMemoryRefs(message, { busy: true });
  assert.match(busy, /memory-ref-forget" data-memory-id="f1" disabled/);
});
