// A turn owns its chat until execution and persistence settle. Other chats
// have independent lanes; cancellation never releases an executing lane early.
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';

const lanes = new Map();

export function canonicalHome(home) {
  try { return realpathSync(home); } catch { return resolve(home); }
}

export function scheduleChatTurn({ home, chatId, signal }, execute) {
  const key = JSON.stringify([canonicalHome(home), chatId]);
  const prior = lanes.get(key) || Promise.resolve();
  const work = prior.catch(() => {}).then(() => {
    signal?.throwIfAborted();
    return execute();
  });
  lanes.set(key, work);
  const cleanup = () => { if (lanes.get(key) === work) lanes.delete(key); };
  work.then(cleanup, cleanup);
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
