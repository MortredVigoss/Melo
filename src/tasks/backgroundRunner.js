/**
 * Background task runner.
 *
 * Manages long-running shell commands as named background tasks.
 * Each task has a unique id, streams stdout/stderr incrementally,
 * and persists its final output/status so it can be retrieved later.
 *
 * Architecture:
 *   - Tasks are kept in memory while running (Map: taskId → RunRecord)
 *   - Subscribers (SSE connections) receive incremental output chunks
 *   - On completion, output + status are stored as the task's latestNote
 *     and the task state is persisted via the provided onComplete callback
 *
 * Usage:
 *   const runner = new BackgroundRunner();
 *   const taskId = await runner.start({ command, workspacePath, onComplete });
 *   runner.subscribe(taskId, chunk => sendSse('chunk', chunk));
 *   const info = runner.status(taskId);
 *   runner.kill(taskId);
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * @typedef {Object} RunRecord
 * @property {string}   id            - unique task run id
 * @property {string}   command       - shell command string
 * @property {'running'|'done'|'error'|'killed'} status
 * @property {string}   output        - accumulated stdout+stderr
 * @property {number|null} exitCode
 * @property {number}   startedAt     - Date.now() ms
 * @property {number|null} endedAt
 * @property {Function[]} _subscribers  - active output subscribers
 */

const MAX_OUTPUT_CHARS = 500_000; // ~500 KB cap on in-memory output

export class BackgroundRunner {
  constructor() {
    /** @type {Map<string, RunRecord>} */
    this._runs = new Map();
  }

  /**
   * Start a background shell command.
   *
   * @param {Object} options
   * @param {string}   options.command          - shell command
   * @param {string}   [options.workspacePath]  - cwd for the command
   * @param {number}   [options.timeout]        - ms before auto-kill (default: 10min)
   * @param {Function} [options.onComplete]     - (record) => void called on finish
   * @param {AbortSignal} [options.signal]      - external abort
   * @returns {string}  - run id
   */
  start({ command, workspacePath, timeout = 10 * 60_000, onComplete, signal }) {
    const id = randomUUID();
    /** @type {RunRecord} */
    const record = {
      id,
      command,
      status: 'running',
      output: '',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      _subscribers: [],
    };
    this._runs.set(id, record);

    const proc = spawn('bash', ['-c', command], {
      cwd: workspacePath || process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const killTimer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 3000);
    }, timeout);

    const onAbort = () => {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 2000);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const onData = (chunk) => {
      const text = chunk.toString();
      record.output = (record.output + text).slice(-MAX_OUTPUT_CHARS);
      for (const sub of record._subscribers) {
        try { sub(text); } catch {}
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('close', (code, sigName) => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);

      if (record.status !== 'running') return; // already killed externally
      record.exitCode = sigName ? null : (code ?? 1);
      record.status = sigName
        ? 'killed'
        : record.exitCode === 0 ? 'done' : 'error';
      record.endedAt = Date.now();

      // Notify all subscribers that the stream ended
      const endChunk = `\n[Process ${record.status}: exit ${record.exitCode ?? sigName}]`;
      for (const sub of record._subscribers) {
        try { sub(endChunk); } catch {}
      }
      record._subscribers = [];

      if (typeof onComplete === 'function') {
        onComplete(record);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      record.status = 'error';
      record.output += `\n[Spawn error: ${err.message}]`;
      record.endedAt = Date.now();
      for (const sub of record._subscribers) {
        try { sub(`\n[Spawn error: ${err.message}]`); } catch {}
      }
      record._subscribers = [];
      if (typeof onComplete === 'function') {
        onComplete(record);
      }
    });

    return id;
  }

  /**
   * Subscribe to output chunks for a running task.
   * Returns the accumulated output so far (for catch-up), then calls
   * subscriber for future chunks until the task finishes.
   *
   * @param {string}   runId
   * @param {Function} subscriber  - (chunk: string) => void
   * @returns {string}  - accumulated output so far
   */
  subscribe(runId, subscriber) {
    const record = this._runs.get(runId);
    if (!record) return '';

    const catchUp = record.output;
    if (record.status === 'running') {
      record._subscribers.push(subscriber);
    }
    return catchUp;
  }

  /**
   * Kill a running task.
   * @param {string} runId
   */
  kill(runId) {
    const record = this._runs.get(runId);
    if (!record || record.status !== 'running') return;
    record.status = 'killed';
    record.endedAt = Date.now();
    // The proc.on('close') will fire and clean up
  }

  /**
   * Get current status of a run.
   * @param {string} runId
   * @returns {RunRecord|null}
   */
  status(runId) {
    return this._runs.get(runId) || null;
  }

  /**
   * List all runs (active + recent).
   * @returns {RunRecord[]}
   */
  list() {
    return [...this._runs.values()];
  }

  /**
   * Remove a finished run from memory.
   * @param {string} runId
   */
  cleanup(runId) {
    const record = this._runs.get(runId);
    if (record && record.status !== 'running') {
      this._runs.delete(runId);
    }
  }
}

// ─── Singleton instance ───────────────────────────────────────────────────────

export const backgroundRunner = new BackgroundRunner();
