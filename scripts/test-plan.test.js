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
test('missing dependency context conservatively expands runtime changes, and never silently drops deleted tests', () => {
  const ui = planTests(['desktop-ui/one.js'], tests);
  assert.deepEqual(ui.files, tests);
  assert.equal(ui.browsers, true); assert.equal(ui.ios, true); assert.equal(ui.swift, true);
  for (const path of ['src/shared/example.js','src/services/chat/prompt.js','package-lock.json','scripts/new-tool.js','shared/contract.json','mobile-sync/protocol.js','unknown.config','skills/example/SKILL.md','assets/prompt.txt']) {
    const plan = planTests([path], tests);
    assert.deepEqual(plan.files, tests, path); assert.equal(plan.swift, true); assert.equal(plan.browsers, true);
  }
  assert.deepEqual(planTests(['docs/design.md'],tests).files, []);
  assert.deepEqual(planTests(['desktop-ui/new.test.js'],tests).files,['desktop-ui/new.test.js']);
  assert.deepEqual(planTests(['desktop-ui/deleted.test.js'],tests).files,tests);
  assert.equal(planTests(['ios/Melo/Models.swift'],tests).swift,true);
});
test('registered explanation-only documents run only the link check; runtime-read Markdown stays a code change', () => {
  const docs = ['MELO_OVERVIEW.md','AGENTS.md','CHANGELOG.md','ios/README.md','ios/VERIFICATION.md','docs/handoffs/overview-history-20261019.md','docs/handoffs/evidence/receipt.json'];
  for (const path of docs) {
    const plan = planTests([path], tests);
    assert.deepEqual(plan.files, [], path);
    assert.equal(plan.fullUnit, false, path);
    assert.equal(plan.browsers, false, path); assert.equal(plan.ios, false, path); assert.equal(plan.swift, false, path);
    assert.deepEqual(plan.syntax, [], path);
    assert.deepEqual(plan.docs, path.endsWith('.md') ? [path] : [], path);
    assert.match(plan.reason, /仅文档变化/, path);
  }
  const together = planTests(docs, tests);
  assert.deepEqual(together.files, []); assert.equal(together.swift, false);
  // Markdown read at runtime (skills/personas), bundled into an app or kept as
  // a protocol fixture is not an explanation file and keeps the full gate.
  for (const path of ['src/agents/personas/default.md','mobile-sync/fixtures/v1/README.md','skills/example/SKILL.md']) {
    const plan = planTests([path], tests);
    assert.deepEqual(plan.files, tests, path); assert.equal(plan.fullUnit, true, path);
    assert.equal(plan.swift, true, path); assert.deepEqual(plan.docs, [], path);
  }
  // Inside the app source folder a README is bundled-candidate code: the iOS group still runs.
  const bundled = planTests(['ios/Melo/README.md'], tests);
  assert.deepEqual(bundled.files, tests); assert.equal(bundled.swift, true); assert.deepEqual(bundled.docs, []);
  // A document beside a code change is still link-checked; the code decides the tier.
  const mixed = planTests(['MELO_OVERVIEW.md','src/services/project/projectMutations.js'], tests);
  assert.deepEqual(mixed.files, tests); assert.deepEqual(mixed.docs, ['MELO_OVERVIEW.md']);
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
    await mkdir(join(root,'nested'));
    assert.throws(()=>changedPaths(join(root,'nested')), /not the Git worktree root/);
    assert.equal(currentTestPlan(join(root,'nested'),tests).fullUnit,true);
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
  const run=()=>execFileSync(process.execPath,[script,'--files','desktop-ui/one.test.js','desktop-ui/two.test.js'],{cwd:root,env,encoding:'utf8',stdio:'pipe'});
  const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
  try {
    for(const dir of [...TEST_ROOTS,'ios/scripts']) await mkdir(join(root,dir),{recursive:true});
    await writeFile(join(root,'package.json'),'{"type":"module"}');
    await writeFile(join(root,'scripts/test-quarantine.json'),'{}');
    await writeFile(join(root,'src/unrelated.test.js'),'throw Error("unrelated backend must not run for UI-only edits");');
    const testBody='import test from "node:test"; import assert from "node:assert/strict"; test("isolated",()=>{assert.equal(process.env.MELO_TEST_MODE,"1");assert.ok(!process.env.MELO_HOME.endsWith("must-not-use"));});';
    for(const name of ['one','two']) await writeFile(join(root,`desktop-ui/${name}.test.js`),testBody);
    for(const name of ['check-syntax.js','verify-settings-design.mjs']) await writeFile(join(root,'scripts',name),`import {appendFileSync} from 'node:fs';appendFileSync('jobs.log', '${name}\\n');`);
    await writeFile(join(root,'ios/scripts/test.py'),"import sys\nfrom pathlib import Path\nassert '--renderer-only' in sys.argv\nwith Path('jobs.log').open('a') as f: f.write('renderer\\n')\n");
    git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    git('add','package.json','src','desktop-ui','scripts','ios');git('commit','-m','fixture');
    await writeFile(join(root,'desktop-ui/changed.js'),'// UI change');
    assert.match(run(),/2\/3 个 JS 测试文件/);
    const jobs=await readFile(join(root,'jobs.log'),'utf8');assert.equal(jobs.trim().split('\n').length,1);
    await rm(join(root,'jobs.log')); // Keep the next Git range confined to UI.
    await writeFile(join(root,'desktop-ui/one.test.js'),'throw Error("deliberate regression");');
    assert.throws(run,error=>error.status===1&&/JS 回归 failed/.test(error.stderr));
    assert.equal((await readFile(join(root,'jobs.log'),'utf8')).trim(),'check-syntax.js', 'syntax preflight may run; browser jobs must not');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('daily CLI runs only the document link check for an overview-only change', async () => {
  const root=await mkdtemp(join(tmpdir(),'melo-daily-docs-'));
  const env={...process.env,MELO_HOME:join(root,'must-not-use')};
  delete env.NODE_TEST_CONTEXT;
  const script=fileURLToPath(new URL('./verify-daily.js',import.meta.url));
  const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
  try {
    for(const dir of [...TEST_ROOTS,'ios/scripts']) await mkdir(join(root,dir),{recursive:true});
    await writeFile(join(root,'package.json'),'{"type":"module"}');
    await writeFile(join(root,'scripts/test-quarantine.json'),'{}');
    await writeFile(join(root,'desktop-ui/ui.test.js'),'throw Error("documentation edits must not run product tests");');
    for(const name of ['check-syntax.js','verify-settings-design.mjs','check-doc-links.js']) await writeFile(join(root,'scripts',name),`import {appendFileSync} from 'node:fs';appendFileSync('jobs.log', ['${name}',...process.argv.slice(2)].join(' ')+'\\n');`);
    await writeFile(join(root,'ios/scripts/test.py'),"from pathlib import Path\nwith Path('jobs.log').open('a') as f: f.write('ios\\n')\n");
    await writeFile(join(root,'MELO_OVERVIEW.md'),'# old\n');
    git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    git('add','.');git('commit','-m','fixture');
    await writeFile(join(root,'MELO_OVERVIEW.md'),'# new\n');
    const output=execFileSync(process.execPath,[script],{cwd:root,env,encoding:'utf8',stdio:'pipe'});
    assert.match(output,/0\/1 个 JS 测试文件/);
    assert.equal((await readFile(join(root,'jobs.log'),'utf8')).trim(),'check-doc-links.js MELO_OVERVIEW.md');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('a failed resource preflight stops the real CLI before JS, browser or Swift execution', async()=>{
  const root=await mkdtemp(join(tmpdir(),'melo-preflight-cli-'));
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const script=fileURLToPath(new URL('./verify-daily.js',import.meta.url));
  try {
    for(const dir of ['src','desktop-ui','scripts','mobile-sync','ios/Tests','ios/scripts'])await mkdir(join(root,dir),{recursive:true});
    await writeFile(join(root,'package.json'),'{"type":"module"}');
    await writeFile(join(root,'scripts/test-quarantine.json'),'{}');
    await writeFile(join(root,'src/marker.test.js'),"import {writeFileSync} from 'node:fs';writeFileSync('must-not-run','JS ran');");
    await writeFile(join(root,'scripts/check-syntax.js'),'// fixture syntax already checked');
    for(const name of ['verify-settings-design.mjs'])await writeFile(join(root,'scripts',name),"import {writeFileSync} from 'node:fs';writeFileSync('must-not-run','browser ran');");
    await writeFile(join(root,'ios/scripts/test.py'),"import sys\nfrom pathlib import Path\nassert '--check-renderer' in sys.argv\nPath('preflight-ran').write_text('1')\nraise SystemExit(1)\n");
    assert.throws(()=>execFileSync(process.execPath,[script,'--files','package.json'],{cwd:root,env,encoding:'utf8',stdio:'pipe'}),error=>error.status===1&&/共享渲染资源预检 failed/.test(error.stderr));
    assert.equal(await readFile(join(root,'preflight-ran'),'utf8'),'1');
    await assert.rejects(readFile(join(root,'must-not-run')),{code:'ENOENT'});
  } finally {await rm(root,{recursive:true,force:true});}
});

test('Android integration selects native checks and shared Core changes include Android', () => {
  const native = planTests(['android/app/src/main/java/com/melo/android/device/DeviceAgent.kt'], tests);
  assert.equal(native.android, true); assert.equal(native.swift, false); assert.equal(native.browsers, false);
  for (const path of ['shared/agent/turn.js', 'shared/protocol/sync.schema.json', 'ios/Melo/Scene/scene.js', 'scripts/android.mjs', '.github/workflows/android.yml']) assert.equal(planTests([path], tests).android, true, path);
  assert.equal(planTests(['src/server.js'], tests).android, false);
});
