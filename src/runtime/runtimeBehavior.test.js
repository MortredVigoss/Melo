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

