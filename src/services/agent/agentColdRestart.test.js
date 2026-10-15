import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
// Each phase is a fresh process: no resident snapshot can hide a disk reload.
async function phase(home, operation) {
  const script = `
    import assert from 'node:assert/strict';
    import {readFile} from 'node:fs/promises';
    import {loadState,updateStateAtomically,persistStateAtomically} from './src/state/stateStore.js';
    import {updateAgentProfile} from './src/services/agent/agentMutations.js';
    const home=process.env.MELO_HOME;
    ${operation}
  `;
  await exec(process.execPath,['--input-type=module','-e',script],{
    cwd:root,timeout:30000,env:{...process.env,MELO_HOME:home,MELO_TEST_MODE:'1',MELO_MEMORY_RUNTIME:'0',MELO_DREAMING_ENABLED:'0'},
  });
}

test('cold Agent edits survive cache publication, unrelated saves, and another restart', {timeout:120000}, async t => {
  const home=await mkdtemp(join(tmpdir(),'melo-agent-cold-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  await phase(home,`
    await updateAgentProfile('main',{minimaxVoiceId:'old-global',channels:{telegram:{botToken:'fixture-old-global'}}});
    await updateAgentProfile('main',{minimaxVoiceId:'old-project',channels:{telegram:{botToken:'fixture-old-project'}}},{scope:'project',projectId:'p'});
    await updateStateAtomically(s=>{s.chats.push({id:'kept-chat',title:'Kept',messages:[{id:'kept-message',role:'user',content:'Keep this transcript'}]});},{home});
  `);
  await phase(home,`
    const cold=await loadState({home});
    assert.equal(cold.agentProfiles.main.minimaxVoiceId,'old-global');
    await updateAgentProfile('main',{minimaxVoiceId:'new-global',channels:{telegram:{botToken:'fixture-new-global'}}});
    await updateAgentProfile('main',{minimaxVoiceId:'new-project',channels:{telegram:{botToken:'fixture-new-project'}}},{scope:'project',projectId:'p'});
    const committed=await updateStateAtomically(s=>{s.settings.restartProof=true;},{home});
    assert.equal(committed.agentProfiles.main.minimaxVoiceId,'new-global');
    assert.equal(committed.projectAgentOverrides.p.main.channels.telegram.botToken,'fixture-new-project');
    const cached=await loadState({home});
    assert.equal(cached.agentVoiceSettings,undefined);
    assert.equal(cached.agentChannelBindings,undefined);
    assert.equal(cached.agentProfiles.main.channels.telegram.botToken,'fixture-new-global');
    assert.equal(cached.projectAgentOverrides.p.main.minimaxVoiceId,'new-project');
    assert.equal(cached.chats.find(c=>c.id==='kept-chat').messages[0].content,'Keep this transcript');
    const candidate=await loadState({home});candidate.agentProfiles.main.minimaxVoiceId='failed-write';
    await assert.rejects(persistStateAtomically(candidate,{_writeState:async()=>{throw new Error('fixture write failure');}}),/fixture write failure/);
    assert.equal((await loadState({home})).agentProfiles.main.minimaxVoiceId,'new-global');
  `);
  await phase(home,`
    const state=await loadState({home});
    assert.equal(state.agentProfiles.main.minimaxVoiceId,'new-global');
    assert.equal(state.agentProfiles.main.channels.telegram.botToken,'fixture-new-global');
    assert.equal(state.projectAgentOverrides.p.main.minimaxVoiceId,'new-project');
    assert.equal(state.projectAgentOverrides.p.main.channels.telegram.botToken,'fixture-new-project');
    assert.equal(state.chats.find(c=>c.id==='kept-chat').messages[0].content,'Keep this transcript');
    await Promise.all([
      updateAgentProfile('main',{instructions:'Concurrent persona'}),
      updateAgentProfile('main',{ttsSpeed:1.2}),
    ]);
    await updateAgentProfile('main',{minimaxVoiceId:''});
    await updateAgentProfile('main',{}, {scope:'project',projectId:'p',clearProjectOverride:true});
    await updateStateAtomically(s=>{s.settings.finalProof=true;},{home});
  `);
  await phase(home,`
    const state=await loadState({home});
    assert.equal(state.agentProfiles.main.instructions,'Concurrent persona');
    assert.equal(state.agentProfiles.main.ttsSpeed,1.2);
    assert.equal(state.agentProfiles.main.minimaxVoiceId,'');
    assert.equal(state.agentProfiles.main.channels.telegram.botToken,'fixture-new-global');
    assert.equal(state.projectAgentOverrides.p,undefined);
    const disk=JSON.parse(await readFile(home+'/desktop/state.json','utf8'));
    assert.equal(disk.agentVoiceSettings.projects.p,undefined);
    assert.equal(disk.agentChannelBindings.projects.p,undefined);
  `);
});
