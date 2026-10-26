import { createStageRunner } from './test-stage-runner.js';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, loadavg, cpus } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { discoverRunnableTests } from './test-discovery.js';
import { currentTestPlan, planTests, isDocOnly } from './test-plan.js';
import { buildTestImpact } from './test-impact.js';
import { dailyStages } from './test-stages.js';
import { parseTapSummary, isolatedRerunFiles, describeFailures } from './test-tap-summary.js';
import { acquireTestLock, waitForLoad } from './test-run-guards.js';

// Two tiers (2026-10-24): `--files` runs the quick tier (one change, its
// dependents and the real-server tests when a public boundary moved); `--base`,
// no arguments and `--all` run the integration tier (the shared-tree rules,
// public boundaries widen). `--full` forces the integration tier for `--files`,
// `--quick` the quick tier for a range. A quick result never certifies the
// shared tree: the summary says `integrationRequired` and the merge step runs
// the integration tier once.
const env = {...process.env};
const root = process.cwd();
const args = process.argv.slice(2);
let base, taskFiles, all=false, preview=false, tierFlag;
for(let i=0;i<args.length;i++) {
  const arg=args[i];
  if(arg==='--plan')preview=true;
  else if(arg==='--all')all=true;
  else if(arg==='--full'||arg==='--quick') {
    if(tierFlag)throw Error('Use only one of --full or --quick');
    tierFlag=arg==='--full'?'integration':'quick';
  } else if(arg==='--base') {
    if(base!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw Error('--base requires one Git ref');
    base=args[++i];
  } else if(arg==='--files') {
    if(taskFiles)throw Error('--files may only be specified once');
    taskFiles=[];
    while(args[i+1]&&!args[i+1].startsWith('--')) {
      const path=relative(root,resolve(root,args[++i]));
      if(!path||path==='..'||path.startsWith('../')||isAbsolute(path))throw Error('--files paths must be files inside the repository');
      taskFiles.push(path);
    }
    if(!taskFiles.length)throw Error('--files requires at least one path');
  } else throw Error(`Unknown option: ${arg}`);
}
if([base!==undefined,Boolean(taskFiles),all].filter(Boolean).length>1)throw Error('Use only one of --base, --files or --all');
if(all&&tierFlag==='quick')throw Error('--all is always the integration tier');
const tier=all?'integration':tierFlag||(taskFiles?'quick':'integration');
const options={tier};
const {files,excluded}=await discoverRunnableTests();
let plan=taskFiles?{...planTests(taskFiles,files,null,options),base:'显式任务文件（不代表整个共享工作树）'}:currentTestPlan(root,files,base,null,options);
if(all)plan={...planTests([...plan.changed,'package.json'],files),base:'显式完整日常检查'};
const code=plan.changed.filter(path=>!isDocOnly(path));
if(code.some(path=>!path.endsWith('.test.js'))||code.some(path=>!files.includes(path))) {
  let impact=null;
  try {impact=await buildTestImpact(root);} catch(error) {console.warn(`依赖分析不可用，保守扩大：${error.message}`);}
  plan={...planTests(plan.changed,files,impact,all?{}:options),base:plan.base};
}
const tierLabel=(plan.tier==='quick'?'快速档（只证明改动影响面）':'集成档（共享树规则）')+(plan.fullUnit?'，已扩大到全部':'');
console.log(`日常回归 · ${tierLabel}：${plan.files.length}/${files.length} 个 JS 测试文件；${plan.base}；${plan.reason}`);
for(const reason of plan.reasons||[])console.log(`  · ${reason}`);
console.log(`浏览器：${plan.browsers?'设置':'无'}；渲染：${plan.renderer?'是':'否'}；Swift：${plan.swift?(plan.swiftSuites===null?'全部':plan.swiftSuites.join(', ')):'无'}`);
if(plan.integrationRequired)console.log('  ⚠ 快速档结果不代表共享树；合并前运行一次 npm test -- --base <该批开始前的提交>');
if(preview) {
  console.log(JSON.stringify({...plan,excluded},null,2));
} else {
  // Nested runs (the gate's own fixtures, CI) skip the machine guards.
  const nested=env.MELO_TEST_NESTED==='1'||env.CI==='true';
  const number=(value,fallback)=>Number.isFinite(Number(value))&&value!==undefined&&value!==''?Number(value):fallback;
  const lock=nested?{acquired:false,waitedMs:0,holder:null,release:()=>{}}:await acquireTestLock({waitMs:number(env.MELO_TEST_LOCK_WAIT_MS,10*60_000),label:`${tierLabel} ${root}`});
  if(lock.holder&&lock.waitedMs>0)console.log(`等待了 ${Math.round(lock.waitedMs/1000)} s：另一套测试正在运行（pid ${lock.holder.pid}${lock.holder.label?' · '+lock.holder.label:''}）${lock.acquired?'，已接手':'，等待超时后继续'}`);
  const load=nested?{waitedMs:0,samples:[loadavg()[0]],exceeded:false}:await waitForLoad({max:number(env.MELO_TEST_LOAD_MAX,cpus().length*1.5),waitMs:number(env.MELO_TEST_LOAD_WAIT_MS,5*60_000),emit:console.log});
  const home=await mkdtemp(join(tmpdir(),'melo-daily-'));
  const started=Date.now();
  const runner=await createStageRunner({root,env:{...env,MELO_HOME:home,MELO_TEST_MODE:'1',MELO_TEST_NESTED:'1'}});
  const summary={version:1,tier:plan.tier,base:plan.base,reason:plan.reason,reasons:plan.reasons||[],selected:plan.files.length,total:files.length,integrationRequired:Boolean(plan.integrationRequired),
    stages:[],js:null,flaky:null,lock:{waitedMs:lock.waitedMs,acquired:lock.acquired},load:{atStart:load.samples.at(-1),waitedMs:load.waitedMs,exceeded:load.exceeded},ok:false,elapsedSeconds:0,directory:runner.directory};
  const writeSummary=async()=>{summary.elapsedSeconds=Number(((Date.now()-started)/1000).toFixed(1));await writeFile(join(runner.directory,'summary.json'),JSON.stringify(summary,null,2)+'\n');};
  const record=stage=>summary.stages.push({label:stage.label,code:stage.code,seconds:Number(stage.seconds.toFixed(2)),log:stage.log});
  try {
    for(const [path,entry] of Object.entries(excluded))console.log(`QUARANTINED ${path}: ${entry.reason} (expires ${entry.expires})`);
    for(const stage of dailyStages(plan)) {
      if(stage.label!=='JS 回归') {record(await runner.run(stage.label,stage.command,stage.args));continue;}
      const result=await runner.run(stage.label,stage.command,stage.args,{allowFailure:true});
      record(result);
      const tap=parseTapSummary(await readFile(result.log,'utf8'));
      summary.js={tests:tap.tests,pass:tap.pass,fail:tap.fail,cancelled:tap.cancelled,skipped:tap.skipped,failures:describeFailures(tap,root)};
      if(!result.code)continue;
      // One isolated rerun, only when every failure is timeout class (load),
      // recorded as its own stage. A real failure stops here.
      const rerun=env.MELO_TEST_NO_RERUN==='1'?null:isolatedRerunFiles(tap,root);
      if(!rerun) {console.log(result.tail);throw Error(`${stage.label} failed (${result.code})`);}
      console.log(`⚠ ${rerun.length} 个测试文件只有超时类失败（负载 ${loadavg()[0].toFixed(1)}），串行隔离复测一次：${rerun.join(', ')}`);
      const again=await runner.run('JS 隔离复测',process.execPath,['--test','--test-concurrency=1','--test-timeout=120000',...rerun],{allowFailure:true});
      record(again);
      const retap=parseTapSummary(await readFile(again.log,'utf8'));
      summary.flaky={files:rerun,loadAtFailure:Number(loadavg()[0].toFixed(2)),passed:!again.code,failures:describeFailures(retap,root)};
      if(again.code) {console.log(again.tail);throw Error(`JS 隔离复测 failed (${again.code})：超时类失败在空载下仍复现`);}
      console.log(`⚠ 隔离复测通过；首轮失败记为负载超时（见 summary.json flaky），不代表这些测试没有真实问题时也会通过`);
    }
    summary.ok=true;
    await writeSummary();
    console.log(`日常选定范围通过 (${summary.elapsedSeconds}s)。${plan.tier==='quick'?'快速档只证明显式任务范围；合并前运行集成档 npm test -- --base <ref>。':taskFiles?'仅证明显式任务范围；共享树集成另验。':''}完整验证运行 npm run test:full（不安装）；仅在明确授权发布时运行 npm run release:verify，包含安装与正式启动验收。`);
    console.log(`摘要：${join(runner.directory,'summary.json')}`);
  } catch(error) {
    await writeSummary();
    if(summary.js?.failures?.length)for(const line of summary.js.failures)console.error(`  ✗ ${line}`);
    console.error(error.message);
    console.error(`摘要：${join(runner.directory,'summary.json')}`);
    process.exitCode=1;
  } finally {lock.release();await rm(home,{recursive:true,force:true});}
}
