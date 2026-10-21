import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {ciChangedPaths,ciJobs} from './ci-test-plan.js';
import {planTests} from './test-plan.js';

test('CI docs use local selection and start no expensive product jobs; runtime docs fail closed',()=>{
  const files=['src/safety/identity.test.js','desktop-ui/chat.test.js'];
  assert.deepEqual(ciJobs(planTests(['README.md','docs/plan.md'],files)),{linux:false,swift:false,safety:false,android:false,full:false,replay:false});
  for(const path of ['skills/example/SKILL.md','src/state/stateStore.js','package.json','scripts/ci-test-plan.js']) {
    const jobs=ciJobs(planTests([path],files));
    for(const key of ['linux','swift','safety','android','full'])assert.equal(jobs[key],true,`${path}: ${key}`);
  }
});

test('CI range includes entire push, PR merge base and both sides of rename; missing history widens',async()=>{
  const root=await mkdtemp(join(tmpdir(),'melo-ci-range-'));
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:'pipe'}).trim();
  try {
    git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    await writeFile(join(root,'old.js'),'one');git('add','old.js');git('commit','-m','base');const base=git('rev-parse','HEAD');
    git('mv','old.js','new.js');git('commit','-m','rename');
    await writeFile(join(root,'README.md'),'new');git('add','README.md');git('commit','-m','docs');
    for(const [kind,event] of [['push',{before:base}],['pull_request',{pull_request:{base:{sha:base}}}]])assert.deepEqual(ciChangedPaths(root,kind,event).sort(),['README.md','new.js','old.js']);
    for(const [kind,event] of [['push',{before:'0'.repeat(40)}],['push',{before:'f'.repeat(40)}],['workflow_dispatch',{}]])assert.deepEqual(ciChangedPaths(root,kind,event),['package.json']);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('each CI workflow plans before setup and propagates plan failure into existing gates',async()=>{
  for(const name of ['verification','file-safety','android']) {
    const source=await readFile(new URL(`../.github/workflows/${name}.yml`,import.meta.url),'utf8');
    assert.match(source,/run: node scripts\/ci-test-plan.js/);
    assert.match(source,/needs: plan/);
    assert.match(source,/always\(\) && \(needs.plan.result != 'success'/);
    assert.match(source,/test "\$\{\{ needs.plan.result \}\}" = success/);
    assert.match(source,/fetch-depth: 0/);
    assert.doesNotMatch(source,/continue-on-error/);
    assert.match(source,/cancel-in-progress: true/);
  }
});
