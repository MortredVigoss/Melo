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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getMeloHome } from '../../config.js';

const HOUR = 60 * 60 * 1000;
const SIX_HOURS = 6 * HOUR;
const TWENTY_FOUR_HOURS = 24 * HOUR;
const IDLE_MS = 10 * 60 * 1000;
// 2026-10-17 audit C-11: the scheduler only registered 6h / 24h intervals and
// kept lastRun in memory, so a desktop that never stays up for six hours never
// ran a sweep at all. Now the last run times are persisted under the home and
// a startup check runs an overdue sweep shortly after boot.
const STARTUP_DELAY_MS = 3 * 60 * 1000;

let _scheduled = false;
let _lastIncrementalIso = null;
let _lastFullIso = null;
let _timers = [];
let _idleUnsub = null;

function stateFile() {
  return join(getMeloHome(), 'desktop', 'dreams', 'scheduler.json');
}
function loadPersistedRuns() {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf8'));
    if (typeof parsed?.lastIncrementalIso === 'string') _lastIncrementalIso = parsed.lastIncrementalIso;
    if (typeof parsed?.lastFullIso === 'string') _lastFullIso = parsed.lastFullIso;
  } catch {}
}
function persistRuns() {
  try {
    mkdirSync(dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({ lastIncrementalIso: _lastIncrementalIso, lastFullIso: _lastFullIso }));
  } catch {}
}
function overdue(iso, everyMs, now = Date.now()) {
  const last = Date.parse(iso || '');
  return !Number.isFinite(last) || now - last >= everyMs;
}

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
  setTimeout: st = setTimeout,
  incrementalMs = SIX_HOURS,
  fullMs = TWENTY_FOUR_HOURS,
  startupDelayMs = STARTUP_DELAY_MS,
  persist = true,
} = {}) {
  if (_scheduled) return { stop };
  if (!dreamingEnabled()) return { stop: () => {} };
  _scheduled = true;
  if (persist) loadPersistedRuns();

  const runIncremental = () => {
    const sinceIso = _lastIncrementalIso;
    _lastIncrementalIso = new Date().toISOString();
    if (persist) persistRuns();
    runDreamingSweep({ sinceIso }).catch(() => {});
  };
  const runFull = () => {
    _lastFullIso = new Date().toISOString();
    if (persist) persistRuns();
    runDreamingSweep({ sinceIso: null, limit: 20000 }).catch(() => {});
  };

  _timers.push(si(runIncremental, incrementalMs));
  _timers.push(si(runFull, fullMs));
  // Catch-up pass a few minutes after boot: run whichever sweep is overdue
  // according to the persisted clock (the full one wins when both are).
  const startup = st(() => {
    if (overdue(_lastFullIso, fullMs)) runFull();
    else if (overdue(_lastIncrementalIso, incrementalMs)) runIncremental();
  }, startupDelayMs);
  startup?.unref?.();
  _timers.push(startup);

  return { stop };
}

export function stop() {
  for (const t of _timers) {
    try { clearInterval(t); clearTimeout(t); } catch {}
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
