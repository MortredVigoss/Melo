import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHeavySource, poolLimits, poolOrder, nextJob, runTestPool, poolFileTimes } from './test-pool.js';
import { parseTapSummary } from './test-tap-summary.js';

// 2026-11-14 test-cost work: the JS regression runs its files through a weighted
// pool instead of one `node --test --test-concurrency=4` call. These cases pin
// what must not change (every file runs once, a failure fails the run, four
// heavy files at most) and what did (light files fill the free capacity).

test('heavy files are recognised from their own source, not from a list', () => {
  assert.equal(isHeavySource('desktop-ui/x.browser.test.js', ''), true);
  assert.equal(isHeavySource('src/a.test.js', "import { launch } from '../testSupport/testChrome.js';"), true);
  assert.equal(isHeavySource('src/a.test.js', "const { chromium } = await import('playwright-core');"), true);
  assert.equal(isHeavySource('src/a.test.js', "spawn(process.execPath, ['src/server.js'])"), true);
  // Naming the word is not starting a browser.
  assert.equal(isHeavySource('src/mcp/presets.test.js', "assert.equal(preset.id, 'playwright'); // chromium is optional"), false);
  assert.equal(isHeavySource('src/a.test.js', "import { x } from './server.js';"), false);
});

test('limits follow what the machine has to spare, never drop below four slots, and explicit values win', () => {
  assert.deepEqual(poolLimits({ env: {}, cores: 10, load: 0.4 }), { slots: 8, heavyCost: 2, heavyMax: 3 }, 'an idle ten-core machine');
  assert.deepEqual(poolLimits({ env: {}, cores: 10, load: 3.2 }), { slots: 5, heavyCost: 1.25, heavyMax: 3 }, 'three cores already busy');
  assert.deepEqual(poolLimits({ env: {}, cores: 10, load: 6.5 }), { slots: 4, heavyCost: 1, heavyMax: 3 }, 'a busy machine keeps the four slots the suite was written for');
  assert.deepEqual(poolLimits({ env: {}, cores: 10, load: 40 }), { slots: 4, heavyCost: 1, heavyMax: 3 });
  assert.deepEqual(poolLimits({ env: {}, cores: 4, load: 0 }), { slots: 4, heavyCost: 1, heavyMax: 3 }, 'a four-core runner: three heavy files and one light one');
  assert.deepEqual(poolLimits({ env: {}, cores: 2, load: 0 }), { slots: 4, heavyCost: 1, heavyMax: 3 });
  assert.deepEqual(poolLimits({ env: { MELO_TEST_BASELINE_LOAD: '5.2' }, cores: 10, load: 0 }), { slots: 4, heavyCost: 1, heavyMax: 3 }, 'the load the daily runner sampled before its own stages wins over the current one');
  assert.deepEqual(poolLimits({ env: { MELO_TEST_BASELINE_LOAD: '0.3' }, cores: 10, load: 9 }), { slots: 8, heavyCost: 2, heavyMax: 3 }, 'so the runner\'s own Swift and Android work does not shrink the pool');
  assert.deepEqual(poolLimits({ env: { MELO_TEST_BASELINE_LOAD: 'bad' }, cores: 10, load: 0 }), { slots: 8, heavyCost: 2, heavyMax: 3 }, 'an unreadable sample falls back to the current load');
  assert.deepEqual(poolLimits({ env: { MELO_TEST_CONCURRENCY: '1' }, cores: 10, load: 0 }), { slots: 1, heavyCost: 1, heavyMax: 1 }, 'serial stays serial');
  assert.deepEqual(poolLimits({ env: { MELO_TEST_CONCURRENCY: '6' }, cores: 10, load: 9 }), { slots: 6, heavyCost: 1.5, heavyMax: 3 }, 'an explicit size is not reduced by load');
  assert.deepEqual(poolLimits({ env: { MELO_TEST_HEAVY_MAX: '4' }, cores: 10, load: 0 }), { slots: 8, heavyCost: 2, heavyMax: 4 });
  assert.deepEqual(poolLimits({ env: { MELO_TEST_HEAVY_MAX: '2' }, cores: 10, load: 6 }), { slots: 4, heavyCost: 1, heavyMax: 2 }, 'a lower limit can be asked for');
  assert.deepEqual(poolLimits({ env: { MELO_TEST_CONCURRENCY: '2' }, cores: 10, load: 0 }), { slots: 2, heavyCost: 1, heavyMax: 2 }, 'never more heavy files than slots');
  assert.deepEqual(poolLimits({ env: { MELO_TEST_HEAVY_MAX: '9' }, cores: 10, load: 0 }), { slots: 8, heavyCost: 2, heavyMax: 4 }, 'never more heavy files than the slots hold');
  for (const value of ['0', '-1', '1.5', 'bad', '']) {
    assert.throws(() => poolLimits({ env: { MELO_TEST_CONCURRENCY: value } }), /MELO_TEST_CONCURRENCY must be a positive integer/, value);
    assert.throws(() => poolLimits({ env: { MELO_TEST_HEAVY_MAX: value } }), /MELO_TEST_HEAVY_MAX must be a positive integer/, value);
  }
});

test('order is heavy first, longest first, then by name', () => {
  const heavy = new Set(['b.browser.test.js', 'a.browser.test.js']);
  const order = poolOrder(['z.test.js', 'a.browser.test.js', 'm.test.js', 'b.browser.test.js', 'c.test.js'], heavy, { 'b.browser.test.js': 9000, 'm.test.js': 700, 'z.test.js': 20 });
  assert.deepEqual(order, ['b.browser.test.js', 'a.browser.test.js', 'm.test.js', 'z.test.js', 'c.test.js']);
});

test('a heavy file waiting for slots holds the queue; one waiting for the heavy limit lets light files in', () => {
  const heavy = new Set(['h1', 'h2']), limits = { slots: 8, heavyCost: 2, heavyMax: 3 };
  assert.equal(nextJob(['h1', 'l1'], heavy, 0, limits, 0), 0);
  assert.equal(nextJob(['h1', 'l1'], heavy, 6, limits, 2), 0, 'two slots free and two heavy files running: the heavy file starts');
  assert.equal(nextJob(['h1', 'l1'], heavy, 7, limits, 2), -1, 'one slot free: the light file must not jump the heavy one');
  assert.equal(nextJob(['h1', 'l1'], heavy, 6, limits, 3), 1, 'three heavy files running: the two slots left go to light files');
  assert.equal(nextJob(['h1', 'h2'], heavy, 6, limits, 3), -1, 'and a fourth heavy file waits even though it would fit');
  assert.equal(nextJob(['h1', 'l1'], heavy, 8, limits, 3), -1);
  assert.equal(nextJob(['l1', 'l2'], heavy, 7, limits, 0), 0, 'with no heavy file waiting the free slot is used');
  assert.equal(nextJob(['l1'], heavy, 8, limits, 0), -1);
  assert.equal(nextJob([], heavy, 0, limits, 0), -1);
});

function fakeSpawn(log, { durations = {}, exit = {}, output = {} } = {}) {
  let running = 0, heavyRunning = 0;
  return (_command, args) => {
    const file = args.at(-1), child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    const isHeavy = /browser/.test(file);
    running++; if (isHeavy) heavyRunning++;
    log.push({ file, running, heavyRunning, args });
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from(output[file] ?? `TAP version 13\nok 1 - ${file}\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`));
      running--; if (isHeavy) heavyRunning--;
      child.emit('close', exit[file] ?? 0);
    }, durations[file] ?? 5);
    return child;
  };
}

test('every file runs exactly once, never more heavy files than the limit, never more than the slots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'melo-pool-')); t.after(() => rm(root, { recursive: true, force: true }));
  const files = [...Array.from({ length: 7 }, (_, i) => `h${i}.browser.test.js`), ...Array.from({ length: 120 }, (_, i) => `l${i}.test.js`)];
  for (const file of files) await writeFile(join(root, file), '');
  const log = [], out = [];
  const { code, totals, results } = await runTestPool({ root, files, env: {}, limits: { slots: 8, heavyCost: 2, heavyMax: 3 }, write: text => out.push(text), spawnTest: fakeSpawn(log, { durations: Object.fromEntries(files.filter(f => /browser/.test(f)).map(f => [f, 40])) }) });
  assert.equal(code, 0);
  assert.deepEqual(log.map(row => row.file).sort(), [...files].sort(), 'each file is started once');
  assert.equal(Math.max(...log.map(row => row.heavyRunning)), 3, 'three heavy files at once is the ceiling');
  assert.equal(Math.max(...log.map(row => row.running)), 8, 'once the heavy files are done every slot is used');
  assert.equal(Math.max(...log.filter(row => row.heavyRunning === 3).map(row => row.running)), 5, 'three heavy files hold six of the eight slots; two light files run beside them');
  assert.ok(log.some(row => !/browser/.test(row.file) && row.heavyRunning === 3), 'light files run beside the heavy files from the start');
  assert.deepEqual(log[0].args.slice(0, 2), ['--test', '--test-timeout=120000'], 'the per-test timeout is unchanged');
  assert.deepEqual(totals, { tests: 127, pass: 127, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  const text = out.join('');
  assert.deepEqual({ tests: parseTapSummary(text).tests, pass: parseTapSummary(text).pass }, { tests: 127, pass: 127 }, 'the gate reads the summed counts');
  assert.equal(poolFileTimes(text).length, 127);
  assert.equal(results.length, 127);
});

test('one failing file fails the run and its failure is reported; a silent crash is counted too', async t => {
  const root = await mkdtemp(join(tmpdir(), 'melo-pool-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ['ok.test.js', 'bad.test.js', 'crash.test.js']) await writeFile(join(root, file), '');
  const failing = "TAP version 13\nnot ok 1 - broken\n  ---\n  location: '/x/bad.test.js:3:1'\n  failureType: 'testCodeFailure'\n  error: 'real regression'\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n";
  const out = [];
  const { code, totals } = await runTestPool({ root, files: ['ok.test.js', 'bad.test.js', 'crash.test.js'], env: {}, limits: { slots: 4, heavyCost: 1, heavyMax: 2 }, write: text => out.push(text), spawnTest: fakeSpawn([], { exit: { 'bad.test.js': 1, 'crash.test.js': 7 }, output: { 'bad.test.js': failing, 'crash.test.js': 'Segmentation fault\n' } }) });
  assert.equal(code, 1);
  assert.deepEqual([totals.tests, totals.pass, totals.fail], [2, 1, 2], 'the crashed file adds a failure of its own');
  const summary = parseTapSummary(out.join(''));
  assert.equal(summary.fail, 2);
  assert.ok(summary.failures.some(failure => failure.name === 'broken' && failure.error === 'real regression'));
  assert.ok(summary.failures.some(failure => failure.name === 'crash.test.js' && /exited with code 7/.test(failure.error)));
});

test('the command line runs real test files and exits 1 when one fails', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'melo-pool-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src')); await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'src/one.test.js'), "import test from 'node:test';test('one',()=>{});");
  await writeFile(join(root, 'src/two.test.js'), "import test from 'node:test';test('two',()=>{});");
  const script = fileURLToPath(new URL('./run-test-pool.js', import.meta.url)), env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const passed = await promisify(execFile)(process.execPath, [script, 'src/one.test.js', 'src/two.test.js'], { cwd: root, env });
  assert.match(passed.stdout, /# tests 2\n# pass 2\n# fail 0/);
  assert.equal(poolFileTimes(passed.stdout).length, 2);
  await writeFile(join(root, 'src/two.test.js'), "import test from 'node:test';test('two',()=>{throw Error('fixture must fail');});");
  await assert.rejects(promisify(execFile)(process.execPath, [script, 'src/one.test.js', 'src/two.test.js'], { cwd: root, env }), error => error.code === 1 && /fixture must fail/.test(error.stdout) && /# fail 1\n/.test(error.stdout));
  await assert.rejects(promisify(execFile)(process.execPath, [script], { cwd: root, env }), /Usage/);
});
