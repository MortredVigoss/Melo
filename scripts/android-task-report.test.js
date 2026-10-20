import test from 'node:test';
import assert from 'node:assert/strict';
import { createAndroidTaskCollector } from './android-task-report.js';
test('real localhost report upload rejects stale, failed, missing, oversized and duplicate reports', async () => {
  const id = 'current-fixture-only', collector = await createAndroidTaskCollector(id);
  const report = { version: 1, evaluationId: id, host: 'Android-JavaScriptSandbox', report: { passed: true } };
  const upload = (body, token = id) => fetch(`http://127.0.0.1:${collector.port}/task-eval`, { method: 'POST', headers: { 'x-melo-evaluation': token }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  try {
    assert.throws(() => collector.read());
    assert.equal((await upload(report, 'stale')).status, 403);
    assert.equal((await upload({ ...report, evaluationId: 'stale' })).status, 422);
    assert.equal((await upload({ ...report, report: { passed: false } })).status, 422);
    assert.equal((await upload('{invalid')).status, 400);
    assert.equal((await upload('x'.repeat(2_000_001))).status, 413);
    const responses = await Promise.all([upload(report), upload(report)]);
    assert.deepEqual(responses.map(row => row.status).sort(), [204, 409]);
    assert.deepEqual(collector.read(), report);
  } finally { await collector.close(); }
});
