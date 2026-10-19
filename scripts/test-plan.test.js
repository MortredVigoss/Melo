import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planTests, changedPaths, currentTestPlan} from './test-plan.js';
import {TEST_ROOTS} from './test-discovery.js';

const tests = ['src/server.test.js','desktop-ui/one.test.js','desktop-ui/new.test.js','mobile-sync/one.test.js','ios/Tests/Scene.test.js'];
test('Android changes run the native gate and shared assets cover both consumers', () => {
  const native = planTests(['android/app/src/main/java/com/melo/android/device/DeviceAgent.kt'], tests);
  assert.equal(native.android, true); assert.deepEqual(native.files, []);
  assert.equal(native.browsers, false); assert.equal(native.swift, false);
  for (const path of ['shared/protocol/sync.schema.json', 'ios/Melo/Scene/scene.js', 'scripts/android.mjs', '.github/workflows/android.yml']) assert.equal(planTests([path], tests).android, true, path);
  assert.equal(planTests(['src/server.js'], tests).android, false);
  assert.deepEqual(planTests(['MELO_OVERVIEW.md'], tests).files, []);
});
test('daily selection keeps complete UI groups, falls back for cross-boundary changes, and never silently drops deleted tests', () => {
  const ui = planTests(['desktop-ui/one.js'], tests);
  assert.deepEqual(ui.files, tests.filter(f => !f.startsWith('src/') && !f.startsWith('mobile-sync/')));
  assert.equal(ui.browsers, true); assert.equal(ui.ios, true); assert.equal(ui.swift, false);
  for (const path of ['src/shared/example.js','src/services/chat/prompt.js','package-lock.json','scripts/new-tool.js','shared/contract.json','mobile-sync/protocol.js','unknown.config','skills/example/SKILL.md','assets/prompt.txt']) {
    const plan = planTests([path], tests);
    assert.deepEqual(plan.files, tests, path); assert.equal(plan.swift, true); assert.equal(plan.browsers, true);
  }
  assert.deepEqual(planTests(['docs/design.md'],tests).files, []);
  assert.deepEqual(planTests(['desktop-ui/new.test.js'],tests).files,['desktop-ui/new.test.js']);
  assert.deepEqual(planTests(['desktop-ui/deleted.test.js'],tests).files,tests);
  assert.equal(planTests(['ios/Melo/Models.swift'],tests).swift,true);
});
test('change discovery includes staged, unstaged, untracked, deletion and clean last-commit changes', async () => {
  const root = await mkdtemp(join(tmpdir(),'melo-test-plan-'));
  const git = (...args) => execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  try {
    git('init'); git('config','user.email','fixture@example.invalid'); git('config','user.name','Fixture');
    await writeFile(join(root,'first'),'a'); git('add','first'); git('commit','-m','initial');
    assert.equal(currentTestPlan(root,tests).fullUnit,true,'initial commit cannot skip');
    await writeFile(join(root,'second'),'b'); git('add','second'); git('commit','-m','second');
    assert.deepEqual(changedPaths(root).paths,['second']);
    await writeFile(join(root,'first'),'changed'); git('add','first');
    await rm(join(root,'second')); await writeFile(join(root,'third'),'untracked');
    assert.deepEqual(changedPaths(root).paths.sort(),['first','second','third']);
    assert.throws(()=>currentTestPlan(root,tests,'missing-ref'));
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('full gate remains all-tests and daily gate is explicit about release coverage', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(pkg.scripts.test,'node scripts/verify-daily.js');
  assert.equal(pkg.scripts['test:full'],pkg.scripts['verify:red-green']);
  const full=await readFile(new URL('./verify-red-green.js',import.meta.url),'utf8');
  assert.match(full,/runCommand\('npm', \['run', 'test:unit'\]\)/);
  assert.match(full,/runCommand\('npm', \['run', 'check:android'\]\)/);
  assert.doesNotMatch(await readFile(new URL('./run-unit-tests.js',import.meta.url),'utf8'),/currentTestPlan/);
});

test('daily CLI executes the selected group, isolates home, and stops on failure before browser jobs', async () => {
  const root=await mkdtemp(join(tmpdir(),'melo-daily-cli-'));
  const env={...process.env,MELO_HOME:join(root,'must-not-use')};
  // Emulate a shell invocation; Node disables nested --test runners when it
  // inherits the parent test worker's internal context marker.
  delete env.NODE_TEST_CONTEXT;
  const script=fileURLToPath(new URL('./verify-daily.js',import.meta.url));
  const run=()=>execFileSync(process.execPath,[script],{cwd:root,env,encoding:'utf8',stdio:'pipe'});
  const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
  try {
    for(const dir of [...TEST_ROOTS,'ios/scripts']) await mkdir(join(root,dir),{recursive:true});
    await writeFile(join(root,'package.json'),'{"type":"module"}');
    await writeFile(join(root,'scripts/test-quarantine.json'),'{}');
    await writeFile(join(root,'src/unrelated.test.js'),'throw Error("unrelated backend must not run for UI-only edits");');
    const testBody='import test from "node:test"; import assert from "node:assert/strict"; test("isolated",()=>{assert.equal(process.env.MELO_TEST_MODE,"1");assert.ok(!process.env.MELO_HOME.endsWith("must-not-use"));});';
    for(const name of ['one','two']) await writeFile(join(root,`desktop-ui/${name}.test.js`),testBody);
    for(const name of ['check-syntax.js','verify-settings-design.mjs','verify-extra-fast.mjs']) await writeFile(join(root,'scripts',name),`import {appendFileSync} from 'node:fs';appendFileSync('jobs.log', '${name}\\n');`);
    await writeFile(join(root,'ios/scripts/test.py'),"import sys\nfrom pathlib import Path\nassert '--renderer-only' in sys.argv\nwith Path('jobs.log').open('a') as f: f.write('renderer\\n')\n");
    git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    git('add','package.json','src','desktop-ui','scripts','ios');git('commit','-m','fixture');
    await writeFile(join(root,'desktop-ui/changed.js'),'// UI change');
    assert.match(run(),/2\/3 个 JS 测试文件/);
    const jobs=await readFile(join(root,'jobs.log'),'utf8');assert.equal(jobs.trim().split('\n').length,4);
    await rm(join(root,'jobs.log')); // Keep the next Git range confined to UI.
    await writeFile(join(root,'desktop-ui/one.test.js'),'throw Error("deliberate regression");');
    assert.throws(run,error=>error.status===1&&/JS 回归 failed/.test(error.stderr));
    await assert.rejects(readFile(join(root,'jobs.log')), {code:'ENOENT'});
  } finally {await rm(root,{recursive:true,force:true});}
});
