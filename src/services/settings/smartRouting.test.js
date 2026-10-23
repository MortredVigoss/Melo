import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { saveConfig, loadConfig } from '../../config.js';
import { saveSmartRouting } from './smartRouting.js';

test('routing settings save is atomic, preserves accounts and rejects stale or unknown selections', async t => {
 const home = await mkdtemp(join(tmpdir(), 'melo-routing-settings-'));t.after(()=>rm(home,{recursive:true,force:true}));
 await runWithRequestContext(createRequestContext({home,env:{MELO_TEST_MODE:'1'}}),async()=>{
  await saveConfig({authMode:'api-key',apiKey:'retained-secret',baseUrl:'https://fixture.invalid',model:'opaque',activeLlmProfileId:'local',llmProfiles:{local:{name:'Existing',authMode:'api-key',apiKey:'retained-secret',baseUrl:'https://fixture.invalid',model:'opaque',models:['opaque']}},extraFast:{enabled:true},unrelatedSetting:'retain'});
  const before=await loadConfig({skipModelNormalize:true});
  const tiers=Object.fromEntries(['light','standard','strong'].map(tier=>[tier,[{connectionId:'local',model:'opaque'}]]));
  const patch={revision:0,defaultMode:'smart',preference:'balanced',allowCrossConnection:false,allowEscalation:true,tiers};
  const saved=await saveSmartRouting(patch);assert.equal(saved.revision,1);assert.ok(!JSON.stringify(saved).includes('retained-secret'));
  const after=await loadConfig({skipModelNormalize:true});assert.deepEqual(after.llmProfiles,before.llmProfiles);assert.equal(after.apiKey,before.apiKey);assert.deepEqual(after.extraFast,before.extraFast);assert.equal(after.unrelatedSetting,'retain');
  await assert.rejects(saveSmartRouting(patch),/已被更新/);
  await assert.rejects(saveSmartRouting({...patch,revision:1,tiers:{...tiers,strong:[{connectionId:'other',model:'invented'}]}}),/目录已改变/);
  assert.deepEqual(await loadConfig({skipModelNormalize:true}),after);
 });
});
