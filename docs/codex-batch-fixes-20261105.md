# Codex 批次复核 C1–C3 修复记录（2026-11-05，Claude）

用户在看完[复核记录](codex-batch-review-20261105.md)后决定三项 P2 全部修、修完推送 master。基准 `bc42ea2`（本机 master，含 Codex 未推送的 iPhone 回执 `a3817f5`）。三处都在同一提交里，产品行为改动见下表；没有改权限、同步协议、用户数据或 UI。

## 修改前的链路与边界

- **C1 整轮副作用账本**：`executor.executeScopedTool` → `reserveTurnEffect(context.turnEffects, tool, args, workspacePath)` → 共享 `toolEffect` 分类 → 账本键（工作区 + 调用指纹）。账本由 `chatExecutionRunner` 每轮创建，主 Agent 与成员经请求上下文共用；成员的 `context.budget` 是 `narrowBudget` 子对象、主 Agent 是根预算，所以预算对象可以当"执行者"身份用，不需要新状态。边界：不碰共享 `toolEffects.js`（三端同源）、不碰权限；`bash` 的只读判定复用 `readOnlyCommand.js` 自己服务的两种形式（`ls` 变体、单路径 `cat`）。
- **C2 审核规则**：`goalCandidate(tools)` → `state.availableTools` → `goalReviewRequest` / `reviewGoal`。三端的 candidate 都只传基础工具，控制工具（`route_task` / `task_progress`）另行加进请求规格，所以共享核心看不到"本轮有没有提供 task_progress"。边界：只在三端 candidate 处追加这一个名字，规则判断留在共享 `goal.js`。
- **C3 成员切片**：`TASK_EVALUATION_POLICY.member.milliseconds`（固定 90 s）分别被 Node `narrowBudget`、iOS `beginMember`、Android `memberAllocation` 各自相加；三处算法不同源。边界：改成每轮 90 s 的 `roundMilliseconds` 加共享 `memberDeadlineMs(rounds)`，Node / Android 走共享函数，iOS 用同一公式；轮数上限、调用上限、收尾保留都不变。

## 改动

| 项 | 文件 | 行为 |
| --- | --- | --- |
| C1 | `src/runtime/turnEffects.js`、`src/tools/executor.js`（传执行者）、`src/tools/builtins/readOnlyCommand.js`（纯分类 `readOnlyCommandForm`）、`src/tools/builtins/bashTool.js`（`effectFor`） | 声明为 `write` 的效果仍然整轮不重复；`unknown` 效果只在上一次仍在进行中、或上一次是别的执行者（主 ↔ 成员、成员 ↔ 成员）时拒绝，同一执行者在上一次结束后可以重复（翻页、再列目录）；`bash` 的 `ls` / `cat <路径>` 形式不进账本 |
| C2 | `shared/agent/goal.js`、`src/runtime/sharedAgentCore.js`（`offeredTools`）、`src/services/chat/execution/invokeModelNode.js`、`ios/Melo/AgentLoop.swift`、`android/.../SharedChatAgent.kt` | 只有本轮提供了 `task_progress`（或已有账本）时，审核提示词才要求账本、宿主才把 `needsEvaluation` / `evaluationValid=false` 转成 continue；没提供时提示词明说"不要索取账本"，`complete` 照常成立 |
| C3 | `shared/agent/taskEvaluation.js`（`roundMilliseconds`、`memberDeadlineMs`、allocation 接 `rounds`）、`src/services/chat/execution/internalMembers.js`、`ios/Melo/AgentLoop.swift`、`android/.../SharedChatAgent.kt`、`android/.../SharedRunBudget.kt` | 成员子预算截止 = 本次轮数 × 90 s + 60 s 收尾保留（初次 4 轮 420 s，续派 2 轮 240 s，累计仍封顶 12 轮）；一次 60 s 工具超时不再吃掉整个成员 |
| 共享包 | `shared/agent/dist/*`、`ios/Melo/AgentCore/*`、`architecture/modules.json` | `npm run build:agent-core` 再生成（44 模块），模块地图随新测试文件再生成 |

## 验证

- 定向测试（隔离 home）：`turnEffects.test.js` +2（同执行者 / 跨执行者 / 进行中 / 写效果 / bash 形式）、新 `src/services/chat/turnEffectsRepeat.test.js`（真实主图计数：同一成员用相同参数翻页执行 2 次；主 Agent 先做、成员再做只执行 1 次且成员收到 `TURN_EFFECT_ALREADY_ATTEMPTED`）、`goal.test.js` +1（未提供 / 提供两种 candidate 下的提示词与裁决）、`taskEvaluation.test.js` +1（`memberDeadlineMs` 与 allocation 的 `rounds`）、`internalMembers.test.js` +1（子预算截止随 roundLimit）；连同 Codex 的 `orchestrationReview` / `taskEvaluationGraph` / `conformance` / executor 系列共 409 项全过。
- 快速档：`run-alGeuV`（339 / 589 文件，JS 3 327 / 3 327，Android、22 组 Swift，892 s）
- 集成档：`run-RtVrtf`（`--base a4ae796`，589 / 589，JS 4 934 / 4 934，Android、设置浏览器、Swift 全绿，294 s）
- 未做：真实模型与真机验收；Swift / Android 只由门禁编译与既有测试覆盖，Android 成员路径仍无单元测试（复核里的 P3，未动）。

## 没改的东西

工具级 60 s 超时先于文件安全卡的 120 s 触发、项目外对话的隔离工作区，都是本批之前的行为，留在复核记录里。`shared/protocol/sync.schema.json` 仍声明 `jobModels`、`jobConnectionConfig` 整份铺档案，这两条 P3 也没动。
