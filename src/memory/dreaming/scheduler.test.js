import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startDreamingScheduler,
  startIdleWatch,
  _resetForTests,
  triggerDreamingNow,
} from './scheduler.js';

test('startDreamingScheduler registers two timers', () => {
  _resetForTests();
  const saved = process.env.MELO_DREAMING_ENABLED;
  process.env.MELO_DREAMING_ENABLED = '1';
  try {
    const created = [];
    const fakeSetInterval = (fn, ms) => { created.push({ fn, ms }); return created.length; };
    const fakeClearInterval = () => {};
    const { stop } = startDreamingScheduler({
      setInterval: fakeSetInterval,
      clearInterval: fakeClearInterval,
      incrementalMs: 1000,
      fullMs: 10_000,
    });
    assert.equal(created.length, 2);
    assert.equal(created[0].ms, 1000);
    assert.equal(created[1].ms, 10_000);
    stop();
  } finally {
    if (saved == null) delete process.env.MELO_DREAMING_ENABLED;
    else process.env.MELO_DREAMING_ENABLED = saved;
    _resetForTests();
  }
});

test('startDreamingScheduler is a no-op when disabled', () => {
  _resetForTests();
  const saved = process.env.MELO_DREAMING_ENABLED;
  process.env.MELO_DREAMING_ENABLED = '0';
  try {
    const created = [];
    startDreamingScheduler({
      setInterval: (fn, ms) => { created.push({ fn, ms }); return 1; },
      clearInterval: () => {},
    });
    assert.equal(created.length, 0);
  } finally {
    if (saved == null) delete process.env.MELO_DREAMING_ENABLED;
    else process.env.MELO_DREAMING_ENABLED = saved;
    _resetForTests();
  }
});

test('triggerDreamingNow returns skipped when disabled', async () => {
  _resetForTests();
  const saved = process.env.MELO_DREAMING_ENABLED;
  process.env.MELO_DREAMING_ENABLED = '0';
  try {
    const result = await triggerDreamingNow();
    assert.equal(result.skipped, true);
  } finally {
    if (saved == null) delete process.env.MELO_DREAMING_ENABLED;
    else process.env.MELO_DREAMING_ENABLED = saved;
    _resetForTests();
  }
});

test('startIdleWatch re-arm tears down the prior watch (no listener/interval leak)', () => {
  // 2026-06-04 audit闭环: re-arming startIdleWatch used to overwrite the
  // module-global _idleUnsub without calling it → the prior interval +
  // emitter listeners leaked. This fake emitter tracks active listener count;
  // after a re-arm it must stay at 2 (the new watch's activity+idle), not
  // climb to 4.
  _resetForTests();
  const listeners = [];
  const emitter = {
    on(ev, cb) { listeners.push({ ev, cb, active: true }); },
    removeListener(ev, cb) {
      const l = listeners.find(x => x.ev === ev && x.cb === cb && x.active);
      if (l) l.active = false;
    },
    get activeCount() { return listeners.filter(l => l.active).length; },
  };
  // Huge idleMs so the real setInterval callback never triggers dreaming
  // during the test; both intervals are cleared via the unsub + the re-arm
  // teardown so no handle leaks past the test.
  const bigIdle = 60 * 60 * 1000;
  startIdleWatch({ emitter, idleMs: bigIdle });
  assert.equal(emitter.activeCount, 2, 'first arm attaches activity + idle listeners');

  const unsub2 = startIdleWatch({ emitter, idleMs: bigIdle });
  assert.equal(emitter.activeCount, 2,
    're-arm must remove the prior 2 listeners before adding 2 new — leak would show 4');

  // Clean up the surviving (second) watch's interval + listeners.
  unsub2();
  assert.equal(emitter.activeCount, 0, 'unsub clears the active watch');
  _resetForTests();
});

test('a startup catch-up sweep runs when the persisted clock says one is overdue', async () => {
  // 2026-10-17 audit C-11: without this, a desktop that never stays up for six
  // hours never consolidated memory at all.
  _resetForTests();
  const saved = process.env.MELO_DREAMING_ENABLED;
  process.env.MELO_DREAMING_ENABLED = '1';
  try {
    const timeouts = [];
    const intervals = [];
    startDreamingScheduler({
      setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
      clearInterval: () => {},
      setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return { unref() {} }; },
      incrementalMs: 1000, fullMs: 10_000, startupDelayMs: 5, persist: false,
    });
    assert.equal(intervals.length, 2);
    assert.equal(timeouts.length, 1, 'one startup catch-up timer');
    assert.equal(timeouts[0].ms, 5);
    // With no persisted run both are overdue; the full sweep wins. The sweep
    // itself is fire-and-forget (errors swallowed), so calling the timer is safe.
    timeouts[0].fn();
  } finally {
    if (saved == null) delete process.env.MELO_DREAMING_ENABLED;
    else process.env.MELO_DREAMING_ENABLED = saved;
    _resetForTests();
  }
});
