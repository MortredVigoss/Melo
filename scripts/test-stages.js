// One execution owner per check: generator tests are removed from JS, and the
// Python phase only runs Swift. Standalone test:ios still covers all three.
export function dailyStages(plan) {
  const stages=[];
  const node=(label,args)=>stages.push({label,command:process.execPath,args});
  const js=(label,files)=>{if(files.length)node(label,['--test','--test-concurrency=4','--test-timeout=120000',...files]);};
  if(plan.syntax===null||plan.syntax.length)node('语法检查',['scripts/check-syntax.js',...(plan.syntax===null?[]:['--files',...plan.syntax])]);
  if(plan.docs.length)node('文档链接检查',['scripts/check-doc-links.js',...plan.docs]);
  js('生成器与依赖预检',plan.preflightTests);
  if(plan.renderer)stages.push({label:'共享渲染资源预检',command:'python3',args:['ios/scripts/test.py','--check-renderer']});
  if(plan.android)node(plan.androidMode==='daily'?'Android JVM / Lint / Debug':'Android JVM / Lint / Debug / Release',['scripts/android.mjs',plan.androidMode||'check']);
  js('JS 回归',plan.files.filter(path=>!plan.preflightTests.includes(path)));
  if(plan.browsers) {
    node('设置浏览器验收',['scripts/verify-settings-design.mjs']);
  }
  if(plan.swift)stages.push({label:'Swift 回归',command:'python3',args:['ios/scripts/test.py','--skip-js','--skip-renderer',...(plan.swiftSuites===null?[]:plan.swiftSuites.flatMap(name=>['--suite',name]))]});
  return stages;
}

// Stages a platform cannot execute (2026-10-26, review finding 3): a Linux
// container has no Xcode and no JDK, so Swift and Android stages are reported
// as not executed on this platform instead of failing the whole run. They are
// never silently dropped: the caller prints and records `skipped`, and a Linux
// pass is explicitly not a Mac / iPhone / Android acceptance.
const PLATFORM_LIMITS={linux:stage=>stage.label==='Swift 回归'||stage.label.startsWith('Android ')};
export function platformStages(plan,platform='darwin') {
  const all=dailyStages(plan), limit=PLATFORM_LIMITS[platform];
  if(!limit)return {stages:all,skipped:[]};
  return {stages:all.filter(stage=>!limit(stage)),skipped:all.filter(limit).map(stage=>stage.label)};
}
