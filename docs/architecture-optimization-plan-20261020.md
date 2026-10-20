# 架构优化执行规范 · 2026-10-20

本文件是给执行者（后续会话，可能是另一个模型）的完整施工说明。它自成一体：读完本文件、`CLAUDE.md` 和 `desktop-ui/features/README.md` 就能开工，不需要本轮审计的对话上下文。

方向：以优化架构的方式优化代码。不加功能、不改用户可见行为、不改用户数据。

基线 `0e79fb1`。审计证据在本机 `.tmp/arch-audit-20261020/facts.txt`。

---

## 0. 执行者必读：硬规则

这些规则在本仓库之前反复出过事，违反任何一条都算任务失败，不论测试是否通过。

1. **不抹除用户已配置的任何字段。** 任何保存路径（表单、自动保存、测试连接、切页、state.json 改写、规范化函数重构）都必须把用户已填写的每个字段原样带回：token、ID、勾选、voicePersonality、TTS 参数、模型覆盖、systemPrompt、白名单、项目覆盖、外部连接器密钥等。部分 patch 不得把未提及字段重置为默认。重构 `normalize*` 前先列出旧代码保留的全部字段，逐一确认新代码仍保留。
2. **改后端必须配真实可交互的 UI。** 不允许只刷新页面的按钮、弹回的勾选框、空壳面板。声明完成前走一遍：用户点 X → DOM 发生什么 → 发什么请求 → 回什么 → 渲染什么。
3. **所有配置输入框统一 3 秒 idle 自动保存 + 切换前 flush + 关窗 beacon flush**，不加专门保存按钮，不每个面板抄一套。
4. **机械移动与语义改动分开提交。** 先按 CLAUDE.md 逐字节搬函数体（允许必要的 import/export 接线），单独提交；接口或行为改动在后一个提交里。审读时能分清哪一行是搬、哪一行是改。
5. **新模块禁止反向依赖旧入口。** 旧入口可以转发到新模块；新模块不得 import `app.js`、`desktopStore.js` 或 `services/desktop/bootstrap.js`。
6. **一次只做一个批次，一个批次内一次只做一个步骤。** 每步结束跑该步的验收命令，绿了再做下一步。不顺手修无关问题；看到的无关问题写进本文件末尾"发现但未处理"一节。
7. **测试绿不等于完成。** 每批有"行为验收"项，必须在隔离 home 的真实浏览器 / 真实对话里跑过。
8. **日常测试用隔离 home。** `MELO_HOME=<临时目录> MELO_TEST_MODE=1`。不碰 `.tmp/melo-home-user/`，不碰已安装的 Melo.app，不运行 `npm run install:desktop`，不推送，不运行 `git pp`。
9. **中文写结论。** 代码、注释、提交信息英文；给用户的总结、`PROGRESS.md` 条目中文。
10. **提交信息格式**：`<area>: <what changed>`，正文说明是机械移动还是接口改动、验收命令和结果。`PROGRESS.md` 顶部追加一条，标注 `（<执行者名>）`。

### 通用验收命令

```sh
npm run build                      # 语法
npm run test:ui                    # desktop-ui 全部测试（含 i18n 覆盖）
npm run test:settings-design       # 设置页编辑/保存/取消/390px 布局
npm run test:prompt-pipeline
npm run test:runtime
node scripts/check-dependencies.js # 必须 cycles:0
npm test -- --base <本批起点提交>   # 日常选组，批次结束时跑
```

### 计算样式探针（样式相关步骤必用）

`.tmp/p2c-chat/css-probe.mjs` + `css-compare.mjs` 是 P2c 用过的探针：对若干场景、5 种宽度，记录每个元素的盒子和全部计算样式的摘要，改动前后必须一致。用法：改动前 `node .tmp/p2c-chat/css-probe.mjs before`，改动后 `node .tmp/p2c-chat/css-probe.mjs after`，`node .tmp/p2c-chat/css-compare.mjs before after`。如果本批涉及探针未覆盖的页面（模型、连接器、技能、安全），先复制一份探针，在场景列表里加这些页面（打开每个分支、每个 tab、编辑态和只读态各一次），再开始改。探针脚本和输出放 `.tmp/<批次目录>/`，不进 git。

---

## 1. 现状事实（执行时核对用）

| 事实 | 数字 | 位置 |
| --- | --- | --- |
| 产品代码规模 | 730 文件 / 153,925 行 | 不含测试、生成物、夹具 |
| 静态依赖 | 432 模块、0 循环 | `node scripts/check-dependencies.js` |
| `desktop-ui/app.js` | 8,807 行；中央 click 分发（7329 行 `switch (action)`）106 个 case，submit 分发（`switch (form.dataset.form)`）11 个；38 个 `render*`、37 个 `handle*`；`uiState` 写入 275 处 | **更正（10-20 执行时）**：原写“180 个 case、P2 后涨 75”是把全文件所有 switch（右键菜单、命令面板、视图路由等）的 case 一起数了；中央分发 P2 结束 105，现 106，只涨 1 |
| 自动保存实现 | **更正（10-20 执行时）：三套调度函数均无调用者，是死代码**——连接器自 10-14 `b96c48a`、Agent 两套自 10-17 起；设置页已改为 `settingsEdit.js` 的“只读 → 编辑 → 保存”，并有测试断言“设置输入保持本地草稿直到显式保存”。原记录：3 套：连接器在 `app.js:3257-3397`；Agent 渠道 `features/agents/controller.js:508-551,609`；Agent Markdown 同文件 `552-608`；关窗 flush 各一份（`app.js:3365-3397`、`controller.js:620-640,1154`） | 相关符号 14 个 |
| 已有共享编辑器 | `desktop-ui/settingsEdit.js`（`EditSession`、`createSettingsFormEditors`、`installUnsavedSettingsGuard`）| 模型/安全/连接器页的只读→编辑→保存用它，没有 idle 自动保存 |
| 动作注册表 | `desktop-ui/features/registry.js` `createActionRegistry()`：`register / has / dispatch / names / owner` | app.js 在 switch 前先问注册表 |
| 聊天执行 | `src/services/chat/chatExecutionRunner.js` 1,352 行，单一导出 `runChatAgentExecutionGraph`（152 行起）。176–236 行定义 ~14 个外层局部量（`env, firstToken, originalDelta, modelResponses, replyProvider, observedReply, budget, createReply, embedQuery, contextBudget, turnContextPlacement, promptDebug, modelOverrides, isRemoteChannel`），237 行起 `createStateGraph` 三个节点闭包：`prepare`（253–737，484 行）、`invoke-model`（744–1196，452 行）、`finalize`（1202–1337，135 行），1341 行 `runStateGraph` | 78 个 import |
| `sendChatMessage.js` | 625 行、50 个 import | 调用 runner |
| 业务依赖页面组装 | `agentMutations.js`、`projectMutations.js`、`desktopStore.js` 导入 `services/desktop/bootstrap`；`getDesktopBootstrap()` 41 处调用；`bootstrap.js` 477 行 | |
| `stateStore` 直接导入方 | 45 个模块 | |
| 样式 | `index.html` 顺序加载 11 个 CSS 共 7,495 行：launchScreen → styles → features/{projects,memory,agents,chat,approvals} → emerald(20 行，旧主题) → neural → neuralGlass → atomicButton → modelPresentation → language → localSettings → settingsEdit → executionPanel → surfaceUnify | token 定义分散在 neural / neuralGlass / surfaceUnify；`!important` 共 24 处（neural 8、neuralGlass 5、executionPanel 4、styles 3、localSettings 2、settingsEdit 1、launchScreen 1） |
| iOS 主题 | `ios/scripts/sync-theme.py` 从 `neuralGlass.css` 生成 | 改 token 位置要同步改脚本 |
| 工具链 | 无 ESLint、无类型检查，`devDependencies` 0 | 边界靠 `check-dependencies.js` 与源码扫描测试 |
| 手机 | `ios/Melo/ChatStore.swift` 1,179 行，近 150 次提交改过 20 次 | |

---

## 2. 批次总览

| 批次 | 内容 | 前置 | 风险 |
| --- | --- | --- | --- |
| B1 | 共享自动保存钩子；冻结中央 switch | 无 | 低 |
| B2 | 聊天执行三节点拆成三个模块 + 显式 turn 对象 | B1 | 中高 |
| B3 | 模型 / 连接器 / 技能 / 安全四页迁入 `features/customize/`；样式合并为 token → base → features 三层 | B1 | 中 |
| B4 | 业务操作返回提交回执；最薄工具链（ESLint + 边界 JSDoc） | B2、B3 | 中 |
| B5 | 手机 `ChatStore.swift` 拆分 | B2 | 中高，需要 Mac 跑模拟器 |

每批独立可回退。B2 和 B3 互不依赖，但不要同时在一个工作树里做。

---

## 3. B1 · 共享自动保存钩子 + 冻结中央 switch

### B1-1 读现状
读 `app.js:3257-3397`、`features/agents/controller.js:20-50,500-640,1150-1160`、`settingsEdit.js` 全文、`desktop-ui/features/README.md` 的 "Shared request layer" 一节。列出三套实现各自的：idle 毫秒数、snapshot 形状、saver 调用、切换前 flush 的触发点、关窗 beacon 的 URL 和 body。把这张表写进 `.tmp/b1-autosave/inventory.md`。

> **B1-2 ~ B1-5 暂停（10-20）**：前提不成立，见上表更正与 §10。按原文执行会重新引入自动保存，属用户可见行为改变，待用户决定方向后改写本节。

### B1-2 新模块（不接线）
新建 `desktop-ui/configAutosave.js`，导出：

```js
export function createConfigAutosave({ idleMs = 3000, now = Date.now, setTimeout = window.setTimeout, clearTimeout = window.clearTimeout, sendBeacon = navigator.sendBeacon?.bind(navigator) } = {})
// 返回 { schedule(key, { snapshot, save, beacon }), flush(key), flushAll(), flushAllOnUnload(), pending(key), keys() }
// schedule: 同 key 覆盖未发出的 snapshot，重置 idle 计时；到点调用 save(snapshot)
// flush(key): 立即执行该 key 的 save，返回 Promise；无 pending 时 resolve
// flushAll(): 全部 flush，用于切 Agent / scope / 视图之前
// flushAllOnUnload(): 同步、best-effort，对每个 pending 调 beacon(snapshot)；beacon 返回 {url, body}
// 已在飞行中的 save 未返回时又 schedule 同 key：排队，不丢，不并发两个 save
```

单例：`export const configAutosave = createConfigAutosave();`，并在模块里挂 `pagehide` / `beforeunload` → `flushAllOnUnload()`。

写 `configAutosave.test.js`，用注入的 `setTimeout/now` 做假时钟，覆盖：idle 到点保存；idle 内连续输入只保存最后一份；flush 立即保存；飞行中再 schedule 不并发；unload 调 beacon 且 body 是最新 snapshot；save 抛错时 pending 保留（供重试）。

验收：`node --test desktop-ui/configAutosave.test.js` 通过；此时产品行为未变。提交 `desktop-ui: add shared config autosave queue (not wired)`。

### B1-3 接线连接器自动保存
把 `app.js:3257-3397` 的连接器实现改为调用 `configAutosave.schedule('connector:<id>', …)`，`flushPendingConnectorAutosaveOnUnload` 等函数删除，`flushAllPendingAutosavesOnUnload` 改为调 `configAutosave.flushAllOnUnload()`。切视图 / 切 section 的入口处（搜索 `selectedCustomizeSection` 的写入点和 `open-view` 动作）在写入前 `await configAutosave.flushAll()`。

行为验收（隔离 home，真实浏览器）：连接器页输入一个 Whisper 密钥 → 不点任何按钮等 3.5 秒 → 刷新 bootstrap → 密钥的掩码显示"已保存"；输入后 1 秒内切到模型页再切回 → 值仍在；输入后 1 秒内关闭标签页 → 重开后值仍在。三条各写成 `desktop-ui/connectorAutosave.browser.test.js` 的用例（参照已有 `*.browser.test.js` 的起服务方式）。

提交 `desktop-ui: route connector autosave through configAutosave`。

### B1-4 接线 Agent 渠道与 Markdown 自动保存
同样方式替换 `features/agents/controller.js` 的两套，key 用 `agent-channel:<agentId>`、`agent-markdown:<agentId>`。该控制器已有的 `flushPending()` / `flushOnUnload()` 导出保留签名，内部改为调共享队列。Markdown 那套有"剩余 idle 时间"逻辑（574 行），共享队列的 schedule 覆盖语义等价，删掉自算的 remaining。

验收：`npm run test:ui`（含 `agentSettings.browser.test.js`）通过；`grep -rn "pendingAgentChannelAutosave\|pendingAgentMarkdownAutosave\|pendingConnectorAutosave\|AutosaveTimer" desktop-ui --include='*.js' | grep -v test` 结果为空；B1-3 的三条行为测试对 Agent 渠道 token 再跑一遍（加进同一个 browser test 文件）。

提交 `desktop-ui: route agent channel and markdown autosave through configAutosave`。

### B1-5 settingsEdit 接入同一 flush 队列
`settingsEdit.js` 的 `EditSession` 保存时，先 `await configAutosave.flushAll()` 再提交，避免编辑态保存与某个 idle 保存交叉写同一对象。不改 settingsEdit 的只读 / 编辑 UI。

验收：`npm run test:settings-design` 通过。提交 `desktop-ui: drain idle autosaves before settings edit sessions save`。

### B1-6 冻结中央 switch
在 `desktop-ui/registry.test.js` 旁新增 `desktop-ui/appSwitchFreeze.test.js`：读取 `app.js`，统计三个 `switch (action)` 内的 `case '...'` 名称，与 `desktop-ui/appSwitchBaseline.json` 比对。基线 JSON 在本步生成（当前 180 个名字）。测试断言：**没有基线之外的新名字**；允许减少。减少时执行者更新基线并在提交信息说明迁到了哪个 feature。

同时在 `scripts/check-dependencies.js` 增加一条规则：`desktop-ui/features/**` 不得 import `desktop-ui/app.js`（现在已经如此，写成规则防回退）。

验收：`npm run test:ui`、`node scripts/check-dependencies.js`。提交 `desktop-ui: freeze app.js action switches at 180 cases`。

### B1 收尾
`npm test -- --base <B1 起点>` 全绿；`PROGRESS.md` 加条目，写明 case 数、自动保存符号数（应为 0）、新增测试数。写 `docs/handoffs/b1-autosave-20261020.md`（半页：做了什么、怎么验的、没做什么）。

---

## 4. B2 · 聊天执行拆三节点

目标形状：

```
src/services/chat/execution/
  turnContext.js      createTurnContext(input) → turn   （原 176–236 行的外层局部量）
  prepareNode.js      export async function prepare(turn, graphState)
  invokeModelNode.js  export async function invokeModel(turn, graphState)
  finalizeNode.js     export async function finalize(turn, graphState)
chatExecutionRunner.js  只剩：参数校验 → createTurnContext → createStateGraph({prepare, invoke-model, finalize}) → runStateGraph
```

`turn` 是一个普通对象，字段就是现在那 ~14 个外层局部量加上函数参数（`context, home, config, state, chat, workspace, connectors, skills, latestUserMessage, imageTask, teamPlan, onImageTaskResolved, onImageProgress, agentId, background, channelContext, signal, onDelta, onReasoningDelta, sseEmitter, providerProfile, _dependencies`）。节点通过 `turn.xxx` 访问，不再闭包捕获。

### B2-0 前置
- 读 `chatExecutionRunner.js` 全文、`sendChatMessage.js`、`taskExecutionRunner.js`（它也用 `runStateGraph`，确认不会被影响）、`shared/agent/loopContract.js`、`shared/protocol/agent-loop.json`。
- 列出三个节点各自读写了哪些外层局部量（逐个 grep），写进 `.tmp/b2-execution/locals.md`。特别标出**被节点赋值**的（如 `modelResponses.push`、`firstToken` 结束），这些在 `turn` 上必须是可变引用，不能解构成值。
- 跑一次基线：`npm run test:prompt-pipeline`、`npm run test:runtime`、`node --test src/services/chat/*.test.js src/agents/*.test.js`，记录通过数。
- 隔离 home 起服务，用 `MELO_MOCK_RESPONSE=fixture` 跑一轮真实对话（文本、带工具调用、带图片任务、取消各一次），用 `.tmp/p2c-chat/smoke.mjs` 做样板写 `.tmp/b2-execution/smoke.mjs`，保存 SSE 事件序列作为基线。

### B2-1 抽 turnContext（机械）
把 176–236 行搬进 `execution/turnContext.js` 的 `createTurnContext(input)`，返回对象；runner 里 `const turn = createTurnContext({...args})`，节点闭包里对这些量的引用临时改为 `turn.xxx`（只改引用，节点体不动位置）。

验收：B2-0 的三组测试数字不变；smoke 事件序列逐字节一致。提交 `chat execution: hoist turn-level locals into createTurnContext (mechanical)`。

### B2-2 搬 finalize（最小的节点先搬）
`1202–1337` 搬进 `execution/finalizeNode.js`，签名 `finalize(turn, graphState)`；runner 的 graph 节点改成 `'finalize': graphState => finalize(turn, graphState)`。只搬，不改。

验收同上。提交 `chat execution: move finalize node to execution/finalizeNode.js (mechanical)`。

### B2-3 搬 invoke-model
`744–1196` 同样方式搬到 `execution/invokeModelNode.js`。这是工具续接、权限、取消、预算扣减所在，注意 `createReply` 和 `budget` 是 turn 上的引用。

验收：除上述外，加跑 `npm run test:tools-evidence-trail`、`npm run test:cross-home`，以及 smoke 的"取消"用例。提交。

### B2-4 搬 prepare
`253–737` 搬到 `execution/prepareNode.js`。验收同 B2-1。提交。

### B2-5 收口接口（语义提交，单独）
现在 runner 应 < 150 行。本步允许的改动：
- 三个节点文件各自只 import 自己用到的模块（78 个 import 按节点分流），runner 的 import 只剩 graph 和三个节点。
- `turn` 对象加 JSDoc `@typedef TurnContext`，写在 `turnContext.js`。
- 为每个节点写一个最小单测：构造假 `turn`（`_dependencies` 注入假 `createReply`），验证 `graphState` 的输入输出键集合。键集合从 B2-0 的 `locals.md` 来。

不允许：改任何分支逻辑、改事件顺序、合并或拆分节点内部步骤。

验收：全部 B2-0 测试 + 新单测；`node scripts/check-dependencies.js` cycles 0；smoke 一致；`sendChatMessage.js` 不需要改（若它直接碰了外层局部量，说明 B2-1 漏了，回去补）。提交 `chat execution: split imports per node and add node contracts`。

### B2-6 双端夹具
`shared/protocol/agent-loop.json` 的夹具按 prepare / invoke / finalize 三段补输入输出样例（从 B2-5 的单测导出）。手机侧本批不改代码，只跑 `python3 ios/scripts/test.py` 里的共享契约测试确认不破。

### B2 收尾
`npm test -- --base <B2 起点>`；`PROGRESS.md`；`docs/handoffs/b2-execution-20261020.md`。

---

## 5. B3 · 四页迁出 + 样式三层

### B3-0 前置
- 复制 `.tmp/p2c-chat/css-probe.mjs` 到 `.tmp/b3-customize/css-probe.mjs`，场景改为：模型页（只读、编辑态、提供方下拉打开）、连接器页（OpenAI / Projects / Artifacts 各选中一次，Whisper 和 MiniMax 表单编辑态）、技能页（列表、筛选输入有值、某技能详情、SKILL.md tab、创建卡）、安全页（空授权、有授权、Cookie 表单有值）、系统设置五个 tab、聊天页一条带列表的回复。宽度 560 / 760 / 1100 / 1440 / 1800。
- 跑 `before`。

### B3-1 迁模型页
参照 `features/README.md` 里 P2b 的做法：新建 `features/customize/model/{controller.js,view.js,model.css}`。从 `app.js` 搬 `renderModelPage` 及其只供模型页用的 helper 和 `handle*`；状态（`modelSetupDraft` 等）改为功能自持；通过 `featureContext` 只接收窄上下文（`getBootstrap, api, render, applyBootstrap*, patchSettings`），拒收 `uiState`；动作经 `registry.register(...)` 登记；`appSwitchBaseline.json` 相应减少并在提交说明。样式：从 `styles.css` / `modelPresentation.css` / `settingsEdit.css` 搬只有模型页用的规则到 `model.css`，`modelPresentation.css` 搬空后删除并从 `index.html` 移除。

验收：`npm run test:settings-design`（这是模型页的）；探针 `after` 与 `before` 一致；行为：编辑→保存→刷新值仍在、编辑→取消恢复、测试连接不抹密钥（硬规则 1）。提交两次：先机械搬 JS，再搬 CSS。

### B3-2 迁连接器页
同法，`features/customize/connectors/`。自动保存已在 B1 走共享队列，这里只搬。连接器的 Whisper / MiniMax 表单必须跑硬规则 1 的字段回流走查，写进提交信息。

### B3-3 迁技能页
`features/customize/skills/`：筛选栏、创建卡、详情、SKILL.md tab、健康面板、提案面板一起搬。`renderSkillProposalsPanel` 里 "存为技能" 的动作与聊天功能共享，查 `features/chat` 是否已登记同名动作，避免重复注册报错。

### B3-4 迁安全页
`features/customize/safety/`：授权列表、临时授权（他线程 10-20 新加，在 `features/approvals` 里有一部分，先读清楚归属）、Cookie 面板。`approvals.css` 里属于安全页的规则搬到 `safety.css`。

### B3-5 样式三层
前四步完成后：
1. 新建 `desktop-ui/tokens.css`：合并 `neural.css`、`neuralGlass.css`、`surfaceUnify.css` 第 1 节的全部 `:root` 变量，重名以 `surfaceUnify` 的值为准（它是最后加载、实际生效的）。修改 `ios/scripts/sync-theme.py` 读 `tokens.css`，跑一次确认生成的手机主题文件无 diff。
2. 新建 `desktop-ui/base.css`：`surfaceUnify.css` 第 2–6 节（字号、卡片间距、控件、骨架、回复节奏）+ `atomicButton.css` + `language.css` + `settingsEdit.css` 里的通用规则。`emerald.css` 删除（20 行，确认其中的类名在 JS 里无引用后）。24 处 `!important` 逐个改为提高选择器优先级或调整加载顺序后删除。
3. `index.html` 加载顺序改为：`launchScreen → tokens → base → styles → features/* → executionPanel`。`surfaceUnify.css`、`neural.css`、`neuralGlass.css`、`atomicButton.css`、`language.css`、`modelPresentation.css` 删除。`styles.css` 中被 base 覆盖的重复规则删除（用探针找：删一条跑一次）。

验收：探针一致；`grep -c '!important' desktop-ui/**/*.css` 为 0；CSS 总行数较 7,495 降 25% 以上；`npm run test:ui`。每个子步一次提交。

### B3 收尾
`app.js` 目标 < 5,000 行，`appSwitchBaseline.json` 条目 < 105。`PROGRESS.md`；`docs/handoffs/b3-customize-20261020.md`；更新 `docs/ui-design-language.md` 说明三层结构。

---

## 6. B4 · 提交回执 + 最薄工具链

### B4-1 Agent 操作返回回执
`src/services/agent/agentMutations.js`：所有导出改为返回 `{agent, revision, changedIds}`（字段由实际提交生成，参照 `projectMutations.js` P1 试点的做法和 `src/state/commitReceipt.js`）。bootstrap 的重组装移到 `src/http/` 对应路由；旧 HTTP 响应形状不变，用现有契约测试守住。移除 `agentMutations.js` 对 `services/desktop/bootstrap` 的 import。
验收：`src/runtime/architectureBoundary.test.js` 加断言：`src/services/**` 不得 import `services/desktop/bootstrap`（`desktopStore.js` 在 `src/` 根，是兼容入口，允许）；Agent 保存单测不再需要构造工作区 / 资料。

### B4-2 `getDesktopBootstrap()` 分类
41 处调用逐个标注"HTTP 响应需要"或"业务里顺手取数据"，后者改为按领域的窄查询（放 `src/services/<domain>/queries.js`，只读）。写进 `.tmp/b4-receipts/bootstrap-callers.md`。只改"业务里顺手取"的；HTTP 的保留。

### B4-3 ESLint
`npm i -D eslint @eslint/js eslint-plugin-import`（这是本仓库第一个 devDependency，提交信息说明）。`eslint.config.js` 只开：`no-unused-vars`（args: none）、`no-undef`、`no-unreachable`、`no-dupe-keys`、`import/no-cycle`。先跑 `npx eslint src desktop-ui shared mobile-sync scripts` 看告警数；逐文件修到 0（只修这几类，不改风格）；然后 `npm run build` 加上 `eslint`。
验收：lint 0；全部测试不变。修 lint 的提交与加 lint 的提交分开。

### B4-4 边界 JSDoc 类型
对 `src/http/*.js` 的响应构造、`shared/protocol/*.json` 对应的 JS 读写、B2 的 `TurnContext` 和三个节点的 `graphState`，加 `@typedef` / `@param` / `@returns`。`tsconfig.json`：`checkJs: true, noEmit: true, allowJs: true`，`include` 只列这几个目录。`npm run typecheck` = `tsc -p .`，先不进 `build`，0 错误后再进。

### B4 收尾
`PROGRESS.md`；`docs/handoffs/b4-receipts-tooling-20261020.md`。

---

## 7. B5 · 手机协调器拆分（需 Mac + 模拟器）

按 10-19 方案 P4：`ChatStore.swift` 拆为 `ChatPersistence`（存档 / 同步）、`ChatApprovals`（审批）、`ChatExecution`（执行与任务记录）三个协作对象，`ChatStore` 公开表面不变，`send` 内部按 B2 的 prepare / invoke / finalize 顺序对照 `shared/protocol/agent-loop.json` 夹具。每拆一个对象跑 `python3 ios/scripts/test.py` 全部 Swift 套件 + `ios/scripts/verify-background-simulator.py`。本批细节在 B2 完成后再展开，不在本文件预写。

---

## 8. 不做的事

- 不做全仓 TypeScript 迁移、不换框架、不引入打包。
- 不为了行数拆 `webSearchTool.js`、`memory/store.js`、`bashRiskParser.js`、`fileSafetyGate.js`。
- 不动 `ios/Melo/Scene/*.js`（生成物）、`ios/Melo/AgentCore/agent-core.js`（打包产物，用 `npm run build:agent-core` 重建）。
- 不改用户数据、已配置参数、已安装应用；不推送；不 `git pp`。
- 不在搬代码的提交里"顺手"改错误文案、简化条件、合并分支。

## 9. 衡量指标

每批结束在 `PROGRESS.md` 条目里给出：

| 指标 | 基线（0e79fb1） | 目标 |
| --- | --- | --- |
| `app.js` 行数 / 中央 click case 数 | 8,807 / 106（B1-6 已冻结） | B3 后 < 5,000 / < 80 |
| 死自动保存代码（调度 / flush / 定时器符号） | 14 | 待用户决定（删除或恢复） |
| `runChatAgentExecutionGraph` 行数 | 1,200 | **B2 已完成**：187（含 66 行 TurnContext 文档与字段），三节点各成模块 |
| `services/**` 导入 `desktop/bootstrap` 的模块数 | 2 | B4 后 0 |
| CSS 文件数 / 总行数 | 11 / 7,495 | B3 后 ≤ 8 / < 5,600 |
| `!important` 数 | 24 | B3 后 0 |
| ESLint 告警 | 无工具 | B4 后 0 |
| 静态依赖循环 | 0 | 始终 0 |

不承诺工期和提速比例。

## 10. 发现但未处理

执行者在此追加（日期、位置、一句话）。

- 2026-10-20（Claude Opus，B1）：三套 idle 自动保存无调用者；`AGENT_MARKDOWN_AUTOSAVE_IDLE_MS` 为 900ms 而非 3s；Agent 渠道为单槽（非按 Agent）。项目记忆里“全部输入框 3 秒自动保存”的规则早于 10-14 显式编辑设计，二者冲突，待用户确认现行规则。
- 2026-10-20（Claude Opus，B1）：`connectorDraftDispatch.test.js` 有 5 项按源码文本钉住死代码形状（`pendingConnectorAutosave = { body }` 等）；删死代码时需同批改写这些断言，不能直接删测试。
- 2026-10-20（Claude Opus，B1）：`agentsFeature.flushPending()` 在 app.js 被调用 5 次（切视图等），当前永远无 pending，是空操作。
- 2026-10-20（Claude Opus，B2）：B2-1 原写法（把 176–236 行搬进 `turnContext.js`）不可行——这段含 `runWithRequestContext(... runChatAgentExecutionGraph ...)` 递归早退和对 `context/home/onDelta` 的重新赋值。改为：初始化留在 runner，建图前组装 `turn` 对象；每个节点搬成 `createXNode(turn)` 工厂，在工厂顶部按原名解构所需绑定，节点主体逐字节不改（仅缩进少一级）。acorn + eslint-scope 分析确认三个节点均不写任何外层绑定、不用 this/arguments，故与原闭包等价。B2-1 并入 B2-2。
- 2026-10-20（Claude Opus，B2）：等价性证据用七场景执行轨迹（审批早退、纯文本、工具一轮、预算耗尽、中途取消、codex 搜索路由、历史追问；记录每次模型请求、SSE 事件、delta、返回值，规范化后逐字节比对），比原计划的“SSE 事件序列”更严；脚本在工作树 `.tmp/b2-execution/`。runner 原有 3 个无人引用的 import（selectedMaterials、requestEnvironment、filterToolsForSearchPlan）留给 B4 lint，不在搬迁提交里清理。
- 2026-10-20（Claude Opus，B2）：B2-6 未做——手机 `AgentLoop` 没有 prepare / invoke / finalize 节点边界，把三段 graphState 加进共享 `agent-loop.json` 等于为手机发明契约；现有 130 个共享夹具覆盖两端共同循环行为，B2 无行为变化。prepare / invoke-model 未加隔离单测（依赖面过大），由执行轨迹与原 runner 测试端到端覆盖；finalize 已有隔离单测。B5 拆 `ChatStore.swift` 时如需阶段对照，再按手机实际结构定义夹具。
