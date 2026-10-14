import test from 'node:test';
import assert from 'node:assert/strict';
import { decideFileSafetyPreflight, decideFileSafetyResponseAction } from './fileSafetyResponse.js';
for (const kind of ['tool', 'file_safety']) {
  test(`${kind}: failed approval remains visible and a successful retry closes it`, () => {
    const entry = { kind, operation: 'write_overwrite' };
    assert.equal(decideFileSafetyPreflight(entry).action, 'noop');
    assert.deepEqual(decideFileSafetyResponseAction({ entry, error: new Error('offline') }), { action: 'mark_error', message: 'offline' });
    assert.equal(decideFileSafetyResponseAction({ entry, response: { ok: false, reason: 'save failed' } }).action, 'mark_error');
    assert.equal(decideFileSafetyResponseAction({ entry, response: { ok: true } }).action, 'remove');
    assert.equal(decideFileSafetyResponseAction({ entry }).action, 'mark_error');
  });
}
test('delete confirmation mismatch preserves the typed-name retry', () => {
  const decision = decideFileSafetyResponseAction({ response: { ok: false, reason: 'CONFIRMATION_MISMATCH', expected: 'report.txt' } });
  assert.equal(decision.action, 'mark_error');
  assert.match(decision.message, /report.txt/);
});
