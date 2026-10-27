import { remainingMs } from './runBudget.js';

// A routing decision may extend a root budget after the turn has started.
// Recheck that extension at the old deadline; never poll or reset elapsed time.
export function runDeadline(budget, { maxMs, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const controller = new AbortController();
  const start = now(), originalDeadline = budget?.deadlineAt;
  const originalRemaining = budget ? remainingMs(budget) : maxMs;
  let timer;
  const schedule = () => {
    const extension = budget ? Math.max(0, budget.deadlineAt - originalDeadline) : 0;
    const left = Math.min(maxMs, originalRemaining + extension) - (now() - start);
    if (left <= 0) { controller.abort(new DOMException('The turn reached its deadline.', 'TimeoutError')); return; }
    timer = setTimer(schedule, Math.max(1, Math.ceil(left)));
    timer?.unref?.();
  };
  schedule();
  return { signal: controller.signal, dispose: () => clearTimer(timer) };
}
