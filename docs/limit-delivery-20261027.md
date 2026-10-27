# 循环轮数与上限交付实施记录 · 2026-10-27

## 授权、源码与索引

用户已指定五步方案，每步独立提交；本次不推送、不安装、不修改真实账号和数据。实际起点为 `ca3fca0`（含 `99b8ba7` 的闭环修复），集成验收仍按用户指定的 `7ae6bf5` 计算范围。使用独立工作树 `/private/tmp/melo-limit-delivery-20261027`。已读 AGENTS、CLAUDE、完整 MELO_DEVELOPMENT_STANDARD 与总览；`npm run scope` 识别 chat/agents/runtime 及原生、同步、生成契约消费者。

## 修改前执行链路与边界

| 链路 | 状态、异常与契约 |
| --- | --- |
| 桌面聊天入口 → `execution/prepareNode.js` → `invokeModelNode.js:invokeModelNode` → `runtime/sharedAgentCore.js:createCoreTurn` → `shared/agent/turn.js:startTurn/advanceTurn` | 请求所属 Agent、目标/补充、权限、预算与上下文均属于本轮；共享 reducer 维护 rounds、pending、审批后执行许可、失败与无进展计数。非法事件抛错由图节点记录；停止回执经 finalize 持久化。 |
| `invokeModelNode` → `openai.js:createReply` → 提供方适配 → 工具执行器 → `coreTurn.results/candidate/review` | 模型请求和工具均消费 runBudget；超时、取消、上下文过大在宿主捕获；工具结果必须配对。候选回答经 `goalCandidate/goalReviewRequest/reviewGoal`，`completionResult` 生成回执，`finalizeNode`/executionScenes/桌面执行面板显示结果。 |
| `delegate.js` / `team.js` → `subAgent.js`；技能入口 → `skillExecutor.js` | 子预算受父预算约束，权限交集保持；每个成员拥有独立 turn/goal/observations。异常与 partial 交接必须沿调用方保留已执行结果，不能误报完整交付。 |
| iPhone `AgentLoop.run/invokeModel` → `PhoneCoreTurn.event` / `PhoneGoalState` / `PhoneRunBudget` → `SharedLoopPolicy` | 同一 JS 契约经 JavaScriptCore 执行；Swift 宿主保留取消、审批、provider/工具调度与持久化。`withDeadline`、成员限制、transport round 的 catch 路径必须一起审计，避免丢失收尾。 |
| Android `SharedChatAgent` → `SharedCoreTurn.request/event` / `SharedRunBudget.model/effect` → `SharedCoreRuntime` | JSON 桥使用同一 reducer/goal/budget；Kotlin cancellation、预算异常与工具回执进入同一结束语义。 |
| Agent 设置 → collaboration 归一化/同步 → 各宿主轮数；smart routing → 分类与运行预算 | 保留已保存配置，明确旧字段兼容；UI 输入范围与运行时范围同源。桌面/iPhone/Android、生成 JS/Swift/Android assets 都是契约消费方。 |

共享读写边界：运行内预算（含祖先）、goal、工具观察与 requestContext；配置只走现有保存入口；最终回答、completion、continuedRequest 只走现有聊天持久化。不得修改 MELO_HOME、模型连接或真实历史数据。执行许可、审批拒绝、取消和重复副作用守卫保持现有规则。

审计停止点：追踪到现有原子持久化与 UI 回执消费，不进入第三方 provider SDK/SQLite 内部；使用既有集成回归验证边界。真机覆盖安装、同步服务器部署、长时间后台运行不在授权范围；原生编译与契约测试不能冒充真机验收。真实模型验收单独保留脱敏场景回执，不能由 fixture 替代。

## 顺序、覆盖与验收

1. request 明确 tools/check/delivery；仅合法工具批次计入 rounds；检查、纠偏候选和收尾不占轮数。保留事件兼容及停止守卫。
2. 统一默认 40/20/12，工具 200、30 分钟，主循环设置 10–64；深度智能任务 64/300/45 分钟；生成契约和三端 UI 对齐。
3. 工作额度与收尾保留分离；一次无工具交付，再目标检查；保持证据/缺口，LIMIT_DELIVERED 回执；取消和硬截止仅宿主证据清单。
4. 成员/技能同语义，partial 交接 GOAL_INCOMPLETE，上级继续补做。
5. 三跳场景 6/40 轮、预算/取消边界、共享 conformance、Swift/Kotlin、同范围快速档、基准集成档与真实模型。

已阅读覆盖：共享 turn/goal/budget/completion/JSON bridge、Node core host、桌面主循环、子循环入口、Swift loop/core、Kotlin core/budget/聊天入口及 scope 索引。逐步补读 provider 预算入口、配置和所有回执消费者并记录差异。未完成：代码、回归、真实模型与最终集成；目前不能宣称行为已修复。

专项证据：`.tmp/limit-delivery-20261027/`；阶段完成后追加实际命令、结果和提交。功能级源代码索引尚未落地，本表来自直接阅读实际函数，不以模块地图代替调用证据。

## 第一步验收

仅实际工具批次增加 rounds；三端 Host 发送 request.kind；兼容旧 mode=review。新增四份跨引擎计数 fixture 与非法 kind/批次、收尾工具零执行断言。Swift 旧夹具改为一轮工具额度，仍断言候选+检查+工具+收尾共四次模型请求与实际执行一次。

快速档 `run-h7krwC/summary.json` 全绿：JS 4732/4732、Swift 37 组、Android JVM/Lint/Debug/Release、设置浏览器与生成资源；无跳过、无隔离复测。Swift 夹具在该组编译前更新，重新生成全文件 test:plan，选组保持全部 Swift/JS/Android；日志保留。证据 `.tmp/limit-delivery-20261027/step1-plan.log`。剩余四步尚未实施。
