import { Worker } from 'node:worker_threads';
import { derivedHomeKey, registerDerivedDispatcher } from '../state/derivedDispatcher.js';

export function startDerivedIndexing({ home, env, onEvent } = {}) {
  home = derivedHomeKey(home);
  const capturedEnv = { ...env, MELO_HOME: home };
  let worker, stopped = false, restart, latestRevision = 0, indexedRevision = -1;
  let status = 'pending';
  let lastDurationMs = null, lastError = null;
  const snapshot = () => ({status,latestRevision,indexedRevision,lastDurationMs,lastError});
  const waiters = new Set();
  function settle() {
    for (const waiter of waiters) if (indexedRevision >= waiter.revision) {
      clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve();
    }
  }
  function launch() {
    if (stopped) return;
    worker = new Worker(new URL('./derivedIndexWorker.js', import.meta.url), {
      workerData: { home, env: capturedEnv }, env: capturedEnv,
    });
    worker.on('message', message => {
      if (message.type === 'indexed') { indexedRevision = message.revision; latestRevision = Math.max(latestRevision,indexedRevision); lastDurationMs = message.durationMs; lastError = null; status = indexedRevision >= latestRevision ? 'ready' : 'pending'; settle(); }
      if (message.type === 'deferred') { status = 'deferred'; lastError = message.code; }
      try { onEvent?.(message); } catch {}
    });
    worker.on('error', () => { status = 'deferred'; });
    worker.on('exit', () => {
      worker = null;
      if (!stopped) { status = 'deferred'; restart = setTimeout(launch, 1000); restart.unref(); }
    });
    worker.unref();
  }
  const unregister = registerDerivedDispatcher(home, revision => {
    latestRevision = Math.max(latestRevision, revision || 0); status = 'pending';
    worker?.postMessage({ type: 'commit' });
  }, snapshot);
  launch();
  const flush = ({ revision = latestRevision, timeoutMs = 10_000 } = {}) => {
    if (indexedRevision >= revision) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { revision, resolve, reject };
      waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(Object.assign(new Error('Derived index is still pending'), {code:'DERIVED_INDEX_PENDING'})); }, timeoutMs);
      waiters.add(waiter);
      worker?.postMessage({ type: 'commit' });
    });
  };
  return {
    flush,
    status: snapshot,
    async stop({ drain = true } = {}) {
      if (drain) await flush({ timeoutMs: 2000 }).catch(() => {});
      stopped = true; unregister(); clearTimeout(restart);
      for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('Index worker stopped')); }
      waiters.clear();
      await worker?.terminate();
    },
  };
}
