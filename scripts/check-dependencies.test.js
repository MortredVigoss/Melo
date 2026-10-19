import test from 'node:test';
import assert from 'node:assert/strict';
import { findCycles, checkDependencies, checkLayerDirections, checkBootstrapBoundary, BOOTSTRAP_FREE_MODULES, BOOTSTRAP_LEGACY_IMPORTERS } from './check-dependencies.js';
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
test('migrated business modules cannot reach the desktop bootstrap and the legacy exception list only shrinks',()=>{
  const boot='/src/services/desktop/bootstrap.js', options={migrated:['services/project/projectMutations.js'],legacy:['services/chat/chatMutations.js']};
  const graph=extra=>new Map([
    ['/src/services/project/projectMutations.js',['/src/state/stateStore.js']],['/src/state/stateStore.js',[]],
    ['/src/services/chat/chatMutations.js',[boot]],['/src/desktopStore.js',[boot]],['/src/http/domainRoutes.js',[boot]],[boot,[]],...extra]);
  assert.doesNotThrow(()=>checkBootstrapBoundary(graph([]),'/src',options));
  // Sliding back through the compatibility facade names the whole chain.
  const viaFacade=graph([['/src/services/project/projectMutations.js',['/src/services/project/helper.js']],['/src/services/project/helper.js',['/src/desktopStore.js']]]);
  assert.throws(()=>checkBootstrapBoundary(viaFacade,'/src',options),/Migrated module reaches the desktop bootstrap: services\/project\/projectMutations\.js -> services\/project\/helper\.js -> desktopStore\.js -> services\/desktop\/bootstrap\.js/);
  assert.throws(()=>checkBootstrapBoundary(graph([['/src/services/project/projectMutations.js',[boot]]]),'/src',options),/projectMutations\.js -> services\/desktop\/bootstrap\.js/);
  // Even a legacy module cannot be a route back for a migrated one.
  assert.throws(()=>checkBootstrapBoundary(graph([['/src/services/project/projectMutations.js',['/src/services/chat/chatMutations.js']]]),'/src',options),/projectMutations\.js -> services\/chat\/chatMutations\.js -> services\/desktop\/bootstrap\.js/);
  assert.throws(()=>checkBootstrapBoundary(graph([['/src/services/task/newCommand.js',[boot]]]),'/src',options),/New business module imports the desktop bootstrap: services\/task\/newCommand\.js/);
  assert.throws(()=>checkBootstrapBoundary(graph([['/src/services/chat/chatMutations.js',[]]]),'/src',options),/exception list is stale: services\/chat\/chatMutations\.js/);
  assert.throws(()=>checkBootstrapBoundary(graph([]),'/src',{...options,migrated:['services/project/gone.js']}),/no longer exists/);
});
test('the production bootstrap exception list is pinned and does not overlap migrated modules',()=>{
  // Lower this number as modules migrate; never raise it.
  assert.ok(BOOTSTRAP_LEGACY_IMPORTERS.length<=11,`legacy bootstrap importers grew to ${BOOTSTRAP_LEGACY_IMPORTERS.length}`);
  for(const entry of ['services/project/projectMutations.js','services/agent/agentMutations.js'])assert.ok(BOOTSTRAP_FREE_MODULES.includes(entry),entry);
  assert.deepEqual(BOOTSTRAP_FREE_MODULES.filter(entry=>BOOTSTRAP_LEGACY_IMPORTERS.includes(entry)),[]);
});
