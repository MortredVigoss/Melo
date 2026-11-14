// Runs JS test files as separate `node --test` processes under a weighted limit
// (2026-11-14 test-cost work). Same files, same per-test timeout, same exit
// semantics as one `node --test --test-concurrency=4 …` call; only the order
// and the number of light files running next to each other change.
//
// Why weights: about forty files start a real browser or the real server and
// account for most of the stage; the other five hundred are short. A flat
// limit of 4 in name order let four short files hold every slot while the long
// ones queued, and now and then put four browsers side by side. Here the long
// files start first, a heavy file costs slots / 4, at most `heavyMax` of them
// run at once and the capacity they leave goes to light files.
//
// How many slots: what the machine has to spare when the run starts. The
// suite's timing-sensitive tests were written for four files at once; on a
// machine that is also doing other work, eight files and four browsers pushed
// a browser test past its own timeout and made a trace flush miss its deadline
// (measured 2026-11-14). So the cores already busy are subtracted, the floor
// is the four slots the suite has always had, and no more than three heavy
// files run together. Three, not two: with four slots and a load of 9-10 on
// ten cores the 41 heavy files alone took 87 s three at a time and 111 s two
// at a time, all passing in both runs.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';
import { parseTapSummary } from './test-tap-summary.js';

// Detected from the test's own source, never from a list: a file named
// `*.browser.test.js`, one that imports Playwright or the shared Chrome
// launcher, or one that starts `src/server.js`.
const BROWSER_SOURCE = /(?:\bfrom\s+|\bimport\s*\(\s*)['"][^'"\n]*(?:testChrome\.js|playwright(?:-core)?)['"]/;
const SERVER_SOURCE = /['"`]src\/server\.js['"`]/;
export function isHeavySource(path, source) {
  return /\.browser\.test\.[cm]?js$/.test(path) || BROWSER_SOURCE.test(source) || SERVER_SOURCE.test(source);
}
export async function heavyTests(root, files) {
  const heavy = new Set();
  await Promise.all(files.map(async file => {
    if (isHeavySource(file, await readFile(resolve(root, file), 'utf8').catch(() => ''))) heavy.add(file);
  }));
  return heavy;
}

// `load` is the 1-minute load average before the run's own work started: the
// daily runner passes the sample it took before its first stage as
// MELO_TEST_BASELINE_LOAD, anything else reads the current value.
export function poolLimits({ env = process.env, cores = cpus().length, load = loadavg()[0] } = {}) {
  const positive = (name, value) => { if (value !== undefined && (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error(`${name} must be a positive integer`); return value === undefined ? null : Number(value); };
  const requested = positive('MELO_TEST_CONCURRENCY', env.MELO_TEST_CONCURRENCY), asked = positive('MELO_TEST_HEAVY_MAX', env.MELO_TEST_HEAVY_MAX);
  const baseline = Number(env.MELO_TEST_BASELINE_LOAD);
  const busy = Math.max(0, Math.floor(env.MELO_TEST_BASELINE_LOAD !== undefined && Number.isFinite(baseline) ? baseline : Number.isFinite(load) ? load : 0));
  const slots = requested ?? Math.max(4, Math.min(8, cores - 2 - busy));
  const heavyCost = Math.max(1, slots / 4);
  const heavyMax = Math.max(1, Math.min(Math.floor(slots / heavyCost), asked ?? 3));
  return { slots, heavyCost, heavyMax };
}

// Longest first, heavy before light, then by name: the order is a pure
// function of its inputs. `times` are the wall-clock milliseconds of an
// earlier run (missing files sort after measured ones of their class).
export function poolOrder(files, heavy, times = {}) {
  const known = file => Number.isFinite(times[file]) ? times[file] : -1;
  return [...files].sort((a, b) => (heavy.has(b) - heavy.has(a)) || (known(b) - known(a)) || (a < b ? -1 : a > b ? 1 : 0));
}

// The next job that may start, or -1. A heavy job that is waiting for slots
// holds the queue: light jobs finish within seconds and would otherwise keep
// taking the single free slot it needs two of. A heavy job that is waiting only
// because `heavyMax` of them are running does not: the slots left over are for
// light jobs.
export function nextJob(queue, heavy, used, limits, heavyRunning = 0) {
  if (!queue.length) return -1;
  const free = limits.slots - used;
  const head = queue.findIndex(file => heavy.has(file));
  const capped = heavyRunning >= (limits.heavyMax ?? Infinity);
  if (head >= 0 && !capped) return limits.heavyCost <= free + 1e-9 ? head : -1;
  const light = queue.findIndex(file => !heavy.has(file));
  return light >= 0 && free >= 1 - 1e-9 ? light : -1;
}

export async function runTestPool({ root = process.cwd(), files, env = { ...process.env }, limits = poolLimits({ env }), times = {}, timeoutMs = 120000, watchdogMs = 30 * 60_000, write = text => process.stdout.write(text), spawnTest = spawn } = {}) {
  const heavy = await heavyTests(root, files);
  const queue = poolOrder(files, heavy, times);
  const totals = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  const results = [];
  let used = 0, running = 0, heavyRunning = 0, failed = false;
  write(`# pool ${files.length} files (${heavy.size} heavy), ${limits.slots} slots, heavy cost ${limits.heavyCost}, at most ${limits.heavyMax ?? 'any number of'} heavy at once\n`);
  await new Promise(done => {
    const start = () => {
      for (;;) {
        const index = nextJob(queue, heavy, used, limits, heavyRunning);
        if (index < 0) break;
        const [file] = queue.splice(index, 1), isHeavy = heavy.has(file), cost = isHeavy ? limits.heavyCost : 1, began = Date.now();
        used += cost; running++; if (isHeavy) heavyRunning++;
        const chunks = [];
        const child = spawnTest(process.execPath, ['--test', `--test-timeout=${timeoutMs}`, file], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
        // A file that never exits would hold its slot for ever; `--test-timeout`
        // already bounds every test, so this only fires for a hung process.
        const watchdog = setTimeout(() => { chunks.push(Buffer.from(`\nnot ok 1 - ${file}\n  ---\n  failureType: 'testTimeoutFailure'\n  error: 'the test file did not exit within ${Math.round(watchdogMs / 1000)} s and was stopped'\n  ...\n`)); child.kill('SIGKILL'); }, watchdogMs);
        child.stdout.on('data', chunk => chunks.push(chunk));
        child.stderr.on('data', chunk => chunks.push(chunk));
        let settled = false;
        const finish = (code, note = '') => {
          if (settled) return; settled = true;
          clearTimeout(watchdog);
          const output = Buffer.concat(chunks).toString('utf8') + note, ms = Date.now() - began;
          const tap = parseTapSummary(output);
          for (const key of Object.keys(totals)) totals[key] += tap[key];
          // A process that died without reporting a failing test still fails the run and is counted.
          const silent = code !== 0 && !tap.fail && !tap.cancelled;
          if (silent) totals.fail += 1;
          if (code !== 0) failed = true;
          results.push({ file, ms, code, heavy: heavy.has(file) });
          write(`# file ${file}\n${output}${output.endsWith('\n') ? '' : '\n'}${silent ? `not ok 1 - ${file}\n  ---\n  failureType: 'testCodeFailure'\n  error: 'the test file exited with code ${code} without reporting a failed test'\n  ...\n` : ''}`);
          used -= cost; running--; if (isHeavy) heavyRunning--;
          if (!queue.length && !running) done(); else start();
        };
        child.once('error', error => finish(1, `\n${error.message}\n`));
        child.once('close', code => finish(code ?? 1));
      }
      if (!queue.length && !running) done();
    };
    start();
  });
  results.sort((a, b) => b.ms - a.ms);
  for (const row of results) write(`# file-time ${row.ms} ${row.code} ${row.heavy ? 'heavy' : 'light'} ${row.file}\n`);
  // The aggregate comes last: the summary parser keeps the last count it reads.
  for (const [key, value] of Object.entries(totals)) write(`# ${key} ${value}\n`);
  return { code: failed ? 1 : 0, totals, results };
}

// `# file-time <ms> <exit> <class> <path>` lines back into rows.
export function poolFileTimes(text = '') {
  const rows = [];
  for (const match of String(text).matchAll(/^# file-time (\d+) (\d+) (heavy|light) (.+)$/gm)) rows.push({ file: match[4], ms: Number(match[1]), code: Number(match[2]), heavy: match[3] === 'heavy' });
  return rows;
}
