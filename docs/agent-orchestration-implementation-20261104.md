# 隐藏子 Agent 编排层：方案 A 实施记录（2026-11-04 起）

用户选定[审计](agent-orchestration-audit-20261104.md)§6 的方案 A：在现有内部岗位路由上分五个阶段补齐——A1 岗位目录动态化、A2 预算分层、A3 并行分派、A4 审批预筛、A5 岗位模型与成员背景。每阶段独立链路、独立回归、独立提交；本文随阶段追加，证据目录 `.tmp/agent-orchestration-audit-20261104/`。

## A1 岗位目录动态化

### 意图

岗位工具白名单原来只写在共享核心（`shared/agent/internalRouting.js` 的 `jobs`），桌面 33 个内建工具只有 11 个能进岗位。A1 让宿主按工具自己的声明给出"建议岗位"，共享核心在静态白名单之外采纳建议，但保留拒绝名单与请求策略过滤。手机端不传建议，行为不变。

### 执行链路

1. `src/services/chat/execution/prepareNode.js:createPrepareNode` 产出 `graphState.promptTools`（工具对象：`id`、`capability`、`uiModule`、MCP 的 `readOnly`、技能 `skill:` 前缀）。
2. `src/services/chat/execution/internalRoles.js:internalRoleSuggestions(tools)`（新）→ 对每个工具 `suggestInternalRole(tool)`：
   - 拒绝：`route_task`、`delegate`、`agent`、`melo_escalate`、`development_job`、`fake`、`skill:*`；
   - `mcp:*`：`readOnly === true` → 检索，否则 → 执行；
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

### 执行链路（计划，实施后按实际修订）

1. 主 Agent 一轮回复 → `roundSession.parse` → 若全部调用都是 `route_task`（一个或多个），逐个 `startInternalJob`（共享校验不变：岗位在目录内、任务 ≤ 3000 字、callId 唯一、≤ 6 项、不重复）；混有其他工具时整轮 `route_task` 以 `ROUTE_DENIED` 拒绝，其他工具照常执行。
2. 新模块 `src/services/chat/execution/internalMembers.js:runInternalMembers({ jobs, … })`：
   - 预算：`remaining = budget.maxInputTokens − used.inputTokens`；若 `remaining − LEAD_RESERVE < MIN_MEMBER_SHARE` 不启动成员，直接交回 `partial` 交接（"主 Agent 预算保留"），避免把收尾额度吃光；否则 `share = min(MEMBER_INPUT_SHARE, remaining − LEAD_RESERVE)`，`narrowBudget(budget, { maxInputTokens: share })` 作为成员子池（用量仍计入父池）。
   - 调度：`research` / `lookup` / `calculate` 为只读岗位，按 `INTERNAL_PARALLEL_LANES` 并发；`execute` 岗位在只读成员全部结束后串行运行，且同一轮只运行一个。
   - 成员：`runWithRequestContext({ …ctx, budget: child }, () => runSubAgent({ task: job.task, roleSystem: job.system（新增可信系统段）, background: 原始目标参考 + buildMemberBackground, allowedToolIds: job.tools, extraTools: MCP + 技能, config: delegatedModelConfig, replyFn: 原始 reply 依赖, maxIterations: MAX_MEMBER_ROUNDS, roleId: 'job-N', depth: 1, signal, sseEmitter: 包装后带 actorName, chatId, workspacePath, chatSource, projectId, onProviderResponse → modelResponses }))`。
   - 事件：`internal:N` 流水线 running / completed / interrupted 不变；成员操作 ID 由 runSubAgent 的 `executionPrefix` 生成 `role:job-N:<轮>:<callId>`。
3. 回到主循环：对每个 job `internalHandoff({ job, answer, observations: result.meta.observations, limited })`，`limited` 取自成员 `meta.exhausted / aborted / stopReason`；成员观察以 `job-N:` 前缀并入主 `coreTurn.observations`；`coreTurn.update('feedback', { internalRouting: true, successfulEffects, uncertainEffects })` 把成员的副作用指纹并入主回合（共享 `turn.js` feedback 事件新增两个可选数组字段，旧宿主不传即原行为）；`functionSession.append(leadMessages, turn, pairs)` 把全部交接作为工具结果接回。
4. 用户补充、模型升级、取消：成员在一轮内被等待完成；取消经 `signal` 传入 runSubAgent（每轮检查 + 工具信号）；补充在下一轮主 Agent 请求前合并。

### 审计边界与停止条件

(a) 共享状态：主 `coreTurn`（观察、副作用指纹）、run 预算父子池、请求上下文（成员以 `runWithRequestContext` 派生，不改父上下文）；(b) 异常：成员异常由 runSubAgent 收敛为 `{ ok:false, output }`，不抛到主循环；主循环 `startInternalJob` 失败仍是工具结果；(c) 契约：`turn.js` feedback 事件可选字段（三端同一 bundle，Swift / Kotlin 不传）。停止：到 `executeToolCalls` / 审批为止；不改 iOS / Android 的内联单成员实现（记录为宿主差异）。

### 计划的回归

既有：`subAgent.test.js`（白名单、深度、预算、取消）、`collaboration.test.js`、`chatExecutionRunner.test.js` 的路由端到端。新增（计数器型，不用永不 resolve 的 mock）：两名只读成员同轮并发（并发峰值 ≥ 2）；执行成员在只读成员后串行；成员多轮不消耗主 Agent 轮数（主上限 3 轮、成员 5 轮仍完成）；成员份额耗尽 → partial 交接、主 Agent 继续；主 Agent 保留额度不足 → 不启动成员；取消中成员的工具不再执行（计数器）；成员成功写入的指纹并入主回合 → 主 Agent 重复同一写入被 `ALREADY_EXECUTED` 拒绝；混合调用整轮拒绝。
