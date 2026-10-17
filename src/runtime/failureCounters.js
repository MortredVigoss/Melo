// In-process counters for failures that used to be swallowed silently
// (2026-10-17 audit A-10): the ledger interrupt after a failed turn and the
// post-turn background tasks (session memory, fact promotion, embedding
// fill-in). A failed interrupt leaves a chat `running`, which then rejects
// retries and deletion until restart; a failed post-turn task silently stops
// memory from improving. Both now log once per occurrence and show up in
// runtime diagnostics so the UI/CLI can surface "something is quietly wrong".

const counters = new Map(); // id → { count, lastAt, lastMessage }
const MAX_MESSAGE = 300;

export function recordFailure(id, error, { log = true } = {}) {
  const key = String(id || 'unknown');
  const message = String(error?.message || error || '').slice(0, MAX_MESSAGE);
  const entry = counters.get(key) || { count: 0, lastAt: null, lastMessage: '' };
  entry.count += 1;
  entry.lastAt = new Date().toISOString();
  entry.lastMessage = message;
  counters.set(key, entry);
  if (log) process.stderr.write(`[failure:${key}] ${message}\n`);
  return entry;
}

export function failureSnapshot() {
  return Object.fromEntries([...counters.entries()].map(([id, entry]) => [id, { ...entry }]));
}

export function _resetFailureCountersForTests() {
  counters.clear();
}
