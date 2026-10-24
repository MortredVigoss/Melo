import { randomUUID } from 'node:crypto';
import { getReminderScheduler } from '../../reminders/scheduler.js';

// Compatibility entry point; server startup uses this same home-bound scheduler.
export function setReminderCallback(fn) {
  return getReminderScheduler().start(fn);
}

export function parseDelay(input, now = Date.now()) {
  const text = String(input || '').trim().toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(s|sec|second|秒|m|min|minute|分|分钟|h|hr|hour|小时|d|day|天|w|week|周)s?$/);
  if (match) {
    const unit = match[2];
    const factor = /^(s|秒)/.test(unit) ? 1000 : /^(m|分)/.test(unit) ? 60_000
      : /^(h|小时)/.test(unit) ? 3600_000 : /^(d|天)/.test(unit) ? 86400_000 : 604800_000;
    return Number(match[1]) * factor;
  }
  const time = text.match(/^(\d{1,2}):(\d{2})$/);
  if (time) {
    if (Number(time[1]) > 23 || Number(time[2]) > 59) return null;
    const target = new Date(now);
    target.setHours(Number(time[1]), Number(time[2]), 0, 0);
    if (target.getTime() <= now) target.setDate(target.getDate() + 1);
    return target.getTime() - now;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) && timestamp > now ? timestamp - now : null;
}

export const reminderTool = {
  id: 'reminder',
  name: 'Reminder',
  description: 'Set, list, or cancel reminders in the current chat. Supports relative times ("30 min", "3天") and absolute times ("14:30", ISO dates). Melo must be running to deliver. Temporary failures retry up to five times; failed, paused, or uncertain records remain visible in list. Inspect uncertain external delivery before cancelling or setting another reminder.',
  category: 'utility',
  isConcurrencySafe: true,
  requiresPermission: false,
  parametersSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['set', 'list', 'cancel'] },
      time: { type: 'string', description: 'When to fire, e.g. "30 min", "3天", "14:30".' },
      text: { type: 'string', description: 'Reminder message, at most 1800 characters.' },
      id: { type: 'string', description: 'Reminder ID to cancel in the current chat.' },
      chatId: { type: 'string', description: 'Legacy field; execution context determines the destination.' },
      agentId: { type: 'string', description: 'Legacy field; originating chat determines the agent.' },
    },
    required: ['action'],
  },
  examples: [{ action: 'list' }, { action: 'set', time: '30 min', text: 'Submit expense report' },
    { action: 'cancel', id: 'rem-example' }],

  async run({ action, time, text, id }, context = {}) {
    const scheduler = getReminderScheduler(context.meloHome);
    const chatId = context.chatId;
    const timeFormat = new Intl.DateTimeFormat(context.config?.replyLanguage || 'en', {dateStyle:'medium', timeStyle:'long', timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});
    if (!chatId) return { ok: false, output: 'A current chat is required for reminder delivery.', error: 'NO_CHAT' };
    context.signal?.throwIfAborted();
    if (action === 'set') {
      const delayMs = parseDelay(time);
      const fireAt = Date.now() + delayMs;
      if (!Number.isFinite(delayMs) || delayMs < 5000 || !Number.isFinite(new Date(fireAt).getTime())) {
        return { ok: false, output: 'Invalid reminder time (minimum 5 seconds).', error: 'INVALID_TIME' };
      }
      if (typeof text !== 'string' || !text.trim() || text.length > 1800) {
        return { ok: false, output: 'Reminder text must contain 1 to 1800 characters.', error: 'INVALID_PARAMS' };
      }
      const reminder = { id: 'rem_' + randomUUID(), text: text.trim(), fireAt, chatId,
        createdAt: new Date().toISOString() };
      await scheduler.add(reminder, { signal: context.signal });
      return { ok: true, output: 'Reminder saved: "' + reminder.text + '" (' + timeFormat.format(new Date(fireAt)) + '). Melo must be running; otherwise delivery resumes on next startup.',
        meta: { id: reminder.id, fireAt } };
    }
    if (action === 'list') {
      const list = await scheduler.list(chatId);
      return { ok: true, output: list.length ? list.map(r => '[' + r.id + '] ' + r.text + ' (' + timeFormat.format(new Date(r.fireAt)) + ') — ' + ({ pending: '等待发送', failed: '已停止：目标失效', paused: '重试已暂停', uncertain: '发送结果待核对', sending: '正在发送', delivered: '已发送，保存中' }[r.status || 'pending'] || r.status) + (r.lastError ? '：' + r.lastError : '')).join('\n') : 'No active reminders.', meta: { count: list.length } };
    }
    if (action === 'cancel') {
      const record = await scheduler.cancel(id, chatId, { signal: context.signal });
      return record ? { ok: true, output: 'Cancelled: "' + record.text + '"', meta: { id } }
        : { ok: false, output: 'Reminder not found in the current chat.', error: 'NOT_FOUND' };
    }
    return { ok: false, output: 'Unknown reminder action.', error: 'INVALID_ACTION' };
  },
};
