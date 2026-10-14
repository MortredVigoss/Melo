import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouteSampler} from './neuralSampling.js';

test('idle animation reuses geometry instead of measuring DOM every frame',()=>{
 let now=0,reads=0;const sample=createRouteSampler(()=>({revision:++reads}),{now:()=>now});
 const first=sample.get();for(let n=1;n<36;n++){now=n*33;assert.equal(sample.get(),first);}
 assert.equal(reads,1);now=1200;assert.notEqual(sample.get(),first);assert.equal(reads,2);
});
test('interrupted motion keeps geometry live until the latest transition settles',()=>{
 let now=0,position=0;const sample=createRouteSampler(()=>position,{now:()=>now,settleMs:600});
 sample.get();sample.invalidate();now=200;position=12;assert.equal(sample.get(),12);
 sample.invalidate();now=700;position=24;assert.equal(sample.get(),24);
 now=850;position=30;assert.equal(sample.get(),24);sample.invalidate(0);assert.equal(sample.get(),30);
});
test('a new render invalidates the previous route immediately',()=>{
 let page='chat';const sample=createRouteSampler(()=>page,{now:()=>0});assert.equal(sample.get(),'chat');page='projects';sample.invalidate();assert.equal(sample.get(),'projects');
});
