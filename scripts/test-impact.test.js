import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {buildTestImpact, moduleReferences, serverConsumers, IOS_JS} from './test-impact.js';
import {planTests} from './test-plan.js';
import {dailyStages, platformStages, stageBatches} from './test-stages.js';
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
  // The regression runs through the weighted pool (2026-11-14); the preflight stays a plain `node --test`.
  const js=stages.filter(s=>s.args.includes('--test')||/run-test-pool\.js$/.test(s.args[0]));
  const scheduled=js.flatMap(s=>s.args.filter(arg=>arg.endsWith('.test.js')));
  assert.equal(new Set(scheduled).size,scheduled.length);
  assert.deepEqual([...scheduled].sort(),[...p.files].sort());
  assert.ok(stages.findIndex(s=>s.label==='共享渲染资源预检')<stages.findIndex(s=>s.label==='JS 回归'));
  const swift=stages.find(s=>s.label==='Swift 回归');
  assert.ok(swift.args.includes('--skip-js'));assert.ok(swift.args.includes('--skip-renderer'));
});
test('the Android build and the Swift compile run together; the Swift suites and the JS regression each run alone',()=>{
  const p=plan('shared/protocol/agent-loop.json');
  const stages=dailyStages({...p,syntax:null,docs:['PROGRESS.md']});
  const labels=stages.map(s=>s.label);
  assert.deepEqual(labels,['语法检查','文档链接检查','生成器与依赖预检','共享渲染资源预检','Android JVM / Lint / Debug / Release','Swift 编译','Swift 回归','JS 回归','设置浏览器验收']);
  const batches=stageBatches(stages).map(batch=>batch.map(s=>s.label));
  assert.deepEqual(batches,[['语法检查'],['文档链接检查'],['生成器与依赖预检'],['共享渲染资源预检'],['Android JVM / Lint / Debug / Release','Swift 编译'],['Swift 回归'],['JS 回归'],['设置浏览器验收']]);
  // The compile step compiles the same suites and runs none; the run step is the same command without the flag.
  const compile=stages.find(s=>s.label==='Swift 编译'), run=stages.find(s=>s.label==='Swift 回归');
  assert.deepEqual(compile.args,[...run.args,'--compile-only']);assert.equal(run.group,undefined,'suites that assert on timing never share the machine with a build');
  // Without an Android build there is nothing to overlap with: no separate compile step, and the suites still run alone.
  const alone=dailyStages({...p,syntax:[],docs:[],android:false});
  assert.ok(!alone.some(s=>s.label==='Swift 编译'));
  assert.deepEqual(stageBatches(alone).map(batch=>batch.map(s=>s.label)).filter(batch=>batch.includes('Swift 回归')),[['Swift 回归']]);
  assert.deepEqual(stageBatches([{label:'a',group:'x'},{label:'b'},{label:'c',group:'x'}]).map(batch=>batch.map(s=>s.label)),[['a'],['b'],['c']],'only neighbours are batched');
});
test('a generated bundle, an Android path beside JS and the progress snapshot are known paths, not unknown boundaries',()=>{
  const quick=(...paths)=>planTests(paths,files,context,{tier:'quick'});
  // The phone's copy of the shared core is the output of a registered generator.
  const bundle=quick('ios/Melo/AgentCore/agent-core.js','ios/Melo/AgentCore/manifest.json');
  assert.equal(bundle.fullUnit,false);
  assert.ok(bundle.files.includes('shared/agent/conformance.test.js'),'the consistency check runs');
  assert.equal(bundle.swift,true);assert.equal(bundle.swiftSuites,null,'every Swift suite loads the bundle');
  // A change to the shared core with its regenerated bundles: the quick tier follows the boundary …
  const core=['shared/agent/goal.js','shared/agent/dist/agent-core.js','shared/agent/dist/manifest.json','ios/Melo/AgentCore/agent-core.js','ios/Melo/AgentCore/manifest.json'];
  const narrowed=quick(...core);
  assert.equal(narrowed.fullUnit,false);assert.ok(narrowed.files.length<files.length);
  assert.ok(planTests(['shared/agent/goal.js'],files,context,{tier:'quick'}).files.every(path=>narrowed.files.includes(path)),'nothing the sources select is lost');
  assert.equal(narrowed.android,true);assert.equal(narrowed.swiftSuites,null);
  // … and the integration tier still runs everything for it.
  assert.equal(plan(...core).fullUnit,true);
  // An Android path next to a JS change keeps both plans.
  const ui=plan('desktop-ui/features/chat/controller.js');
  const mixed=plan('android/scripts/import-pet-skins.mjs','desktop-ui/features/chat/controller.js');
  assert.equal(mixed.fullUnit,false);assert.equal(mixed.android,true);
  assert.ok(ui.files.every(path=>mixed.files.includes(path)));
  assert.ok(mixed.files.some(path=>/^scripts\/android.*\.test\.js$/.test(path)));
  assert.ok(dailyStages(mixed).some(stage=>stage.label.startsWith('Android ')));
  // The snapshot `npm run progress:codex` writes is documentation.
  const snapshot=plan('codex.md','PROGRESS.md','MELO_DEVELOPMENT_STANDARD.md');
  assert.equal(snapshot.files.length,0);assert.equal(snapshot.fullUnit,false);
  // A developer script outside the gate: its test group in the quick tier, everything in the integration tier.
  const script=quick('scripts/bench-turn.js');
  assert.equal(script.fullUnit,false);assert.ok(script.files.includes('scripts/scope.test.js'));assert.ok(script.files.every(path=>path.startsWith('scripts/')||path==='scripts/generate-module-map.test.js'),JSON.stringify(script.files.filter(path=>!path.startsWith('scripts/'))));
  assert.equal(plan('scripts/bench-turn.js').fullUnit,true);
  // The gate's own pieces always widen, in both tiers.
  for(const path of ['scripts/test-pool.js','scripts/run-test-pool.js','scripts/test-tap-summary.js','scripts/check-syntax.js'])assert.equal(quick(path).fullUnit,true,path);
  // A path nobody registered is still unknown.
  assert.equal(plan('unknown.config').fullUnit,true);
  assert.equal(plan('ios/Melo/unregistered.bin').fullUnit,true);
});

test('quick tier: a path the map does not know selects what names it and the tests beside it; the integration tier still widens',()=>{
  const quick=(...paths)=>planTests(paths,files,context,{tier:'quick'});
  // The settings acceptance script is its own check.
  const acceptance=quick('scripts/verify-settings-design.mjs');
  assert.equal(acceptance.fullUnit,false);assert.equal(acceptance.browsers,true);
  assert.ok(dailyStages(acceptance).some(stage=>stage.label==='设置浏览器验收'));
  assert.equal(plan('scripts/verify-settings-design.mjs').fullUnit,true,'the integration tier is unchanged');
  // An iPhone project file, UI test or build script: every Swift suite instead of every JS test.
  for(const path of ['ios/Melo.xcodeproj/project.pbxproj','ios/UITests/ConnectionSaveTests.swift','ios/scripts/generate-project.py']) {
    const selected=quick(path);
    assert.equal(selected.fullUnit,false,path);assert.equal(selected.swift,true,path);assert.equal(selected.swiftSuites,null,path);
    assert.ok(selected.files.length<files.length/4,`${path}: ${selected.files.length}`);
    assert.equal(selected.integrationRequired,true,path);
    assert.equal(plan(path).fullUnit,true,`${path} still widens in the integration tier`);
  }
  // A fixture selects the tests of the directory that holds it.
  const fixture=quick('mobile-sync/fixtures/agent-settings.json');
  assert.equal(fixture.fullUnit,false);
  assert.ok(files.filter(path=>/^mobile-sync\/[^/]+\.test\.js$/.test(path)).every(path=>fixture.files.includes(path)));
  // The Mac shell source selects the tests that name it.
  const shell=quick('desktop-app/main.swift');
  assert.equal(shell.fullUnit,false);
  for(const reader of ['scripts/native-shutdown.test.js','scripts/desktop-server-lifecycle.test.js'])assert.ok(shell.files.includes(reader),reader);
  // Beside a real change nothing that change selects is lost.
  const real=quick('src/services/chat/sendChatMessage.js'), mixed=quick('src/services/chat/sendChatMessage.js','ios/Melo.xcodeproj/project.pbxproj','assets/melo-icon.png');
  assert.equal(mixed.fullUnit,false);assert.ok(real.files.every(path=>mixed.files.includes(path)));assert.equal(mixed.swiftSuites,null);
  // A change that selects nothing at all, a deletion and the gate itself still run everything.
  // (The name is assembled here: written out, this very file would name it and be selected.)
  assert.equal(quick(['.git','ignore'].join('')).fullUnit,true,'nothing names it, so nothing would run');
  assert.equal(quick('no/such/file.bin').fullUnit,true);
  assert.equal(quick('scripts/test-impact.js','assets/melo-icon.png').fullUnit,true);
  // Without the reference search (a context built by an older caller) the path is unknown as before.
  assert.equal(planTests(['ios/Melo.xcodeproj/project.pbxproj'],files,{...context,readers:undefined},{tier:'quick'}).fullUnit,true);
  // Receipts under docs/evidence are documentation.
  const receipt=plan('docs/evidence/agent-core-audit-20261017.json','docs/testing-workflow.md');
  assert.equal(receipt.files.length,0);assert.equal(receipt.fullUnit,false);
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

test('audit inventories select tooling checks without forcing product regressions', () => {
  for (const tier of ['quick', 'integration']) {
    const p = planTests(['docs/audit/inventory-2026-10-26.json', 'docs/audit/diff.json'], files, context, {tier});
    assert.equal(p.fullUnit, false);
    assert.equal(p.swift, false);
    assert.ok(p.files.includes('scripts/audit-inventory.test.js'));
    assert.ok(p.files.includes('scripts/ci-audit-inventory.test.js'));
    assert.ok(p.files.every(path => path.startsWith('scripts/')));
    assert.equal(planTests(['docs/audit/runtime-config.json'], files, context, {tier}).fullUnit, true);
  }
});

// Review finding 3 (2026-10-26): a Linux container cannot run Swift or Android
// stages; they are reported as not executed on that platform, never dropped
// silently and never counted as passed.
test('platform stages: linux reports Swift and Android as not executed, darwin keeps every stage',()=>{
  const p=plan('shared/protocol/agent-loop.json');
  const darwin=platformStages({...p,syntax:[],docs:[]},'darwin');
  assert.deepEqual(darwin.skipped,[]);assert.deepEqual(darwin.stages,dailyStages({...p,syntax:[],docs:[]}));
  const linux=platformStages({...p,syntax:[],docs:[]},'linux');
  assert.ok(linux.skipped.includes('Swift 回归'));assert.ok(linux.skipped.some(label=>label.startsWith('Android ')));
  assert.ok(linux.skipped.includes('Swift 编译'),'the compile step needs Xcode as well');
  assert.ok(!linux.stages.some(stage=>stage.label.startsWith('Swift ')||stage.label.startsWith('Android ')));
  assert.ok(linux.stages.some(stage=>stage.label==='JS 回归'),'JS still runs on linux');
  assert.equal(linux.stages.length+linux.skipped.length,darwin.stages.length);
});
