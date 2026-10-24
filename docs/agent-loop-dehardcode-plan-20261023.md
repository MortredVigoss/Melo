# 取消强制搜索、修正完成状态分类 —— 实施方案（交 Codex）· 2026-10-23

来源：2026-10-23 主线审计（Claude）。本文只给改法与验收，不含代码；按顺序做，每步可独立提交。

## 0. 审计结论（改之前先对一遍）

1. **"首轮必须搜"由三道机关叠加**，不是模型决定：
   - 关键词权重表判定"这轮要查"：`shared/agent/retrieval/searchRouter.js:10-26`（≥3 分或 ≥2 分 + 显式搜索词，`:250`）；共享版 `shared/agent/search.js:84` 又叠了一串死关键词（餐厅 / 营业 / 咖啡馆 / 早午餐 / 深度调研 / 多来源…）。
   - 提示词硬写"先搜"：`shared/agent/search.js:95`（`Search public sources first…`）、`searchRouter.js:309-317`（melo-web）、`:299-307`（codex-native）。
   - 状态机硬卡并作废回答：HTTP 搜索后端时 `search.js:102` 把 `web_search` 放进 `requiredTools` → `shared/agent/turn.js:133` 模型直接给答案就 `MISSING_TOOL_EVIDENCE` → `src/services/chat/execution/invokeModelNode.js:288-289` 把模型已写好的回答丢掉，换成 `turn.js:140` 的模板；Codex 原生搜索同款在 `invokeModelNode.js:290-296`（无 `web_search_call completed` 回执就整段换成写死中文）。测试 `src/services/chat/chatExecutionRunner.test.js:663-682`、`:684-`（Hosted Search receipt）把这两个行为钉死。
2. **完成状态分类粒度错**（`shared/agent/completion.js`）：
   - `completionKind` `:78-86`：任何不在 readTools 白名单里的工具（calculator / translate / pdf / xlsx / image / bash / 技能 / MCP）都让整轮变成 `action`，而 action 的完成证据只认手机的 `device-visible-facts`（`:60-62`）→ 桌面上永远只能"部分完成 · 尚无目标完成证据"。
   - research 证据只认 fetch_url / open_url / web_search（`:68-70`），正文 ≥40 字、问题二元词组 ≥75% 命中、**回复里必须原样出现 URL**（`:38-41`），否则 `RELEVANT_READ_SOURCE_MISSING`，还顺手 `skipVerification`。
   - `src/services/chat/executionScenes.js:77-93` 已经在给"'检查'被当成 research"打事后补丁。

## 0.1 与 Codex 在途改动的关系（2026-10-23 22:50 核对工作区未提交 diff）

Codex 正按 `docs/agent-goal-completion-audit-20261023.md` 实施目标状态 / 有界继续，已经覆盖本方案的一部分，**不要重复做**：

| 本方案条目 | Codex 在途 diff 状态 |
|---|---|
| 步骤 2 回答不作废 | 已做：`invokeModelNode.js` 改为 `finalReply = turn.text || coreTurn.reply(...)`，Hosted 缺回执不再替换回答。本方案只剩：`search:not-used` 事件、回执 reason、`skipVerification` 调整 |
| 步骤 4c 按副作用判 action | 已做：新文件 `shared/agent/toolEffects.js`（read / compute / write），`completionKind` 改按 `effect`。只需核对 calculator / translate / pdf / xlsx / 技能 / MCP 的分类落在 read 或 compute |
| 分类模型写死 `gpt-4o-mini` | 已做：`intentRouter.js` 改为当前连接模型 |
| 步骤 1、3、4a、4b、4e、4f、5、6 | 未做，仍按本方案 |

**新增约束（对 Codex 的目标检查）**：`shared/agent/goal.js:34` 在"没用工具 + 计划判为 research"时进入 `checking`，再由 `reviewGoal` 决定 `continue`（`lookup_missing` 会被强制转成 `continue`，`goal.js:61`），这会把"模型凭稳定知识直答"再推回去搜索——是软化版的强制搜索。要求：
- `research` 这个输入不能来自关键词权重表；在智能模式落地前，只有用户明确要求搜索 / 要来源 / 问当前事实（`EXPLICIT_SEARCH` 类显式表达）时才算 research，权重表命中只提供"可以搜"的路由信息。
- 审核提示词里明确：候选回答若为稳定知识且不涉及时效 / 地点 / 价格等易变事实，应判 `complete`（goalState `unverified`，reason `ANSWERED_WITHOUT_SOURCES`），不得仅因"有搜索工具可用"就 `continue`。
- 纠偏上限 2 次照旧；纠偏反馈文案不得包含"必须先搜索"。

## 1. 目标与不变量

- 模型自己决定要不要检索、何时检索；系统只提供"可以搜、怎么搜"的路由信息和"没搜/没读到来源"的诚实回执。
- **永远不再用模板替换模型写好的回答**（取消、预算用完、轮次上限这类模型没来得及作答的情形除外）。
- 完成回执只描述事实（读了什么、做了什么、核实到什么程度），不否决回答；UI 的"已完成 / 部分完成 / 受阻"要和用户看到的事实一致。
- 不改 `shared/protocol/agent-loop.json` 的字段形状；`shared/agent/*` 是双端共享核心（Android 用 `shared/agent/dist/agent-core.js`），改完必须 `npm run build:agent-core` 并跑 `shared/agent/conformance.test.js`。
- 关键词路由（搜索权重表、意图正则）本方案不动；它们在"智能模式"方案里统一处理（见 `docs/smart-model-routing-plan-20261023.md`）。

## 2. 步骤

### 步骤 1 ─ `web_search` 不再是必需工具（`shared/agent/search.js:102`）
- http-search 路由：`requiredTools: ['web_search', ...phoneTools]` → `requiredTools: [...phoneTools]`。
- `toolDependencies` 里 `phone_use: ['web_search']`（导航前必须先有检索）**保留**——这是安全约束，不是强制搜索。
- hosted-search 路由不变（它本来就只要求 phone）。

### 步骤 2 ─ 回答不再作废（`src/services/chat/execution/invokeModelNode.js:287-298`）
- `coreTurn.update('complete')` 后，若 `coreTurn.status === 'blocked' && coreTurn.reason === 'MISSING_TOOL_EVIDENCE'`：`finalReply = turn.text`（保留回答），`terminalReason = 'MISSING_TOOL_EVIDENCE'` 只进回执；发一个 `execution_event`（`id: 'search:not-used'`，`status: 'completed'`，output 形如"模型未检索即作答，结论未经来源核实"），不要用 `failed`。
- 其他 blocked 原因（REPEATED_TOOL_FAILURE / NO_PROGRESS / DEADLINE_EXCEEDED / ROUND_LIMIT）行为不变。
- Hosted 回执（`:290-296`）：`missingHostedEvidence` 只进回执与事件，不再替换 `finalReply`；`finalReply = receipt.verified ? receipt.answer : turn.text`。写死的中文提示降级为事件文案。
- `skipVerification`（`:507`）：`MISSING_TOOL_EVIDENCE` 和 hosted 缺回执**不再**跳过核验（让不确定性核验照常跑）；`route === 'unavailable'` 和真正 blocked 的保持。
- 状态机 `turn.js:133` 本阶段**不改**（宿主侧处理即可，避免动双端 reducer）；在 PROGRESS 里记下"手机宿主尚未同步"。

### 步骤 3 ─ 路由提示词由"必须"改"建议"
- `shared/agent/search.js:95` guidance：改成"If the answer depends on current, local or external facts, search first and read the sources you rely on; if you are confident the answer is stable knowledge, answer directly and state what was not checked."，后面"snippets 不是全文 / 不编造 / 搜索失败不接管手机"的句子保留。
- `shared/agent/retrieval/searchRouter.js:309-317`（melo-web）、`:299-307`（codex-native）：去掉"Use web_search… then answer"式的命令句，改为同样的"需要时先搜，确定时直答并说明未核实项"；`Do not emit XML tool calls…` 这类协议句保留。
- 文案里不得再出现"must"/"必须"级别的检索要求。

### 步骤 4 ─ 完成回执粒度（`shared/agent/completion.js`）
- 4a `completionObservation`：除 fetch_url / open_url / web_search 外，`knowledge`、`search_history`、`read_history`、`browser_read`、`browser_snapshot`、`file_read` 的成功结果也生成 `type: 'source'` 行（无 URL 的用 `ref`：工具名 + 参数摘要），`text` 取结果正文（≤16000），`reading` 按是否截断。
- 4b `completionReceipt` research 判定：删掉 `String(reply).includes(row.url)` 这一条；相关性改为"二元词组命中 ≥0.5，或该来源被引用（URL 出现在回复 / citations 里）"；阈值做成文件顶部常量并注释，不进 config。
- 4c `completionKind`：`action` 只在**真有副作用的工具成功执行**时成立。宿主在 `completionObservation` 的输入里带 `effect: true|false`（来自工具注册信息：`requiresPermission === true`，或类别为 file-write / send / phone / shell）；核心按 `row.effect === true` 判断，readTools 正则只作为 `effect` 缺失时的回退。文本正则（创建 / 修改 / 删除…文件、发送邮件）只能把 kind 提到 `research-action` 候选，不能单独定 action。
- 4d action 证据：除 `device-visible-facts` 外，接受宿主校验过的工具回执 `{ type: 'tool-receipt', checked: true, goal, evidenceId }`（例如 file_write 返回路径 + 哈希、发送类返回消息 id）；有回执 → `completed` / `goalState: 'supported'`，摘要"操作已执行；结果未独立核实"；没有 → 维持 `partial` + `GOAL_TERMINAL_EVIDENCE_MISSING`。
- 4e 计划说要搜但模型没搜就作答：`outcome: 'completed'`、`goalState: 'unverified'`、`reason: 'ANSWERED_WITHOUT_SOURCES'`（新 reason，只是字符串，不改枚举形状），摘要"已回答；未检索来源"。
- 4f `src/services/chat/executionScenes.js:77-93` 的事后纠正：新场景不再需要，保留给旧场景投影，加注释说明可在旧场景清理后删除。
- `completionSummary` 补上述两条摘要（中 / 英）。

### 步骤 5 ─ 测试
- `src/services/chat/chatExecutionRunner.test.js:663-682`：断言改为回答保留、回执 `reason === 'MISSING_TOOL_EVIDENCE'` 或 `ANSWERED_WITHOUT_SOURCES`、事件 `search:not-used` 出现；Hosted Search 用例改为"无回执时回答保留、`verified=false` 进回执"。
- `shared/agent/completion.test.js` 新增：本地来源算证据；不含 URL 的回复仍可 completed；calculator / pdf 不触发 action；file_write 带回执 → completed；无回执 → partial。
- `shared/agent/conformance.test.js` + `npm run build:agent-core`（dist 必须同步提交）；`shared/protocol/agent-loop.json` 的 fixtures 若引用了被改的文案要同步，并跑 `src/runtime/agentLoopContract.test.js` 与 iOS `SharedContractTests`。
- 提示词改动跑 `src/retrieval/*.test.js`、`shared/agent/research.test.js`。
- 按 `docs/testing-workflow.md`：先 `npm run test:plan -- --files <全部改动文件>`，再 `npm test -- --files ...`。

### 步骤 6 ─ 文档
- PROGRESS.md 一条（意图：取消强制搜索、回执只描述不否决；用户拍板）；MELO_OVERVIEW.md 当前事实表 "Agent、技能与团队" 行补一句。

## 3. 验收（红绿灯）

| 场景 | 期望 |
|---|---|
| HTTP 搜索后端，问"悉尼今天天气"，模型直接作答不搜 | 回答原样交付；回执 `ANSWERED_WITHOUT_SOURCES` / goalState unverified；事件"模型未检索即作答"；核验照常跑 |
| 同上，模型先 web_search 再答，回复没贴 URL | 回执 completed / supported（来源被读取） |
| Codex 原生搜索轮，模型没触发 search | 回答交付，回执 verified=false，不再出现"本轮未收到…回执"替换文 |
| "帮我算 37×48" 调 calculator | 回执 completed / not_applicable，不是"部分完成 · 尚无目标完成证据" |
| 写文件任务 file_write 成功并带回执 | completed / supported，摘要"操作已执行；结果未独立核实" |
| 导航类请求 | 仍要求先有检索再 phone_use（依赖保留） |
| 完整日常回归 | JS / 两组浏览器 / Swift 绿；`build:agent-core` dist 与源码一致 |

## 4. 不在本方案内

- 搜索权重表、意图五分类、工具可见性关键词 → 智能模式方案。
- 循环 / 预算 / 记忆常量进设置页 → 另立。
- 手机宿主（AgentLoop.swift）与 Android 宿主的同款"回答作废"行为 → 本方案落地后按同一规则同步。
