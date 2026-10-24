import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureBehavior } from './runtimeBehavior.js';
test('background flags bind to captured home; overrides do not mutate process or saved state',async t=>{
  const home=await mkdtemp(join(tmpdir(),'melo-behavior-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const file=join(home,'config.json');await writeFile(file,JSON.stringify({behavior:{browserControl:true,offlineMemory:true}}));
  const before=captureBehavior(undefined,{MELO_HOME:home,MELO_DISABLE_MEDIA:'true'});
  assert.equal(before.MELO_CDP_ENABLED,'1');assert.equal(before.MELO_OFFLINE_ONLY,'1');assert.equal(before.MELO_DISABLE_MEDIA,'1');
  await writeFile(file,JSON.stringify({behavior:{browserControl:false}}));
  assert.equal(before.MELO_CDP_ENABLED,'1');
  assert.equal(captureBehavior(undefined,{MELO_HOME:home}).MELO_CDP_ENABLED,'0');
});

test('offline memory blocks remote HTTP adapters before fetch while allowing loopback',async()=>{
 const { memoryEndpointAllowed }=await import('./runtimeBehavior.js');
 assert.equal(memoryEndpointAllowed('https://cloud.example/embed',{MELO_OFFLINE_ONLY:'1'}),false);
 assert.equal(memoryEndpointAllowed('http://127.0.0.1:1234/embed',{MELO_OFFLINE_ONLY:'1'}),true);
 const { runWithRequestContext }=await import('./requestScope.js');
 const { createRequestContext }=await import('./requestContext.js');
 const { CustomHttpEmbedProvider }=await import('../memory/embedProviders/CustomHttpEmbedProvider.js');
 const provider=new CustomHttpEmbedProvider({url:'https://cloud.example/embed'});
 let calls=0;const old=globalThis.fetch;globalThis.fetch=async()=>{calls++;throw new Error('must not fetch');};
 try {
  await runWithRequestContext(createRequestContext({config:{behavior:{offlineMemory:true}},env:{MELO_OFFLINE_ONLY:''}}),async()=>{
   assert.equal(await provider.isAvailable(),false);assert.equal(await provider.embed('private memory'),null);
  });
  assert.equal(calls,0);
 } finally {globalThis.fetch=old;}
});
