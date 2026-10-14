import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { updateLocalProfile } from './localProfile.js';
import { getDesktopBootstrap } from '../../state/desktopBootstrap.js';
import { loadState, updateStateAtomically } from '../../state/stateStore.js';
import { prepareDesktopLaunchState } from './desktopSettings.js';
import { validateLocalPreferencePatch } from './localPreferences.js';

test('local profile and settings persist without changing roles or requiring an account', async () => {
  const home = await mkdtemp(join(tmpdir(), 'melo-local-profile-')), previous = process.env.MELO_HOME;
  process.env.MELO_HOME = home;
  try {
    const before = await loadState();
    const image = await sharp({create:{width:40,height:80,channels:3,background:'#663399'}}).png().toBuffer();
    await updateLocalProfile({ name:'小明', avatarData:`data:image/png;base64,${image.toString('base64')}`, preferences:{textSize:'large',motion:'reduced',autoCollapse:false} });
    const data = await getDesktopBootstrap();
    assert.equal(data.profile.name, '小明');
    assert.match(data.profile.avatarData, /^data:image\/jpeg;base64,/);
    assert.equal(data.settings.localPreferences.textSize, 'large');
    const after = await loadState();
    assert.deepEqual(after.agentProfiles, before.agentProfiles);
    await assert.rejects(updateLocalProfile({name:'   '}));
    await assert.rejects(updateLocalProfile({avatarData:'data:image/svg+xml;base64,AAAA'}));
    await assert.rejects(updateLocalProfile({preferences:{motion:'fake'}}));
    assert.equal((await getDesktopBootstrap()).profile.name, '小明');
    await updateLocalProfile({avatarData:''});
    assert.equal((await getDesktopBootstrap()).profile.avatarData,'');
    await updateStateAtomically(s=>{s.settings.activeView='projects';return s;});
    await updateLocalProfile({preferences:{restoreSession:true}});
    await prepareDesktopLaunchState();
    assert.equal((await loadState()).settings.activeView,'projects');
    await updateLocalProfile({preferences:{restoreSession:false}});
    await prepareDesktopLaunchState();
    assert.equal((await loadState()).settings.activeView,'chat');
  } finally {
    previous === undefined ? delete process.env.MELO_HOME : process.env.MELO_HOME = previous;
    await rm(home,{recursive:true,force:true});
  }
});
test('settings reject unknown fields and wrong types',()=>{
  for(const patch of [{apiKey:'secret'},{autoCollapse:'false'},{textSize:300},JSON.parse('{"__proto__":true}')]) assert.throws(()=>validateLocalPreferencePatch(patch));
});
