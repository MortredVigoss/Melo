# 隐藏子 Agent 编排层审计：主 Agent 路由 / 分派 / 审批 / 整合（2026-11-04）

用户问题：能不能在目前 Agent 的基础上做一层用户看不到的 Agent 架构——主 Agent 负责路由、发任务、审批、整合结果，具体任务（网页查询、工具调用）分别交给不同的子 Agent。只审计、不改代码。

范围与源码基准：本地 master `f1bbdc7`（origin/master `882eba7`，本地多一个他线程的回执提交），桌面安装壳 11-04 17:09 构建，壳从源码目录运行即当前检出；桌面 home `.tmp/melo-home-user`（Codex 连接，模型 `gpt-6.1-sol`，无 Tavily / SerpAPI / Jina key，Playwright MCP 开启）。审计对象限于普通聊天的桌面执行链路与共享核心；iPhone / Android 只核对入口存在与契约同源。

## 0. 结论

1. **这层架构已经存在**：11-04 Codex 按用户选定的"按需分工"落地了内部岗位路由（`shared/agent/internalRouting.js` + 三端执行器）。当前对话的模型兼任主 Agent：遇到复合任务时调用控制工具 `route_task`，把一个子任务交给四个内部岗位之一（检索成员 / 资料读取成员 / 计算成员 / 执行成员），成员在独立上下文、岗位工具白名单内跑最多 6 轮，交回带证据的 JSON 交接，主 Agent 核验后用自己的人设答复。聊天记录里只有主 Agent 的回复；成员动作只在任务空间的"模型与交付记录"里可见。
2. **对照用户描述，四件事已有、五件事没有**。已有：路由与分派、成员上下文隔离、交接核验、与用户审批 / 取消 / 预算的贯通。没有：(a) "工具调用交给子 Agent"只覆盖桌面 33 个内建工具里的 11 个，其余（bash、浏览器、PDF / 表格 / 图片、MCP、技能）仍只能主 Agent 自己调；(b) 不能并行分派，一轮只能派一个子任务；(c) 成员轮次和 token 与主 Agent 共用同一个 40 轮 / 40 万 token 池，没有分层；(d) 审批没有经过主 Agent 预筛，成员的每个副作用调用都直接弹给用户，无人在场时 120 s 超时；(e) 所有岗位用同一个模型连接，内部成员拿不到对话背景。
3. **结论：能做，而且应该在现有内部路由上补齐，而不是另起一层**。推荐方案 A（见 §6），分五个可独立验收的阶段；"主 Agent 完全不碰工具、每轮先路由"的纯编排方案已在 11-04 被用户否决（6/10），本审计不建议重开。
4. 一个与编排无关但直接决定价值的前提：桌面无 key 时 `web_search` 仍拿不到结果（Google 对无头浏览器出验证页、Jina 匿名访问 DuckDuckGo 限流，见 [10-27 测试回执](live-test-bigbang-20261027.md)）。检索成员再怎么分派也只能抓已知 URL。

## 1. 方法

- 读源码：§3 覆盖清单所列文件与函数，按入口 → 节点 → 共享核心 → 工具执行器 → 持久化的顺序读出调用关系；三端入口只核对 `route_task` 的处理位置。
- 跑测试：`node --test shared/agent/internalRouting.test.js src/services/chat/chatExecutionRunner.test.js src/agents/team.test.js src/agents/collaboration.test.js` → 58 / 58 通过（3.5 s）。
- 工具覆盖核对：`src/tools/builtins/*.js` 的 33 个内建工具 ID 与四个岗位白名单逐一比对（§5 P1-1）。
- 真实探针：在当前安装的桌面版上用主 Agent 重跑 10-27 的 BIGBANG 长问题，录全部 SSE 事件与执行场景，见 §4。

## 2. 现有的三层机制

| 机制 | 入口 | 谁能用 | 并行 | 预算 | 用户可见 |
| --- | --- | --- | --- | --- | --- |
| 内部岗位路由（11-04） | `invokeModelNode.js:createInvokeModelNode` 给模型加 `route_task`；共享 `internalRouting.js` | 任何对话的当前 Agent，自动按需 | 否（一轮一派） | 与主 Agent 同一个 run 池、同一个 40 轮上限 | 聊天不可见；任务空间可见岗位名 |
| 显式团队 | `team.js:runAgentTeam`（模板 调研→实施→复核 / 并行调研 / 复核循环） | 开启委派且勾选成员的 Agent；金冬天、懂王当前关闭 | 是（并行读者 ≤4 条道，写者持工作区租约串行） | 计划可扩展顶层预算（`extendBudget`），成员子池 `narrowBudget` | 团队事件、成员回执、主 Agent 汇总均可见 |
| 委派单个 Agent | `delegate.js:delegateTask` → `runConfiguredMember` → `subAgent.js:runSubAgent` | 委派白名单内的自定义 Agent | 否 | 成员子池、`memberTokenLimit` 32k、深度上限 | 成员动作与交接可见 |

三者共用：`src/tools/executor.js:executeToolCalls` 执行工具并在 `permissions.js:requestPermission` 弹审批；`src/runtime/sharedAgentCore.js:createCoreTurn` 包装共享回合状态机 `shared/agent/turn.js`；`src/runtime/runBudget.js` 的 run 池（默认 30 min / 40 万输入 token / 200 次工具调用，`shared/protocol/agent-loop.json`）。

## 3. 执行链路（桌面，内部岗位路由）

1. `src/server.js` 路由表 → `src/http/chatRoutes.js`（`POST /api/chat/send/stream`，SSE；`response.once('close')` 时中止 run）→ `src/services/chat/sendChatMessage.js:executeChatTurn` → `chatExecutionRunner.js:runChatAgentExecutionGraph`（节点 `prepare` → `invoke-model` → `finalize`）。共享状态：`state.json` 的 chatRuns、对话消息；请求上下文 `runtime/requestScope.js`（预算、能力范围、审批范围）。
2. `prepareNode.js:createPrepareNode`：组装提示段、可见工具 `graphState.promptTools`、搜索计划 `searchPlan`、上下文预算。
3. `invokeModelNode.js:createInvokeModelNode`
   - 第 140–142 行：`internalRouteCatalog(routeGoal, promptToolIds)`（共享）按请求策略（`retrieval/requestPolicy.js`：禁工具 / 仅上下文 / 禁搜索 / 禁读页）与"是否纯寒暄"求出可用岗位；有岗位就把 `route_task` 追加进 `promptTools`。显式团队任务（`teamTask` / `teamPlan`）时不加。
   - 主循环每轮：`coreTurn.reporting` 到 40 轮上限即停（`ROUND_LIMIT`）；`fitRequestContext` 装配请求；模型回复经 `roundSession.parse`。
   - 第 412–421 行：模型若只调了一次 `route_task` 且分派数 < 6，`startInternalJob` 校验（岗位在目录内、任务 ≤ 3000 字、callId 唯一、同岗位同任务不重复），然后 `coreTurn.update('feedback',{internalRouting:true})`、保存 `leadMessages`，把 `loopMessages` 换成成员输入（原始目标 + 子任务的 JSON），`observationStart` 记下证据起点，发 `execution_event internal:N running`。
   - 成员轮（`job` 非空）：提示段只剩 `job.system` + 岗位工具说明（第 247–249 行 `phaseTools`），工具调用 ID 加 `job-N:` 前缀（第 394 行）；每轮经 `coreTurn.update('calls')` 计入**主回合轮数**；`jobRounds >= MAX_MEMBER_ROUNDS(6)` 时 `finishJob('Member round budget reached.', true)`（第 243 行）。
   - 成员无工具调用即交接：`finishJob` → `internalHandoff`（证据 ≤ 20 行 × 700 字、报告 ≤ 3000 字、状态 observed / unverified / partial）作为 `route_task` 的工具结果接回 `leadMessages`（第 196–204 行），发 `internal:N completed|interrupted`。
   - 中途用户补充（supplement）：先 `finishJob('Interrupted…', true)` 再 `catalog = null`，本轮不再路由（第 230–233 行）；模型升级（smart routing）同样先结束成员（第 236 行）。
   - 主 Agent 核验：无工具回复进入 `coreTurn.candidate` / `review`（`shared/agent/goal.js`、`completion.js`），`goal-check:N` 事件；交接 JSON 自带"成员报告不可信，须对照原始目标"的指令。
   - 工具执行：第 503 行 `executeToolCalls`（`src/tools/executor.js:333`）→ 第 138–139 行 `checkPermissionRule` / `requestPermission`（`permissions.js`，`PERMISSION_TIMEOUT_MS` 120 s，按 chatId 的 session 规则）；成员与主 Agent 走同一条审批路径，审批范围 `permissionScope` 来自请求上下文。
   - 副作用去重：`shared/agent/turn.js:112–115,149–152`：`internalRouting` 标志下，已成功 / 不确定（超时、中止）的副作用指纹不再重放（`ALREADY_EXECUTED` / `ALREADY_ATTEMPTED`）。
4. `finalizeNode.js:createFinalizeNode`：规范化回复、completion 元数据、持久化 assistantMessage 与执行场景（`.tmp/melo-home-user/desktop/execution-scenes/<runId>.json`）。
5. 界面：`desktop-ui/executionPanel.js` 把 `internal:N` 作为 `create` 模块的流水线阶段渲染（`runtimeStageName` → 翻译表 `desktop-ui/translations.js:18–21` 的岗位名），成员工具调用按 `job-N:` ID 归入操作列表；聊天气泡只有主 Agent 的最终回复。

iPhone：`ios/Melo/AgentLoop.swift:308–321,512–515` 经 `SharedLoopPolicy.value("internalRouting", …)` 调同一份共享核心；Android：`android/app/src/main/java/com/melo/android/chat/SharedChatAgent.kt:144–149,276–292`。两端由 `ios/Tests/AgentLoopTests.swift`、`ChatPhoneUseFlowTest.kt` 与 conformance 覆盖，本审计不再深入。

## 4. 真实探针

（见下节补记。）

## 5. 问题清单（按严重级）

| 级别 | 问题 | 位置与调用关系 | 影响 |
| --- | --- | --- | --- |
| P1-1 | 岗位工具白名单写死在共享核心，覆盖面小 | `shared/agent/internalRouting.js` `jobs` 常量；桌面 33 个内建工具里只有 `web_search` `fetch_url` `web_screenshot` `calculator` `file_read` `glob` `grep` `read_history` `search_history` `file_write` `file_edit` 11 个进岗位；`bash`、`browser_*`（6 个）、`pdf` `xlsx` `image` `media_*` `translate` `clipboard` `knowledge` `reminder` `device_location` `file_delete/move/mkdir`、全部 MCP（Playwright 浏览器、AntV、Markdown→PDF、Mermaid）与技能仍只能主 Agent 直接调；新工具要改共享核心并 `npm run build:agent-core` 三端重建 | 用户要的"工具调用交给子 Agent"只覆盖约三分之一；主 Agent 上下文仍被这些工具的输出撑大 |
| P1-2 | 成员轮次与 token 不分层 | `invokeModelNode.js` 成员轮走 `coreTurn.update('calls')` 计入 40 轮（`resolveLoopLimits`）；6 派 × 6 轮 = 36 轮本身就超过剩余额度；成员不像委派成员那样有 `narrowBudget` / `memberTokenLimit` 子池，直接消耗主 Agent 的 40 万 token | 10-27 那种 `LIMIT_DELIVERED` 半截交付仍会出现；检索成员多抓几页就把主 Agent 的收尾额度吃掉 |
| P1-3 | 不能并行分派 | 第 412 行要求 `toolCalls.length === 1`；一次只有一个 `job`；显式团队的并行读者（`team.js` `parallel` 模式、`delegate.js` `parallelReader`、`workspaceScheduling.js` 写者租约）没有接到内部路由 | "查天气"和"查活动"这类互不依赖的子任务只能串行，长任务时间翻倍 |
| P1-4 | 审批不经主 Agent 预筛，无任务级范围授权 | `executor.js:138–139` 每个受审批工具调用直接 `requestPermission`；成员与主 Agent 同路径；无人在场 120 s 超时后成员带着失败交接；10-27 审计 P1-4 未落地 | 用户看到的是零散的成员级弹窗；无人值守时副作用全部失败 |
| P2-5 | 内部成员没有对话背景 | `startInternalJob` 的输入只有 `originalUserGoal` + `assignment`；委派成员有 `memberBackground.js:buildMemberBackground`（近 6 轮 + 摘要） | 多轮对话里"按上面说的查"要靠主 Agent 把任务写成自包含，写不好就错派 |
| P2-6 | 所有岗位同一模型连接 | 成员会话用 `delegatedModelConfig`；模型升级（`melo_escalate`）只在主 Agent 层 | 检索岗位用不上更快更便宜的模型；成员需要更强模型只能交回主 Agent |
| P2-7 | "用户看不到"只做到聊天层 | `executionPanel.js` 流水线阶段显示岗位名，操作列表显示 `job-N:` 调用 | 不是缺陷，但与用户表述有差；若要完全隐藏需在任务空间折叠内部阶段 |
| P2-8 | 检索岗位依赖的搜索后端在桌面无 key 时不可用 | `webSearchTool.js` SERP：Google 无头验证页、Jina 匿名 DDG 403（[10-27 回执](live-test-bigbang-20261027.md)） | 检索成员只能抓已知 URL；不是编排问题，但决定这层的实际价值 |

已确认不是问题：嵌套分派被挡（`!job && catalog`）；同岗位同任务重复被拒；用户补充与模型升级都会先结束成员；副作用指纹在内部路由下不重放；成员交接明确标注未核验；三端共用一份目录与交接逻辑。

## 6. 方案与评分

| 方案 | 做法 | 评分 | 理由 |
| --- | --- | --- | --- |
| **A. 在现有内部路由上补齐五项（推荐）** | 分五个阶段：A1 岗位目录改为从工具注册表的 `capability` / `uiModule` / `effect` 声明动态生成（只读网络 → 检索，读本地 → 资料读取，写 / 命令 / MCP 副作用 → 执行），保留显式排除表；A2 预算分层：成员轮用独立 `limits.rounds`，不计主回合；成员 token 子池（复用 `memberTokenLimit` / `narrowBudget`）；主 Agent 保留收尾额度；A3 并行分派：允许一轮多个 `route_task`，只读岗位并发（≤ 显式团队的 4 条道），执行岗位串行并持写者租约；A4 审批预筛：复合任务开始时主 Agent 汇总本任务需要的副作用范围，一次征求（session 级 once / session 已有），命中范围的成员调用不再弹，未授权仍弹给用户，主 Agent 永不代批；A5 岗位模型与成员背景：每岗位可选连接（默认当前），内部成员加 bounded background | **8.5 / 10** | 复用已验证的目录 / 交接 / 去重 / 三端契约；每阶段可独立验收；A1、A2 直接解决 10-27 真实测试暴露的半截交付；风险在 A3 的并发与审批交互，需要计数器型测试证明取消时底层没发生 |
| B. 纯编排主 Agent（每轮先路由模型，主 Agent 不直接用工具） | 另起路由模型，主 Agent 只拼结果 | 6 / 10 | 简单任务也要两次调用，延迟和用量翻倍；11-04 用户已否决；上下文隔离最好但不是当前瓶颈 |
| C. 把显式团队自动化（自动生成 team plan 跑 `runAgentTeam`） | 普通聊天自动组队 | 6.5 / 10 | 并行、预算扩展、汇总都现成，但要求 Agent 开启委派并定义成员 Agent（金冬天、懂王关闭委派），成员是完整人设，团队事件对用户可见，改动面大 |
| D. 维持现状 | 不动 | 5 / 10 | 已可用，但工具覆盖三分之一、无并行、预算不分层 |

方案 A 的验收样例（沿用 11-04 的口径）：问"查 10-31 BIGBANG 悉尼演唱会当天天气与活动，再排一天路线"——主 Agent 应并行派检索成员查天气和活动，资料读取成员读本机日程，三份交接合并后由主 Agent 排路线；成员总轮数不计主回合；无人在场时只弹一次范围授权；简单问候零成员请求。

## 7. 审计边界、停止条件、覆盖与未覆盖

边界：(a) 与内部路由共享状态的代码：`coreTurn` 状态（轮数、副作用指纹、观察账本）、run 预算、请求上下文的审批范围；(b) 异常：`startInternalJob` 的拒绝只回工具结果 `ROUTE_DENIED`，成员异常沿主循环既有捕获（上下文超限 `CONTEXT_BUDGET_EXCEEDED` 压缩重试）；(c) 契约：`shared/agent/internalRouting.js`、`turn.js` 与 `shared/protocol/agent-loop.json` 三端同源。

停止条件：到 `executeToolCalls` 与 `permissions.js` 为止（工具执行与审批由各自测试组覆盖，本审计不改）；到 `finalizeNode` 持久化为止（原子写有回归）；iPhone / Android 只核对入口行号，不进入其循环；不进入提供方适配器与第三方库。

覆盖清单（读过并纳入）：`shared/agent/internalRouting.js`（全部）、`shared/agent/turn.js`（状态字段与副作用分支）、`src/services/chat/execution/invokeModelNode.js:128–262,380–470`、`src/services/chat/chatExecutionRunner.js`（节点装配）、`src/services/chat/sendChatMessage.js`（入口函数名）、`src/http/chatRoutes.js`、`src/agents/team.js`（全部）、`src/agents/delegate.js`（全部）、`src/agents/handoff.js`、`src/agents/memberBackground.js`、`src/agents/subAgent.js`（导出与预算 / 工具 / 深度相关行）、`src/runtime/runBudget.js`（默认值与测试）、`src/tools/executor.js:138–139,333`、`src/tools/permissions.js`（超时与作用域）、`desktop-ui/executionPanel.js`、`desktop-ui/translations.js:18–21`、`shared/protocol/agent-loop.json`、`docs/internal-routing-and-scene-20261104.md`、`docs/agent-capability-audit-20261027.md` §2.4。

未覆盖与原因：`prepareNode.js` 内部（只用其输出 `promptTools` / `searchPlan`）；`shared/agent/goal.js` / `completion.js` 的核验细节（10-23 / 10-27 已有专项与 184 项测试）；iPhone `AgentLoop.swift` 与 Android `SharedChatAgent.kt` 的成员循环（由各端测试与 conformance 覆盖，本机未装真机）；MCP 工具的能力声明是否足以支撑 A1 的动态目录（需要逐服务器核对，属实施阶段）；团队模式在普通聊天中的真实并发表现（需真实模型多次运行）。

## 8. 可重复的验证命令

```bash
cd "/Users/mortred/Desktop/melo/Melo Desktop Project"
MELO_TEST_MODE=1 MELO_HOME=$(mktemp -d) node --test shared/agent/internalRouting.test.js src/services/chat/chatExecutionRunner.test.js src/agents/team.test.js src/agents/collaboration.test.js
grep -rhoE "^\s*id: '[a-z_]+'" src/tools/builtins/*.js | sort -u          # 内建工具清单，对照 internalRouting.js 的 jobs
zsh .tmp/agent-orchestration-audit-20261104/run-audit-probe.sh            # 桌面运行时重跑探针（需服务在 43127）
node .tmp/agent-orchestration-audit-20261104/analyze-live-test.mjs .tmp/agent-orchestration-audit-20261104/live-bigbang .tmp/melo-home-user/desktop/execution-scenes
```

## 9. 证据

`.tmp/agent-orchestration-audit-20261104/`：`live-bigbang/`（探针事件流 `events.jsonl`、`console.log`、`reply.md`、`done.json`、`exit.txt`）、`permission-approvals.log`（如有）、脚本副本 `melo-live-test.mjs`、`analyze-live-test.mjs`、`approve-readonly-browser.sh`、`run-audit-probe.sh`。执行场景：`.tmp/melo-home-user/desktop/execution-scenes/<探针 runId>.json`。测试输出见 §1。
