/**
 * Dreaming scheduler — registers a background timer that periodically runs
 * `runDreamingSweep`.  Designed to be called once from the main process at
 * boot.  Safe to call multiple times — subsequent calls are no-ops.
 *
 * Schedule (default):
 *   • incremental sweep every 6h (sinceIso = lastRunAt)
 *   • full sweep every 24h (no sinceIso)
 *   • idle trigger: if the app has been idle 10+ minutes, run an incremental
 *
 * Idle detection is left pluggable — caller passes an `idleSignal` emitter
 * (e.g. Electron's powerMonitor).  We also expose `startIdleWatch({emitter})`
 * for unit tests.
 */

import { runDreamingSweep, dreamingEnabled } from './sweep.js';

const HOUR = 60 * 60 * 1000;
const SIX_HOURS = 6 * HOUR;
const TWENTY_FOUR_HOURS = 24 * HOUR;
const IDLE_MS = 10 * 60 * 1000;

let _scheduled = false;
let _lastIncrementalIso = null;
let _lastFullIso = null;
let _timers = [];
let _idleUnsub = null;

/**
 * @param {Object} [opts]
 * @param {(fn: Function, ms: number) => any} [opts.setInterval]  override for tests
 * @param {(t: any) => void}                   [opts.clearInterval]
 * @param {number} [opts.incrementalMs]
 * @param {number} [opts.fullMs]
 * @returns {{ stop: () => void }}
 */
export function startDreamingScheduler({
  setInterval: si = setInterval,
  clearInterval: ci = clearInterval,
  incrementalMs = SIX_HOURS,
  fullMs = TWENTY_FOUR_HOURS,
} = {}) {
  if (_scheduled) return { stop };
  if (!dreamingEnabled()) return { stop: () => {} };
  _scheduled = true;

  const runIncremental = () => {
    const sinceIso = _lastIncrementalIso;
    _lastIncrementalIso = new Date().toISOString();
    runDreamingSweep({ sinceIso }).catch(() => {});
  };
  const runFull = () => {
    _lastFullIso = new Date().toISOString();
    runDreamingSweep({ sinceIso: null, limit: 20000 }).catch(() => {});
  };

  _timers.push(si(runIncremental, incrementalMs));
  _timers.push(si(runFull, fullMs));

  return { stop };
}

export function stop() {
  for (const t of _timers) {
    try { clearInterval(t); } catch {}
  }
  _timers = [];
  if (_idleUnsub) { try { _idleUnsub(); } catch {} _idleUnsub = null; }
  _scheduled = false;
}

/**
 * Trigger a sweep explicitly — used by the "Consolidate now" UI button
 * and by external IPC callers.
 */
export async function triggerDreamingNow({ full = false } = {}) {
  if (!dreamingEnabled()) return { skipped: true, reason: 'disabled' };
  if (full) {
    _lastFullIso = new Date().toISOString();
    return runDreamingSweep({ sinceIso: null, limit: 20000 });
  }
  const sinceIso = _lastIncrementalIso;
  _lastIncrementalIso = new Date().toISOString();
  return runDreamingSweep({ sinceIso });
}

/**
 * Watch an idle signal source.  `emitter` must expose `.on('idle', cb)` and
 * return a cleanup function.  This is separate from the timer because
 * Electron's powerMonitor lives in the main process only.
 */
export function startIdleWatch({ emitter, idleMs = IDLE_MS } = {}) {
  if (!emitter?.on) return () => {};
  // 2026-06-04 audit闭环: tear down any prior watch before installing a new
  // one. `_idleUnsub` is a module-global; re-arming (powerMonitor re-init,
  // runtime restart without stop()) used to overwrite it without clearing
  // the previous setInterval + emitter listeners → orphaned interval firing
  // triggerDreamingNow forever + listener accumulation.
  try { _idleUnsub?.(); } catch {}
  let lastActivity = Date.now();
  const onActivity = () => { lastActivity = Date.now(); };
  const onCheck = () => {
    if (Date.now() - lastActivity >= idleMs) {
      triggerDreamingNow({ full: false }).catch(() => {});
    }
  };

  emitter.on('activity', onActivity);
  emitter.on('idle', onCheck);

  const timer = setInterval(onCheck, idleMs);
  _idleUnsub = () => {
    try { emitter.removeListener?.('activity', onActivity); } catch {}
    try { emitter.removeListener?.('idle', onCheck); } catch {}
    clearInterval(timer);
  };
  return _idleUnsub;
}

export function _resetForTests() {
  stop();
  _lastIncrementalIso = null;
  _lastFullIso = null;
}
