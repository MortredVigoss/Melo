import {AsyncLocalStorage} from 'node:async_hooks';
import {realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
const writers=new Map(), leases=new AsyncLocalStorage();

// ── Stuck-write handling (agent-loop-audit #3, 2026-10-16) ────────────────
// A cancelled member whose underlying tool ignores cancellation used to keep
// the workspace lease forever: every later writer for that workspace queued
// behind it with no abort race and no way out. The lease still protects
// against overlapping writes — that part was right — but now:
//   • a writer waiting for the lease is released by its own abort signal;
//   • after cancellation the drain of pending side effects is bounded; if
//     work is still running past the grace period the workspace is marked
//     BLOCKED instead of being silently held;
//   • later writers fail fast with WORKSPACE_BLOCKED (and a reason) rather
//     than hanging; the block clears itself the moment the stuck work settles,
//     or explicitly via clearWorkspaceBlock() from a recovery entry point.
export const DEFAULT_DRAIN_GRACE_MS=30_000;
const blocked=new Map(); // key → { since, pending, reason }

function abortRace(signal) {
 if(!signal) return new Promise(()=>{});
 return new Promise((_,reject)=>{
  const fail=()=>reject(Object.assign(new Error('Member cancelled while waiting for workspace'),{code:'ABORTED'}));
  if(signal.aborted) fail(); else signal.addEventListener('abort',fail,{once:true});
 });
}

async function drainPending(lease,graceMs) {
 if(!lease.pending.size) return true;
 if(!Number.isFinite(graceMs)) { while(lease.pending.size) await Promise.allSettled([...lease.pending]); return true; }
 const deadline=Date.now()+graceMs;
 while(lease.pending.size) {
  const remaining=deadline-Date.now();
  if(remaining<=0) return false;
  let timer;
  // Not unref'd: this wait is real work the process must stay alive for.
  const expired=new Promise(resolve=>{timer=setTimeout(()=>resolve('expired'),remaining);});
  const settled=await Promise.race([Promise.allSettled([...lease.pending]).then(()=>'settled'),expired]);
  clearTimeout(timer);
  if(settled==='expired') return false;
 }
 return true;
}

// Keys are canonical (realpath) so /var vs /private/var on macOS resolve to
// the same lease; the inspectors below canonicalise the same way.
async function workspaceKey(workspacePath) {
 const path=resolve(workspacePath || '.');
 return realpath(path).catch(()=>path);
}

export async function workspaceBlockState(workspacePath) {
 return blocked.get(await workspaceKey(workspacePath)) || null;
}

export async function clearWorkspaceBlock(workspacePath) {
 return blocked.delete(await workspaceKey(workspacePath));
}

export async function withWorkspaceWriter(workspacePath,signal,work,{drainGraceMs=DEFAULT_DRAIN_GRACE_MS}={}) {
 const key=await workspaceKey(workspacePath);
 if(leases.getStore()?.keys.has(key)) return work();
 const block=blocked.get(key);
 if(block) throw Object.assign(new Error(`Workspace is blocked by an earlier write that has not finished since ${new Date(block.since).toISOString()} (${block.reason}). Wait for it to settle or restart Melo before writing here again.`),{code:'WORKSPACE_BLOCKED',since:block.since});
 const previous=writers.get(key) || Promise.resolve();
 let release;const done=new Promise(r=>{release=r;});
 const tail=previous.catch(()=>{}).then(()=>done);writers.set(key,tail);
 try {
  await Promise.race([previous.catch(()=>{}),abortRace(signal)]);
  if(signal?.aborted) throw Object.assign(new Error('Member cancelled while waiting for workspace'),{code:'ABORTED'});
  const lease={keys:new Set([...(leases.getStore()?.keys || []),key]),pending:new Set()};
  return await leases.run(lease,async()=>{
   try{return await work();}
   finally{
    // Normal completion: pending work drains fully. After cancellation the
    // wait is bounded; stuck work marks the workspace blocked and unblocks
    // it automatically when it finally settles.
    const drained=await drainPending(lease,signal?.aborted?drainGraceMs:Infinity);
    if(!drained){
     const stuck=[...lease.pending];
     blocked.set(key,{since:Date.now(),pending:stuck.length,reason:`${stuck.length} cancelled write operation(s) still running`});
     Promise.allSettled(stuck).then(()=>{const current=blocked.get(key);if(current&&current.pending===stuck.length)blocked.delete(key);});
    }
   }
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
