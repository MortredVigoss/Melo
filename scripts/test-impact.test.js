import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {buildTestImpact, moduleReferences, serverConsumers, IOS_JS} from './test-impact.js';
import {planTests} from './test-plan.js';
import {dailyStages} from './test-stages.js';
import {discoverRunnableTests} from './test-discovery.js';

const {files}=await discoverRunnableTests();
// Selector behavior uses the freshly built graph. Persisted-map freshness is
// tested independently by generate-module-map.test.js and the fallback below.
const context={...await buildTestImpact(),stale:false};
const plan=(...paths)=>planTests(paths,files,context);

test('UI edits include the existing backend safety source reader',()=>{
  for(const path of ['desktop-ui/app.js','desktop-ui/features/chat/controller.js']) {
    const p=plan(path);
    assert.ok(p.files.includes('src/safety/fileSafetyGate.production.test.js'),path);
    assert.equal(p.fullUnit,false);
  }
});
test('UI whole-feature coverage retains reverse consumers without unrelated backend feature tests',()=>{
  const p=plan('desktop-ui/features/chat/controller.js');
  assert.ok(p.files.includes('desktop-ui/features/chat/controller.test.js'));
  assert.ok(p.files.includes('desktop-ui/features/chat/threadWindow.test.js'));
  assert.ok(p.files.includes('src/safety/fileSafetyGate.production.test.js'));
  assert.ok(!p.files.includes('src/services/chat/chatExecutionRunner.test.js'));
  const css=plan('desktop-ui/features/chat/chat.css');
  assert.ok(css.files.includes('desktop-ui/executionTiming.browser.test.js'),'implicit stylesheet consumer stays');
  assert.ok(!css.files.includes('src/services/chat/chatExecutionRunner.test.js'));
});
test('local Android source iteration avoids R8, while manifests, builds and shared changes keep it',()=>{
  const local=plan('android/app/src/main/java/com/melo/android/MainActivity.kt');
  assert.equal(local.androidMode,'daily');
  assert.deepEqual(dailyStages(local).find(s=>s.args[0]==='scripts/android.mjs').args,['scripts/android.mjs','daily']);
  for(const path of ['android/app/src/main/AndroidManifest.xml','android/app/build.gradle.kts','shared/agent/turn.js'])assert.equal(plan(path).androidMode,'check',path);
});
test('backend leaf covers its whole feature and literal dynamic-import tests without unrelated native work',()=>{
  const p=plan('src/services/search/searchResultsBuilder.js');
  assert.ok(p.files.includes('src/services/search/searchResultsBuilder.test.js'));
  assert.ok(p.files.includes('src/tools/builtins/browserTools.test.js'));
  assert.ok(p.files.length<files.length);
  assert.equal(p.fullUnit,false);assert.equal(p.swift,false);assert.equal(p.browsers,false);
});
test('reverse closure crosses multiple callers and registered generator/source-reader edges',()=>{
  const source='src/services/search/searchResultsBuilder.js';
  const reverse=new Map(context.reverse);
  reverse.set(source,new Set([...(reverse.get(source)||[]),'fixture/middle.js']));
  reverse.set('fixture/middle.js',new Set(['fixture/outer.js']));
  reverse.set('fixture/outer.js',new Set(['src/fixture.transitive.test.js']));
  const p=planTests([source],[...files,'src/fixture.transitive.test.js'],{...context,reverse});
  assert.ok(p.files.includes('src/fixture.transitive.test.js'));
  const shared=plan('desktop-ui/executionPanel.js');
  assert.ok(shared.files.includes('ios/Tests/SceneBridge.test.js'));
  assert.ok(shared.renderer);
});
test('static, dynamic, re-export and URL references resolve while unknown dynamic readers remain explicit',()=>{
  const p=moduleReferences('// import(fake)\nexport { x } from "./a.js";\nconst b=await import(`./b.js?v=${version}`);\nconst c=new URL("../c.js",import.meta.url);\nawait import(variable);');
  assert.deepEqual(p.refs,['../c.js','./a.js','./b.js']);assert.equal(p.opaque,true);
  assert.equal(moduleReferences('/* import(fake) */\n// import(fake)\nimport("./ok.js")').opaque,false);
});
test('documentation and tooling metadata do not run product/native suites',()=>{
  for(const path of ['AGENTS.md','CLAUDE.md','desktop-ui/features/README.md'])assert.equal(plan(path).files.length,0);
  const p=plan('architecture/modules.json','architecture/module-annotations.json');
  assert.ok(p.files.length>0);assert.ok(p.files.every(path=>path.startsWith('scripts/')));
  assert.ok(p.preflightTests.includes('scripts/generate-module-map.test.js'));
  assert.equal(p.browsers,false);assert.equal(p.ios,false);
});
test('desktop-only CSS and phone resources have different platform plans',()=>{
  const desktop=plan('desktop-ui/surfaceUnify.css');
  assert.equal(desktop.renderer,false);assert.equal(desktop.swift,false);
  const phone=plan('ios/Melo/Scene/scene.css');
  assert.equal(phone.renderer,true);assert.equal(phone.swift,false);
  assert.ok(IOS_JS.every(path=>phone.files.includes(path)));
  assert.ok(phone.files.every(path=>path.startsWith('ios/Tests/')||path==='scripts/generate-module-map.test.js'));
});
test('Swift chooses suites using the exact compiler inputs, including appended shared sources',()=>{
  const p=plan('ios/Melo/EditDraft.swift');
  assert.deepEqual(p.swiftSuites,['EditDraftStorageTests','EditDraftTests']);
  assert.equal(p.renderer,false);assert.equal(p.browsers,false);
  const merge=plan('ios/Melo/DraftMerge.swift');
  assert.ok(merge.swiftSuites.includes('AgentEditTests'));
  assert.ok(merge.swiftSuites.includes('EditDraftTests'));
});
test('core, unknown, deletion, stale maps and missing dependency registration cannot silently shrink',()=>{
  for(const path of ['src/state/stateStore.js','shared/protocol/agent-loop.json','package-lock.json','unknown.config','desktop-ui/deleted.test.js'])assert.equal(plan(path).fullUnit,true,path);
  for(const extra of [{stale:true},{problems:['unregistered edge']},{exists:()=>false},{opaque:['src/services/search/searchResultsBuilder.js']}]) {
    const p=planTests(['src/services/search/searchResultsBuilder.js'],files,{...context,...extra});
    assert.equal(p.fullUnit,true);assert.equal(p.files.length,files.length);
  }
});
test('shared-tree union cannot remove task coverage; new registered files retain feature coverage',()=>{
  const task=plan('desktop-ui/features/agents/view.js');
  const combined=plan('desktop-ui/features/agents/view.js','src/state/stateStore.js');
  assert.ok(task.files.every(path=>combined.files.includes(path)));assert.ok(combined.fullUnit);
  const path='src/services/search/newFeature.js';
  const graph=new Map(context.built.graph);graph.set(path,[]);
  const p=planTests([path],files,{...context,exists:()=>true,built:{...context.built,graph}});
  assert.ok(p.files.includes('src/services/search/searchResultsBuilder.test.js'));
});
test('stages fail cheap first and each JS file is scheduled exactly once',()=>{
  const p=plan('shared/protocol/agent-loop.json');
  const stages=dailyStages({...p,syntax:[],docs:[]});
  const js=stages.filter(s=>s.args.includes('--test'));
  const scheduled=js.flatMap(s=>s.args.filter(arg=>arg.endsWith('.test.js')));
  assert.equal(new Set(scheduled).size,scheduled.length);
  assert.deepEqual([...scheduled].sort(),[...p.files].sort());
  assert.ok(stages.findIndex(s=>s.label==='共享渲染资源预检')<stages.findIndex(s=>s.label==='JS 回归'));
  const swift=stages.find(s=>s.label==='Swift 回归');
  assert.ok(swift.args.includes('--skip-js'));assert.ok(swift.args.includes('--skip-renderer'));
});
test('daily CLI rejects ambiguous task scopes and unknown flags',()=>{
  for(const args of [['--files'],['--files','../outside.js'],['--base','HEAD','--files','README.md'],['--wat'],['--all','--base','HEAD']]) {
    assert.throws(()=>execFileSync(process.execPath,['scripts/verify-daily.js',...args],{stdio:'pipe'}));
  }
});

// Two tiers (2026-10-24): the quick tier replaces "public boundary → every test"
// with the owning feature, the reverse-import closure and the tests that start
// the real server; the integration tier keeps the 2026-10-20 widening.
test('quick tier: a public runtime boundary selects dependents plus real-server tests instead of everything',()=>{
  const quick=planTests(['src/state/stateStore.js'],files,context,{tier:'quick'});
  assert.equal(quick.tier,'quick');assert.equal(quick.fullUnit,false);assert.equal(quick.integrationRequired,true);
  assert.ok(quick.files.length>0&&quick.files.length<files.length,`${quick.files.length} of ${files.length}`);
  assert.ok(context.serverConsumers.length>=20,'the real-server tests are detected from source');
  for(const test of context.serverConsumers)assert.ok(quick.files.includes(test),test);
  assert.ok(quick.files.some(path=>path.startsWith('src/state/')),'the owning feature group is kept');
  const integration=planTests(['src/state/stateStore.js'],files,context);
  assert.equal(integration.tier,'integration');assert.equal(integration.fullUnit,true);
  assert.ok(quick.files.every(path=>integration.files.includes(path)),'quick is a subset of integration');
  assert.match(quick.reason,/快速档/);
});
test('quick tier fails fast on a stale or unregistered map and still widens for the gate itself and deletions',()=>{
  for(const extra of [{stale:true},{problems:['unregistered edge']}]) {
    const p=planTests(['src/services/search/searchResultsBuilder.js'],files,{...context,...extra},{tier:'quick'});
    assert.equal(p.preflightOnly,true);assert.equal(p.fullUnit,false);
    assert.ok(p.files.length>0&&p.files.every(file=>/^scripts\/generate-.*\.test\.js$/.test(file)),JSON.stringify(p.files));
    assert.deepEqual(p.files,p.preflightTests);assert.equal(p.browsers,false);assert.equal(p.swift,false);
    assert.ok(p.reasons.some(reason=>/快速档只跑预检/.test(reason)));
  }
  assert.equal(planTests(['scripts/test-plan.js'],files,context,{tier:'quick'}).fullUnit,true,'the gate itself always widens');
  assert.equal(planTests(['desktop-ui/deleted.test.js'],files,context,{tier:'quick'}).fullUnit,true,'a deleted test always widens');
  assert.equal(planTests(['unknown.config'],files,context,{tier:'quick'}).fullUnit,true,'an unknown boundary always widens');
  const leaf=planTests(['src/services/search/searchResultsBuilder.js'],files,context,{tier:'quick'});
  assert.deepEqual(leaf.files,planTests(['src/services/search/searchResultsBuilder.js'],files,context).files,'a leaf change selects the same tests in both tiers');
  assert.equal(leaf.integrationRequired,true);
  assert.equal(planTests(['docs/design.md'],files,context,{tier:'quick'}).integrationRequired,false);
});
test('server consumers are detected from test sources, never from a hand-kept list',async()=>{
  const detected=await serverConsumers(process.cwd(),['desktop-ui/agentSettings.browser.test.js','scripts/test-run-guards.test.js','scripts/missing.test.js']);
  assert.deepEqual(detected,['desktop-ui/agentSettings.browser.test.js']);
});
