import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTasks, compareTaskReports } from './eval-agent-tasks.js';
const report = await evaluateTasks();
test('host comparison ignores measured engine time but compares every event and fixture metric', () => {
  const second = structuredClone(report); second.host = 'jscore'; second.replayElapsedMs += 100;
  assert.equal(compareTaskReports(report, second).identical, true);
  for (const change of [r => { r.datasetSha256 = 'changed'; }, r => { r.bundleSha256 = 'changed'; }, r => { r.report.tasks[0].events.pop(); }, r => { r.report.tasks[0].metrics.fixtureInputTokens++; }, r => { r.report.passed = false; }, r => { r.report.kind = 'real-llm'; }]) {
    const changed = structuredClone(second); change(changed);
    assert.throws(() => compareTaskReports(report, changed));
  }
});
test('CLI exits nonzero on failed expectations, invalid arguments and mismatched reports', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const run = args => promisify(execFile)(process.execPath, ['scripts/eval-agent-tasks.js', ...args]);
  const root = await mkdtemp(join(tmpdir(), 'melo-eval-'));
  try {
    const path = join(root, 'report.json'); await run(['--out', path]);
    await run(['--compare', path]);
    const broken = JSON.parse(await readFile(path, 'utf8')); broken.report.tasks[0].events.pop();
    await writeFile(path, JSON.stringify(broken)); await assert.rejects(run(['--compare', path]));
    const data = JSON.parse(await readFile('shared/agent/fixtures/tasks.json', 'utf8'));
    data.tasks[0].expected.modelCalls = 999; await writeFile(path, JSON.stringify(data));
    await assert.rejects(run(['--dataset', path])); await assert.rejects(run(['--unknown']));
  } finally { await rm(root, { recursive: true, force: true }); }
});
