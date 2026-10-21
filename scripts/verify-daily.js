import { createStageRunner } from './test-stage-runner.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { discoverRunnableTests } from './test-discovery.js';
import { currentTestPlan, planTests, isDocOnly } from './test-plan.js';
import { buildTestImpact } from './test-impact.js';
import { dailyStages } from './test-stages.js';

const env = {...process.env};
const root = process.cwd();
const args = process.argv.slice(2);
let base, taskFiles, all=false, preview=false;
for(let i=0;i<args.length;i++) {
  const arg=args[i];
  if(arg==='--plan')preview=true;
  else if(arg==='--all')all=true;
  else if(arg==='--base') {
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
const {files,excluded}=await discoverRunnableTests();
let plan=taskFiles?{...planTests(taskFiles,files),base:'显式任务文件（不代表整个共享工作树）'}:currentTestPlan(root,files,base);
if(all)plan={...planTests([...plan.changed,'package.json'],files),base:'显式完整日常检查'};
const code=plan.changed.filter(path=>!isDocOnly(path));
if(code.some(path=>!path.endsWith('.test.js'))||code.some(path=>!files.includes(path))) {
  let impact=null;
  try {impact=await buildTestImpact(root);} catch(error) {console.warn(`依赖分析不可用，保守扩大：${error.message}`);}
  plan={...planTests(plan.changed,files,impact),base:plan.base};
}
console.log(`日常回归：${plan.files.length}/${files.length} 个 JS 测试文件；${plan.base}；${plan.reason}`);
for(const reason of plan.reasons||[])console.log(`  · ${reason}`);
console.log(`浏览器：${plan.browsers?'设置 + 加速设置':'无'}；渲染：${plan.renderer?'是':'否'}；Swift：${plan.swift?(plan.swiftSuites===null?'全部':plan.swiftSuites.join(', ')):'无'}`);
if(preview) {
  console.log(JSON.stringify({...plan,excluded},null,2));
} else {
  const home=await mkdtemp(join(tmpdir(),'melo-daily-'));
  const started=Date.now();
  const {run}=await createStageRunner({root,env:{...env,MELO_HOME:home,MELO_TEST_MODE:'1'}});
  try {
    for(const [path,entry] of Object.entries(excluded))console.log(`QUARANTINED ${path}: ${entry.reason} (expires ${entry.expires})`);
    for(const stage of dailyStages(plan))await run(stage.label,stage.command,stage.args);
    console.log(`日常选定范围通过 (${((Date.now()-started)/1000).toFixed(1)}s)。${taskFiles?'仅证明显式任务范围；共享树集成另验。':''}发布前运行 npm run test:full，包含全部测试及打包、安装、启动验收。`);
  } catch(error) {console.error(error.message);process.exitCode=1;}
  finally {await rm(home,{recursive:true,force:true});}
}
