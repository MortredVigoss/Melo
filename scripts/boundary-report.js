// npm run boundaries — dependency boundary report (architecture plan P0).
// Markdown to stdout, no gate. Built from the same static graph as
// scripts/generate-module-map.js (check-dependencies.js sourceGraph per root
// plus cross-root edges; dynamic import() and packages excluded). Reachable
// counts are static closures, not what one request executes.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, reverseGraph, reach, loadAnnotations, compileOwnership, ownerOf } from './generate-module-map.js';

export const BOOTSTRAP = 'src/services/desktop/bootstrap.js';
export const STATE_STORE = 'src/state/stateStore.js';

// Approximate count of assignments to uiState properties (=, op=, ++/--,
// delete, Object.assign(uiState …), uiState = …). Simple regex: writes through
// aliases, destructuring or helper calls are not counted.
const UI_STATE_WRITES = [
  /\buiState(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]+\])+\s*(?:\*\*|\?\?|\|\||&&|[+\-*/%|&^])?=(?!=)/g,
  /\buiState(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]+\])+\s*(?:\+\+|--)/g,
  /(?:\+\+|--)\s*uiState(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]+\])+/g,
  /\bdelete\s+uiState(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]+\])+/g,
  /\bObject\.assign\(\s*uiState\b/g,
  /(?<![.\w$])uiState\s*=(?!=)/g,
];
export function countUiStateWrites(text) {
  return UI_STATE_WRITES.reduce((sum, pattern) => sum + [...text.matchAll(pattern)].length, 0);
}

export async function boundaryReport(root = process.cwd(), { top = 15 } = {}) {
  const annotations = await loadAnnotations(root);
  const rules = compileOwnership(annotations.features);
  const feature = path => ownerOf(path, rules)?.feature || '—';
  const graph = await buildGraph(root, annotations);
  const reverse = reverseGraph(graph);
  const withFeature = list => list.map(module => ({ module, feature: feature(module) }));
  const byFeature = list => Object.entries(list.reduce((acc, module) => { const id = feature(module); acc[id] = (acc[id] || 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const bootstrapDirect = reverse.get(BOOTSTRAP) || [];
  const bootstrapAll = reach(reverse, [BOOTSTRAP]);
  const stateDirect = reverse.get(STATE_STORE) || [];
  const stateAll = reach(reverse, [STATE_STORE]);
  const fanOut = [...graph].map(([module, imports]) => ({ module, feature: feature(module), direct: imports.length, reachable: reach(graph, [module]).length }))
    .sort((a, b) => b.direct - a.direct || a.module.localeCompare(b.module)).slice(0, top);
  const uiWrites = [];
  for (const module of graph.keys()) {
    if (!module.startsWith('desktop-ui/')) continue;
    const writes = countUiStateWrites(await readFile(resolve(root, module), 'utf8'));
    if (writes) uiWrites.push({ module, feature: feature(module), writes });
  }
  uiWrites.sort((a, b) => b.writes - a.writes || a.module.localeCompare(b.module));
  return {
    graph: { modules: graph.size, edges: [...graph.values()].reduce((sum, list) => sum + list.length, 0) },
    bootstrap: { module: BOOTSTRAP, direct: withFeature(bootstrapDirect), directServices: bootstrapDirect.filter(module => module.startsWith('src/services/')), transitive: bootstrapAll.length, transitiveByFeature: byFeature(bootstrapAll), transitiveServices: bootstrapAll.filter(module => module.startsWith('src/services/')) },
    stateStore: { module: STATE_STORE, direct: withFeature(stateDirect), directByFeature: byFeature(stateDirect), transitive: stateAll.length },
    fanOut,
    uiStateWrites: uiWrites.slice(0, top),
    uiStateWritesTotal: uiWrites.reduce((sum, item) => sum + item.writes, 0),
  };
}

export function formatBoundaryReport(data) {
  const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`)];
  const counts = list => list.map(([id, n]) => `${id} ${n}`).join('、') || '无';
  const lines = [
    '# 依赖边界报告',
    '',
    `> 只报告，不是 gate。静态 import 图：${data.graph.modules} 个模块 / ${data.graph.edges} 条边（src、desktop-ui、mobile-sync、shared；含 /shared/*.js 服务映射，不含动态 import 与外部包）。可达数是静态闭包，不代表单次请求的执行量。`,
    '',
    `## 1. 导入桌面整页组装 \`${data.bootstrap.module}\``,
    '',
    `直接导入 ${data.bootstrap.direct.length} 个（其中业务服务 \`src/services/\` ${data.bootstrap.directServices.length} 个）；直接或间接 ${data.bootstrap.transitive} 个（间接业务服务 ${data.bootstrap.transitiveServices.length} 个）。P1 目标：业务模块不再导入它。`,
    '',
    ...table(['直接导入方', '功能'], data.bootstrap.direct.map(item => [`\`${item.module}\``, item.feature])),
    '',
    `间接导入按功能：${counts(data.bootstrap.transitiveByFeature)}`,
    '',
    `## 2. 依赖全状态 \`${data.stateStore.module}\``,
    '',
    `直接依赖 ${data.stateStore.direct.length} 个，按功能：${counts(data.stateStore.directByFeature)}；直接或间接 ${data.stateStore.transitive} 个。`,
    '',
    ...table(['直接依赖方', '功能'], data.stateStore.direct.map(item => [`\`${item.module}\``, item.feature])),
    '',
    `## 3. 直接依赖最多的模块（前 ${data.fanOut.length}）`,
    '',
    ...table(['模块', '功能', '直接依赖', '静态可达'], data.fanOut.map(item => [`\`${item.module}\``, item.feature, item.direct, item.reachable])),
    '',
    `## 4. desktop-ui 写 \`uiState\` 最多的文件（前 ${data.uiStateWrites.length}，共 ${data.uiStateWritesTotal} 处）`,
    '',
    '计数方法：简单正则统计 `uiState.x =`、复合赋值、`++/--`、`delete uiState.x`、`Object.assign(uiState…)` 与 `uiState =`；经别名、解构或辅助函数的写入不计，只作相对比较。',
    '',
    ...table(['文件', '功能', '写入处'], data.uiStateWrites.map(item => [`\`${item.module}\``, item.feature, item.writes])),
    '',
  ];
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(formatBoundaryReport(await boundaryReport()));
}
