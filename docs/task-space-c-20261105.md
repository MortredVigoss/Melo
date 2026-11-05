# 任务空间 C 方案：星核主控、实时评估契约与三维视角

状态：2026-11-05 用户选定 C（相对 A「只升级视角」、B「只用现有数据投影」），要求视频底部各面板对应真实数据、设计语言与现有界面一致。分支 `claude/task-space-c-20261105`（worktree `.tmp/task-space-c-20261105`），基准 bc42ea2。主工作区另一线程的未提交改动涉及 `taskEvaluation.js`、`goal.js`、`internalMembers.js`、`invokeModelNode.js`、`AgentLoop.swift`、`SharedChatAgent.kt`，本分支不触碰，合并前变基并重跑集成档。

## 执行链路（修改前从源码读出）

桌面：
1. `src/services/chat/execution/invokeModelNode.js` 主循环。`task_progress` 单独调用时 → `coreTurn.progress()`（`src/runtime/sharedAgentCore.js`）→ `goalOperation('progress')` → `updateTaskEvaluation`（`shared/agent/taskEvaluation.js`）→ 返回 `progressResult` 给模型 → `sseEmitter('execution_event', {kind:'pipeline', id:'task-evaluation:<iter>', ...taskProgressPresentation})`。
2. `route_task` → `startInternalJob`（`shared/agent/internalRouting.js`）→ `runInternalMembers`（`internalMembers.js`）→ `prescreenApprovals` 发 `routing:approval:N`，`pipeline()` 发 `internal:N`（running / completed / interrupted），成员子循环事件经 `emit` 加 `job-N:` 前缀和 `actorName`。
3. 核验：`goal-check:<iter>`（stage.delivery）；预算：`budget:exhausted`；停止：`core:stop`、`limit:delivery`。
4. `sseEmitter` → `src/services/chat/executionScenes.js createExecutionRecorder.event` → `applyExecutionEvent`（`src/shared/executionScene.js`，字段白名单）→ 每 100 ms 原子写入 `MELO_HOME/desktop/execution-scenes/<runId>.json`（tmp + rename），同时经 `execution_scene` SSE 推前端。
5. 结束：`finishExecutionScene` 写 `completion`（含 `task.evaluation` 完整状态，B 方案）。
6. 前端：`desktop-ui/executionPanel.js receiveExecutionScene / syncExecutionPanel → paint()` → `executionScene3D.update(scene, focus, items, zoom)`，标签由 `onProject` 投影到 DOM。

iPhone：`ios/Melo/AgentLoop.swift` 在 `internal:N`（:378 / :584）与 `task-evaluation:<iter>`（:572）调用 `hooks.onStage(id, name, status, output)` → `ChatStore.stage`（:260）→ `ExecutionRecord.recordStage` → 本机存档与同步 → `NeuralWebView` → `ios/SceneSource/mobile.js meloReceive` → 同一个 `executionPanel.js`（打包清单 `ios/Melo/Scene/desktop-manifest.json`，`npm run build:ios-scene`）。

Android：`SharedChatAgent.kt` 在 `internal:N`（:296 / :317）与 `task-evaluation:<seq>`（:385）调用 `journal.event` → JS core `scene`（`shared/agent/execution.js executionScene`）→ `SharedScene.kt` WebView，资源由 Gradle 从 `ios/Melo/Scene` 拷贝。

共享读写状态：场景 JSON（随消息进入历史与同步，`shared/protocol/sync.schema.json` `$defs/stage` 未限制额外字段）、评估状态（goal state 内的 `evaluation`，只在本轮内存与 completion 回执中）。

## 审计边界与停止条件

- (a) 共享状态：场景 reducer 两份（桌面 `applyExecutionEvent`、便携 `executionScene`）及其所有消费者（面板、三维场景、`executionContext`、`sessionEvents`、同步序列化）。
- (b) 异常：快照与规范化函数遇坏数据只丢弃字段、不抛错；reducer 现有抛错（未知 run、事件超限）形态不变。
- (c) 契约：`goalOperation` 新增只读 action、`taskEvaluationOperation` 新增 action、stage 新可选字段 `role` / `limits` / `evaluation`，三端实现方与消费方全部纳入。
- 停止：到 `shared/protocol` 与 conformance 为止；不进入 three.js 内部（版本钉死）；不进入模型供应商传输层；不改 sync v1 字段形状（新字段可选，旧端解码忽略）。

## 覆盖 / 未覆盖（实施中更新）

见文末「实施记录」。

## 实施记录（分支 `claude/task-space-c-20261105`）

| 提交 | 内容 |
| --- | --- |
| `3497472` C1 | `taskEvaluationSnapshot` / `normalizeEvaluationSnapshot`（`shared/agent/taskEvaluation.js`），`goalOperation('progressSnapshot')` 只读；`INTERNAL_JOB_ROLES`；两份 reducer 接受 stage 可选字段 `role` / `limits` / `evaluation`；桌面、iPhone（新 hook `onStageEvent`，旧 `onStage` 作回退）、Android（`journal.event` 新参数，捕获异常先 `ensureActive()`）三端发出；服务端白名单与 iOS 打包清单加入 `taskEvaluation.js` |
| `c293857` C1 | 重新打包手机 / Android 共用场景 |
| `b21814c` C2 | `src/shared/executionBoard.js`：成员、阶段条、评估（实时快照优先，回退结束回执，再回退文本）、日志、资源、候选变化 |
| `fb785c5` C3 | 星核、成员行动者（岗位色）、分派光束、交接回流、评估火花；全局 / 跟随 / 自由视角（`executionViewFrame` 等纯函数），聚焦详情锁正面；拖动阈值与拾取一致（6 px） |
| `75b1361` C4 | 作战台六卡、阶段条、当前行动卡、视角切换、五语言文案；只在发生分派或评估时出现；视角与收起状态只存本机 |

设计承诺：
- 快照只含字段状态与用户合同原话，不含证据原文；分档直接取 `taskEvaluationSummary` 的主推 / 备选，界面门槛线读快照里的 policy，不写死；分数注明「排序分，不是概率」。
- 新字段可选；iPhone 冻结的 v1 同步投影（`WorkspaceProjection.stage`）不带这些字段，所以手机发起的任务在桌面同步回看时显示文本评估（界面标明「这条记录没有结构化评估数据」），本机回看完整。
- 没有分派或评估的普通对话，界面、相机与静止姿态与改动前一致（`yaw = pitch = 0` 时取景逐值相等，有测试）。
- 与批准计划的一处差异：跟随视角下拖动改为「绕跟随目标改变角度、继续跟随」，只有全局视角拖动才切到自由视角。

## 覆盖 / 未覆盖

覆盖：上表全部改动文件；共享快照对 36 个 B 夹具逐一核对分档、字段状态、门槛与限长；reducer 拒收坏数据与未知岗位；桌面宿主事件（计数器证明快照不触发工具执行）；Swift `ExecutionTests` / `AgentLoopTests` / `ParityRegressionTests`（同步投影不含新字段）；投影与视角纯函数；真实浏览器（服务端 + 临时 `MELO_HOME`）验证六卡数值、阶段条、三种视角、拖动不误触、聚焦锁定、实时飞入与减弱动态、393 宽无溢出、普通对话不出现作战台；手机打包场景（file:// + 原生桥桩）393×852 渲染与跟随。

未覆盖与原因：Android 仪器测试（`ChatPhoneUseFlowTest` 已加断言并编译通过，需模拟器或真机运行）；真实模型探针（会使用用户自己的模型连接，需用户确认后执行）；iPhone / Mac 安装（未获授权）。主工作区另一线程的未提交改动与本分支有文件重叠，合并前需变基后重跑集成档。

## 回归与证据

- C1 扩大快速档 `run-VMwbfc`（隔离 worktree，提交 `c293857`）：语法 / 生成器 / 共享渲染 / Android JVM·Lint·Debug·Release 全绿；JS 4965 通过、1 跳过、3 失败——三项都是新 worktree 缺少被 gitignore 的本机资源（桌宠皮肤、内置向量模型），软链接资源后同三项重跑通过；随后 Swift 38 组全部通过（583 s，无编译缓存）。
- 集成档 `npm test -- --base bc42ea2` → `run-VHB0gX`（提交 `75b1361`）：JS 4982/4982，零失败 / 跳过 / 复测；Swift 38 组、Android 四项、设置浏览器、文档链接、生成器与共享渲染预检全绿。
- C5 之后的改动（手机行高、证据目录名、文档）：renderer 预检、`SceneBridge`、`taskSpaceBoard.browser` 重跑通过。
- iOS 模拟器无签名 Release 构建：BUILD SUCCEEDED，改动行无新告警。审计扫描 H1–H20 相对基线除既有 H5 外无新增（H10 / H11 / H13 / H14 均 +0）。
- 本平台未执行：Android 仪器测试（需模拟器）；真实模型探针、安装未做（见上）。
- 证据目录 `.tmp/task-space-board-20261105/`：`screens/`（改动前、结束、实时全局、跟随、自由旋转、作战台 4–6 卡、393 窄屏、手机打包场景两张）与 `gates/`（两次门禁摘要、Swift 38 组、iOS 构建结论）。
