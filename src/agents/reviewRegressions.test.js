import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {emptyCapabilities,recommendedCapabilities,filterToolsByCapabilities} from '../domain/agent/capabilities.js';
import {hydrateState} from '../state/stateHydration.js';
import {readStateSnapshot} from '../state/stateStore.js';
import {effectiveAgentProfile} from '../state/agentProfiles.js';
import {runAgentTeam} from './team.js';
import {runConfiguredMember} from './delegate.js';
import {runSubAgent} from './subAgent.js';
const member=id=>({id,name:id,capabilities:recommendedCapabilities(id)});
test('fresh disk and empty manifest have recommended capabilities; real legacy records keep migration preview',async()=>{
 const home=await mkdtemp(join(tmpdir(),'melo-agent-fresh-'));
 try {assert.deepEqual((await readStateSnapshot({home})).agentProfiles.main.capabilities,recommendedCapabilities('main'));}finally{await rm(home,{recursive:true,force:true});}
 assert.deepEqual(hydrateState({}).agentProfiles.main.capabilities,recommendedCapabilities('main'));
 assert.equal(hydrateState({agentProfiles:{main:{tools:['local-files']}}}).agentProfiles.main.capabilities,null);
});
test('team preflight rejects every unmigrated member before any model call',async()=>{
 let calls=0;const profiles={research:member('research'),builder:{id:'builder',name:'builder',capabilities:null}};
 await assert.rejects(runAgentTeam({plan:{members:['research','builder']},task:'work',config:{},capabilities:recommendedCapabilities('main'),agentProfiles:profiles,run:async()=>{calls++;return{ok:true,output:'done'};}}),{code:'AGENT_MIGRATION_REQUIRED'});
 assert.equal(calls,0);
 const result=await runConfiguredMember({profile:profiles.builder,task:'work',config:{},run:()=>{calls++;}});
 assert.equal(result.error,'AGENT_MIGRATION_REQUIRED');assert.equal(calls,0);
});
test('model tool list hides the old alias and cannot advertise delegation before migration',()=>{
 const tools=[{id:'agent'},{id:'delegate'},{id:'file_read'}];
 assert.deepEqual(filterToolsByCapabilities(tools,null).map(t=>t.id),['file_read']);
 assert.deepEqual(filterToolsByCapabilities(tools,recommendedCapabilities('main')).map(t=>t.id),['delegate','file_read']);
});
test('API member reply is bounded by its remaining budget, not an arbitrary 4096 tokens',async()=>{
 let seen;await runSubAgent({task:'write a complete implementation',config:{authMode:'api-key',model:'custom'},maxTokens:32000,allowedToolIds:[],replyFn:async request=>{seen=request;return 'done';}});
 assert.ok(seen.maxTokens>4096);assert.ok(seen.maxTokens<32000);
});
test('review loop can recover from a failed earlier build while retaining the failed round',async()=>{
 let builds=0;const result=await runAgentTeam({plan:{members:['builder','reviewer'],mode:'review-loop',maxRounds:2},task:'work',config:{},capabilities:recommendedCapabilities('main'),agentProfiles:{builder:member('builder'),reviewer:member('reviewer')},run:async({roleId})=>({ok:roleId!=='builder'||++builds>1,output:JSON.stringify({conclusion:'checked',review:builds>1?'approve':'revise'})})});
 assert.equal(result.results[0].ok,false);assert.equal(result.results.length,4);assert.equal(result.ok,true);
});
test('project overrides cannot expand a global capability ceiling',()=>{
 const state={agentProfiles:{main:{capabilities:emptyCapabilities()}},projectAgentOverrides:{p:{main:{capabilities:recommendedCapabilities('main')}}}};
 assert.deepEqual(effectiveAgentProfile(state,'main','p').capabilities,emptyCapabilities());
});
