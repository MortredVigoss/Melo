/**
 * calculator tool
 *
 * Safe math evaluation, unit conversion, and date calculation.
 * No external dependencies — pure JS.
 */

const UNIT_TABLE = {
  // length (base: m)
  km: { base: 'm', factor: 1000 }, m: { base: 'm', factor: 1 },
  cm: { base: 'm', factor: 0.01 }, mm: { base: 'm', factor: 0.001 },
  mi: { base: 'm', factor: 1609.344 }, mile: { base: 'm', factor: 1609.344 },
  ft: { base: 'm', factor: 0.3048 }, inch: { base: 'm', factor: 0.0254 },
  in: { base: 'm', factor: 0.0254 }, yard: { base: 'm', factor: 0.9144 },
  // weight (base: kg)
  kg: { base: 'kg', factor: 1 }, g: { base: 'kg', factor: 0.001 },
  mg: { base: 'kg', factor: 0.000001 }, lb: { base: 'kg', factor: 0.453592 },
  oz: { base: 'kg', factor: 0.0283495 }, ton: { base: 'kg', factor: 1000 },
  // temperature handled separately
  // time (base: s)
  s: { base: 's', factor: 1 }, sec: { base: 's', factor: 1 },
  min: { base: 's', factor: 60 }, h: { base: 's', factor: 3600 },
  hr: { base: 's', factor: 3600 }, hour: { base: 's', factor: 3600 },
  day: { base: 's', factor: 86400 }, week: { base: 's', factor: 604800 },
  // data (base: byte)
  byte: { base: 'byte', factor: 1 }, kb: { base: 'byte', factor: 1024 },
  mb: { base: 'byte', factor: 1048576 }, gb: { base: 'byte', factor: 1073741824 },
  tb: { base: 'byte', factor: 1099511627776 },
};

function convertUnit(value, from, to) {
  const fl = from.toLowerCase();
  const tl = to.toLowerCase();

  // Temperature special case
  const tempNames = { c: 'c', celsius: 'c', f: 'f', fahrenheit: 'f', k: 'k', kelvin: 'k' };
  if (tempNames[fl] && tempNames[tl]) {
    const fc = tempNames[fl], tc = tempNames[tl];
    let celsius;
    if (fc === 'c') celsius = value;
    else if (fc === 'f') celsius = (value - 32) * 5 / 9;
    else celsius = value - 273.15;
    let result;
    if (tc === 'c') result = celsius;
    else if (tc === 'f') result = celsius * 9 / 5 + 32;
    else result = celsius + 273.15;
    return { result: +result.toFixed(6), from, to, value };
  }

  const fromU = UNIT_TABLE[fl], toU = UNIT_TABLE[tl];
  if (!fromU || !toU) return { error: `Unknown unit: ${!fromU ? from : to}` };
  if (fromU.base !== toU.base) return { error: `Cannot convert ${from} (${fromU.base}) to ${to} (${toU.base})` };
  const result = value * fromU.factor / toU.factor;
  return { result: +result.toFixed(6), from, to, value };
}

function safeMathEval(expr) {
  // Allow: digits, operators, parens, decimal points, whitespace, math functions
  const sanitized = expr.replace(/\s+/g, ' ').trim();
  if (!/^[\d\s+\-*/().,%^a-zA-Z_]+$/.test(sanitized)) {
    throw new Error('Invalid characters in expression');
  }
  // Expose safe math functions
  const mathScope = {
    abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round,
    sqrt: Math.sqrt, cbrt: Math.cbrt, pow: Math.pow, log: Math.log,
    log2: Math.log2, log10: Math.log10, sin: Math.sin, cos: Math.cos,
    tan: Math.tan, PI: Math.PI, E: Math.E, min: Math.min, max: Math.max,
    random: Math.random,
  };
  const fn = new Function(...Object.keys(mathScope), `"use strict"; return (${sanitized});`);
  const result = fn(...Object.values(mathScope));
  if (typeof result !== 'number' || !isFinite(result)) {
    throw new Error(`Result is not a finite number: ${result}`);
  }
  return result;
}

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
