# 最近主线改动复核（2026-11-05，Codex）

## 结论与源码范围

审计基准 `afdcce18e548746e957233043357470ec0316add`，开始时 master 与本机 origin/master 跟踪引用一致、工作树干净；未额外读取 GitHub。本轮只审计、记录，不修产品、不安装、不推送、不运行 git pp。

用户说“刚刚 Codex 的改动”。实际提交分两批：Codex 的内部岗位路由 `b80ade3`、模型连接 `b148a3a` / `3379718` 已在昨晚安装；此后 `f1bbdc7..afdcce1` 共 51 个文件的主要产品改动署名 Claude（`afc9992`、`a1b56f8`、三处真实探针修正、`f6de67a`、`4e56677`）。本报告以当前组合实现为准，不把作者称呼当作范围或质量结论。

近期改动实现了：多 API 连接及单对话切换、Key 分两次保存修复；内部检索 / 读取 / 计算 / 执行岗位；桌面独立子循环及只读并行；任务级授权卡；岗位选择模型连接；限额收尾证据优先分配。方向合理，但当前组合确认 **7 项缺陷，另有 2 项配置 / 跨端遗漏**。现有 16 文件、324 项定向回归全过，新反例仍触发缺陷；不能据现有 GREEN 宣称边界闭合。

## 方法、链路与边界

已读 `AGENTS.md`、`CLAUDE.md`、`MELO_DEVELOPMENT_STANDARD.md`、总览与专项记录；使用 `architecture/modules.json` 及 `npm run scope`，再读实际 diff 和函数实现。

1. 分工执行：`prepareNode → invokeModelNode:createInvokeModelNode → internalRouteCatalog/startInternalJob → internalMembers:runInternalMembers → subAgent:runSubAgentLoop → executor:executeTool → createCoreTurn.results/receipt → internalHandoff → 主循环 observation/feedback → goal:reviewGoal → finalize`。共享状态是请求能力、预算、工具副作用指纹、证据账本与审批桶；普通 provider 异常从 subAgent 抛到 internalMembers。
2. 授权：`prescreenApprovals → checkPermissionRule/requestTaskScopeApproval → SSE task_scope → approvals feature → /api/tools/permission-response → resolvePermission → executor 再校验 → chatExecutionRunner finally 清理`。检查主 Agent 的智能强档门槛与成员绕行，未把“模型档位策略”混称为“能力权限”。
3. 模型连接：桌面 `jobModelChoices/agentProfilePatch → normalizeCollaboration → jobConnectionConfig → delegatedConfig → createFunctionCallingSession → replyFn`；同时复核 `saveLlmProfile` 两阶段保存修复与 iOS Keychain 读取失败分支。
4. 跨端：`sync.schema → refreshAgentSettings → agent-settings-v1 → iOS AgentSettingsProjection.validated/apply`；核对昨晚安装源码 `882eba7` 的旧契约。iPhone `AgentLoop` 与 Android `SharedChatAgent` 的内联成员控制流只做静态核对。
5. 证据：`fetch_url(offset) → completionObservation → deliveryEvidence → limitDelivery/goalReview`，检查同 URL 不同分页窗口。

停止条件：跟到真实共享循环、执行器入口、线协议验证和 UI 配置来源；工具副作用以临时目录中的计数器替代，模型以确定性回包替代，不调用真实账号 / 平台，不进入第三方 SDK 内部。未重新跑整个产品 gate、Swift / Android 编译、实体设备、真实网站、长期后台或现场 UI 点击；这些不能以本轮 Node 定向结果代替。之前安装与真实模型记录仅作定位，不算本轮验收。

## 发现（按影响排序）

### R1 · P1：副作用记录没有覆盖主 Agent 与所有成员；异常还会丢失成功回执

位置：`src/services/chat/execution/internalMembers.js:139–149`，`src/agents/subAgent.js:215,261–264`，`src/services/chat/execution/invokeModelNode.js:424–426`。

成员创建全新的 coreTurn，未继承父回合 / 兄弟成员的成功与不确定指纹。回流给主 Agent 的 feedback 只能保护主 Agent 自己，不能保护下一名成员；任务描述改几个字就可再次分派相同操作。另一个路径是工具已成功、下一次模型请求断线：subAgent 抛出后，被改成只有 `ERROR` 的 result，observations / effects 丢失。

反例：完整 `runChatAgentExecutionGraph` 中，两名串行成员对同一参数写入，底层计数 **2**；另一反例成员写入成功后模拟断线，主 Agent 补做，底层同样 **2**，最终均 completed。原有 operationLedger 不为普通聊天自动提供跨成员防重（taskId 为空）；不应依赖这层兜住。

建议：整轮共用成功 / 不确定操作账本，成员启动与每次执行均检查；所有退出方式返回部分 observations、effects 和 completion。回归应覆盖成员→成员、成员→主、主→成员及断线 / 取消，断言真实执行计数。

### R2 · P1：成员自述被升格为“已执行证据”，零执行也能 completed

位置：`src/services/chat/execution/invokeModelNode.js:420–422` → `shared/agent/goal.js:80–94`。

所有非空 memberReport 一律记为 `ok:true, executed:true`，包括 partial / unverified。目标检查的 validEvidence 只校验这两个标志和非空正文，没有排除 handoff。这样“成员说做完”可替代真正工具回执，违背本轮的完成核验目标。

反例：成员没有调用任何工具，自己的检查明确 partial；主检查引用 `job-1:report`，完整主循环返回 **completed**，底层写入计数 **0**。

建议：报告留作说明，不能独立证明外部事实或副作用；报告的事实必须引用实际工具 / 页面证据 ID，父核验追溯这些 ID。保留报告内容与禁止把它冒充执行凭证是两件事。

### R3 · P1：新岗位配置不兼容昨晚安装的手机契约

位置：`shared/protocol/sync.schema.json:1321`，`mobile-sync/agentSettings.js:18–34`，`src/http/mobileSyncRoutes.js:61–75`，`ios/Melo/AgentProfile.swift:361–369`。

新增 `collaboration.jobModels`，但仍使用 `agent-settings-v1`，未协商旧端能力、未做兼容投影。`882eba7` 的 `agentCollaboration.additionalProperties=false`，不接受该字段。只要在桌面选一次岗位连接，旧手机就拒收这份 Agent 设置扩展。

反例：使用真实 `refreshAgentSettings` 生成 payload，当前契约接受，昨晚安装契约报 **Invalid workspace sync schema**。这是旧契约回放，不是操作用户手机。iPhone `ChatStore.syncAgentSettings` 单独 catch，因此这里确认的是 Agent 设置待同步，**不是全部聊天数据同步都中断**；旧数据并未被删除。

建议：版本 / 能力协商、旧端兼容投影与待同步保留；新增“当前桌面 × 上一版手机 / 同步服务”的回归，不能只让三份最新生成器互相通过。

### R4 · P2：内部执行成员绕开智能模式“副作用必须强档”门槛

位置：`src/services/chat/execution/invokeModelNode.js:401–431,490–492`，`src/services/chat/execution/internalMembers.js:139–142`。

直接工具调用经过强档判定，route_task 在这段之前分流并 continue。成员拿到低档连接后，subAgent / executor 没有同等档位判定。

反例：完整主循环的智能判断选 lower；模型随后派 execute 成员调用 write 计数工具。写入计数 **1**，全部模型请求仍为 lower，未升级 higher。这是模型档位策略旁路，**没有证明可以绕过 Agent 能力或 OS 授权**。

建议：将最低档要求传入成员执行上下文，在实际 effect 判定处统一执行；岗位自选连接也必须明确如何满足这个下限。

### R5 · P2：预算延长了，主循环截止时间没有延长

位置：`src/services/chat/execution/internalMembers.js:43–57` → `src/services/chat/execution/invokeModelNode.js:190–192` → `shared/agent/turn.js:50`；另有 `chatExecutionRunner.js:94` 的宿主硬上限。

主 coreTurn 初始化时将剩余时间固化为 deadline，派成员后只扩 runBudget。反例虚拟时钟：30 分钟预算增加 5 分钟，31 分钟时 budget 还剩 **240000 ms**，coreTurn 已是 **blocked / DEADLINE_EXCEEDED**。此外默认宿主 maxMs 为深度任务 45 分钟，而累计扩展可能宣称 50 / 65 分钟。

建议：统一有效截止时间，或让共享循环显式接收受校验的延长事件；预算回执必须显示真实可用上限。补虚拟时钟交叉测试，不依靠漫长真实等待。

### R6 · P2：同一 URL 的不同分页被当作重复内容丢掉

位置：`shared/agent/evidence.js:15–28`；调用来源 `src/tools/builtins/fetchUrlTool.js:184,768`。

去重只按 URL 选最长正文，其他记录最多留 160 字。fetch_url 已支持 offset，同 URL 可以对应不同页段，而不是重复读取。较短页段里 160 字后的独有事实会从收尾证据消失。

反例：同一天气表两次读取，第一段含 OCT31、第二段含 NOV01；48k 预算充足，第一段仍只剩 **160 字**，OCT31 事实丢失，NOV01 保留。不能仅靠建议模型“再分页”解决这一层。

建议：按内容哈希 / 窗口范围去重，保留互不重叠内容及原 truncated 状态；增加同 URL 不同 offset、重复全文、更新内容三种夹具。

### R7 · P2：岗位切连接只换五个字段，工具能力等仍来自旧连接

位置：`src/services/chat/execution/internalMembers.js:88–94` → `src/tools/toolProtocol.js:63–74`，`src/agents/subAgent.js:172–173,245–250`。

新的连接解析只覆盖 authMode / baseUrl / model / key / protocol，保留旧 modelCapabilities / modelMetadata 等。subAgent 组装真实模型请求时也未完整传递连接能力快照。现有岗位测试只断言模型和 Key，没有覆盖能力参数与实际协议。

反例：所选连接明确配置 `tools:false`，其正确解析是 XML；经 jobConnectionConfig 后变成原生 chat-completions，可能给不接受 tools 的接口发原生工具定义。另一个已记录行为是未知 / 未填模型的连接静默回退对话连接，界面“当前不可用”与实际用别的连接不够明确。

建议：统一连接解析入口，完整传递所选连接快照，再由传输按该连接能力编译请求；不可用连接需要明确回执。用同地址不同能力、不同协议、不同上下文窗口的出站夹具验证。

## 硬编码与双端遗漏

1. **运行策略仍写死，设置的含义不一致。** `shared/agent/internalRouting.js:19–20` 的 6 次分派 / 6 工具轮；`internalMembers.js:21–41` 的 3 并发、120k token、60k 保留、5 条搜索 / 3000 字等未进统一契约或 Agent 设置。UI 紧邻岗位模型的“成员轮数 / token 上限 / 超时”实际用于 delegate，内部岗位成员不读它们。固定默认值本身合理，但应集中配置、明确作用域、尊重用户明确上限。静态名单还绑定 `mcp:melo-public-media/...` 等服务 ID；换 ID 的同类只读 MCP 不会自动进入研究岗。这是策略硬编码，不是固定了某个模型名。
2. **手机没有实现这次新增编排。** iPhone `AgentLoop.swift:308,514–523`、Android `SharedChatAgent.kt:275–300` 仍是单成员内联；没有桌面的独立预算 / 并行 / 岗位连接执行和对应设置入口。文档已主动说明此边界，不能把“生成共享 bundle / 校验字段通过”当作功能与 UI 对齐。另，任务卡当前申请整个岗位工具；拒绝任务卡仍继续逐项询问，此行为已在设计和测试中明写，未当作新发现的越权漏洞，但应明确按钮含义并缩小授权清单。

## 回归与复现

本轮实际执行 16 文件、324 项，全部通过，0 失败 / 跳过 / 取消：

```sh
MELO_HOME=/tmp/melo-review-isolated node --test --test-concurrency=4 \
  src/services/chat/execution/internalMembers.test.js src/services/chat/execution/internalRoles.test.js \
  src/services/chat/chatExecutionRunner.test.js src/agents/subAgent.test.js \
  src/tools/permissions.taskScope.test.js shared/agent/internalRouting.test.js shared/agent/limitDelivery.test.js \
  src/domain/agent/capabilities.test.js desktop-ui/features/agents/jobModelChoices.test.js \
  desktop-ui/features/approvals/taskScope.test.js desktop-ui/features/approvals/controller.test.js \
  desktop-ui/features/chat/controller.test.js src/providers/llmConnections.test.js \
  desktop-ui/llmConnections.test.js shared/agent/conformance.test.js mobile-sync/syncContract.test.js
```

独立反例不写入产品测试、不调用真实供应商。证据 `.tmp/recent-change-review-20261105/`：

- `probes.mjs / probes.json`：真实子循环计数、异常、虚拟截止时间、证据核验、分页和连接协议。
- `graph-probes.mjs / graph-probes.json`：真实主图四场景（重复写、断线重做、低档执行、零工具假完成）；模型与工具外部效果为夹具。
- `sync-probe.mjs / sync-probe.json`：旧安装版本与当前版本的契约交叉回放。
- `targeted.tap`：本轮 324 项结果。脚本使用 /tmp 隔离 home；不访问真实用户数据。
- 可重跑：`node .tmp/recent-change-review-20261105/probes.mjs`、`node .tmp/recent-change-review-20261105/graph-probes.mjs`、`node .tmp/recent-change-review-20261105/sync-probe.mjs`。

建议先修 R1 / R2 / R3，再处理 R4–R7，然后统一内部岗位配置和两端行为。已有 API Key 修复的相关定向回归通过；本轮没有发现其原来的两阶段保存问题复发，但没有重做原生点击或真实供应商授权验收。
