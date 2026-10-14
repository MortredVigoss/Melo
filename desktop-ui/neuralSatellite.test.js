import test from 'node:test';
import assert from 'node:assert/strict';
import {createSatelliteMotion,advanceSatelliteMotion,rotateSatellitePoint,lobeDepth,pickNeuralLobe} from './neuralSatellite.js';

test('focus resolves the current 3D attitude within 200ms and release has no phase jump',()=>{
 const state=createSatelliteMotion(4);
 for(let i=0;i<1800;i++)advanceSatelliteMotion(state,1/30,false);
 const before={...state};advanceSatelliteMotion(state,0,true);
 assert.ok(Math.abs(state.yaw-before.yaw)<1e-9);
 for(let i=0;i<12;i++)advanceSatelliteMotion(state,1/60,true);
 assert.ok(Math.abs(state.yaw)+Math.abs(state.pitch)+Math.abs(state.roll)<1e-8);
 const rotation=advanceSatelliteMotion(state,0,false),point=[.4,.3,-.5],out=[];
 rotateSatellitePoint(point,rotation,out);out.forEach((v,i)=>assert.ok(Math.abs(v-point[i])<1e-8));
 advanceSatelliteMotion(state,1/30,false);assert.ok(state.yaw>0&&state.yaw<.01);
});

test('rapid hover changes reverse from the visible attitude and reduced motion aligns immediately',()=>{
 const state=createSatelliteMotion(1);
 advanceSatelliteMotion(state,.06,true);advanceSatelliteMotion(state,.04,false);
 const before=state.yaw;advanceSatelliteMotion(state,0,true);assert.ok(Math.abs(state.yaw-before)<1e-9);
 advanceSatelliteMotion(state,.01,true,true);assert.equal(state.yaw,0);assert.equal(state.pitch,0);
});

test('moving a lobe toward the camera increases its projected size by ten percent',()=>{
 for(const scale of [48,88,172]){
   const distance=1070,base=lobeDepth(0,0,0,distance,scale),raised=lobeDepth(0,0,1,distance,scale);
   const magnification=distance/(distance-(raised-base)*scale);
   assert.ok(Math.abs(magnification-1.1)<1e-9);
 }
});

test('core picking follows projected regions and keeps a small overlap hysteresis',()=>{
 const regions=[{x:100,y:100,rx:30,ry:20},{x:145,y:100,rx:30,ry:20}];
 assert.equal(pickNeuralLobe(regions,100,100),0);
 assert.equal(pickNeuralLobe(regions,145,100),1);
 assert.equal(pickNeuralLobe(regions,200,100),-1);
 assert.equal(pickNeuralLobe(regions,123,100,0),0);
 regions[0].x=30;assert.equal(pickNeuralLobe(regions,100,100),-1);
});
