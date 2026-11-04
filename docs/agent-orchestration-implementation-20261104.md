# 隐藏子 Agent 编排层：方案 A 实施记录（2026-11-04 起）

用户选定[审计](agent-orchestration-audit-20261104.md)§6 的方案 A：在现有内部岗位路由上分五个阶段补齐——A1 岗位目录动态化、A2 预算分层、A3 并行分派、A4 审批预筛、A5 岗位模型与成员背景。每阶段独立链路、独立回归、独立提交；本文随阶段追加，证据目录 `.tmp/agent-orchestration-audit-20261104/`。

## A1 岗位目录动态化

### 意图

岗位工具白名单原来只写在共享核心（`shared/agent/internalRouting.js` 的 `jobs`），桌面 33 个内建工具只有 11 个能进岗位。A1 让宿主按工具自己的声明给出"建议岗位"，共享核心在静态白名单之外采纳建议，但保留拒绝名单与请求策略过滤。手机端不传建议，行为不变。

### 执行链路

1. `src/services/chat/execution/prepareNode.js:createPrepareNode` 产出 `graphState.promptTools`（工具对象：`id`、`capability`、`uiModule`、MCP 的 `readOnly`、技能 `skill:` 前缀）。
2. `src/services/chat/execution/internalRoles.js:internalRoleSuggestions(tools)`（新）→ 对每个工具 `suggestInternalRole(tool)`：
   - 拒绝：`route_task`、`delegate`、`agent`、`melo_escalate`、`development_job`、`fake`、`skill:*`；
   - `mcp:*`：非只读 → 执行；只读（含受管的图表 / 图示 / PDF 生成器与浏览器检视）留给主 Agent，检索岗位的 MCP 只保留共享静态名单里的公开媒体服务器（修订于当晚探针：43 个工具定义把成员份额吃光）；
   - 效果（`shared/agent/toolEffects.js:toolEffect(id, {}, tool)`）为 compute → 计算；
   - 浏览器动作、效果 write、能力含 writeFiles / runCommands / generateMedia、或能力是函数（按参数而定）→ 执行；
   - 能力含 network：效果 read / `uiModule === 'search'` / 只读 / 浏览器读取 → 检索，`device_location` → 资料读取，其余留给主 Agent；
   - 效果 read 且无能力或能力为 readFiles / knowledgeMemory → 资料读取；其余留给主 Agent。
   能力来源：`src/domain/agent/capabilities.js:declaredCapabilityRequirement`，未声明时用新导出的 `legacyCapabilityRequirement(id)`（原有 READ / WRITE / NETWORK 旧表的只读视图）。
3. `src/services/chat/execution/invokeModelNode.js:createInvokeModelNode` 第 140 行附近把建议作为第三个参数传给 `internalRouteCatalog(routeGoal, ids, suggestions)`。
4. `shared/agent/internalRouting.js:internalRouteCatalog(goal, tools, suggestions)`：每个岗位 = 静态列表 ∪ 该岗位的建议（只接受 `tools` 里有、不在任何静态列表、不在 `NEVER_ASSIGNED`、非 `skill:` 的 id，排序后追加），再经原有 `requestAllowsTool` 与检索策略过滤。`internalRouting({action:'catalog', suggestions})` 分发器同步透传。`startInternalJob` / `internalHandoff` 不变，成员拿到的 `job.tools` 即扩展后的列表，`phaseTools` 据此限制成员可见工具。
5. 共享核心打包：`npm run build:agent-core` → `shared/agent/dist/agent-core.js` 与 `ios/Melo/AgentCore/agent-core.js`（43 模块）；`shared/agent/conformance.test.js` 校验散列与隔离 bundle。

共享状态：无新增；建议只在一轮内由 `promptTools` 派生。异常：建议形状非法（非对象 / 值不是岗位名）被静默忽略，不抛错。契约：`internalRouting` 的 `catalog` 输入新增可选 `suggestions` 字段，旧调用方（iOS `AgentLoop.swift`、Android `SharedChatAgent.kt`）不传即原行为。

### 审计边界与停止条件

边界：(a) 共享状态——无；(b) 异常——无新抛出；(c) 契约——`internalRouting` catalog 的可选字段，三端都经同一份 bundle，Swift / Kotlin 调用方未改。停止：到 `startInternalJob` 为止（岗位列表只影响成员可见工具，审批与能力范围仍由 `src/tools/executor.js` 与能力范围在执行时判定，不随建议放宽）；不进入各工具实现。

### 覆盖与未覆盖

覆盖：`shared/agent/internalRouting.js`、`internalRoles.js`、`capabilities.js:37–63`、`invokeModelNode.js:128–145`、`shared/agent/toolEffects.js`、`src/tools/registry.js:bootstrapBuiltinTools`、`src/mcp/manager.js:416`（`readOnly` 来源）。未覆盖：各 MCP 服务器的 `readOnlyHint` 是否可信（审计已注明只是展示提示，非授权依据；执行成员仍走审批）；iPhone / Android 若要同样扩展需各自从本机工具表派生建议（未做，行为不变）。

### 回归

- 单元：`shared/agent/internalRouting.test.js` 新增"宿主建议只扩展、不覆盖静态列表 / 拒绝名单 / 策略"；`src/services/chat/execution/internalRoles.test.js`（新，接入 `src` 根目录发现）：声明规则逐条 + 真实注册表逐工具期望（bash / pdf / image / xlsx / knowledge → 执行，glob / grep / media_info / device_location → 资料读取，translate → 计算，浏览器读取 → 检索，browser_click / fill → 执行；delegate / development_job / clipboard / reminder / media_api 留给主 Agent）。本地 7 / 7。
- 一致性：`npm run build:agent-core` 后 `shared/agent/conformance.test.js` 155 / 155；`chatExecutionRunner.test.js` + `capabilities.test.js` 34 / 34。
- 门禁：共享边界按规则扩大为全部，快速档 `run-jJz2SQ`（579/579 个 JS 测试文件、JS 4847/4847、语法检查、生成器与依赖预检、共享渲染资源预检、Android JVM / Lint / Debug / Release、JS 回归、设置浏览器验收、Swift 回归，296.7 s）全绿；第一次 `run-rl3ibq` 因新增模块使 `architecture/modules.json` 过期在预检红灯，`npm run generate:module-map` 后重跑。

### 结果

A1 已落地并本地提交（见 PROGRESS 当日条目）。桌面岗位目录现在覆盖 bash / pdf / image / xlsx / knowledge / 浏览器动作（执行），glob / grep / media_info / device_location（资料读取），translate（计算），浏览器读取（检索），以及 MCP 只读 / 非只读工具；clipboard、reminder、media_api、委派、开发作业仍只归主 Agent。iPhone / Android 未传建议，行为不变。

## A2 + A3 + A5(背景) 成员独立运行：预算分层、并行分派、会话背景

### 意图

内部成员原来在主循环里"换一套消息"运行（`invokeModelNode` 的 job 模式）：成员每轮工具调用经同一个 `coreTurn.update('calls')` 计入主 Agent 的 40 轮上限，模型请求在同一个 run 池计费，一轮只能派一个成员。改为每个内部成员走 `src/agents/subAgent.js:runSubAgent`（已有：独立 `createCoreTurn`、`narrowBudget` 子池、`memberTokenLimit`、取消传递、`role:<id>:` 操作前缀、`deliveryEvidence` 观察），主 Agent 只收交接。由此：成员轮数不计主回合（A2）、成员有自己的输入 token 份额且主 Agent 保留收尾额度（A2）、一轮可派多名只读成员并发、执行成员串行（A3）、成员拿到有界会话背景（A5 的背景部分）。岗位模型可选连接（A5 的模型部分）需要设置界面与配置契约，本阶段不做，见"未覆盖"。

### 执行链路（已实施）

1. `invokeModelNode.js:createInvokeModelNode`：主 Agent 一轮回复经 `roundSession.parse` 后，若全部调用都是 `route_task`（一个或多个）且目录未关闭、分派数 < 6，逐个 `startInternalJob`（共享校验不变），每个 job 记 `index` 与 `id = job-N`；混有其他工具或目录已关闭时，`route_task` 以 `ROUTE_DENIED` 拒绝（说明"单独调用"），其他工具照常执行。节点不再有内联 job 模式：`finishJob`、成员轮计数、`job-N:` 调用 ID 改写、成员工具越界拒绝等分支全部移除。
2. 新模块 `src/services/chat/execution/internalMembers.js:runInternalMembers({ jobs, goal, background, config, extraTools, replyFn, signal, sseEmitter, … })`：
   - 预算 `memberShare(budget)`：`remaining = maxInputTokens − used.inputTokens − delivery.inputTokens`；`remaining − LEAD_INPUT_RESERVE(60k) < MIN_MEMBER_SHARE(20k)` 时不启动成员，直接交回 `partial` 交接并发 `internal:N interrupted`（"主 Agent 预算保留"）；否则 `share = min(MEMBER_INPUT_SHARE(120k), remaining − 60k)`，`narrowBudget(budget, { maxInputTokens: share })` 作为成员子池（用量仍计入父池）。
   - 调度：`research` / `lookup` / `calculate` 为只读岗位，`INTERNAL_PARALLEL_LANES(3)` 条道并发；`execute` 岗位在只读成员全部结束后逐个串行。
   - 成员：`runWithRequestContext({ …ctx, budget: child }, () => runSubAgent({ task: job.task, roleSystem: job.system, background: "Original user goal (reference only)…" + buildMemberBackground, allowedToolIds: job.tools, extraTools: 技能 + MCP, config: delegatedModelConfig, replyFn: turn._dependencies.createReply（未计费的原始依赖，子池由 runSubAgent 自己计费）, maxIterations: MAX_MEMBER_ROUNDS(6), roleId: job.id, depth: 1, signal, sseEmitter: execution_event 加 actorName, chatId, workspacePath, chatSource, projectId, onProviderResponse → modelResponses }))`；异常收敛为 `partial` 交接，不抛出。
   - `subAgent.js` 新增 `roleSystem` 选项（可信系统段，位于人设之后、通用约束之前；调用方 `instructions` 仍只进用户轮）与 `meta.effects`（成员回合的 successful / uncertain 指纹，经 `sharedAgentCore.js` 新增的 `effects` 读取器）。
   - 事件：`internal:N` 流水线 running / completed / interrupted；成员操作 ID 由 runSubAgent 的 `executionPrefix` 生成 `role:job-N:<轮>:<callId>`，流水线事件带 `actorName` 岗位名。
3. 回到主循环：对每个 job `internalHandoff({ job, answer, observations: result.meta.observations, limited })`，`limited` 取自成员 `meta.aborted / exhausted / stopReason ∈ {ROUND_LIMIT, BUDGET_EXHAUSTED, CANCELLED, DEADLINE_EXCEEDED, ERROR}` 或取消信号；成员观察以 `job-N:` 前缀并入主 `coreTurn.observations`（主 Agent 的目标核验可引用）；`coreTurn.update('feedback', { internalRouting: true, successfulEffects, uncertainEffects })` 把成员的副作用指纹并入主回合（共享 `turn.js` feedback 事件新增两个可选数组字段，旧宿主不传即原行为）；`functionSession.append(loopMessages, turn, pairs)` 把全部交接（或 `ROUTE_DENIED`）作为各自调用的工具结果接回。成员现在在自己的回合里做完成核验（多一次免工具请求），交接 `status` 仍只看真实回执。
4. 用户补充、模型升级、取消：成员在一轮内被等待完成；取消经 `signal` 传入 runSubAgent（每轮检查 + 工具信号）；补充在下一轮主 Agent 请求前合并。

### 审计边界与停止条件

(a) 共享状态：主 `coreTurn`（观察、副作用指纹）、run 预算父子池、请求上下文（成员以 `runWithRequestContext` 派生，不改父上下文）；(b) 异常：成员异常由 runSubAgent 收敛为 `{ ok:false, output }`，不抛到主循环；主循环 `startInternalJob` 失败仍是工具结果；(c) 契约：`turn.js` feedback 事件可选字段（三端同一 bundle，Swift / Kotlin 不传）。停止：到 `executeToolCalls` / 审批为止；不改 iOS / Android 的内联单成员实现（记录为宿主差异）。

### 回归

- 新增 `src/services/chat/execution/internalMembers.test.js`（计数器型）：两条只读车道并发峰值 = 2、执行成员等全部只读成员结束后才启动；成员子池上限 = 份额、子池不是父池对象；主 Agent 保留额度不足时成员零启动且交接 partial；成员抛错 → partial 不抛出；取消信号后成员零工作、交接 partial；`memberShare` 随剩余池变化。
- `shared/agent/internalRouting.test.js` 新增：feedback 导入成员指纹后，主回合对同一写入判 `ALREADY_EXECUTED` / `ALREADY_ATTEMPTED`，只读调用照常放行；非法指纹值被忽略。
- `src/agents/subAgent.test.js` 新增：`roleSystem` 进系统提示、调用方提示仍只在用户轮、`meta.effects` 形状。
- `src/services/chat/chatExecutionRunner.test.js`：原路由端到端改为成员各自核验（检查器三次：研究成员、计算成员、主 Agent，主 Agent 引用 `job-1:forecast` / `job-2:calc`）；新增"一轮两派并行回收"（两成员 running 事件都先于任一 completed，主 Agent 第二轮同时拿到两份交接）与"route_task 混用其他工具整轮拒绝、其他工具照跑、无成员启动"。
- 本地：上述文件 + conformance + sharedAgentCore.completion + agentLoopContract 共 193 项与 chatExecutionRunner 31 项全部通过；agent-core bundle 重建（43 模块）；`npm run generate:module-map` 收录新模块。
- 成员多轮不消耗主 Agent 轮数：按构造成立（成员在自己的 `createCoreTurn` 上计轮），主循环对成员轮不再调用 `coreTurn.update('calls')`；未另写夹具（主循环轮上限最小值由契约钳制，夹具无法构造 3 轮上限）。
- 门禁：快速档 `run-1Fcuen`（580/580 个 JS 测试文件、JS 4854/4854、Android 四项、设置浏览器、Swift 全部，288.9 s）全绿。

### 结果

A2 / A3 与 A5 的背景部分已落地并本地提交（`a1b56f8`）。

真实探针（重启桌面后同一道 BIGBANG 题，`live-bigbang-phase2/`，场景 `aefd0d9f6e85081b2aded8669ae001c8`，trace `66bb67c2…`）暴露一个真 bug：检索成员 1 在 7 s 派出、43 s 交回"未核实"，trace 里它的第一次模型请求就是 `limit-delivery`，`run.finished` 为 `BUDGET_EXHAUSTED`——`runSubAgent` 用 `memberTokenLimit(child, maxTokens ?? 32000)` 把成员输入 token 上限压到 32k、再扣 8k 收尾保留与 `maxTotalTokens` 口径下的输出保留，成员第一次带工具定义和原始目标背景的工作请求就超过 `admitModel` 允许值，直接进入收尾。主 Agent 随后自己抓页，161 s 再派成员时已触发 60k 保留不启动，174 s 预算耗尽，仍是 `LIMIT_DELIVERED`（1 met / 4 missing）。修正：`runInternalMembers` 把 `maxTokens: share`（≤ 120k）传给 `runSubAgent`，成员的输入与总 token 上限即其份额；成员 `execution_event` 的 id 改为 `job-N:` 前缀（之前只加 `actorName`，成员的 `model:N` 会并进主 Agent 同名阶段）。新增真实 `runSubAgent` 循环下的回归：成员上限 ∈ [20k, 120k] 且 > 32k，第一次请求是带 `Task:` 的工作请求而非 limit-delivery，事件全部带 `job-1:` 前缀。

第二次探针（`live-bigbang-phase2b/`，trace `48319190…`）：成员这次真的开工（4 次工作请求），但 120k 份额仍在 112 s 内用完：(1) A1 把所有 `readOnly` 的 MCP 工具（26 个 AntV 图表生成器、Playwright 检视、公开媒体）都归入检索岗位，成员每次请求带 43 个工具定义；(2) 成员全程用供应商托管搜索（`hosted-call`），未本地抓页，托管结果"无可读正文"；(3) 成员第 3 次回复已写明"巡演官网与主办方 FAQ 非空正文交叉核实 2026-10-31 悉尼 Accor Stadium 19:30"，而限额收尾把它改写成"候选线索、未核实"（审计 P2-10 的又一实例）。主 Agent随后自己抓页、再派成员时触发 60k 保留、184 s 预算耗尽，最终 0 met / 5 missing。修正 (1)：只读 MCP 不再自动归入检索岗位（见 A1 规则修订，`42e992d`）。

第三次探针（`live-bigbang-phase2c/`）：成员每次请求的工具定义降到 11 个，但成员 1 在 20 s 以 `Codex OAuth request completed without returning a final reply` 失败（供应商对成员请求只返回托管搜索项、没有消息体），成员 2 三次请求各带 74k / 8.5k / 70k 输入 token——供应商托管搜索（`hosted-call`）把搜索上下文整段重发，而托管结果在成员的观察账本里"正文全部为空"，自检不过、份额用完、交回 partial；主 Agent 第 26 s 已读到官方日程，限额收尾却把场次标为 missing（P2-10）。修正 (2)：`runSubAgent` 新增 `nativeWebSearch` / `nativeImageGeneration` 开关，内部成员一律关闭托管搜索与图像生成，只用本地 `web_search` / `fetch_url`（有界、可核验）；回归断言成员请求的两个开关为 false。(3) 限额收尾丢失已核实事实仍是独立缺陷，见审计 P2-10。主 Agent 一轮可派多名成员；只读成员并行、执行成员串行；每名成员有自己的回合与输入 token 份额，主 Agent 保留 60k 收尾额度；成员拿到原始目标与有界会话背景；成员副作用指纹回流主回合。未做：岗位模型可选连接（需要设置界面与配置契约，待产品决定）；iPhone / Android 仍是内联单成员实现（共享契约向后兼容，两端行为不变）。真实探针见下一节。

## A4 审批预筛与 A5 岗位模型：待用户选定的两个产品点

两项都会改用户可见的交互或设置，按规范 §1 / §4.5 先列方案评分，等用户选定再动手。

### A4 审批预筛

| 方案 | 做法 | 改动面 | 评分 |
| --- | --- | --- | --- |
| A4-1 审批卡片加"本次任务"作用域 | 主 Agent 派执行成员前，对该岗位里需要审批的工具发一张汇总卡（列工具与子任务）；用户批后登记为本轮任务级规则，成员命中不再弹，未批的仍逐个弹；主 Agent 永不代批 | `src/tools/permissions.js`（pending 条目带工具清单、`resolvePermission` 新作用域 `task`）、`src/server.js` 路由透传、`desktop-ui/features/approvals/view.js` 新卡片；iPhone / Android 卡片可先不做，记宿主差异 | 8 / 10 |
| A4-2 不改界面，只"早问" | 执行成员启动前，按岗位工具并行发标准审批卡让用户一次点完；`requestPermission` 支持"预授权票据"：同对话、同工具、同任务的下一次调用直接放行 | 只改 `permissions.js` 与 `internalMembers.js`，界面零改动；但卡片上看不到子任务说明 | 7 / 10 |
| A4-3 维持现状 | 成员调用时才弹，无人在场 120 s 超时 | 无 | 5 / 10 |

### A5 岗位模型

| 方案 | 做法 | 改动面 | 评分 |
| --- | --- | --- | --- |
| A5-1 Agent 设置页新增"内部岗位模型" | 每个岗位可选连接 / 模型（默认跟随对话），存 `agentProfiles[id].collaboration.jobModels`，三端契约字段同步 | 设置页 UI、`shared/protocol` 契约、三端读取 | 7 / 10 |
| A5-2 复用智能路由档位 | 智能模式下检索 / 资料读取岗位用"快"档，执行 / 计算跟随对话模型；非智能模式不变 | 只改 `internalMembers.js` 取连接的方式，无新界面 | 6.5 / 10 |
| A5-3 维持现状 | 所有岗位同一连接 | 无 | 5 / 10 |
