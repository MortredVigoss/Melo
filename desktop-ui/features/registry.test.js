import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createActionRegistry } from './registry.js';
import { memoryActions, memoryForms } from './memory/controller.js';
import { projectsActions, projectsForms } from './projects/controller.js';
import { agentsActions, agentsForms } from './agents/controller.js';

test('the registry routes a name to its handler with the payload and reports misses', async () => {
  const registry = createActionRegistry('action');
  const seen = [];
  registry.register({ 'demo-run': payload => { seen.push(payload); } }, 'demo');
  assert.equal(registry.has('demo-run'), true);
  assert.equal(registry.has('other'), false);
  assert.equal(registry.owner('demo-run'), 'demo');
  assert.equal(await registry.dispatch('demo-run', { trigger: 1 }), true);
  assert.equal(await registry.dispatch('other', {}), false);
  assert.deepEqual(seen, [{ trigger: 1 }]);
  assert.throws(() => registry.register({ 'demo-run': () => {} }, 'second'), /already registered by demo/);
  assert.throws(() => registry.register({ broken: 'nope' }, 'demo'), /needs a handler function/);
});

test('a handler starts synchronously, like the case body it replaced', () => {
  const registry = createActionRegistry('action');
  let started = false;
  registry.register({ go: async () => { started = true; await null; } });
  registry.dispatch('go', {});
  assert.equal(started, true);
});

// app.js composes the features; it must not keep a second copy of their
// branches or their state (architecture plan P2 completion criteria).
test('app.js has no switch case or uiState field for registered feature actions', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const names = [memoryActions, memoryForms, projectsActions, projectsForms, agentsActions, agentsForms].flatMap(table => Object.keys(table));
  assert.ok(names.length >= 50);
  assert.equal(new Set(names).size, names.length, 'action and form names are unique across features');
  for (const name of names) assert.doesNotMatch(app, new RegExp(`case '${name}'`), name);
  for (const field of ['memoryStatus', 'memoryFact', 'memoryRef', 'memoryConnection', 'projectBook', 'projectSearch', 'showProjectForm', 'draftProject', 'showArchivedProjects',
    'agentEditorTab', 'agentChannelTab', 'agentDrafts', 'agentCreating', 'agentOpenSections', 'agentSaveStates', 'agentSecretVisibility', 'agentListScrollTop', 'agentDetailScrollTops', 'agentEditorStates', 'shouldFocusAgentEditor']) {
    assert.doesNotMatch(app, new RegExp(`uiState\\.${field}`), field);
  }
  assert.match(app, /featureActions\.register\(memoryFeature\.actions, 'memory'\)/);
  assert.match(app, /featureActions\.register\(projectsFeature\.actions, 'projects'\)/);
  assert.match(app, /featureActions\.register\(agentsFeature\.actions, 'agents'\)/);
  assert.doesNotMatch(app, /features\/(memory|projects|agents)\/(?!index\.js)/, 'app.js imports a feature only through its index.js');
  assert.match(app, /if \(featureActions\.has\(action\)\) \{ await featureActions\.dispatch/, 'shell actions stay synchronous when no feature owns them');
});
