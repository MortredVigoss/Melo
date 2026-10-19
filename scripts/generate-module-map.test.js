import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModuleMap, generateModuleMap, platformSourcesAvailable, ownerOf, compileOwnership, ownershipCandidates, expandBraces, routeOwner } from './generate-module-map.js';

// The committed architecture/modules.json must match the current import graph,
// route registries and annotations (same pattern as the sync/agent-loop
// contract checks). Linux test copies omit ios/ and desktop-app/.
test('architecture/modules.json is current', async t => {
  if (!await platformSourcesAvailable()) return t.skip('ios/ or desktop-app/ sources are not part of this checkout');
  await generateModuleMap({ check: true });
});

test('ownership prefers exact paths, then longer literal prefixes, and tests follow their subject', () => {
  const rules = compileOwnership({
    memory: { owns: ['desktop-ui/{memoryFacts,projectMemoryBook}.js'] },
    projects: { owns: ['desktop-ui/project*.js'] },
    shell: { owns: ['desktop-ui/**'] },
    a: { owns: ['x/*.js'] },
    b: { owns: ['x/*.js'] },
  });
  assert.deepEqual(expandBraces('a/{b,c}.{js,css}'), ['a/b.js', 'a/b.css', 'a/c.js', 'a/c.css']);
  assert.deepEqual(ownershipCandidates('desktop-ui/agent.browser.test.js'), ['desktop-ui/agent.browser.test.js', 'desktop-ui/agent.browser.js', 'desktop-ui/agent.js']);
  assert.equal(ownerOf('desktop-ui/projectMemoryBook.js', rules).feature, 'memory');
  assert.equal(ownerOf('desktop-ui/projectPresentation.test.js', rules).feature, 'projects');
  assert.equal(ownerOf('desktop-ui/memoryFacts.test.js', rules).feature, 'memory');
  assert.equal(ownerOf('desktop-ui/app.js', rules).feature, 'shell');
  assert.deepEqual(ownerOf('x/y.js', rules).ties, ['b']);
  assert.equal(ownerOf('docs/plan.md', rules), null);
  assert.equal(routeOwner('/api/projects/memory-book', { projects: { routes: ['/api/projects'] }, memory: { routes: ['/api/projects/memory-book'] } }), 'memory');
});

test('the map covers every requested feature with entries, routes, counterparts, contracts and tests', async () => {
  const { map, problems } = await buildModuleMap();
  assert.deepEqual(problems, []);
  assert.deepEqual(map.summary.features, ['projects', 'agents', 'chat', 'memory', 'knowledge', 'settings', 'sync', 'tools', 'media', 'voice', 'approvals', 'desktop-shell', 'iphone']);
  assert.deepEqual(map.summary.unassignedRoutes, []);
  assert.deepEqual(map.summary.unownedFiles, []);
  assert.deepEqual(map.summary.sourceReadingTests.unannotated, [], 'register new source-reading tests in architecture/module-annotations.json');
  const { projects, chat, memory } = map.features;
  assert.ok(projects.entryModules.some(entry => entry.module === 'src/services/project/projectMutations.js'));
  assert.ok(projects.httpRoutes.includes('POST /api/projects/update ← src/http/domainRoutes.js'));
  assert.ok(memory.desktopUi.includes('desktop-ui/memoryFacts.js'));
  assert.ok(memory.httpRoutes.some(route => route.startsWith('GET /api/projects/memory-book ')));
  assert.ok(chat.sharedContracts.includes('agent-loop'));
  assert.ok(chat.tests.js.includes('src/runtime/agentLoopContract.test.js'));
  const loop = map.sharedContracts.find(entry => entry.id === 'agent-loop');
  assert.equal(loop.path, 'shared/protocol/agent-loop.json');
  assert.ok(loop.desktopConsumers.includes('src/services/chat/chatExecutionRunner.js'));
  assert.ok(map.counterparts.some(entry => entry.contract === 'agent-loop' && entry.iphone.includes('ios/Melo/AgentLoop.swift')));
  for (const [id, feature] of Object.entries(map.features)) {
    for (const group of feature.tests.groups) assert.match(group, /^npm run /, id);
  }
});
