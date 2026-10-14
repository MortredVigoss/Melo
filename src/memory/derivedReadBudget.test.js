import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateStateAtomically,loadState } from '../state/stateStore.js';
import { syncDerivedSnapshot } from './derivedIndex.js';
test('unchanged committed checkpoints do not access transcript bodies during index comparison',async t=>{
  const home=await realpath(await mkdtemp(join(tmpdir(),'melo-derived-budget-')));t.after(()=>rm(home,{recursive:true,force:true}));
  await updateStateAtomically(s=>{s.chats=Array.from({length:10},(_,i)=>({id:`chat-${i}`,messages:[{id:`msg-${i}`,role:'user',content:'saved'}]}));},{home});
  const state=await loadState({home});let reads=0;
  for(const chat of state.chats)Object.defineProperty(chat,'messages',{enumerable:true,configurable:true,get(){reads++;throw Error('Unexpected transcript materialization');}});
  assert.equal(syncDerivedSnapshot(state,{home,storePath:join(home,'desktop/store.sqlite')},{throwOnError:true}),false);
  assert.equal(reads,0);
});
