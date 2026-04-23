import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startDreamingScheduler,
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
