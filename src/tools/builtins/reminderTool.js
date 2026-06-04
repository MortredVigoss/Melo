/**
 * reminder tool
 *
 * Set, list, and cancel timed reminders.
 * Reminders are stored in-memory and persist via a JSON file.
 * When a reminder fires, it calls a configurable callback (default: logs to stderr).
 *
 * In Telegram context, the fired reminder is delivered as a message.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const REMINDER_FILE = resolve(
  process.env.MELO_HOME || resolve(process.env.HOME || '/tmp', '.melo'),
  'reminders.json',
);
const MAX_REMINDERS = 100;

// In-memory store: id → { id, text, fireAt, chatId, agentId, timerId }
const _reminders = new Map();
let _loaded = false;
let _onFire = null; // callback: (reminder) => void

export function setReminderCallback(fn) {
  _onFire = fn;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

async function loadReminders() {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = await readFile(REMINDER_FILE, 'utf8');
    const list = JSON.parse(raw);
    const now = Date.now();
    for (const r of list) {
      if (r.fireAt <= now) continue; // expired
      scheduleReminder(r);
    }
  } catch {}
}

async function saveReminders() {
  const list = [..._reminders.values()].map(({ timerId, ...rest }) => rest);
  try {
    await mkdir(dirname(REMINDER_FILE), { recursive: true });
    await writeFile(REMINDER_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch {}
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

function scheduleReminder(r) {
  const delay = Math.max(r.fireAt - Date.now(), 1000);
  const timerId = setTimeout(() => {
    _reminders.delete(r.id);
    saveReminders();
    if (_onFire) {
      _onFire(r);
    } else {
      process.stderr.write(`[reminder] FIRED: ${r.text} (id=${r.id})\n`);
    }
  }, delay);
  // Don't block process exit
  if (timerId.unref) timerId.unref();
  _reminders.set(r.id, { ...r, timerId });
}

function parseDelay(input) {
  const text = String(input || '').trim().toLowerCase();

  // "30 min", "2 hours", "1.5h", "90s", "3天"
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(s|sec|second|秒|m|min|minute|分|分钟|h|hr|hour|小时|d|day|天|w|week|周)s?$/);
  if (match) {
    const val = parseFloat(match[1]);
    const unit = match[2];
    if (unit.startsWith('s') || unit === '秒') return val * 1000;
    if (unit.startsWith('m') || unit === '分' || unit === '分钟') return val * 60_000;
    if (unit.startsWith('h') || unit === '小时') return val * 3600_000;
    if (unit.startsWith('d') || unit === '天') return val * 86400_000;
    if (unit.startsWith('w') || unit === '周') return val * 604800_000;
  }

  // Try as absolute time: "2025-05-20 14:00", "14:30", "tomorrow 9:00"
  const asDate = new Date(text);
  if (!isNaN(asDate) && asDate.getTime() > Date.now()) {
    return asDate.getTime() - Date.now();
  }

  // HH:MM today or tomorrow
  const timeMatch = text.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const target = new Date();
    target.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2]), 0, 0);
    if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1); // tomorrow
    return target.getTime() - Date.now();
  }

  return null;
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export const reminderTool = {
  id: 'reminder',
  name: 'Reminder',
  description:
    'Set, list, or cancel timed reminders. ' +
    'Supports relative times ("30 min", "2 hours", "3天") and absolute times ("14:30", "2025-05-20 14:00"). ' +
    'Reminders fire as notifications/messages when the time arrives.',
  category: 'utility',
  isConcurrencySafe: true,
  requiresPermission: false,
  parametersSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['set', 'list', 'cancel'],
        description: '"set" to create, "list" to show all, "cancel" to remove.',
      },
      time: {
        type: 'string',
        description: 'For set: when to fire. E.g. "30 min", "2 hours", "3天", "14:30", "2025-05-20 09:00".',
      },
      text: {
        type: 'string',
        description: 'For set: reminder message.',
      },
      id: {
        type: 'string',
        description: 'For cancel: the reminder ID to remove.',
      },
      chatId: {
        type: 'string',
        description: 'Optional: associate with a specific chat for delivery.',
      },
      agentId: {
        type: 'string',
        description: 'Optional: associate with a specific agent.',
      },
    },
    required: ['action'],
  },
  examples: [
    { action: 'list' },
    { action: 'create', time: '2026-05-24T09:00', text: 'Submit expense report' },
    { action: 'delete', id: 'rem-abc123' },
  ],

  async run({ action, time, text, id, chatId, agentId }) {
    await loadReminders();

    if (action === 'set') {
      if (!time) return { ok: false, output: 'Missing "time".', error: 'INVALID_PARAMS' };
      if (!text) return { ok: false, output: 'Missing "text" (reminder message).', error: 'INVALID_PARAMS' };
      if (_reminders.size >= MAX_REMINDERS) {
        return { ok: false, output: `Too many reminders (max ${MAX_REMINDERS}).`, error: 'LIMIT' };
      }

      const delayMs = parseDelay(time);
      if (!delayMs || delayMs < 5000) {
        return { ok: false, output: `Cannot parse time "${time}" or too short (min 5s).`, error: 'INVALID_TIME' };
      }

      const reminder = {
        id: `rem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        text,
        fireAt: Date.now() + delayMs,
        chatId: chatId || '',
        agentId: agentId || '',
        createdAt: new Date().toISOString(),
      };
      scheduleReminder(reminder);
      await saveReminders();

      const fireDate = new Date(reminder.fireAt);
      const mins = Math.round(delayMs / 60_000);
      const timeDesc = mins < 60 ? `${mins}分钟后` : mins < 1440 ? `${(mins / 60).toFixed(1)}小时后` : `${(mins / 1440).toFixed(1)}天后`;
      return {
        ok: true,
        output: `Reminder set: "${text}" — ${timeDesc} (${fireDate.toLocaleString()})`,
        meta: { id: reminder.id, fireAt: reminder.fireAt },
      };
    }

    if (action === 'list') {
      if (_reminders.size === 0) return { ok: true, output: 'No active reminders.', meta: { count: 0 } };
      const sorted = [..._reminders.values()].sort((a, b) => a.fireAt - b.fireAt);
      const lines = sorted.map((r, i) => {
        const remaining = Math.max(0, r.fireAt - Date.now());
        const mins = Math.round(remaining / 60_000);
        const timeLeft = mins < 60 ? `${mins}分钟` : `${(mins / 60).toFixed(1)}小时`;
        return `${i + 1}. [${r.id}] "${r.text}" — ${timeLeft}后 (${new Date(r.fireAt).toLocaleString()})`;
      });
      return { ok: true, output: `**Active reminders (${sorted.length}):**\n${lines.join('\n')}`, meta: { count: sorted.length } };
    }

    if (action === 'cancel') {
      if (!id) return { ok: false, output: 'Missing "id" to cancel.', error: 'INVALID_PARAMS' };
      const r = _reminders.get(id);
      if (!r) return { ok: false, output: `Reminder "${id}" not found.`, error: 'NOT_FOUND' };
      clearTimeout(r.timerId);
      _reminders.delete(id);
      await saveReminders();
      return { ok: true, output: `Cancelled: "${r.text}"`, meta: { id } };
    }

    return { ok: false, output: `Unknown action "${action}".`, error: 'INVALID_ACTION' };
  },
};
