import test from 'node:test';
import assert from 'node:assert/strict';
import { findCycles, checkDependencies, checkLayerDirections } from './check-dependencies.js';
test('cycle detector reports a real cycle and leaves a directed acyclic graph alone',()=>{
  assert.deepEqual(findCycles(new Map([['a',['b']],['b',['c']],['c',['a']]])),[['a','b','c']]);
  assert.deepEqual(findCycles(new Map([['a',['b','c']],['b',['c']],['c',[]]])),[]);
});
test('production source imports remain acyclic and config has no execution dependencies', async()=>{
  assert.equal((await checkDependencies()).cycles,0);
});
test('persistence and domain cannot grow new application dependencies',()=>{
  assert.throws(()=>checkLayerDirections(new Map([['/src/state/store.js',['/src/services/chat/send.js']]]),'/src'),/Persistence depends/);
  assert.throws(()=>checkLayerDirections(new Map([['/src/domain/task.js',['/src/state/store.js']]]),'/src'),/Domain depends/);
  assert.doesNotThrow(()=>checkLayerDirections(new Map([['/src/state/store.js',['/src/domain/task.js']]]),'/src'));
});
