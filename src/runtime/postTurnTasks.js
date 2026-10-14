import { derivedHomeKey } from '../state/derivedDispatcher.js';

// Work may outlive result delivery, but it must not outlive teardown silently.
// Callers capture request scope before scheduling; this registry only owns life.
const jobs = new Map();
export function schedulePostTurnTask(home, run) {
  const key = derivedHomeKey(home);
  const pending = jobs.get(key) || new Set();
  jobs.set(key, pending);
  const job = Promise.resolve().then(run).catch(() => {}).finally(() => {
    pending.delete(job);
    if (!pending.size) jobs.delete(key);
  });
  pending.add(job);
  return job;
}
export async function drainPostTurnTasks(home, { timeoutMs = 10_000 } = {}) {
  const key = derivedHomeKey(home);
  let timer;
  try {
    await Promise.race([
      (async () => { while (jobs.get(key)?.size) await Promise.all([...jobs.get(key)]); })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Post-turn work is still pending'), { code: 'POST_TURN_PENDING' })), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
