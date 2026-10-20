#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { evaluate } from '../shared/agent/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
export async function evaluateTasks({ host = 'node', datasetPath = resolve(root, 'shared/agent/fixtures/tasks.json') } = {}) {
  const source = await readFile(datasetPath);
  const bundle = await readFile(resolve(root, 'shared/agent/dist/agent-core.js'));
  const start = performance.now();
  const result = evaluate({ version: 1, op: 'taskReplay', dataset: JSON.parse(source) });
  if (!result.ok || !result.value.passed) throw Error('Task evaluation failed: ' + JSON.stringify(result));
  return { version: 1, host, datasetSha256: hash(source), bundleSha256: hash(bundle), replayElapsedMs: performance.now() - start, report: result.value };
}
export function compareTaskReports(reference, candidate) {
  if (reference.version !== 1 || candidate.version !== 1 || reference.report?.kind !== 'fixture' || candidate.report?.kind !== 'fixture' || !reference.report.passed || !candidate.report.passed) throw Error('Only passing fixture reports can be compared.');
  if (reference.datasetSha256 !== candidate.datasetSha256 || reference.bundleSha256 !== candidate.bundleSha256) throw Error('Task dataset or Core bundle differs.');
  if (!isDeepStrictEqual(reference.report, candidate.report)) throw Error('Task metrics, receipts or normalized events differ.');
  return { hosts: [reference.host, candidate.host], tasks: reference.report.tasks.length, identical: true };
}
async function main(args) {
  const options = {}, compare = [];
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (['--out', '--dataset', '--compare', '--write-golden'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const value = args[++i];
      if (key === '--compare') compare.push(value); else options[key] = value;
    } else throw Error('Usage: eval-agent-tasks.js [--dataset file] [--out file] [--compare report] [--write-golden file]');
  }
  const result = await evaluateTasks({ datasetPath: options['--dataset'] });
  for (const path of compare) console.log(JSON.stringify(compareTaskReports(result, JSON.parse(await readFile(path, 'utf8')))));
  for (const [key, data] of [['--out', result], ['--write-golden', result.report]]) {
    if (!options[key]) continue;
    await mkdir(dirname(options[key]), { recursive: true });
    await writeFile(options[key], JSON.stringify(data, null, 2) + '\n');
  }
  console.log(`${result.report.tasks.length} deterministic tasks passed; fixture tokens/latency only; no real-model quality claim.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
