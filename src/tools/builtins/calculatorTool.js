import { convertUnit, safeMathEval } from '../../../shared/agent/arithmetic.js';
/**
 * calculator tool
 *
 * Safe math evaluation, unit conversion, and date calculation.
 * No external dependencies — pure JS.
 */

function dateCalc(operation, dateStr, offsetStr) {
  const now = new Date();
  let target;

  if (operation === 'diff') {
    const d1 = new Date(dateStr);
    const d2 = offsetStr ? new Date(offsetStr) : now;
    if (isNaN(d1)) return { error: `Invalid date: ${dateStr}` };
    if (isNaN(d2)) return { error: `Invalid date: ${offsetStr}` };
    const diffMs = d2 - d1;
    const days = Math.abs(Math.floor(diffMs / 86400000));
    const hours = Math.abs(Math.floor(diffMs / 3600000));
    const isPast = diffMs > 0;
    return {
      from: d1.toISOString().split('T')[0],
      to: d2.toISOString().split('T')[0],
      days, hours,
      description: isPast ? `已过去${days}天` : `还有${days}天`,
    };
  }

  if (operation === 'add' || operation === 'subtract') {
    target = dateStr ? new Date(dateStr) : now;
    if (isNaN(target)) return { error: `Invalid date: ${dateStr}` };
    const match = String(offsetStr || '').match(/^(-?\d+)\s*(day|week|month|year|hour|min|minute|s|sec|second)s?$/i);
    if (!match) return { error: `Invalid offset: ${offsetStr}. Use like "7 days", "2 months"` };
    let amount = parseInt(match[1]) * (operation === 'subtract' ? -1 : 1);
    const unit = match[2].toLowerCase();
    if (unit === 'day') target.setDate(target.getDate() + amount);
    else if (unit === 'week') target.setDate(target.getDate() + amount * 7);
    else if (unit === 'month') target.setMonth(target.getMonth() + amount);
    else if (unit === 'year') target.setFullYear(target.getFullYear() + amount);
    else if (unit === 'hour' || unit === 'h') target.setHours(target.getHours() + amount);
    else if (unit.startsWith('min')) target.setMinutes(target.getMinutes() + amount);
    else target.setSeconds(target.getSeconds() + amount);
    return { result: target.toISOString(), date: target.toISOString().split('T')[0], time: target.toTimeString().split(' ')[0] };
  }

  if (operation === 'now') {
    return { iso: now.toISOString(), date: now.toISOString().split('T')[0], time: now.toTimeString().split(' ')[0], timestamp: now.getTime() };
  }

  return { error: `Unknown date operation: ${operation}` };
}

export const calculatorTool = {
  id: 'calculator',
  name: 'Calculator',
  description:
    'Perform math calculations, unit conversions, and date arithmetic. ' +
    'Math: evaluate expressions like "sqrt(144) + 2^3". ' +
    'Convert: units like "100 km to mi", "30 celsius to fahrenheit". ' +
    'Date: diff between dates, add/subtract offsets, get current time.',
  category: 'utility',
  isConcurrencySafe: true,
  requiresPermission: false,
  parametersSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['math', 'convert', 'date'],
        description: 'Action type.',
      },
      expression: {
        type: 'string',
        description: 'For math: the expression to evaluate, e.g. "2 * (3 + 4)".',
      },
      value: {
        type: 'number',
        description: 'For convert: the numeric value to convert.',
      },
      from: {
        type: 'string',
        description: 'For convert: source unit (e.g. "km", "celsius", "lb").',
      },
      to: {
        type: 'string',
        description: 'For convert: target unit.',
      },
      operation: {
        type: 'string',
        enum: ['diff', 'add', 'subtract', 'now'],
        description: 'For date: date operation.',
      },
      date: {
        type: 'string',
        description: 'For date: a date string (ISO or natural, e.g. "2025-05-20").',
      },
      offset: {
        type: 'string',
        description: 'For date add/subtract: e.g. "7 days", "2 months". For date diff: second date.',
      },
    },
    required: ['action'],
  },
  examples: [
    { action: 'math', expression: '(2 + 3) * 4' },
    { action: 'convert', value: 100, from: 'USD', to: 'JPY' },
    { action: 'date', operation: 'add', date: '2026-05-23', offset: '7 days' },
  ],

  async run({ action, expression, value, from, to, operation, date, offset }) {
    if (action === 'math') {
      if (!expression) return { ok: false, output: 'Missing "expression".', error: 'INVALID_PARAMS' };
      try {
        const result = safeMathEval(expression);
        return { ok: true, output: `${expression} = ${result}`, meta: { expression, result } };
      } catch (e) {
        return { ok: false, output: `Math error: ${e.message}`, error: 'EVAL_FAILED' };
      }
    }

    if (action === 'convert') {
      if (value == null || !from || !to) return { ok: false, output: 'Need value, from, to.', error: 'INVALID_PARAMS' };
      const r = convertUnit(value, from, to);
      if (r.error) return { ok: false, output: r.error, error: 'CONVERT_FAILED' };
      return { ok: true, output: `${value} ${from} = ${r.result} ${to}`, meta: r };
    }

    if (action === 'date') {
      const op = operation || 'now';
      const r = dateCalc(op, date, offset);
      if (r.error) return { ok: false, output: r.error, error: 'DATE_FAILED' };
      const summary = op === 'now' ? `Current: ${r.date} ${r.time}` :
        op === 'diff' ? `${r.from} → ${r.to}: ${r.description} (${r.days}天/${r.hours}小时)` :
        `Result: ${r.date} ${r.time}`;
      return { ok: true, output: summary, meta: r };
    }

    return { ok: false, output: `Unknown action "${action}". Use math/convert/date.`, error: 'INVALID_ACTION' };
  },
};
