import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReminderScheduler, MAX_TIMER_DELAY } from './scheduler.js';
import { parseDelay, reminderTool, setReminderCallback } from '../tools/builtins/reminderTool.js';
import { getReminderScheduler } from './scheduler.js';

function fixture(initial = []) {
  const clock = { now: 10000, jobs: new Map(), next: 0, saved: initial, failWrite: false };
  clock.options = { home: '/unused-test-home', now: () => clock.now,
    read: async () => JSON.stringify(clock.saved),
    persist: async (path, records) => { if (clock.failWrite) throw new Error('disk full'); clock.saved = structuredClone(records); },
    setTimer: (fn, ms) => { const id = ++clock.next; clock.jobs.set(id, { fn, ms }); return id; },
    clearTimer: id => clock.jobs.delete(id) };
  clock.tick = async () => {
    const [id, job] = clock.jobs.entries().next().value;
    clock.jobs.delete(id);
    clock.now += job.ms;
    await job.fn();
  };
  return clock;
}

test('30-day reminders never overflow timers or fire early', async () => {
  const clock = fixture();
  let delivered = 0;
  const scheduler = await new ReminderScheduler(clock.options).start(async () => { delivered++; });
  await scheduler.add({ id: 'long', text: 'long', chatId: 'a', fireAt: clock.now + 30 * 86400_000 });
  assert.equal([...clock.jobs.values()][0].ms, MAX_TIMER_DELAY);
  await clock.tick();
  assert.equal(delivered, 0);
  await clock.tick();
  assert.equal(delivered, 1);
  assert.deepEqual(clock.saved, []);
  await scheduler.stop();
});

test('startup restores overdue reminders and failures retry without deleting them', async () => {
  const clock = fixture([{ id: 'old', text: 'missed', chatId: 'a', fireAt: 1 }]);
  let attempts = 0;
  const scheduler = await new ReminderScheduler(clock.options).start(async () => {
    if (++attempts === 1) throw new Error('offline');
  });
  await clock.tick();
  assert.equal(clock.saved.length, 1);
  assert.equal([...clock.jobs.values()][0].ms, 60000);
  await clock.tick();
  assert.equal(attempts, 2);
  assert.equal(clock.saved.length, 0);
  await scheduler.stop();
});

test('failed save cannot report success or schedule an unsaved reminder', async () => {
  const clock = fixture();
  const scheduler = await new ReminderScheduler(clock.options).start(async () => {});
  clock.failWrite = true;
  await assert.rejects(scheduler.add({ id: 'a', chatId: 'a', text: 'a', fireAt: 20000 }), /disk full/);
  assert.equal(clock.jobs.size, 0);
  assert.equal((await scheduler.list('a')).length, 0);
  await scheduler.stop();
});

test('cancel is durable, scoped to the originating chat, and stop preserves pending records', async () => {
  const clock = fixture();
  const scheduler = await new ReminderScheduler(clock.options).start(async () => assert.fail('cancelled reminder fired'));
  await scheduler.add({ id: 'a', chatId: 'a', text: 'a', fireAt: 20000 });
  assert.deepEqual(await scheduler.list('b'), []);
  assert.equal(await scheduler.cancel('a', 'b'), null);
  clock.failWrite = true;
  await assert.rejects(scheduler.cancel('a', 'a'));
  assert.equal(clock.jobs.size, 1);
  clock.failWrite = false;
  await scheduler.cancel('a', 'a');
  assert.equal(clock.jobs.size, 0);
  await scheduler.add({ id: 'b', chatId: 'a', text: 'b', fireAt: 20000 });
  await scheduler.stop();
  assert.equal(clock.jobs.size, 0);
  assert.equal(clock.saved.length, 1);
});

test('tool binds chat and home to context; valid set persists before success', async t => {
  const root = await mkdtemp(join(tmpdir(), 'melo-reminder-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scheduler = await getReminderScheduler(root).start(async () => {});
  t.after(() => scheduler.stop());
  const result = await reminderTool.run({ action: 'set', time: '30 days', text: 'test', chatId: 'other' }, { chatId: 'origin', meloHome: root });
  assert.equal(result.ok, true);
  const persisted = JSON.parse(await readFile(join(root, 'reminders.json'), 'utf8'));
  assert.equal(persisted[0].chatId, 'origin');
  assert.equal((await reminderTool.run({ action: 'list' }, { chatId: 'other', meloHome: root })).meta.count, 0);
  assert.equal((await reminderTool.run({ action: 'set', time: '30 min', text: 'test', chatId: 'spoofed' })).error, 'NO_CHAT');
  const other = new ReminderScheduler({ home: join(root, 'other') });
  assert.deepEqual(await other.list('origin'), []);
  assert.equal(typeof setReminderCallback, 'function');
});

test('invalid clock times are rejected; relative Chinese and long durations work', () => {
  assert.equal(parseDelay('25:30'), null);
  assert.equal(parseDelay('14:99'), null);
  assert.equal(parseDelay('30 days'), 30 * 86400_000);
  assert.equal(parseDelay('3天'), 3 * 86400_000);
});

test('permanent failures stop; temporary failures have a bounded retry budget', async () => {
  for (const permanent of [true, false]) {
    const clock = fixture([{ id: 'bad', text: 'bad', chatId: 'a', fireAt: 1 }]);
    let attempts = 0;
    const scheduler = await new ReminderScheduler(clock.options).start(async () => {
      attempts++;
      throw Object.assign(new Error('unavailable'), { permanent });
    });
    for (let i = 0; i < 8 && clock.jobs.size; i++) await clock.tick();
    assert.equal(clock.jobs.size, 0);
    assert.equal(attempts, permanent ? 1 : 5);
    assert.equal((await scheduler.list('a'))[0].status, permanent ? 'failed' : 'paused');
    await scheduler.stop();
  }
});

test('successful delivery followed by a failed save is not sent twice', async () => {
  const clock = fixture([{ id: 'r', text: 'x', chatId: 'a', fireAt: 1 }]);
  let attempts = 0;
  const scheduler = await new ReminderScheduler(clock.options).start(async () => { attempts++; clock.failWrite = true; });
  await clock.tick();
  clock.failWrite = false;
  await clock.tick();
  assert.equal(attempts, 1);
  assert.deepEqual(clock.saved, []);
  await scheduler.stop();
});

test('external send claim survives restart and prevents an ambiguous repeat', async () => {
  const clock = fixture([{ id: 'r', text: 'x', chatId: 'a', fireAt: 1, status: 'sending' }]);
  const scheduler = await new ReminderScheduler(clock.options).start(async () => assert.fail('resent'));
  assert.equal(clock.jobs.size, 0);
  assert.equal((await scheduler.list('a'))[0].status, 'uncertain');
  await scheduler.stop();
});

test('deleting a chat cancels all its reminders but preserves other chats', async () => {
  const clock = fixture(['a', 'b'].map(id => ({ id, chatId: id, text: id, fireAt: 20000 })));
  const scheduler = await new ReminderScheduler(clock.options).start(async () => {});
  await scheduler.cancelChat('a');
  assert.deepEqual((await scheduler.list('a')), []);
  assert.equal((await scheduler.list('b')).length, 1);
  assert.equal(clock.jobs.size, 1);
  await scheduler.stop();
});
