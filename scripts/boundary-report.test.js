import test from 'node:test';
import assert from 'node:assert/strict';
import { boundaryReport, formatBoundaryReport, countUiStateWrites, BOOTSTRAP, STATE_STORE } from './boundary-report.js';
import { buildGraph } from './generate-module-map.js';

test('uiState writes are counted by a simple regex and reads are not', () => {
  const text = [
    'uiState.page = "chat";', 'uiState.drafts[id] = value;', 'uiState.count += 1;', 'uiState.count++;', '--uiState.depth;',
    'delete uiState.editing;', 'Object.assign(uiState, patch);', 'uiState = createState();',
    'if (uiState.page === "chat") render(uiState.page);', 'const page = uiState.page;', 'x = uiState.page == y;',
  ].join('\n');
  assert.equal(countUiStateWrites(text), 8);
});

test('the boundary report lists bootstrap and stateStore dependents from the same static graph', async () => {
  const data = await boundaryReport();
  const graph = await buildGraph();
  const direct = target => [...graph].filter(([, imports]) => imports.includes(target)).map(([file]) => file).sort();
  assert.deepEqual(data.bootstrap.direct.map(item => item.module), direct(BOOTSTRAP));
  assert.deepEqual(data.stateStore.direct.map(item => item.module), direct(STATE_STORE));
  assert.ok(data.bootstrap.transitive >= data.bootstrap.direct.length);
  assert.equal(data.fanOut.length, 15);
  assert.ok(data.fanOut[0].direct >= data.fanOut.at(-1).direct);
  assert.equal(data.uiStateWrites[0].module, 'desktop-ui/app.js');
  const markdown = formatBoundaryReport(data);
  for (const heading of ['# 依赖边界报告', '## 1. 导入桌面整页组装', '## 2. 依赖全状态', '## 3. 直接依赖最多的模块', '## 4. desktop-ui 写 `uiState` 最多的文件']) assert.ok(markdown.includes(heading), heading);
  assert.match(markdown, /只报告，不是 gate/);
});
