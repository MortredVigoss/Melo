import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

// The composition root registers a worker. Standalone maintenance commands
// retain synchronous indexing when no dispatcher is installed.
const dispatchers = new Map();
export function derivedHomeKey(home) {
  const path = resolve(home);
  try { return realpathSync(path); } catch { return path; }
}
export function registerDerivedDispatcher(home, dispatch, status = () => ({status:'pending'})) {
  const key = derivedHomeKey(home);
  if (dispatchers.has(key)) throw new Error('Derived dispatcher already registered for this home');
  const entry = {dispatch,status};
  dispatchers.set(key, entry);
  return () => { if (dispatchers.get(key) === entry) dispatchers.delete(key); };
}
export function dispatchDerivedCommit(home, revision) {
  const entry = dispatchers.get(derivedHomeKey(home));
  if (!entry) return false;
  entry.dispatch(revision);
  return true;
}
export function derivedIndexStatus(home) {
  return structuredClone(dispatchers.get(derivedHomeKey(home))?.status() || {status:'inline'});
}
