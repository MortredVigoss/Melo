import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileNetwork, moduleIDs } from '../SceneSource/neuralLayout.js';
import { neuralIdentities } from '../../desktop-ui/neuralSatellite.js';

test('mobile ports follow measured native glyphs at each width, without imaginary branch endpoints', () => {
  assert.deepEqual(neuralIdentities.map(x => x.id), ['chat','projects','agents','knowledge','system']);
  for (const width of [320, 390, 430, 844]) {
    const frames = Object.fromEntries(moduleIDs.map((id,i) => [id,{x:10 + (width-20)/5*(i+.5)-14,y:73,width:28,height:28}]));
    const network = mobileNetwork({compact:true,frames,selected:3,transmitting:true},width,138);
    assert.equal(network.active,4, 'Native system ID is not the desktop index');
    assert.equal(network.focus,4); assert.equal(network.busy,true);
    assert.deepEqual(network.ports, moduleIDs.map(id => [frames[id].x+14,87]));
    assert.deepEqual(network.core,[width-54,44]);
    assert.deepEqual(network.routes,[]); assert.equal(network.output,null);
    assert.ok(network.ports.every(([x,y])=>x>0&&x<width&&y<138));
  }
});
test('stale frames during navigation and malformed geometry cannot draw detached links', () => {
  const frames=Object.fromEntries(moduleIDs.map((id,i)=>[id,{x:20+i*60,y:80,width:60,height:60}]));
  assert.equal(mobileNetwork({frames},390,710).ports.length,5);
  assert.deepEqual(mobileNetwork({frames,compact:true},390,138).ports,[]);
  assert.deepEqual(mobileNetwork({frames:{...frames,2:{x:NaN,y:80,width:60,height:60}}},390,710).ports,[]);
  assert.deepEqual(mobileNetwork({},390,710).ports,[]);
  assert.equal(mobileNetwork({hover:2},390,710).hoverFocus,2);
  assert.equal(mobileNetwork({hover:2},390,710).focus,2);
  assert.equal(mobileNetwork({},390,710).focus,-1);
});

test('compact selection and touch grow one node by four percent without moving any center',()=>{
 for(const width of [320,390,430,844]) {
  const frames=Object.fromEntries(moduleIDs.map((id,i)=>[id,{x:10+(width-20)/5*(i+.5)-14,y:73,width:28,height:28}]));
  const base=mobileNetwork({compact:true,frames,selected:1},width,138);
  for(const selected of moduleIDs) {
   const value=mobileNetwork({compact:true,frames,selected,hover:-1},width,138);
   assert.equal(value.stationaryNavigation,true);assert.deepEqual(value.ports,base.ports);assert.deepEqual(value.core,base.core);
   value.portRadii.forEach((r,i)=>assert.equal(r,28*.48*(moduleIDs[i]===selected?1.04:1)));
   const touched=mobileNetwork({compact:true,frames,selected:1,hover:selected},width,138);
   assert.deepEqual(touched.ports,base.ports);assert.deepEqual(touched.core,base.core);
   assert.deepEqual(touched.portRadii,value.portRadii);
  }
 }
});
