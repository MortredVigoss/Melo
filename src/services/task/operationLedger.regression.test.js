import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveTaskOperation } from './operationLedger.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'melo-operation-retry-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, taskId: 'task', tool: { id: 'bash', requiresPermission: false }, args: { command: 'npm run build' } };
}
test('new invocation reruns build; retransmission of that invocation replays', async t => {
  const options = await fixture(t);
  reserveTaskOperation({ ...options, invocationId: 'turn:one' }).finish({ ok: true, output: 'old' });
  const next = reserveTaskOperation({ ...options, invocationId: 'turn:two' });
  assert.equal(next.result, undefined);
  next.finish({ ok: true, output: 'new' });
  assert.match(reserveTaskOperation({ ...options, invocationId: 'turn:two' }).result.output, /new/);
});
test('known process exit failure can be retried by a new invocation', async t => {
  const options = await fixture(t);
  reserveTaskOperation({ ...options, invocationId: 'one' }).finish({ ok: false, meta: { exitCode: 1 } });
  const retry = reserveTaskOperation({ ...options, invocationId: 'two' });
  assert.equal(retry.result, undefined);
  retry.finish({ ok: true });
});
test('provably unstarted operation does not leave an uncertain receipt', async t => {
  const options = await fixture(t);
  reserveTaskOperation(options).finish({ ok: false, meta: { aborted: true, executionStarted: false } });
  const retry = reserveTaskOperation(options);
  assert.equal(retry.result, undefined);
  retry.finish({ ok: true });
});
test('unknown side effects still block even under a new call id', async t => {
  const options = await fixture(t);
  reserveTaskOperation({ ...options, invocationId: 'one' }).finish({ ok: false, meta: { aborted: true, executionStarted: true } });
  assert.equal(reserveTaskOperation({ ...options, invocationId: 'two' }).result.error, 'OPERATION_UNCERTAIN');
});
test('plain file reads are repeatable but shell metacharacters are never bypassed', async t => {
  const options = await fixture(t);
  for (const command of ['cat foo.js', 'ls -la', 'pwd']) {
    assert.equal(reserveTaskOperation({ ...options, args: { command } }), null);
  }
  const ticket = reserveTaskOperation({ ...options, args: { command: 'cat foo.js > bar.js' } });
  assert.ok(ticket);
  ticket.finish({ ok: false });
});
