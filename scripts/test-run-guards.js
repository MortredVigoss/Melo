// Machine-level guards for the daily runner (2026-10-24 test-cost work).
//
// Two suites from two sessions, or a suite next to an Android / Swift build,
// turn 80 s of JS into 13 minutes of timeouts that then get rerun. Instead of
// paying for that twice, a run waits for the machine: one lock per machine for
// the heavy stages, and a load threshold before starting. Both only delay;
// after the wait budget the run proceeds and says so. Everything is injectable
// so the behaviour is unit-tested without sleeping.
import { mkdirSync, openSync, closeSync, writeSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir, loadavg, cpus } from 'node:os';
import { join } from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function defaultLockPath() {
  return join(tmpdir(), 'melo-test-runner.lock');
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

// Returns { acquired, waitedMs, holder, release }. A dead holder's lock is
// stale and taken over; a live holder is waited for up to `waitMs`, then the
// run continues without the lock (reported, never silent).
export async function acquireTestLock({ path = defaultLockPath(), waitMs = 10 * 60_000, pollMs = 5_000, now = Date.now, wait = sleep, isAlive = processAlive, pid = process.pid, label = '' } = {}) {
  const started = now();
  let holder = null;
  for (;;) {
    try {
      mkdirSync(join(path, '..'), { recursive: true });
      const fd = openSync(path, 'wx');
      writeSync(fd, JSON.stringify({ pid, label, startedAt: new Date(now()).toISOString() }));
      closeSync(fd);
      return { acquired: true, waitedMs: now() - started, holder, release: () => { try { if (JSON.parse(readFileSync(path, 'utf8')).pid === pid) unlinkSync(path); } catch { /* already gone */ } } };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    try { holder = JSON.parse(readFileSync(path, 'utf8')); } catch { holder = null; }
    if (!holder || !Number.isInteger(holder.pid) || !isAlive(holder.pid)) { try { unlinkSync(path); } catch { /* raced */ } continue; }
    if (now() - started >= waitMs) return { acquired: false, waitedMs: now() - started, holder, release: () => {} };
    await wait(pollMs);
  }
}

// Waits while the 1-minute load average is above `max` (default 1.5 × cores),
// up to `waitMs`. Returns the samples it saw so the summary can record them.
export async function waitForLoad({ max = cpus().length * 1.5, waitMs = 5 * 60_000, pollMs = 10_000, now = Date.now, wait = sleep, load = () => loadavg()[0], emit = () => {} } = {}) {
  const started = now();
  const samples = [];
  for (;;) {
    const current = load();
    samples.push(Number(current.toFixed(2)));
    if (current <= max) return { waitedMs: now() - started, samples, exceeded: false };
    if (now() - started >= waitMs) { emit(`负载 ${current.toFixed(1)} 仍高于 ${max.toFixed(1)}，等待 ${Math.round(waitMs / 1000)} s 后继续（结果可能出现超时类失败）`); return { waitedMs: now() - started, samples, exceeded: true }; }
    emit(`机器负载 ${current.toFixed(1)}（阈值 ${max.toFixed(1)}），等待其他构建 / 测试结束…`);
    await wait(pollMs);
  }
}

export function lockHeldBy(path = defaultLockPath()) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
