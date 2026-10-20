import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAndroidTaskReport } from './android-task-report.js';
test('AGP report collection rejects stale, missing, failed or ambiguous output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'melo-android-report-'));
  const report = { version: 1, evaluationId: 'current', host: 'Android-JavaScriptSandbox', report: { passed: true } };
  async function put(dir, value) { await mkdir(join(root, dir), { recursive: true }); await writeFile(join(root, dir, 'agent-task-eval-android.json'), JSON.stringify(value)); }
  try {
    await put('old', { ...report, evaluationId: 'old' });
    await assert.rejects(readAndroidTaskReport(root, 'current'));
    await put('connected/device', report);
    assert.deepEqual(await readAndroidTaskReport(root, 'current'), report);
    await put('duplicate', report); await assert.rejects(readAndroidTaskReport(root, 'current'));
    await rm(join(root, 'duplicate'), { recursive: true });
    await put('connected/device', { ...report, report: { passed: false } });
    await assert.rejects(readAndroidTaskReport(root, 'current'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
