import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeBootstrap } from './bootstrapTransport.js';
import { decodeBootstrap, olderBootstrap } from '../../desktop-ui/bootstrapPatch.js';

const fixture = revision => ({stateRevision:revision,settings:{selectedChatId:'a'},customize:{agents:[]},chats:[{id:'a'}],activeChat:{id:'a',messages:[{content:'long transcript '.repeat(1000)}]},profile:{name:'old'}});
test('a mutation transmits only changed entities and reconstructs the exact bootstrap',()=>{
  const before = encodeBootstrap(fixture(1),{home:'a'});
  const expected = {...fixture(2),profile:{name:'new'}};
  const patch = encodeBootstrap(expected,{home:'a',baseToken:before._snapshot.token});
  assert.equal(patch.kind,'bootstrap-patch');
  assert.deepEqual(Object.keys(patch.set).sort(),['profile','stateRevision']);
  assert.ok(JSON.stringify(patch).length < JSON.stringify(expected).length/10);
  const decoded = decodeBootstrap(patch,before);
  assert.deepEqual({...decoded,_snapshot:undefined},{...expected,_snapshot:undefined});
  assert.equal(olderBootstrap(before,decoded),true);
});
test('unknown or other-home baselines fall back to full data; old clients remain compatible',()=>{
  const before = encodeBootstrap(fixture(1),{home:'a'});
  assert.ok(encodeBootstrap(fixture(2),{home:'b',baseToken:before._snapshot.token}).activeChat);
  assert.ok(encodeBootstrap(fixture(2),{home:'a',baseToken:'expired'}).activeChat);
  assert.ok(encodeBootstrap(fixture(2),{home:'a'}).activeChat);
  assert.throws(()=>decodeBootstrap({kind:'bootstrap-patch',baseToken:'expired'},before));
});
test('nested reply bootstraps and removed fields round-trip; late responses cannot overwrite a newer revision',()=>{
  const before=encodeBootstrap({...fixture(1),obsolete:true},{home:'a'});
  const result=encodeBootstrap({assistantMessage:{id:'m'},bootstrap:fixture(2)},{home:'a',baseToken:before._snapshot.token});
  const decoded=decodeBootstrap(result,before);
  assert.equal(Object.hasOwn(decoded.bootstrap,'obsolete'),false);
  assert.equal(decoded.assistantMessage.id,'m');
  const late=encodeBootstrap(fixture(1),{home:'a'});
  assert.equal(olderBootstrap(late,decoded.bootstrap),true);
});
