#!/usr/bin/env node
// Synthetic application-path measurements. Never contacts a model or user home.
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir, cpus, platform, release } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { capacityWorker, distribution } from './capacity-fixture.js';

const args = process.argv.slice(2);
const childEnvironment = { ...process.env };
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
if (args.includes('--worker')) {
  const settings = JSON.parse(await readFile(option('--input'), 'utf8'));
  await writeFile(option('--result'), JSON.stringify(await capacityWorker(settings)));
} else {
  const sizes = String(option('--sizes', '20,200,1000')).split(',').map(Number);
  const coldSamples = Number(option('--cold-samples', 10)), rounds = Number(option('--rounds', 20));
  const messages = Number(option('--messages', 50)), chars = Number(option('--chars', 512));
  const indexMode = option('--index', 'deferred');
  if (!['deferred', 'inline'].includes(indexMode)) throw Error('Index mode must be deferred or inline');
  if (![...sizes, coldSamples, rounds, messages, chars].every(value => Number.isSafeInteger(value) && value > 0) ||
    sizes.length > 10 || Math.max(...sizes) > 5000 || messages > 1000 || chars > 8000 || rounds > 100 || coldSamples > 50) throw Error('Invalid benchmark dimensions');
  const root = await mkdtemp(join(tmpdir(), 'melo-capacity-'));
  const report = { version: 1, kind: 'synthetic-local-capacity', createdAt: new Date().toISOString(),
    environment: { node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model,
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() },
    fixture: { sizes, coldSamples, rounds, messagesPerChat: messages, contentChars: chars, model: 'stub', embedding: 'stub-null',
      network: 'not measured', indexMode, indexDefinition: indexMode === 'deferred' ? 'revision notifications retained; derived indexing deferred without a competing worker; not an indexed-memory capacity benchmark' : 'standalone synchronous derived indexing',
      coldDefinition: 'fresh process and application caches; OS filesystem cache not flushed',
      memoryDefinition: 'OS child-process peak RSS, including module load and validation; not live-object heap size' }, sizes: [] };
  async function worker(settings) {
    const input = join(root, 'input.json'), result = join(root, 'result.json');
    await writeFile(input, JSON.stringify(settings));
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', '--input', input, '--result', result], {
        env: { ...childEnvironment, MELO_HOME: settings.home, MELO_TEST_MODE: '1', MELO_DREAMING_ENABLED: '0', MELO_OFFLINE_ONLY: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let log = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { log = (log + value).slice(-8000); });
      child.once('error', reject);
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Error('Capacity worker exceeded five minutes')); }, 300000);
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`Capacity worker failed (${code}): ${log}`)); });
    });
    return JSON.parse(await readFile(result, 'utf8'));
  }
  try {
    for (const chats of sizes) {
      const config = { home: join(root, String(chats)), chats, messages, chars, indexMode };
      const storage = await worker({ ...config, mode: 'seed' });
      const cold = [];
      for (let i = 0; i < coldSamples; i++) cold.push(await worker({ ...config, mode: 'cold', rounds: 1 }));
      const warm = await worker({ ...config, mode: 'warm', rounds });
      const summarize = runs => {
        const samples = runs.flatMap(run => run.samples);
        const stages = {};
        for (const run of runs) for (const [key, values] of Object.entries(run.stages)) (stages[key] ||= []).push(...values);
        return { ...Object.fromEntries(['buildMs', 'serializeMs', 'transportMs', 'fullBytes', 'wireBytes'].map(key => [key, distribution(samples.map(row => row[key]))])),
          peakRssBytes: distribution(runs.map(run => run.peakRssBytes)), stages: Object.fromEntries(Object.entries(stages).map(([key, values]) => [key, distribution(values)])), samples };
      };
      report.sizes.push({ chats, messages: chats * messages, storage, cold: summarize(cold), warm: summarize([warm]),
        localPreparationMs: distribution(warm.localPreparationMs), semantics: warm.semantics });
      const checkpoint = option('--out', null);
      if (checkpoint) { await mkdir(dirname(checkpoint), { recursive: true }); await writeFile(checkpoint, JSON.stringify({ ...report, complete: false }, null, 2) + '\n'); }
      console.error(`Measured ${chats} chats / ${chats * messages} messages`);
    }
    report.complete = true;
    const output = option('--out', null);
    if (output) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
    console.log(JSON.stringify(report, null, 2));
  } finally { await rm(root, { recursive: true, force: true }); }
}
