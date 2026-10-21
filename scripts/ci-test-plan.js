import { execFileSync } from 'node:child_process';
import { readFile, writeFile, appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { planTests } from './test-plan.js';
import { buildTestImpact } from './test-impact.js';
import { discoverRunnableTests } from './test-discovery.js';
import { dailyStages } from './test-stages.js';
import { createStageRunner } from './test-stage-runner.js';

export function ciChangedPaths(root, eventName, event) {
  const git = args => execFileSync('git', args, {cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  // Manual/initial/missing history must run all checks, never a guessed range.
  if(!['push','pull_request'].includes(eventName))return ['package.json'];
  const base = eventName==='pull_request' ? event.pull_request?.base?.sha : event.before;
  if(!/^[a-f0-9]{40}$/i.test(base||'')||/^0+$/.test(base))return ['package.json'];
  try {
    const start=eventName==='pull_request' ? git(['merge-base',base,'HEAD']).trim() : base;
    return git(['diff','--no-renames','--name-only','-z',start,'HEAD','--']).split('\0').filter(Boolean);
  } catch { return ['package.json']; }
}

export function ciJobs(plan) {
  return {
    linux: Boolean(plan.files.length||plan.syntax===null||plan.syntax.length||plan.browsers||plan.renderer),
    swift: Boolean(plan.swift||plan.files.includes('scripts/native-shutdown.test.js')),
    safety: Boolean(plan.fullUnit||plan.files.some(p=>p.startsWith('src/safety/')||p==='src/tools/builtins/phase2a.fileTools.test.js')),
    android: Boolean(plan.android||plan.fullUnit),
    full: Boolean(plan.fullUnit),
    replay: Boolean(plan.fullUnit||plan.swiftSuites?.includes('SharedAgentCoreTests')),
  };
}

export async function createCIPlan(root, eventName, event) {
  const changed=ciChangedPaths(root,eventName,event);
  const {files}=await discoverRunnableTests(root);
  const provisional=planTests(changed,files);
  const impact=provisional.docs.length===changed.length ? null : await buildTestImpact(root);
  const plan=planTests(changed,files,impact);
  return {plan,jobs:ciJobs(plan)};
}

async function main() {
  const mode=process.argv[2]||'plan';
  if(!['plan','linux','swift'].includes(mode)||process.argv.length>3)throw Error('Usage: ci-test-plan.js [plan|linux|swift]');
  const root=process.cwd(), env={...process.env};
  const event=JSON.parse(await readFile(env.GITHUB_EVENT_PATH,'utf8'));
  const {plan,jobs}=await createCIPlan(root,env.GITHUB_EVENT_NAME,event);
  await mkdir(resolve(root,'.tmp/ci'),{recursive:true});
  await writeFile(resolve(root,`.tmp/ci/plan-${mode}.json`),JSON.stringify({plan,jobs},null,2)+'\n');
  console.log(JSON.stringify({changed:plan.changed,jsFiles:plan.files.length,jobs,reasons:plan.reasons}));
  if(mode==='plan') {
    if(env.GITHUB_OUTPUT)await appendFile(env.GITHUB_OUTPUT,Object.entries(jobs).map(([k,v])=>`${k}=${v}\n`).join(''));
    // Cheap documentation validation runs even if every product job is omitted.
    if(plan.docs.length)execFileSync(process.execPath,['scripts/check-doc-links.js',...plan.docs],{cwd:root,stdio:'inherit'});
    return;
  }
  const home=await mkdtemp(join(tmpdir(),'melo-ci-'));
  try {
    const runner=await createStageRunner({root,env:{...env,MELO_HOME:home,MELO_TEST_MODE:'1'}});
    const stages=dailyStages({...plan,docs:[],android:false});
    for(const stage of stages) {
      const swift=stage.label==='Swift 回归';
      if((mode==='swift')===swift)await runner.run(stage.label,stage.command,stage.args);
    }
    if(mode==='swift'&&plan.files.includes('scripts/native-shutdown.test.js'))await runner.run('macOS native shell lifecycle',process.execPath,['--test','scripts/native-shutdown.test.js']);
  } finally {await rm(home,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error);process.exitCode=1;});
