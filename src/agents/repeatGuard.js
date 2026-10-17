// Repeated-failure guard for tool loops (2026-10-16 agent-loop-audit #1).
//
// Without this, a model that keeps re-issuing the same call with the same
// arguments against a permanent error burns the whole iteration budget:
// 10 main-loop rounds, 20 member rounds, 16 skill rounds, each one a model
// request plus a failing tool execution. The guard fingerprints every failed
// call (tool + canonical arguments + error class) and, once the same
// fingerprint has failed `limit` times in a row, answers further identical
// calls locally with REPEATED_FAILURE instead of executing them, telling the
// model to change approach or stop. Successful calls reset their fingerprint.

import { createHash } from 'node:crypto';

const DEFAULT_LIMIT = 2;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function errorClass(result) {
  const code = String(result?.error || result?.errorCode || '').trim();
  if (code) return code;
  return String(result?.output || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function toolCallFingerprint(name, args) {
  const payload = JSON.stringify([String(name || ''), canonical(args ?? {})]);
  return createHash('sha1').update(payload).digest('hex').slice(0, 24);
}

export function createRepeatGuard({ limit = DEFAULT_LIMIT } = {}) {
  const failures = new Map(); // fingerprint → { count, errorClass, name }
  return {
    /** Returns a rejection result when this call should not be executed again. */
    check(name, args) {
      const entry = failures.get(toolCallFingerprint(name, args));
      if (!entry || entry.count < limit) return null;
      return {
        ok: false,
        error: 'REPEATED_FAILURE',
        output: `Tool "${name}" already failed ${entry.count} times with identical arguments (${entry.errorClass || 'same error'}). It was not run again. Change the arguments or the approach, or tell the user what is blocking you.`,
      };
    },
    /** Record an executed call's outcome. */
    record(name, args, result) {
      const key = toolCallFingerprint(name, args);
      if (result?.ok === false) {
        const current = failures.get(key);
        const cls = errorClass(result);
        failures.set(key, { count: current && current.errorClass === cls ? current.count + 1 : 1, errorClass: cls, name });
      } else {
        failures.delete(key);
      }
    },
    get size() { return failures.size; },
  };
}
