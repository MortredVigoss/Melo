// Dependency-aware daily selection. This augments (never replaces) whole-feature
// coverage with reverse imports, source readers, generators and native bridges.
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, relative } from 'node:path';
import { buildModuleMap, ownerOf, matchesGlob, servedModules, loadAnnotations } from './generate-module-map.js';
import { discoverTests } from './test-discovery.js';

// Tests that start the real server (`spawn(node, ['src/server.js', …])`) are
// not reachable through the import graph; the quick tier adds them whenever a
// public runtime boundary changed. Detected from source, never from a list.
const SERVER_LITERAL = /['"`]src\/server\.js['"`]/;
export async function serverConsumers(root, tests) {
  const matches = await Promise.all(tests.map(async test => SERVER_LITERAL.test(await readFile(resolve(root, test), 'utf8').catch(() => '')) ? test : null));
  return matches.filter(Boolean).sort();
}

export const IOS_JS = ['ios/Tests/SceneBridge.test.js', 'ios/Tests/NeuralLayout.test.js'];
const CORE = /^(?:package(?:-lock)?\.json$|binding\.gyp$|native\/|src\/(?:state\/|persistence\/|runtime\/|safety\/|providers\/|server\.js$|desktopStore\.js$|config\.js$|openai\.js$|tools\/(?:executor|permissions|permissionPersistence|registry)\.|services\/chat\/(?:chatExecutionRunner|sendChatMessage|turnLifecycle|turnScheduler)\.)|shared\/(?:protocol|agent)\/|mobile-sync\/.*(?:protocol|Protocol|syncContract))/;
const GATE = /^(?:scripts\/(?:test-(?:plan|impact|discovery|stages|stage-runner)|ci-test-plan|verify-daily|run-unit-tests|verify-red-green|generate-module-map|check-dependencies)\.js|ios\/scripts\/(?:test|swift_test_cache)\.py|\.github\/workflows\/.*\.ya?ml)$/;
const TOOLING = /^(?:docs\/audit\/(?:inventory-\d{4}-\d{2}-\d{2}|diff)\.json|architecture\/(?:modules|module-annotations)\.json|scripts\/(?:scope|boundary-report|check-doc-links)\.js)$/;
const sorted = values => [...new Set(values)].sort();
const list = value => Array.isArray(value) ? value : value ? [value] : [];
const matches = (path, patterns) => list(patterns).some(pattern => matchesGlob(path, pattern));

async function jsFiles(root, dir) {
  const files = [];
  let entries;
  try { entries = await readdir(resolve(root, dir), {withFileTypes:true}); }
  catch (error) { if (error.code === 'ENOENT') return files; throw error; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await jsFiles(root, path));
    else if (/\.[cm]?js$/.test(path)) files.push(path);
  }
  return files;
}

// Conservative literal extraction: false positive edges only add checks. Dynamic
// paths that cannot be resolved keep their readers in every code-change plan.
export function moduleReferences(source) {
  source = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const refs = [];
  for (const regex of [
    /\b(?:import|export)\s+(?:[^;'"`]*?\s+from\s+)?['"]([^'"\n]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"`]([^'"`\n]+)['"`]/g,
    /new\s+URL\(\s*['"`]([^'"`\n]+)['"`]/g,
  ]) for (const match of source.matchAll(regex)) refs.push(match[1]);
  const dynamic = [...source.matchAll(/\b(?:import|require)\s*\(\s*([^\n)]*)/g)];
  const opaque = dynamic.some(match => !/^['"`]/.test(match[1]) || /\$\{/.test(match[1].split(/[?#]/)[0]));
  return {refs:sorted(refs.map(ref => ref.split(/[?#]/)[0]).filter(ref => !ref.includes('${'))), opaque};
}

export async function buildTestImpact(root = process.cwd(), built = null) {
  const env = {...process.env};
  built ||= await buildModuleMap(root);
  const annotations = await loadAnnotations(root);
  const served = servedModules(annotations);
  const paths = sorted([...built.graph.keys(), ...await jsFiles(root,'scripts'), ...await jsFiles(root,'ios/SceneSource'), ...Object.values(built.map.features).flatMap(f=>f.tests.js)]);
  const graph = new Map(paths.map(path => [path, new Set(built.graph.get(path)||[])]));
  const opaque = [];
  for (const path of paths) {
    const {refs,opaque:uncertain} = moduleReferences(await readFile(resolve(root,path),'utf8'));
    if (uncertain) opaque.push(path);
    for (const ref of refs) {
      const name=ref.split(/[?#]/)[0];
      const target=name.startsWith('.') ? relative(root,resolve(root,dirname(path),name)) : served[name];
      if (target) graph.get(path).add(target);
    }
  }
  // Every edge is input -> consumer. Expand implicit edges at the file level;
  // do not union an entire annotation's unrelated source-reading pairs.
  const reverse = new Map();
  const edge=(input,consumer)=>{if(!reverse.has(input))reverse.set(input,new Set());reverse.get(input).add(consumer);};
  for(const [consumer,inputs] of graph) for(const input of inputs) edge(input,consumer);
  // Pet runtime files are bridge candidates (desktop-app/DesktopPet.swift ↔ desktop-pet/main.cjs)
  // but not graph paths: their dynamic requires must not widen unrelated plans.
  const candidates=sorted([...paths,...Object.values(built.map.features).flatMap(f=>[...f.desktopUi,...f.iphone.owned,...f.tests.swift]),...await jsFiles(root,'desktop-pet')]);
  for(const item of built.map.implicit) {
    if(item.kind==='source-reading-test') {
      const pairs=item.pairs||Object.fromEntries(list(item.tests).map(test=>[test,list(item.reads)]));
      for(const [test,reads] of Object.entries(pairs)) for(const path of candidates) if(matches(path,reads))edge(path,test);
    } else if(item.kind==='generator') {
      for(const input of candidates) if(matches(input,[...list(item.inputs),...list(item.generator)])) {
        for(const output of candidates) if(matches(output,item.outputs))edge(input,output);
        for(const check of list(item.check))edge(input,check);
      }
    } else if(item.kind==='native-bridge') {
      for(const input of candidates) if(matches(input,[...list(item.from),...list(item.to)])) for(const test of list(item.tests))edge(input,test);
    }
  }
  let swiftSources={}, manifest={};
  if(existsSync(resolve(root,'ios/scripts/test.py'))) swiftSources=JSON.parse(execFileSync('python3',['ios/scripts/test.py','--list-suites'],{cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  if(existsSync(resolve(root,'ios/Melo/Scene/desktop-manifest.json'))) manifest=JSON.parse(await readFile(resolve(root,'ios/Melo/Scene/desktop-manifest.json'),'utf8'));
  const saved=await readFile(resolve(root,'architecture/modules.json'),'utf8').catch(()=>null);
  const problems=[...built.problems,...built.map.summary.sourceReadingTests.unannotated.map(p=>`未登记源码读取测试：${p}`),...built.map.summary.unownedFiles.map(p=>`未登记归属：${p}`)];
  const servers=await serverConsumers(root,await discoverTests(root));
  return {root,built,reverse,opaque,swiftSources,manifest,problems,serverConsumers:servers,stale:!built.partial&&saved!==`${JSON.stringify(built.map,null,2)}\n`,exists:path=>existsSync(resolve(root,path))};
}

// Two tiers (2026-10-24, user decision "改什么都要 4500 个测试"):
//   integration (default) — the 2026-10-20 rules unchanged: public runtime
//     boundaries, stale maps and unknown dependencies widen to every test.
//   quick — one change at a time. Public boundaries select their owning
//     feature, the reverse-import closure and the tests that start the real
//     server instead of everything; a stale / unregistered map only runs the
//     preflight (fail fast, fix the map) instead of 4500 tests. The gate
//     itself, deletions and unknown paths still widen. A quick plan never
//     proves the shared tree: `integrationRequired` says so and the merge
//     step runs the integration tier once.
export function impactedPlan(code, files, impact, {tier='integration'}={}) {
  const quick=tier==='quick';
  const chosen=new Set(), reasons=[], selectedFeatures=new Set(), touched=new Set(code);
  const preflight=new Set(), swiftSuites=new Set();
  let full=false, allSwift=false, renderer=false, browsers=false, preflightOnly=false, publicBoundary=false;
  const add=(paths,reason)=>{for(const path of paths)if(files.includes(path))chosen.add(path);if(reason)reasons.push(reason);};
  const widen=reason=>{full=true;allSwift=true;renderer=true;browsers=true;reasons.push(reason);};
  if(!impact) {widen('依赖地图不可用，保守回退全量');return finish();}
  const {built,reverse,swiftSources,manifest}=impact;
  const owner=path=>ownerOf(path,built.rules)?.feature;
  const feature=(id,reason)=>{if(!id)return;selectedFeatures.add(id);add(built.map.features[id]?.tests.js||[],reason);};
  const toolbox=()=>add(files.filter(p=>p.startsWith('scripts/')),'开发工具：脚本测试组');
  const expand=seeds=>{const queue=[...seeds],seen=new Set(queue);for(const p of queue)for(const next of reverse.get(p)||[])if(!seen.has(next)){seen.add(next);queue.push(next);}return seen;};
  // Public boundary in the quick tier: the owning feature group plus every
  // test reachable through reverse imports; the real-server tests join below.
  const boundary=(path,label)=>{
    publicBoundary=true;
    const id=owner(path);
    if(id&&!['platform','tooling'].includes(id))feature(id,`${path}：${label} → ${id} 功能组`);
    add([...expand([path])].filter(p=>p.endsWith('.test.js')),`${path}：${label} → 反向依赖测试`);
  };
  if(impact.problems.length||impact.stale) {
    const why=impact.problems.length?`依赖登记不完整：${impact.problems.join('；')}`:'生成的功能地图过期；先更新地图';
    if(quick) {preflightOnly=true;reasons.push(`${why}（快速档只跑预检：npm run generate:module-map 后重试）`);}
    else widen(why);
  }
  for(const path of code) {
    if(!impact.exists(path)) {widen(`${path}：删除 / 重命名 / 不存在，回退全量`);continue;}
    if(path.endsWith('.test.js')) {add([path],`${path}：改动测试`);continue;}
    if(GATE.test(path)) {widen(`${path}：检测基础设施`);continue;}
    if(CORE.test(path)) {if(quick)boundary(path,'公共运行边界');else widen(`${path}：公共运行边界 / 检测基础设施`);continue;}
    if(TOOLING.test(path)) {toolbox();continue;}
    if(path.startsWith('ios/Melo/Scene/')||path.startsWith('ios/SceneSource/')||path==='ios/scripts/build-scene.py') {renderer=true;reasons.push(`${path}：手机渲染资源`);continue;}
    if(/^ios\/(Melo|Tests)\/.*\.swift$/.test(path)) {
      const suites=Object.keys(swiftSources).filter(name=>swiftSources[name].includes(path));
      if(suites.length){for(const name of suites)swiftSuites.add(name);reasons.push(`${path}：Swift 编译输入 → ${suites.join(', ')}`);}
      else {allSwift=true;reasons.push(`${path}：未纳入独立编译组的原生源码，扩大 Swift 检查`);}
      continue;
    }
    if(path==='ios/Melo/Localizable.xcstrings'||path==='ios/native-translations.js') {add(['scripts/native-translations.test.js']);continue;}
    if(path.startsWith('desktop-pet/')) {
      // The pet is a self-contained CommonJS package: its whole test group plus the
      // native-bridge tests reached below. Media, runtime and node_modules are build inputs.
      if(/^desktop-pet\/(?:node_modules|runtime|skins\/winter\/winter-animation|upstream\/assets\/webm)\//.test(path)) {reasons.push(`${path}：桌宠构建输入，不选测试`);continue;}
      feature('desktop-pet',`${path}：desktop-pet 功能组`);continue;
    }
    if(/^desktop-ui\/.*\.(js|css|html)$/.test(path)) {
      const id=owner(path);
      // Keep the entire feature's UI group. Backend consumers, source readers
      // (including file safety) and shared/native contracts are added below
      // by the same transitive graph, rather than by unrelated feature labels.
      if(id)selectedFeatures.add(id);
      add((built.map.features[id]?.tests.js||[]).filter(test=>test.startsWith('desktop-ui/')),`${path}：${id} 界面测试`);
      if(id==='desktop-shell')add(files.filter(p=>p.startsWith('desktop-ui/')));
      if(id==='settings'||id==='desktop-shell')browsers=true;
      continue;
    }
    if(/^(src|mobile-sync|shared)\/.*\.js$/.test(path)&&built.graph.has(path)) {
      const id=owner(path);
      if(!id||['platform','tooling'].includes(id)) {if(quick)boundary(path,'未分离的公共基础设施');else widen(`${path}：未分离的公共基础设施`);}
      else {feature(id,`${path}：${id} 功能组`);if(id==='settings')browsers=true;}
      continue;
    }
    widen(`${path}：未知运行时 / 构建边界`);
  }
  // Always include opaque readers and their consumers. This costs extra checks
  // but prevents unresolvable dynamic imports from silently excluding tests.
  const runtimeJS=code.some(p=>/^(src|desktop-ui|mobile-sync|shared)\/.*\.js$/.test(p));
  const uncertain=runtimeJS?impact.opaque:[];
  const reached=expand([...code,...uncertain]);
  for(const path of reached)touched.add(path);
  add([...reached].filter(p=>p.endsWith('.test.js')));
  for(const path of uncertain.filter(p=>!p.endsWith('.test.js'))) {
    if(quick) {publicBoundary=true;reasons.push(`${path}：运行时动态依赖无法确定；快速档加入其反向依赖与真实服务测试`);}
    else widen(`${path}：运行时动态依赖无法确定，回退全量`);
  }
  if(quick&&publicBoundary)add(impact.serverConsumers||[],'公共边界：启动真实服务的 HTTP / 浏览器测试');
  for(const contract of built.map.sharedContracts) if(code.some(p=>[contract.path,...contract.desktop,...contract.iphone].includes(p))) {
    add(contract.tests,'共享契约：'+contract.id);
    for(const p of contract.iphone)touched.add(p);
  }
  for(const pair of built.map.counterparts) if(pair.contract&&code.some(p=>pair.desktop.includes(p)||pair.iphone.includes(p))) {
    for(const p of [...pair.desktop,...pair.iphone])touched.add(p);
    add([...expand(pair.desktop)].filter(p=>p.endsWith('.test.js')));
  }
  for(const [name,sources] of Object.entries(swiftSources))if(sources.some(p=>touched.has(p)))swiftSuites.add(name);
  if([...touched].some(p=>Object.hasOwn(manifest,p)))renderer=true;
  if([...touched].some(p=>/^desktop-ui\/(localSettings|settingsEdit|llmConnections|smartRouting)\.js$/.test(p)))browsers=true;
  if(renderer)add(IOS_JS,'共享渲染：manifest 与桥接测试');
  if(!chosen.size&&!swiftSuites.size&&!allSwift&&!renderer&&code.some(p=>!TOOLING.test(p)))widen('未找到有效覆盖，回退全量');
  return finish();

  function finish() {
    if(preflightOnly&&!full) {
      // Fail fast on a stale or unregistered map: only the generator checks run,
      // nothing else is selected, and the plan says why.
      const check=files.filter(file=>/^scripts\/generate-.*\.test\.js$/.test(file));
      return {files:check,fullUnit:false,reason:'快速档：功能地图过期或登记不完整，只跑预检',reasons:sorted(reasons),features:[],preflightTests:check,browsers:false,renderer:false,ios:false,swift:false,swiftSuites:[],tier,integrationRequired:true,preflightOnly:true};
    }
    if(full)for(const file of files)chosen.add(file);
    for(const file of chosen)if(/^scripts\/generate-.*\.test\.js$/.test(file))preflight.add(file);
    if(impact&&code.some(p=>!p.endsWith('.test.js')))preflight.add('scripts/generate-module-map.test.js');
    for(const file of preflight)if(files.includes(file))chosen.add(file);else preflight.delete(file);
    const reason=full?'公共或未知边界，扩大回归':quick?'快速档：按反向依赖、所属功能与真实服务测试选择；合并前跑集成档':'按功能、反向依赖与跨端契约选择';
    return {files:files.filter(p=>chosen.has(p)),fullUnit:full,reason,reasons:sorted(reasons),features:sorted(selectedFeatures),preflightTests:sorted(preflight),browsers,renderer,ios:renderer||allSwift||swiftSuites.size>0,swift:allSwift||swiftSuites.size>0,swiftSuites:allSwift?null:sorted(swiftSuites),tier,integrationRequired:quick&&!full&&code.some(p=>!p.endsWith('.test.js')),preflightOnly:false};
  }
}
