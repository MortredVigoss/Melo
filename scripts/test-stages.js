import { fileURLToPath } from 'node:url';

// The pool script is addressed by its own location: the gate also runs with a
// fixture directory as the working directory.
const POOL=fileURLToPath(new URL('./run-test-pool.js',import.meta.url));

// One execution owner per check: generator tests are removed from JS, and the
// Python phase only runs Swift. Standalone test:ios still covers all three.
//
// Order (2026-11-14): cheap preflights, then the two native builds, then the
// Swift suites, then the JS regression, then the settings browser journey.
// Stages that share a `group` may run at the same time: Android (Gradle) and the
// Swift compile (swiftc) do not touch each other's inputs. Nothing that measures
// time runs next to a compiler: the Swift suites run after both builds (run
// beside Gradle, a suite that expects two tasks to start in spawn order failed
// once in four runs), and JS runs after that (a compiler beside the browser and
// real-server tests is what used to turn them into timeouts).
export function dailyStages(plan) {
  const stages=[];
  const node=(label,args,extra={})=>stages.push({label,command:process.execPath,args,...extra});
  const js=(label,files)=>{if(files.length)node(label,['--test','--test-concurrency=4','--test-timeout=120000',...files]);};
  if(plan.syntax===null||plan.syntax.length)node('语法检查',['scripts/check-syntax.js',...(plan.syntax===null?[]:['--files',...plan.syntax])]);
  if(plan.docs.length)node('文档链接检查',['scripts/check-doc-links.js',...plan.docs]);
  js('生成器与依赖预检',plan.preflightTests);
  if(plan.renderer)stages.push({label:'共享渲染资源预检',command:'python3',args:['ios/scripts/test.py','--check-renderer']});
  if(plan.android)node(plan.androidMode==='daily'?'Android JVM / Lint / Debug':'Android JVM / Lint / Debug / Release',['scripts/android.mjs',plan.androidMode||'check'],{group:'native'});
  const swift=['ios/scripts/test.py','--skip-js','--skip-renderer',...(plan.swiftSuites===null?[]:(plan.swiftSuites||[]).flatMap(name=>['--suite',name]))];
  // Compiling ahead only pays when there is an Android build to overlap with; the run below reuses the binaries.
  if(plan.swift&&plan.android)stages.push({label:'Swift 编译',command:'python3',args:[...swift,'--compile-only'],group:'native'});
  if(plan.swift)stages.push({label:'Swift 回归',command:'python3',args:swift});
  const regression=plan.files.filter(path=>!plan.preflightTests.includes(path));
  if(regression.length)node('JS 回归',[POOL,...regression]);
  if(plan.browsers) {
    node('设置浏览器验收',['scripts/verify-settings-design.mjs']);
  }
  return stages;
}

// Neighbouring stages of one group form a batch that runs together; every other
// stage is a batch of its own. Pure, so the gate's order can be tested.
export function stageBatches(stages) {
  const batches=[];
  for(const stage of stages) {
    const last=batches.at(-1);
    if(stage.group&&last?.[0].group===stage.group)last.push(stage);else batches.push([stage]);
  }
  return batches;
}

// Stages a platform cannot execute (2026-10-26, review finding 3): a Linux
// container has no Xcode and no JDK, so Swift and Android stages are reported
// as not executed on this platform instead of failing the whole run. They are
// never silently dropped: the caller prints and records `skipped`, and a Linux
// pass is explicitly not a Mac / iPhone / Android acceptance.
const PLATFORM_LIMITS={linux:stage=>stage.label.startsWith('Swift ')||stage.label.startsWith('Android ')};
export function platformStages(plan,platform='darwin') {
  const all=dailyStages(plan), limit=PLATFORM_LIMITS[platform];
  if(!limit)return {stages:all,skipped:[]};
  return {stages:all.filter(stage=>!limit(stage)),skipped:all.filter(limit).map(stage=>stage.label)};
}
