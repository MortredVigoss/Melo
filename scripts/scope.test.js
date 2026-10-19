import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scopeReport, formatScope } from './scope.js';
import { planTests } from './test-plan.js';

const cache = {};
const report = path => scopeReport([path], process.cwd(), cache);
const checks = item => item.check;

test('a project service change reports its feature, the iPhone counterpart and the unchanged full daily tier', async () => {
  const result = await report('src/services/project/projectMutations.js');
  assert.equal(result.changed[0].feature, 'projects');
  assert.ok(result.affectedFeatures.some(feature => feature.id === 'projects'));
  assert.ok(result.counterparts.flatMap(checks).includes('ios/Melo/PersonalWorkspace.swift'));
  assert.equal(result.testPlan.fullUnit, true);
  assert.match(result.testPlan.tier, /日常全量/);
  // Report only: the tier is exactly what scripts/test-plan.js selects.
  assert.equal(result.testPlan.selected, result.testPlan.discovered);
  assert.match(formatScope(result), /只报告，不改变 npm test 的选组/);
});

test('a desktop memory page renderer points at the phone memory views and the UI group', async () => {
  const result = await report('desktop-ui/memoryFacts.js');
  assert.equal(result.changed[0].feature, 'memory');
  assert.ok(result.changed[0].importers.some(item => item.file === 'desktop-ui/app.js'));
  assert.ok(result.counterparts.flatMap(checks).includes('ios/Melo/MemoryFacts.swift'));
  assert.deepEqual([result.testPlan.fullUnit, result.testPlan.browsers, result.testPlan.ios, result.testPlan.swift], [false, true, true, false]);
  assert.ok(result.focused.tests.includes('desktop-ui/memoryFacts.test.js'));
});

test('the phone agent loop points back at the desktop runner through the shared agent-loop contract', async () => {
  const result = await report('ios/Melo/AgentLoop.swift');
  assert.equal(result.changed[0].feature, 'chat');
  assert.ok(result.counterparts.flatMap(checks).includes('src/services/chat/chatExecutionRunner.js'));
  assert.ok(result.sharedContracts.some(contract => contract.id === 'agent-loop'));
  assert.deepEqual([result.testPlan.fullUnit, result.testPlan.browsers, result.testPlan.swift], [false, false, true]);
});

test('the shared agent-loop contract names both platforms, its generator and the full tier', async () => {
  const result = await report('shared/protocol/agent-loop.json');
  assert.equal(result.changed[0].feature, 'chat');
  const contract = result.sharedContracts.find(item => item.id === 'agent-loop');
  assert.ok(contract.hits.some(hit => hit.includes('契约文件')));
  const generator = result.implicit.find(item => item.id === 'gen-agent-loop');
  assert.equal(generator.command, 'npm run generate:agent-loop-contract');
  const both = result.counterparts.flatMap(checks);
  assert.ok(both.includes('src/runtime/agentLoopContract.js') && both.includes('ios/Melo/AgentLoopContract.swift'));
  assert.equal(result.testPlan.fullUnit, true);
});

test('an overview edit is documentation only: no feature, no product tests, link check only', async () => {
  const result = await report('MELO_OVERVIEW.md');
  assert.equal(result.changed[0].kind, 'docs');
  assert.deepEqual(result.affectedFeatures, []);
  assert.deepEqual(result.counterparts, []);
  assert.equal(result.testPlan.selected, 0);
  assert.deepEqual(result.testPlan.docs, ['MELO_OVERVIEW.md']);
  assert.deepEqual([result.testPlan.browsers, result.testPlan.ios, result.testPlan.swift], [false, false, false]);
  assert.deepEqual(planTests(['MELO_OVERVIEW.md'], ['src/a.test.js']).files, []);
});

test('the CLI prints JSON with --json', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./scope.js', import.meta.url)), '--json', 'MELO_OVERVIEW.md'], { encoding: 'utf8', env });
  const parsed = JSON.parse(output);
  assert.equal(parsed.changed[0].path, 'MELO_OVERVIEW.md');
  assert.match(parsed.reportOnly, /只报告/);
});
