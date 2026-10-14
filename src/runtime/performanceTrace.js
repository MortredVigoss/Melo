import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

// Timings contain stage names and durations only: never prompts, credentials,
// paths, model output or error messages. Disabled callers pay no I/O cost.
const scope = new AsyncLocalStorage();
const writers = new Map();
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function writeBatch(path, rows) {
  if (!path || !rows.length) return;
  const pending = (writers.get(path) || Promise.resolve()).catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive: true });
    if ((await stat(path).catch(() => null))?.size > MAX_LOG_BYTES) await rename(path, `${path}.previous`);
    await appendFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  });
  writers.set(path, pending);
  pending.catch(() => {}).finally(() => { if (writers.get(path) === pending) writers.delete(path); });
}

export function startStage(stage) {
  const trace = scope.getStore();
  if (!trace) return () => {};
  const started = performance.now();
  let ended = false;
  return (status = 'completed') => {
    if (ended) return;
    ended = true;
    const row = { stage, durationMs: Math.round((performance.now() - started) * 1000) / 1000,
      status, at: new Date().toISOString() };
    if (trace.rows.length < 2048) trace.rows.push(row);
    try { trace.onTiming?.(row); } catch { /* Observability cannot fail a turn. */ }
  };
}

export async function measureStage(stage, work) {
  const end = startStage(stage);
  try { const value = await work(); end(); return value; }
  catch (error) { end('failed'); throw error; }
}

export function measureStageSync(stage, work) {
  const end = startStage(stage);
  try { const value = work(); end(); return value; }
  catch (error) { end('failed'); throw error; }
}

export function hasPerformanceTrace() { return Boolean(scope.getStore()); }

export async function withPerformanceTrace({ onTiming, logPath } = {}, work) {
  const trace = { onTiming, rows: [] };
  try { return await scope.run(trace, work); }
  finally { writeBatch(logPath, trace.rows); }
}

export async function flushPerformanceLogs() { await Promise.allSettled([...writers.values()]); }
