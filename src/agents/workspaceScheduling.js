import {AsyncLocalStorage} from 'node:async_hooks';
import {realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
const writers=new Map(), leases=new AsyncLocalStorage();
export async function withWorkspaceWriter(workspacePath,signal,work) {
 const path=resolve(workspacePath || '.');
 const key=await realpath(path).catch(()=>path);
 if(leases.getStore()?.has(key)) return work();
 const previous=writers.get(key) || Promise.resolve();
 let release;const done=new Promise(r=>{release=r;});
 const tail=previous.catch(()=>{}).then(()=>done);writers.set(key,tail);
 try {
  await previous.catch(()=>{});
  if(signal?.aborted) throw Object.assign(new Error('Member cancelled while waiting for workspace'),{code:'ABORTED'});
  return await leases.run(new Set([...(leases.getStore() || []),key]),work);
 } finally {release();if(writers.get(key)===tail)writers.delete(key);}
}
