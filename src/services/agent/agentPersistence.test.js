import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeAgentState, hydrateAgentRecords, hydrateProjectAgentRecords } from '../../domain/agent/agentState.js';
import { normalizeAgentProfile, effectiveAgentProfile } from '../../state/agentProfiles.js';
import { createRequestContext } from '../../runtime/requestContext.js';
import { runWithRequestContext } from '../../runtime/requestScope.js';
import { updateAgentProfile } from './agentMutations.js';
import { loadState, updateStateAtomically } from '../../state/stateStore.js';
import { exportCommittedAgent } from './agentExport.js';

test('persistent persona separates local channel and voice settings and round-trips project overrides', () => {
  const profile=normalizeAgentProfile('main',{instructions:'My document',channels:{telegram:{botToken:'local-secret',enabled:true}},ttsSpeed:1.2});
  const state={agentProfiles:{main:profile},projectAgentOverrides:{p:{main:{instructions:'Project document',channels:profile.channels,ttsSpeed:0.9}}}};
  const disk=serializeAgentState(state);
  assert.equal(disk.agentProfiles.main.instructions,'My document');
  assert.equal(disk.agentProfiles.main.channels,undefined);
  assert.equal(disk.agentProfiles.main.ttsSpeed,undefined);
  assert.equal(disk.agentProfiles.main.identity,undefined);
  assert.equal(disk.agentChannelBindings.global.main.agentId,'main');
  assert.equal(hydrateAgentRecords(disk).main.channels.telegram.botToken,'local-secret');
  assert.equal(hydrateProjectAgentRecords(disk).p.main.ttsSpeed,0.9);
});

test('legacy migration backs up original state and modern saves ignore edited Markdown', async t => {
  const home=await mkdtemp(join(tmpdir(),'melo-agent-migration-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const desktop=join(home,'desktop'); await mkdir(desktop,{recursive:true});
  const original=JSON.stringify({_storageFormat:2,chats:[],agentProfiles:{main:{rolePrompt:'Work',identity:'Identity',soulMd:'Style',systemPrompt:'Extra',channels:{telegram:{botToken:'keep-secret'}}}}});
  await writeFile(join(desktop,'state.json'),original);
  await runWithRequestContext(createRequestContext({home}),async()=>{
    await updateAgentProfile('main',{name:'Edited built-in'});
    const raw=JSON.parse(await readFile(join(desktop,'state.json'),'utf8'));
    assert.equal(raw._storageFormat,3);
    for(const section of ['Work','Identity','Style','Extra']) assert.ok(raw.agentProfiles.main.instructions.includes(section));
    const backup=(await readdir(join(desktop,'backups'))).find(name=>name.startsWith('before-agent-v3-'));
    assert.equal(await readFile(join(desktop,'backups',backup,'state.json'),'utf8'),original);
    // A newer manifest forces a fresh resident snapshot; modern Markdown is export only.
    await writeFile(join(desktop,'agents','global','main','IDENTITY.md'),'External overwrite');
    await writeFile(join(desktop,'state.json'),JSON.stringify(raw));
    const restored=await loadState({home});
    assert.equal(restored.agentProfiles.main.name,'Edited built-in');
    assert.doesNotMatch(restored.agentProfiles.main.instructions,/External overwrite/);
    assert.equal(restored.agentProfiles.main.channels.telegram.botToken,'keep-secret');
  });
});

test('export failure reports saved state with warning and failed transaction leaves exports intact', async t => {
  const home=await mkdtemp(join(tmpdir(),'melo-agent-export-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  await runWithRequestContext(createRequestContext({home}),async()=>{
    await updateAgentProfile('main',{instructions:'Before'});
    const dir=join(home,'desktop','agents','global','main');
    await assert.rejects(updateStateAtomically(state=>{state.agentProfiles.main.instructions='Never committed';throw new Error('rollback');},{home}),/rollback/);
    assert.equal((await readFile(join(dir,'AGENT.md'),'utf8')).trim(),'Before');
    await rm(join(dir,'AGENT.md')); await mkdir(join(dir,'AGENT.md'));
    const result=await updateAgentProfile('main',{instructions:'Saved despite export failure'});
    assert.match(result.agentExportWarning,/已保存/);
    assert.equal((await loadState({home})).agentProfiles.main.instructions,'Saved despite export failure');
  });
});

test('older post-commit export cannot replace newer document and home is bound at entry', async()=>{
  const writes=[]; const write=async(path,content)=>writes.push([path,content]);
  const state=revision=>({_revision:revision,agentProfiles:{main:{instructions:`revision ${revision}`}}});
  await exportCommittedAgent(state(5),{home:'/tmp/melo-export-bound',agentId:'main',write});
  await exportCommittedAgent(state(4),{home:'/tmp/melo-export-bound',agentId:'main',write});
  assert.equal(writes.length,3);
  assert.ok(writes.every(([path])=>path.startsWith('/tmp/melo-export-bound/')));
  assert.equal(writes[0][1],'revision 5');
});


test('project voice settings survive a persona-only update and disk reload', async t => {
  const home=await mkdtemp(join(tmpdir(),'melo-agent-project-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  await runWithRequestContext(createRequestContext({home}),async()=>{
    await updateAgentProfile('main',{minimaxVoiceId:'project-voice',voiceReplyMode:'off',voicePersonality:'Gentle',edgeTtsVoice:'en-US-AriaNeural'},{scope:'project',projectId:'p'});
    await updateAgentProfile('main',{instructions:'Project persona'},{scope:'project',projectId:'p'});
    const disk=JSON.parse(await readFile(join(home,'desktop','state.json'),'utf8'));
    assert.equal(disk.agentVoiceSettings.projects.p.main.minimaxVoiceId,'project-voice');
    assert.equal(disk.agentVoiceSettings.projects.p.main.voiceReplyMode,'off');
    assert.equal(disk.projectAgentOverrides.p.main.minimaxVoiceId,undefined);
    await writeFile(join(home,'desktop','state.json'),JSON.stringify(disk));
    const state=await loadState({home});
    assert.equal(state.projectAgentOverrides.p.main.voicePersonality,'Gentle');
    assert.equal(state.projectAgentOverrides.p.main.instructions,'Project persona');
  });
});

test('legacy capability migration requires matching preview and persists after cold hydration', async t=>{
 const {capabilityMigrationPreview,migrationOptions}=await import('./capabilityMigration.js');
 const {effectiveAgentProfile}=await import('../../state/agentProfiles.js');
 const {emptyCapabilities}=await import('../../domain/agent/capabilities.js');
 const home=await mkdtemp(join(tmpdir(),'melo-capability-migration-'));t.after(()=>rm(home,{recursive:true,force:true}));
 await mkdir(join(home,'desktop'),{recursive:true});
 await writeFile(join(home,'desktop','state.json'),JSON.stringify({_storageFormat:3,agentProfiles:{main:{instructions:'Keep',tools:['local-files']}}}));
 await runWithRequestContext(createRequestContext({home}),async()=>{
  let state=await loadState({home});const preview=capabilityMigrationPreview(effectiveAgentProfile(state,'main'),migrationOptions(state));
  await assert.rejects(updateAgentProfile('main',{capabilities:emptyCapabilities()}),/预览/);
  await assert.rejects(updateAgentProfile('main',{capabilities:emptyCapabilities(),capabilityMigrationExpected:'stale'}),/预览/);
  assert.equal((await loadState({home})).agentProfiles.main.capabilities,null);
  await updateAgentProfile('main',{capabilities:preview.proposed,capabilityMigrationExpected:preview.fingerprint});
  const disk=JSON.parse(await readFile(join(home,'desktop','state.json'),'utf8'));
  await writeFile(join(home,'desktop','state.json'),JSON.stringify(disk));state=await loadState({home});
  assert.equal(state.agentProfiles.main.capabilities.runCommands,false);assert.equal(state.agentProfiles.main.capabilities.readFiles,true);
  await assert.rejects(updateAgentProfile('main',{capabilities:null}),/explicit object/);
  assert.equal(state.agentProfiles.main.instructions,'Keep');
 });
});


test('project reply language inherits, overrides and explicitly resets through committed storage', async t => {
  const home = await mkdtemp(join(tmpdir(), 'melo-project-language-'));
  t.after(() => rm(home, {recursive:true, force:true}));
  await runWithRequestContext(createRequestContext({home}), async () => {
    await updateAgentProfile('main', {replyLanguage:'ko'});
    await updateAgentProfile('main', {name:'Project Agent'}, {scope:'project', projectId:'p'});
    let state = await loadState({home});
    assert.equal(effectiveAgentProfile(state, 'main', 'p').replyLanguage, 'ko');
    assert.equal(Object.hasOwn(state.projectAgentOverrides.p.main, 'replyLanguage'), false);
    for (const replyLanguage of ['ja', 'es', '']) {
      await updateAgentProfile('main', {replyLanguage}, {scope:'project', projectId:'p'});
      await updateAgentProfile('main', {name:'Renamed Project Agent'}, {scope:'project', projectId:'p'});
      const path = join(home, 'desktop', 'state.json');
      const disk = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(disk.projectAgentOverrides.p.main.replyLanguage, replyLanguage);
      await writeFile(path, JSON.stringify(disk));
      state = await loadState({home});
      assert.equal(effectiveAgentProfile(state, 'main', 'p').replyLanguage, replyLanguage);
      assert.equal(state.agentProfiles.main.replyLanguage, 'ko');
    }
  });
});
