# 架构优化 B2 交接 · 2026-10-20（Claude Opus）

分支 `claude/arch-b2-20261020`（工作树 `.tmp/arch-b2-20261020`），基于 `8772e92`。

## 做了什么

`src/services/chat/chatExecutionRunner.js` 的三个图节点逐字节搬成独立模块，runner 只剩初始化、`turn` 对象和建图：

| 文件 | 内容 |
| --- | --- |
| `execution/prepareNode.js` | prepare（485 行主体）+ 只它用的 `getSharedSkillIndex` 单例 |
| `execution/invokeModelNode.js` | invoke-model（459 行主体）+ 只它用的 `STABLE_MEMORY_KINDS` |
| `execution/finalizeNode.js` | finalize（137 行主体） |
| `chatExecutionRunner.js` | 1362 → 225 行（`runChatAgentExecutionGraph` 187 行，其中 66 行是 `TurnContext` 文档与逐行字段） |

每个节点是 `createXNode(turn)` 工厂：顶部按原名解构所需绑定，返回原节点函数。主体与搬迁前逐行相同，仅少一级缩进（`.tmp/b2-execution/verify-move.mjs` 对 git 原文校验）。每个节点文件只 import 自己用到的模块。

与规范的偏差（已记入规范 §10）：

- B2-1 原写法不可行（初始化段含递归早退与重新赋值），改为 runner 内组装 `turn`；B2-1 并入 B2-2。
- B2-6（双端 agent-loop 夹具按三段扩展）未做：手机 `AgentLoop` 没有这三个节点边界，加进共享契约等于为手机发明契约；现有 130 个共享夹具覆盖两端共同的循环行为，本批无行为变化。
- prepare / invoke-model 未加隔离单测：依赖存储、工具注册表、技能索引等，隔离假对象成本高于价值；它们由七场景执行轨迹与原有 runner 测试端到端覆盖。finalize 已加隔离单测。

## 怎么验的

- 搬迁前用 acorn + eslint-scope 做作用域分析：三个节点均不写任何外层绑定、不用 this / arguments；外层的 `context` / `home` / `onDelta` 重新赋值都在建图之前。
- 七场景执行轨迹（审批早退、纯文本、工具一轮、预算耗尽、中途取消、codex 搜索路由、历史追问），记录每次模型请求、SSE 事件、delta、返回值，规范化后约 199KB；三次运行逐字节确定；每次搬迁后逐字节一致；改一个字符即被发现。
- 每次搬迁后：prompt-pipeline 149、runtime 49、chat+agents 636、tools-evidence-trail 25、cross-home 14，与基线一致。
- `activeAgentProfile` 作用域约定源码测试改为按文件区分里外，两个方向的反向对照都会失败。
- 新 `finalizeNode.test.js` 5 项，取消路径有反向对照。
- 批次 `npm test -- --base 8772e92` GREEN：JS 4360 过 / 0 败 / 1 跳过，设置与加速设置浏览器验收，Swift 35 套件。首轮失败于 `generate-module-map.test.js`：它写死 agent-loop 契约的桌面消费者为 runner；契约 import 已随 invoke-model 搬走，断言改为 invokeModelNode.js，并把三个节点文件补进 agent-loop 的手机配对（改任一节点都会选上 AgentLoopTests 等手机套件）。

## 没做什么

- runner 仍有 3 个搬迁前就无人引用的 import（selectedMaterials、requestEnvironment、filterToolsForSearchPlan），留给 B4 lint。
- `turn` 字段类型暂写 `{*}`，B4-4 边界类型检查时细化。
- 未合入 master，未推送，未运行 git pp。
