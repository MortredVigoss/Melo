// npm run scope -- <changed files…> [--json]
// REPORT ONLY (architecture plan P0): which features a change touches, which
// counterpart on the other platform to check, which test tier the current
// scripts/test-plan.js would choose and why, and which implicit dependencies
// (generators, native bridges, served modules, source-reading tests, shared
// contracts) the change hits. It never changes test selection: npm test keeps
// using scripts/test-plan.js, and release still needs npm run test:full.
// Without file arguments it reports the same Git range npm test would use.
import { readFile, access } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planTests, isDocOnly, changedPaths } from './test-plan.js';
import { discoverRunnableTests, discoverTests, TEST_ROOTS } from './test-discovery.js';
import { buildModuleMap, reverseGraph, reach, matchesGlob, ownerOf, MAP_PATH } from './generate-module-map.js';

const IMPORT = /^(?:import|export)\s+(?:[^;'"`]*?\s+from\s+)?['"]([^'"\n]+)['"]/gm;
const unique = values => [...new Set(values)];
async function exists(path) { try { await access(path); return true; } catch { return false; } }

function normalize(root, path) {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  return relative(root, absolute).split(sep).join('/');
}

function kindOf(path, graph) {
  if (isDocOnly(path)) return 'docs';
  if (path.endsWith('.test.js') || /^ios\/Tests\/.*\.swift$/.test(path)) return 'test';
  if (graph.has(path)) return 'module';
  if (path.endsWith('.swift')) return 'swift';
  if (path.startsWith('shared/protocol/')) return 'contract';
  return 'file';
}

const KIND_LABEL = { docs: '纯说明文档（test-plan 文档规则）', test: '测试文件', module: '静态图内模块', swift: 'Swift 源码', contract: '共享协议文件', file: '其他文件' };

async function discoverForPlan(root) {
  try { return { files: (await discoverRunnableTests(root)).files, note: null }; }
  catch {
    const roots = [];
    for (const dir of TEST_ROOTS) if (await exists(resolve(root, dir))) roots.push(dir);
    return { files: await discoverTests(root, roots), note: `测试发现回退：缺少 ${TEST_ROOTS.filter(dir => !roots.includes(dir)).join(', ')}，按现有目录计数` };
  }
}

function tierOf(plan) {
  const code = plan.changed.filter(path => !isDocOnly(path));
  if (!code.length) return '纯文档：只检查改动文档的相对链接';
  if (plan.fullUnit) return '日常全量：全部 JS 测试 + 语法 + 设置浏览器验收 + iOS 协议/渲染与 Swift';
  if (plan.files.length && plan.changed.every(path => isDocOnly(path) || path.endsWith('.test.js'))) return '仅运行改动的测试文件';
  return `界面 / iOS 整组${plan.browsers ? ' + 设置浏览器验收' : ''}${plan.ios ? (plan.swift ? ' + iOS 协议/渲染与 Swift' : ' + iOS 共用渲染（不编译 Swift）') : ''}`;
}

function implicitRoles(entry, path) {
  const roles = [];
  const has = list => (Array.isArray(list) ? list : list ? [list] : []).some(glob => matchesGlob(path, glob));
  if (has(entry.generator)) roles.push('生成器');
  if (has(entry.inputs)) roles.push('生成输入');
  if (has(entry.outputs)) roles.push('生成产物（勿手改，重新生成）');
  if (has(entry.from)) roles.push('桥接/调用方');
  if (has(entry.to)) roles.push('桥接/被调用方');
  if (has(entry.reads)) roles.push('被测试按源码文本读取');
  if (has(entry.tests) || has(entry.check)) roles.push('校验测试');
  if (entry.served && Object.values(entry.served).includes(path)) roles.push('经 /shared/*.js 提供给页面');
  return roles;
}

// Features on the far side of an implicit edge: what must be regenerated,
// the other end of a bridge, the tests that read a file's text.
function impactedBy(entry, path, owner) {
  const list = value => (Array.isArray(value) ? value : value ? [value] : []);
  const ownersOf = paths => list(paths).map(file => owner(file.includes('*') ? `${file.slice(0, file.indexOf('*'))}_` : file)).filter(Boolean);
  const has = value => list(value).some(glob => matchesGlob(path, glob));
  if (entry.kind === 'generator') return has(entry.outputs) ? ownersOf(entry.inputs) : ownersOf([...list(entry.outputs), ...list(entry.check)]);
  // A served backend module reaches the pages importing it; the page itself reaches no one.
  if (entry.kind === 'served-module') return (entry.links || []).flatMap(link => link.target === path ? ownersOf(link.importers) : []);
  if (entry.kind === 'source-reading-test') {
    const pairs = entry.pairs || Object.fromEntries(list(entry.tests).map(test => [test, list(entry.reads)]));
    return Object.entries(pairs).flatMap(([test, reads]) => test === path ? ownersOf(reads) : reads.some(glob => matchesGlob(path, glob)) ? ownersOf([test]) : []);
  }
  return has(entry.from) ? ownersOf([...list(entry.to), ...list(entry.tests)]) : ownersOf([...list(entry.from), ...list(entry.tests)]);
}

// `cache` lets several reports share one graph build (tests, batch use).
export async function scopeReport(changed, root = process.cwd(), cache = {}) {
  const built = cache.built ||= await buildModuleMap(root);
  const { map, graph, owners } = built;
  const features = map.features;
  const reverse = reverseGraph(graph);
  const ownerFeature = path => owners.get(path) ?? null;
  const paths = unique(changed.map(path => normalize(root, path))).sort();
  const { files: tests, note: discoveryNote } = cache.discovered ||= await discoverForPlan(root);
  const plan = planTests(paths, tests);

  // Tests that import a changed module directly (static, report only).
  const testImports = new Map();
  for (const test of tests) {
    let text = '';
    try { text = await readFile(resolve(root, test), 'utf8'); } catch { continue; }
    for (const match of text.matchAll(IMPORT)) {
      if (!match[1].startsWith('.')) continue;
      const target = relative(root, resolve(root, test, '..', match[1])).split(sep).join('/');
      if (!testImports.has(target)) testImports.set(target, []);
      testImports.get(target).push(test);
    }
  }

  const entries = [];
  const affected = new Map();
  const touch = (feature, why) => {
    if (!feature || !features[feature]) return;
    if (!affected.has(feature)) affected.set(feature, { id: feature, title: features[feature].title, kind: features[feature].kind, why: [] });
    if (!affected.get(feature).why.includes(why)) affected.get(feature).why.push(why);
  };
  const counterparts = [];
  const implicitHits = new Map();
  const contracts = new Map();

  for (const path of paths) {
    const kind = kindOf(path, graph);
    const feature = owners.has(path) ? owners.get(path) : ownerOf(path, built.rules)?.feature ?? null;
    const entry = { path, exists: await exists(resolve(root, path)), kind, kindLabel: KIND_LABEL[kind], feature, featureTitle: feature ? features[feature].title : null, importers: [], reverseReach: null, testsImportingIt: testImports.get(path) || [] };
    if (feature) touch(feature, `所属：${path}`);
    if (graph.has(path)) {
      entry.importers = reverse.get(path).map(file => ({ file, feature: ownerFeature(file) }));
      for (const importer of entry.importers) if (importer.feature !== feature) touch(importer.feature, `直接导入 ${path}：${importer.file}`);
      const reached = reach(reverse, [path]);
      entry.reverseReach = { modules: reached.length, features: unique(reached.map(ownerFeature).filter(Boolean)).sort() };
    }

    let explicit = false;
    for (const pair of map.counterparts) {
      if (pair.desktop.includes(path)) { counterparts.push({ for: path, check: pair.iphone, side: 'iPhone', note: pair.note, contract: pair.contract || null }); explicit = true; }
      if (pair.iphone.includes(path)) { counterparts.push({ for: path, check: pair.desktop, side: '桌面', note: pair.note, contract: pair.contract || null }); explicit = true; }
    }
    for (const contract of map.sharedContracts) {
      const role = contract.path === path ? '契约文件' : contract.desktop.includes(path) ? '桌面读取方' : contract.iphone.includes(path) ? '手机实现' : contract.desktopConsumers.includes(path) ? '桌面使用方' : contract.tests.includes(path) ? '契约测试' : null;
      if (!role) continue;
      if (!contracts.has(contract.id)) contracts.set(contract.id, { id: contract.id, path: contract.path, title: contract.title, generator: contract.generator || null, desktop: contract.desktop, iphone: contract.iphone, tests: contract.tests, note: contract.note, hits: [] });
      contracts.get(contract.id).hits.push(`${path}（${role}）`);
      // Only the contract file or its desktop reader reaches every consumer.
      if (role === '契约文件' || role === '桌面读取方') for (const id of contract.features) touch(id, `共享契约 ${contract.id}`);
      if (role === '契约文件') { counterparts.push({ for: path, check: [...contract.desktop, ...contract.iphone], side: '双端', note: contract.title, contract: contract.id }); explicit = true; }
    }
    if (!explicit && feature && features[feature].kind === 'feature' && kind !== 'docs') {
      const info = features[feature];
      const iosSide = path.startsWith('ios/');
      const check = iosSide ? unique([...info.entryModules.map(item => item.module).filter(file => file.startsWith('src/')).slice(0, 5), ...info.desktopUi.slice(0, 3)])
        : unique([...info.iphone.owned, ...info.iphone.counterparts]).slice(0, 8);
      if (check.length) counterparts.push({ for: path, check, side: iosSide ? '桌面' : 'iPhone', note: `按功能 ${feature} 推断，未登记一一对应；以注释文件 counterparts 为准`, inferred: true });
    }

    for (const implicit of map.implicit) {
      const roles = implicitRoles(implicit, path);
      if (!roles.length) continue;
      if (!implicitHits.has(implicit.id)) implicitHits.set(implicit.id, { id: implicit.id, kind: implicit.kind, note: implicit.note, command: implicit.command || null, check: implicit.check || null, tests: implicit.tests || [], hits: [] });
      implicitHits.get(implicit.id).hits.push(`${path}（${roles.join('、')}）`);
      for (const id of impactedBy(implicit, path, file => ownerOf(file, built.rules)?.feature)) if (id !== feature) touch(id, `隐式依赖 ${implicit.id}`);
    }
    entries.push(entry);
  }

  const focused = unique([
    ...entries.flatMap(entry => entry.kind === 'test' && entry.path.endsWith('.js') ? [entry.path] : entry.testsImportingIt),
    ...[...contracts.values()].flatMap(contract => contract.tests.filter(test => test.endsWith('.js'))),
    ...[...implicitHits.values()].flatMap(hit => hit.tests.filter(test => test.endsWith('.js'))),
  ]).sort();
  const groups = unique(entries.flatMap(entry => entry.feature && entry.kind !== 'docs' ? features[entry.feature].tests.groups : [])).sort();

  let mapStatus = '未核对（缺少 ios/ 或 desktop-app/，地图不完整）';
  if (!built.partial) {
    const current = await readFile(resolve(root, MAP_PATH), 'utf8').catch(() => '');
    mapStatus = current === `${JSON.stringify(map, null, 2)}\n` ? '与当前源码一致' : `过期：运行 npm run generate:module-map`;
  }
  return {
    reportOnly: '只报告，不改变 npm test 的选组；发布前仍需 npm run test:full',
    changed: entries,
    affectedFeatures: [...affected.values()],
    counterparts,
    sharedContracts: [...contracts.values()],
    implicit: [...implicitHits.values()],
    testPlan: { tier: tierOf(plan), reason: plan.reason, selected: plan.files.length, discovered: tests.length, fullUnit: plan.fullUnit, browsers: plan.browsers, ios: plan.ios, swift: plan.swift, syntax: plan.syntax === null ? 'all' : plan.syntax, docs: plan.docs, discoveryNote },
    focused: { tests: focused, groups, note: '不替代上面的日常选组' },
    moduleMap: mapStatus,
  };
}

export function formatScope(report) {
  const lines = ['# 改动范围报告', '', `> ${report.reportOnly}`, ''];
  lines.push(`## 改动文件（${report.changed.length}）`);
  for (const entry of report.changed) {
    lines.push(`- \`${entry.path}\` — ${entry.feature ? `${entry.feature}（${entry.featureTitle}）` : '未归属功能'} · ${entry.kindLabel}${entry.exists ? '' : ' · 当前树不存在（删除或拼写）'}`);
    if (entry.importers.length) lines.push(`  - 直接被 ${entry.importers.length} 个模块导入：${entry.importers.slice(0, 6).map(item => `${item.file}（${item.feature}）`).join('、')}${entry.importers.length > 6 ? ' …' : ''}`);
    if (entry.reverseReach) lines.push(`  - 反向静态可达 ${entry.reverseReach.modules} 个模块，涉及：${entry.reverseReach.features.join('、') || '无'}`);
  }
  lines.push('', '## 受影响功能');
  if (!report.affectedFeatures.length) lines.push('- 无（未触及功能代码）');
  for (const feature of report.affectedFeatures) lines.push(`- ${feature.id}（${feature.title}${feature.kind === 'support' ? '，基础设施' : ''}）：${feature.why.slice(0, 4).join('；')}${feature.why.length > 4 ? ' …' : ''}`);
  lines.push('', '## 另一端需核对');
  if (!report.counterparts.length) lines.push('- 无');
  for (const item of report.counterparts) lines.push(`- \`${item.for}\` → ${item.side}：${item.check.map(file => `\`${file}\``).join('、')}${item.note ? ` — ${item.note}` : ''}`);
  if (report.sharedContracts.length) {
    lines.push('', '## 共享契约');
    for (const contract of report.sharedContracts) lines.push(`- ${contract.id}（\`${contract.path}\`）：${contract.hits.join('、')}${contract.generator ? `；生成器 \`${contract.generator}\`` : ''}；测试 ${contract.tests.map(test => `\`${test}\``).join('、')}`);
  }
  lines.push('', '## 测试层级（按当前 scripts/test-plan.js）');
  const plan = report.testPlan;
  lines.push(`- ${plan.tier}`);
  lines.push(`- 原因：${plan.reason}`);
  lines.push(`- JS 测试 ${plan.selected}/${plan.discovered} 个文件；浏览器 ${plan.browsers ? '是' : '否'}；iOS ${plan.ios ? (plan.swift ? '协议/渲染 + Swift' : '仅共用渲染') : '否'}；语法 ${plan.syntax === 'all' ? '全部' : `${plan.syntax.length} 个文件`}${plan.docs.length ? `；文档链接 ${plan.docs.length} 个文件` : ''}`);
  if (plan.discoveryNote) lines.push(`- ${plan.discoveryNote}`);
  lines.push('', '## 命中的隐式依赖');
  if (!report.implicit.length) lines.push('- 无');
  for (const hit of report.implicit) lines.push(`- ${hit.id}（${hit.kind}）：${hit.hits.join('、')} — ${hit.note}${hit.command ? `；命令 \`${hit.command}\`` : ''}${hit.check ? `；校验 \`${hit.check}\`` : ''}`);
  if (report.focused.tests.length || report.focused.groups.length) {
    lines.push('', `## 可先定向运行（${report.focused.note}）`);
    if (report.focused.groups.length) lines.push(`- ${report.focused.groups.join('、')}`);
    if (report.focused.tests.length) lines.push(`- node --test ${report.focused.tests.slice(0, 12).join(' ')}${report.focused.tests.length > 12 ? ` …（共 ${report.focused.tests.length} 个）` : ''}`);
  }
  lines.push('', `模块地图：${report.moduleMap}`);
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  let files = args.filter(arg => arg !== '--json');
  if (!files.length) files = changedPaths(process.cwd()).paths;
  const report = await scopeReport(files);
  console.log(json ? JSON.stringify(report, null, 2) : formatScope(report));
}
