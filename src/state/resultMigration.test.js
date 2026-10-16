import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadState,updateStateAtomically} from './stateStore.js';
test('legacy snippets migrate after checkpoint transcript hydration and survive cold persistence',async()=>{
 const home=await mkdtemp(join(tmpdir(),'melo-result-migration-'));
 try {
  await updateStateAtomically(s=>{s.chats=[{id:'c',title:'Chat',messages:[{id:'m',role:'assistant',content:'```js\nconst result=1;\n```'}]}];s.artifacts=[];},{home});
  const path=join(home,'desktop/state.json');let raw=JSON.parse(await readFile(path,'utf8'));
  assert.equal(raw.chats[0].messages,undefined);
  raw.artifacts=[{id:'a',title:'Chat snippet 1',kind:'code',chatId:'c',language:'js',content:'const result=1;'}];await writeFile(path,JSON.stringify(raw));
  const state=await loadState({home});assert.equal(state.artifacts[0].kind,'result');
  await updateStateAtomically(()=>{},{home});raw=JSON.parse(await readFile(path,'utf8'));assert.equal(raw.artifacts[0].origin,'assistant-code');
 }finally{await rm(home,{recursive:true,force:true});}
});
