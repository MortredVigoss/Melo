import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { visualColor, visualRgb } from '../src/shared/visualTokens.js';
test('visual defaults match the authored theme and browser overrides reach canvas colors',()=>{
 execFileSync(process.execPath,['scripts/generate-visual-tokens.js','--check']);
 assert.equal(visualColor('chat'),'#ba793b');assert.equal(visualRgb('chat'),'186,121,59');
 const previous=[globalThis.document,globalThis.getComputedStyle];
 globalThis.document={documentElement:{}};globalThis.getComputedStyle=()=>({getPropertyValue:()=> 'rgb(1, 2, 3)'});
 try{assert.equal(visualColor('chat'),'rgb(1, 2, 3)');assert.equal(visualRgb('chat'),'1,2,3');}
 finally{[globalThis.document,globalThis.getComputedStyle]=previous;}
});
