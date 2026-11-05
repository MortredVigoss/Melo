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
