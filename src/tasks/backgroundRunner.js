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
  constructor({ now = Date.now, retentionMs = 30 * 60_000, maxFinished = 20 } = {}) {
    this.now = now;
    this.retentionMs = retentionMs;
    this.maxFinished = maxFinished;
    this._cleanupTimer = null;
    /** @type {Map<string, RunRecord>} */
    this._runs = new Map();
    this._processes = new Map();
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
  start({ command, workspacePath, timeout = 10 * 60_000, onComplete, signal, env = { ...process.env } }) {
    this.prune();
    const id = randomUUID();
    /** @type {RunRecord} */
    const record = {
      id,
      command,
      status: 'running',
      output: '',
      exitCode: null,
      startedAt: this.now(),
      endedAt: null,
      _subscribers: [],
    };
    this._runs.set(id, record);

    if (signal?.aborted) {
      record.status = 'killed';
      record.endedAt = this.now();
      this.prune();
      if (onComplete) Promise.resolve().then(() => onComplete(record)).catch(() => {});
      return id;
    }

    const proc = spawn('bash', ['-c', command], {
      cwd: workspacePath || process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let forceTimer = null;
    let finished = false;
    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    const sendSignal = name => {
      try {
        if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, name);
        else proc.kill(name);
      } catch {}
    };
    const stop = () => {
      if (finished || forceTimer) return;
      record.status = 'killed';
      sendSignal('SIGTERM');
      forceTimer = setTimeout(() => sendSignal('SIGKILL'), 2000);
      forceTimer.unref?.();
    };
    this._processes.set(id, { stop, closed });
    const killTimer = setTimeout(stop, timeout);
    killTimer.unref?.();
    const onAbort = stop;
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
      if (finished) return;
      // The shell may exit before a redirected descendant that ignored TERM.
      if (record.status === 'killed') sendSignal('SIGKILL');
      finished = true;
      clearTimeout(killTimer);
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', onAbort);
      this._processes.delete(id);
      resolveClosed();
      record.exitCode = sigName ? null : (code ?? 1);
      record.status = sigName || record.status === 'killed'
        ? 'killed'
        : record.exitCode === 0 ? 'done' : 'error';
      record.endedAt = this.now();

      // Notify all subscribers that the stream ended
      const endChunk = `\n[Process ${record.status}: exit ${record.exitCode ?? sigName}]`;
      for (const sub of record._subscribers) {
        try { sub(endChunk); } catch {}
      }
      record._subscribers = [];
      this.prune();

      if (typeof onComplete === 'function') {
        Promise.resolve().then(() => onComplete(record)).catch(() => {});
      }
    });

    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', onAbort);
      this._processes.delete(id);
      resolveClosed();
      record.status = 'error';
      record.output += `\n[Spawn error: ${err.message}]`;
      record.endedAt = this.now();
      for (const sub of record._subscribers) {
        try { sub(`\n[Spawn error: ${err.message}]`); } catch {}
      }
      record._subscribers = [];
      this.prune();
      if (typeof onComplete === 'function') {
        Promise.resolve().then(() => onComplete(record)).catch(() => {});
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

  unsubscribe(runId, subscriber) {
    const record = this._runs.get(runId);
    if (record) record._subscribers = record._subscribers.filter(fn => fn !== subscriber);
  }

  prune() {
    clearTimeout(this._cleanupTimer);
    const finished = [...this._runs.values()].filter(r => r.endedAt != null).sort((a, b) => b.endedAt - a.endedAt);
    finished.forEach((record, index) => {
      if (index >= this.maxFinished || this.now() - record.endedAt >= this.retentionMs) this._runs.delete(record.id);
    });
    const expiry = [...this._runs.values()].filter(r => r.endedAt != null).map(r => r.endedAt + this.retentionMs);
    if (expiry.length) {
      this._cleanupTimer = setTimeout(() => this.prune(), Math.max(1, Math.min(...expiry) - this.now()));
      this._cleanupTimer.unref?.();
    }
  }

  /**
   * Kill a running task.
   * @param {string} runId
   */
  kill(runId) {
    const record = this._runs.get(runId);
    if (!record || record.status !== 'running') return;
    this._processes.get(runId)?.stop();
  }

  async shutdown() {
    const processes = [...this._processes.values()];
    for (const child of processes) child.stop();
    await Promise.allSettled(processes.map(child => child.closed));
    clearTimeout(this._cleanupTimer);
  }

  /**
   * Get current status of a run.
   * @param {string} runId
   * @returns {RunRecord|null}
   */
  status(runId) {
    this.prune();
    return this._runs.get(runId) || null;
  }

  /**
   * List all runs (active + recent).
   * @returns {RunRecord[]}
   */
  list() {
    this.prune();
    return [...this._runs.values()];
  }

  /**
   * Remove a finished run from memory.
   * @param {string} runId
   */
  cleanup(runId) {
    const record = this._runs.get(runId);
    if (record && record.endedAt != null) {
      this._runs.delete(runId);
    }
  }
}

// ─── Singleton instance ───────────────────────────────────────────────────────

export const backgroundRunner = new BackgroundRunner();
