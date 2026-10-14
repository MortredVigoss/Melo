import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson } from '../storage.js';
import { resolveRuntimePaths } from '../runtime/paths.js';

export const MAX_TIMER_DELAY = 2_147_483_647;

export class ReminderScheduler {
  constructor({ home, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    read = readFile, persist = atomicWriteJson } = {}) {
    this.path = join(home, 'reminders.json');
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.read = read;
    this.persist = persist;
    this.records = new Map();
    this.timers = new Map();
    this.queue = Promise.resolve();
    this.loaded = false;
    this.deliver = null;
    this.stopped = false;
  }

  enqueue(fn) {
    const work = this.queue.catch(() => {}).then(fn);
    this.queue = work;
    return work;
  }

  async load() {
    if (this.loaded) return;
    let list;
    try { list = JSON.parse(await this.read(this.path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      list = [];
    }
    if (!Array.isArray(list)) throw new Error('Invalid reminders file. It has not been overwritten.');
    for (const item of list) {
      if (!item?.id || !item.text || !Number.isFinite(item.fireAt)) {
        throw new Error('Invalid reminder record. The file has not been overwritten.');
      }
      this.records.set(item.id, { ...item, ...(item.status === 'sending' ? { status: 'uncertain', lastError: '发送时服务中断，外部结果尚未确认；请核对后取消或重新设置。' } : {}) });
    }
    this.loaded = true;
  }

  start(deliver) {
    return this.enqueue(async () => {
      await this.load();
      this.deliver = deliver;
      this.stopped = false;
      for (const record of this.records.values()) this.arm(record);
      return this;
    });
  }

  arm(record, retryDelay = 0) {
    this.clearTimer(this.timers.get(record.id));
    if (this.stopped || !this.deliver || ['failed', 'paused', 'uncertain'].includes(record.status)) return;
    // Node converts overflowing delays to 1ms. Long waits must be chunked.
    const delay = Math.min(MAX_TIMER_DELAY, Math.max(1, retryDelay, (record.nextAttemptAt || record.fireAt) - this.now()));
    const timer = this.setTimer(() => {
      this.timers.delete(record.id);
      return this.enqueue(async () => {
        const current = this.records.get(record.id);
        if (!current || this.stopped) return;
        if (current.fireAt > this.now()) return this.arm(current);
        try {
          if (current.status !== 'delivered') {
            await this.deliver({ ...current }, { beforeExternalSend: async () => {
              // Persist intent BEFORE a non-idempotent remote API request. A
              // restart after this point requires inspection, never blind resend.
              const claimed = { ...current, status: 'sending' };
              await this.persist(this.path, [...this.records.values()].map(r => r.id === current.id ? claimed : r));
              Object.assign(current, claimed);
            } });
            current.status = 'delivered';
          }
          await this.persist(this.path, [...this.records.values()].filter(r => r.id !== current.id));
          this.records.delete(current.id);
        } catch (error) {
          if (current.status === 'delivered') {
            // Retry persistence only, not delivery.
            this.arm(current, 60_000);
            return;
          }
          current.attempts = (current.attempts || 0) + 1;
          current.lastError = String(error.message || error).slice(0, 600);
          current.status = current.status === 'sending' ? 'uncertain' : error.permanent ? 'failed'
            : current.attempts >= 5 ? 'paused' : 'pending';
          current.nextAttemptAt = this.now() + Math.min(15 * 60_000, 60_000 * 2 ** (current.attempts - 1));
          try { await this.persist(this.path, [...this.records.values()]); } catch { /* durable send claim remains conservative */ }
          this.arm(current, current.nextAttemptAt - this.now());
        }
      });
    }, delay);
    timer?.unref?.();
    this.timers.set(record.id, timer);
  }

  add(record, { signal } = {}) {
    return this.enqueue(async () => {
      await this.load();
      signal?.throwIfAborted();
      if (!this.deliver || this.stopped) throw new Error('Reminder delivery is not running. Restart Melo and try again.');
      if (this.records.size >= 100) throw new Error('Too many active reminders (max 100).');
      if (!record.chatId || !record.text || !Number.isFinite(record.fireAt)) throw new Error('Invalid reminder.');
      await this.persist(this.path, [...this.records.values(), record]);
      this.records.set(record.id, { ...record });
      this.arm(record);
      return record;
    });
  }

  list(chatId) {
    return this.enqueue(async () => {
      await this.load();
      return [...this.records.values()].filter(r => r.chatId === chatId)
        .sort((a, b) => a.fireAt - b.fireAt).map(r => ({ ...r }));
    });
  }

  cancel(id, chatId, { signal } = {}) {
    return this.enqueue(async () => {
      await this.load();
      signal?.throwIfAborted();
      const record = this.records.get(id);
      if (!record || record.chatId !== chatId) return null;
      await this.persist(this.path, [...this.records.values()].filter(r => r.id !== id));
      this.clearTimer(this.timers.get(id));
      this.timers.delete(id);
      this.records.delete(id);
      return record;
    });
  }

  cancelChat(chatId) {
    return this.enqueue(async () => {
      await this.load();
      const removed = [...this.records.values()].filter(r => r.chatId === chatId);
      if (!removed.length) return;
      await this.persist(this.path, [...this.records.values()].filter(r => r.chatId !== chatId));
      for (const record of removed) {
        this.clearTimer(this.timers.get(record.id));
        this.timers.delete(record.id);
        this.records.delete(record.id);
      }
    });
  }

  async stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    await this.queue.catch(() => {});
  }
}

const schedulers = new Map();
export function getReminderScheduler(home = resolveRuntimePaths().home) {
  if (!schedulers.has(home)) schedulers.set(home, new ReminderScheduler({ home }));
  return schedulers.get(home);
}
