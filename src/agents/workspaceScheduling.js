import {AsyncLocalStorage} from 'node:async_hooks';
import {realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
const writers=new Map(), leases=new AsyncLocalStorage();
export async function withWorkspaceWriter(workspacePath,signal,work) {
 const path=resolve(workspacePath || '.');
 const key=await realpath(path).catch(()=>path);
 if(leases.getStore()?.keys.has(key)) return work();
 const previous=writers.get(key) || Promise.resolve();
 let release;const done=new Promise(r=>{release=r;});
 const tail=previous.catch(()=>{}).then(()=>done);writers.set(key,tail);
 try {
  await previous.catch(()=>{});
  if(signal?.aborted) throw Object.assign(new Error('Member cancelled while waiting for workspace'),{code:'ABORTED'});
  const lease={keys:new Set([...(leases.getStore()?.keys || []),key]),pending:new Set()};
  return await leases.run(lease,async()=>{
   try{return await work();}
   finally{while(lease.pending.size)await Promise.allSettled([...lease.pending]);}
  });
 } finally {release();if(writers.get(key)===tail)writers.delete(key);}
}

// Cancellation can stop the tool caller before the actual side effect settles.
// Keep the workspace lease until that underlying work has drained.
export function trackWorkspaceWork(promise) {
 const lease=leases.getStore();if(!lease)return promise;
 lease.pending.add(promise);
 promise.then(()=>lease.pending.delete(promise),()=>lease.pending.delete(promise));
 return promise;
}
