import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMessageMemoryRefs } from './viewMessageRefs.js';

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

// Bug audit 2026-10-18 M14 / U1 / U9 / U15.
import { personalTargetId, ACTIONABLE_KINDS } from './viewMessageRefs.js';

test('U1/M14b: footer actions only on kinds the update route accepts; project-book / personal-profile rows hide the no-op scope button', () => {
  const html = renderMessageMemoryRefs({ id: 'm2', role: 'assistant', metadata: { memoryUsage: [
    { id: 'f1', kind: 'fact', text: 'standing fact' },
    { id: 'v1', kind: 'verification-correction', text: 'correction' },
    { id: 'book:promoted:x', kind: 'project-book', text: 'mirrored decision' },
    { id: 'book:user:P:abc', kind: 'project-book', text: 'hand-written' },
    { id: 'promoted:y', kind: 'personal-profile', text: 'profile row' },
    { id: 'promoted:z', kind: 'session-fact', text: 'session fact' },
  ] } });
  assert.doesNotMatch(html, /data-memory-id="f1" data-scope|memory-ref-forget" data-memory-id="f1"/, 'fact rows have no editor');
  assert.doesNotMatch(html, /data-memory-id="v1" data-scope|memory-ref-forget" data-memory-id="v1"/);
  assert.deepEqual([...ACTIONABLE_KINDS].sort(), ['personal-profile', 'project-book', 'session-fact']);
  assert.doesNotMatch(html, /data-memory-id="book:promoted:x" data-scope="project"/, 'already in the project');
  assert.match(html, /data-kind="project-book" data-action="memory-ref-scope" data-memory-id="book:promoted:x" data-scope="personal"/, 'mirror row can be promoted to personal (via its underlying fact)');
  assert.doesNotMatch(html, /data-memory-id="book:user:P:abc" data-scope=/, 'hand-written row: no underlying fact, no scope buttons');
  assert.match(html, /memory-ref-forget" data-memory-id="book:user:P:abc"/);
  assert.doesNotMatch(html, /data-memory-id="promoted:y" data-scope="personal"/, 'already personal');
  assert.match(html, /data-memory-id="promoted:y" data-scope="project"/);
  assert.match(html, /data-memory-id="promoted:z" data-scope="project"/);
  assert.match(html, /data-memory-id="promoted:z" data-scope="personal"/);
});

test('U15: 记成个人 on a project-book mirror targets the underlying fact and leaves the book row', () => {
  assert.equal(personalTargetId({ id: 'book:promoted:x', kind: 'project-book' }), 'promoted:x');
  assert.equal(personalTargetId({ id: 'book:promoted:x', kind: 'project-book', bookOf: 'promoted:other' }), 'promoted:other');
  assert.equal(personalTargetId({ id: 'book:user:P:abc', kind: 'project-book' }), null);
  assert.equal(personalTargetId({ id: 'promoted:x', kind: 'project-book' }), 'promoted:x', 'a promoted chat fact in the book is the fact itself');
  assert.equal(personalTargetId({ id: 'promoted:x', kind: 'session-fact' }), 'promoted:x');
});

test('M14a/U9: feedback is shown only in the message it was clicked in', () => {
  const shown = renderMessageMemoryRefs(message, { feedback: { id: 'f1', messageId: 'm1', message: 'saved' } });
  assert.match(shown, /✓ saved/);
  const other = renderMessageMemoryRefs({ ...message, id: 'm9' }, { feedback: { id: 'f1', messageId: 'm1', message: 'saved' } });
  assert.doesNotMatch(other, /✓ saved/);
  assert.match(other, /memory-ref-forget" data-memory-id="f1"/);
});

test('U3: the footer renders open when the user opened it or when its feedback is showing', () => {
  assert.doesNotMatch(renderMessageMemoryRefs(message), /<details class="message-memory-refs"[^>]*\bopen\b/);
  assert.match(renderMessageMemoryRefs(message, { open: true }), /<details class="message-memory-refs" data-message-memory-refs="m1" open>/);
  const feedback = { id: 'f1', messageId: 'm1', message: 'saved' };
  assert.match(renderMessageMemoryRefs(message, { feedback }), /data-message-memory-refs="m1" open>/, 'feedback keeps the footer open across re-renders');
  assert.doesNotMatch(renderMessageMemoryRefs({ ...message, id: 'm9' }, { feedback }), /data-message-memory-refs="m9" open>/, 'other messages stay collapsed');
  assert.doesNotMatch(renderMessageMemoryRefs(message, { feedback: { id: 'f1', message: 'saved' } }), /\bopen>/, 'feedback without a message id does not open anything');
});
