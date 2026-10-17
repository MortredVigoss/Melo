import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepeatGuard, toolCallFingerprint } from './repeatGuard.js';

test('identical failing calls are refused after two consecutive failures; success resets', () => {
  const guard = createRepeatGuard();
  const args = { path: '/missing.txt', encoding: 'utf8' };
  const failure = { ok: false, error: 'ENOENT', output: 'no such file' };
  assert.equal(guard.check('file_read', args), null);
  guard.record('file_read', args, failure);
  assert.equal(guard.check('file_read', args), null, 'one failure is still allowed to retry');
  guard.record('file_read', args, failure);
  const refused = guard.check('file_read', { encoding: 'utf8', path: '/missing.txt' });
  assert.equal(refused.error, 'REPEATED_FAILURE');
  assert.match(refused.output, /failed 2 times/);
  assert.equal(guard.check('file_read', { path: '/other.txt' }), null, 'different arguments are a different call');
  guard.record('file_read', args, { ok: true, output: 'now exists' });
  assert.equal(guard.check('file_read', args), null, 'a success clears the fingerprint');
});

test('a different error class restarts the count and fingerprints ignore key order', () => {
  const guard = createRepeatGuard();
  guard.record('web_search', { q: 'a', n: 1 }, { ok: false, error: 'TIMEOUT' });
  guard.record('web_search', { n: 1, q: 'a' }, { ok: false, error: 'RATE_LIMIT' });
  assert.equal(guard.check('web_search', { q: 'a', n: 1 }), null);
  assert.equal(toolCallFingerprint('t', { b: 1, a: [1, { y: 2, x: 1 }] }), toolCallFingerprint('t', { a: [1, { x: 1, y: 2 }], b: 1 }));
});
