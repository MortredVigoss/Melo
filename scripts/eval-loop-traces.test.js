import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTraceFixtures, inspectTrace } from './eval-loop-traces.js';
test('eight local controlled traces exercise shared Loop transitions; labels are independent and missing labels never mean pass', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-trace-fixtures-')); t.after(() => rm(home, { recursive:true,force:true }));
  const reports = await createTraceFixtures(home);
  assert.equal(reports.length, 8); for (const report of reports) assert.equal(report.passed, true, report.id + ': ' + report.failures.join(','));
  const trace = reports.find(row => row.id === 'calendar-venue-weather');
  assert.equal((await inspectTrace(trace.directory)).passed, null);
  const deliberatelyWrong = await inspectTrace(trace.directory, { requiredTools: ['missing-weather-tool'] });
  assert.equal(deliberatelyWrong.passed, false);
  assert.ok(deliberatelyWrong.failures.includes('MISSING_TOOL:missing-weather-tool'));
  const raw = await readFile(join(trace.directory,'events.jsonl'),'utf8'); assert.ok(raw.split('\n').length > 20);
  await writeFile(join(trace.directory,'events.jsonl'),raw + '{broken-tail');
  const broken = await inspectTrace(trace.directory, {}); assert.equal(broken.passed,false); assert.equal(broken.complete,false);
});
