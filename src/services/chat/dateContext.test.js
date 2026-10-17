import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDateChangeNote, localDateString, DATE_CONTINUITY_RULE } from './dateContext.js';

const tz = 'Australia/Sydney';

test('no note while the conversation stays on the same local day', () => {
  const now = new Date('2026-10-17T12:30:00+11:00');
  const messages = [
    { role: 'user', content: 'a', createdAt: '2026-10-17T10:00:00+11:00' },
    { role: 'assistant', content: '今天天气不错', createdAt: '2026-10-17T10:00:05+11:00' },
    { role: 'user', content: 'b', createdAt: now.toISOString() },
  ];
  assert.equal(buildDateChangeNote(messages, { now, timeZone: tz }), '');
  assert.equal(buildDateChangeNote([{ role: 'user', content: 'first' }], { now, timeZone: tz }), '');
});

test('a reply written before midnight is dated when the next message comes the next day', () => {
  const now = new Date('2026-10-18T00:20:00+11:00');
  const messages = [
    { role: 'user', content: '今天怎么样', createdAt: '2026-10-17T23:40:00+11:00' },
    { role: 'assistant', content: '今天挺好的', createdAt: '2026-10-17T23:40:10+11:00' },
    { role: 'user', content: '帮我查个别的', createdAt: now.toISOString() },
  ];
  const note = buildDateChangeNote(messages, { now, timeZone: tz });
  assert.match(note, /sent on 2026-10-17 \(yesterday\); today is 2026-10-18/);
  assert.match(note, /Do not|do not comment/);
  assert.equal(localDateString('2026-10-17T13:30:00Z', tz), '2026-10-18', 'local day, not UTC day');
  assert.match(DATE_CONTINUITY_RULE, /not a mistake/);
});
