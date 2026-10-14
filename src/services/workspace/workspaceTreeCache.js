import { watch, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { measureStage } from '../../runtime/performanceTrace.js';

const roots = new Map();
const keyFor = root => { try { return realpathSync(root); } catch { return resolve(root); } };
export function invalidateWorkspaceTree(root) {
  const entry = roots.get(keyFor(root));
  if (entry) { entry.version++; entry.expires = 0; }
}
export function closeWorkspaceTreeCaches() {
  for (const entry of roots.values()) entry.watcher?.close();
  roots.clear();
}
export async function cachedWorkspaceTree(root, load, { maxAgeMs = 1000 } = {}) {
  const key = keyFor(root);
  let entry = roots.get(key);
  if (!entry) {
    entry = { version: 0, expires: 0 };
    try {
      entry.watcher = watch(key,{recursive:true,persistent:false},()=>{entry.version++;entry.expires=0;});
      entry.watcher.on('error',()=>{entry.expires=0;entry.watcher?.close();entry.watcher=null;});
    } catch { /* Short TTL also covers systems without recursive watches. */ }
    roots.set(key,entry);
    while(roots.size>8) {const oldest=roots.keys().next().value;roots.get(oldest).watcher?.close();roots.delete(oldest);}
  }
  if (entry.value && entry.expires > Date.now()) return structuredClone(entry.value);
  if (!entry.pending) {
    const version = entry.version;
    entry.pending = measureStage('workspace.tree.scan',load).then(value=>{
      entry.value=value;entry.expires=version===entry.version?Date.now()+maxAgeMs:0;
      return value;
    }).finally(()=>{entry.pending=null;});
  }
  return structuredClone(await entry.pending);
}
