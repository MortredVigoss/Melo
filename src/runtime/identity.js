import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { atomicWriteJson } from '../storage.js';
import { resolveRuntimePaths } from './paths.js';

const run = promisify(execFile);

export async function createRuntimeIdentity({ paths = resolveRuntimePaths(), host = '127.0.0.1', port = 43127 } = {}) {
  let revision = 'unknown';
  let dirty = null;
  try {
    const result = await run('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: paths.projectDir, timeout: 1500 });
    revision = result.stdout.trim();
    const status = await run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: paths.projectDir, timeout: 1500 });
    dirty = Boolean(status.stdout.trim());
  } catch { /* Packaged installs need not contain Git metadata. */ }
  return {
    ...paths,
    instanceId: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    host,
    port,
    revision,
    dirty,
    nodeVersion: process.version,
  };
}

export async function publishRuntime(identity) {
  await atomicWriteJson(identity.runtimePath, identity);
}

export async function releaseRuntime(identity) {
  try {
    const current = JSON.parse(await readFile(identity.runtimePath, 'utf8'));
    if (current.instanceId === identity.instanceId) await unlink(identity.runtimePath);
  } catch { /* Missing or replaced metadata belongs to another lifecycle. */ }
}

export async function probeDesktopRuntime(paths = resolveRuntimePaths(), { fetchImpl = fetch } = {}) {
  let record;
  try { record = JSON.parse(await readFile(paths.runtimePath, 'utf8')); }
  catch { return { status: 'not-running', reason: 'no-runtime-record' }; }
  if (record.home !== paths.home || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) {
    return { status: 'mismatch', reason: 'invalid-runtime-record' };
  }
  try {
    // Runtime metadata cannot redirect diagnostics to an arbitrary remote host.
    const response = await fetchImpl(`http://127.0.0.1:${record.port}/api/health`, { signal: AbortSignal.timeout(2000) });
    const health = await response.json();
    if (!response.ok || health?.runtime?.instanceId !== record.instanceId || health.runtime.home !== paths.home) {
      return { status: 'mismatch', reason: 'different-listener', port: record.port };
    }
    return { status: 'running', runtime: health.runtime };
  } catch {
    return { status: 'not-running', reason: 'listener-unreachable', port: record.port };
  }
}

export async function readDesktopDiagnostics(paths, desktop, { includeStorage = false, probe = false, fetchImpl = fetch } = {}) {
  const runtime = desktop?.runtime;
  if (desktop?.status !== 'running' || runtime?.home !== paths.home) return null;
  if (!Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535) return null;
  try {
    const query = new URLSearchParams({ storage: includeStorage ? '1' : '0', probe: probe ? '1' : '0' });
    const response = await fetchImpl(`http://127.0.0.1:${runtime.port}/api/diagnostics?${query}`, { signal: AbortSignal.timeout(12000) });
    const report = await response.json();
    if (!response.ok || report?.paths?.home !== paths.home || report.desktop?.runtime?.instanceId !== runtime.instanceId) return null;
    return report;
  } catch { return null; }
}
