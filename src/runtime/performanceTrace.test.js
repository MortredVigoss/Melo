import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withPerformanceTrace, measureStage, measureStageSync, flushPerformanceLogs } from './performanceTrace.js';

test('timing scopes isolate parallel requests, preserve failures and never log payloads', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'melo-perf-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = [], b = [], logPath = join(dir, 'trace.jsonl');
  await Promise.all([
    withPerformanceTrace({ logPath, onTiming: row => a.push(row) }, async () => {
      await assert.rejects(measureStage('failed-step', async () => { throw new Error('private prompt'); }));
      assert.equal(measureStageSync('sync-step', () => 42), 42);
    }),
    withPerformanceTrace({ logPath, onTiming: row => { b.push(row); throw Error('broken observer'); } }, () => measureStage('other-request', async () => 7)),
  ]);
  await flushPerformanceLogs();
  assert.deepEqual(a.map(r => r.stage), ['failed-step', 'sync-step']);
  assert.deepEqual(b.map(r => r.stage), ['other-request']);
  const rows = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3);
  assert.equal(rows.find(row => row.stage === 'failed-step').status, 'failed');
  assert.ok(rows.every(r => r.durationMs >= 0));
  assert.ok(!JSON.stringify(rows).includes('private prompt'));
});
