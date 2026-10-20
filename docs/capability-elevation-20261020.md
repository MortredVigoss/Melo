# Agent 能力临时提升与即时开启（2026-10-20，桌面端 + 共享规则）

范围：桌面端实现与双端共享的规则契约。iPhone 端由下一位工程师按第 9 节交接实现。入口：[总览](../MELO_OVERVIEW.md)、[后端架构](backend-architecture.md)。

## 1. 用户拍板的规则

1. **上限是 Agent 自己的设置。** 成员可以临时拿到父级（如 main）没有、但自己设置允许的能力；永远拿不到自己设置不允许的能力（除非用户按规则 4 即时开启）。成员有效能力 = (成员 ∩ 父级) ∪ (成员 ∩ 该成员在本上下文的有效授权)。
2. **超出父级必须用户在运行时点击确认**，例如「Builder 需要『修改文件』，Melo 没有这个能力 —— 仅本次任务 / 本项目 24 小时 / 拒绝」。从不静默放行。没有交互界面（远程渠道、无头、后台）时与以前完全相同地拒绝。
3. **授权会过期**：随运行结束（`run`），或 24 小时（`project`，绑定该项目；无项目时为 `chat`，绑定该对话）；随时可撤销，撤销对下一次工具调用生效。
4. **即时开启 Agent 自身缺少的能力**（main 或任何自身设置缺少该能力的 Agent，包括主循环）：「此 Agent（Melo）需要『运行命令』：仅本次 / 一直开启 / 拒绝」。「一直开启」通过正常的 Agent 修改命令（P1 回执）改设置，写本对话当前生效的作用域（全局或项目覆盖）；「仅本次」写一条运行级授权。成员自身设置缺少时弹的是这一种，而不是规则 2。
5. **授权账本是独立存储，不是知识/记忆**：模型工具不能读写，从不进入提示词；只能由用户在本机来源的 HTTP 路由上对一个进行中的请求 ID 做出决定而产生；能跨重启保存（项目级授权）并清理过期项；只在桌面本机，不同步到手机（手机有自己的账本）。
6. **新建自定义 Agent 默认只读起步**：读取文件、联网、知识与记忆开启；修改文件、运行命令、生成媒体、委派关闭；MCP/技能/连接器为空。新建流程提供「基于已有 Agent」。
7. 授权与即时开启的决定记入本次运行的执行场景与工具记录（谁、什么、范围、到期）。

## 2. 设计决定

| 问题 | 决定 | 理由 |
| --- | --- | --- |
| 规则放哪里 | `shared/protocol/agent-loop.json` 新增 `capabilityElevation` 节，夹具在 `fixtures.capabilityElevation` | 现有生成器 `npm run generate:agent-loop-contract` 已把除 `fixtures` 外的整份 JSON 嵌入 `ios/Melo/AgentLoopContract.swift`，无需新生成器、新 Swift 文件或 Xcode 工程改动；Swift 测试照旧从仓库读取夹具 |
| 能力的表示 | 原子（atom）：布尔能力键（`writeFiles`）或 `<list>:<id>`（`mcpServers:github`、`skills:x`、`connectors:y`） | 一次请求可能需要多个能力（远程 PDF 写入 = 修改文件 + 联网），列表能力需要带 ID；原子集合可直接比较、排序、写入账本与夹具 |
| 授权是否进入 scope | **不进入**。scope 携带 `elevation = {ceiling, parent, parentAgentId, base, surface}`，`base` 永不含授权；执行器每次调用都用无授权视图判断，被拒时才查账本或弹窗 | 撤销对下一次调用立即生效；成员派生时从父级的 `base` 起算，父级的授权不会被成员继承（每个 Agent 的授权只属于它自己） |
| 唯一卡口 | `src/tools/executor.js` 的能力检查（原 `CAPABILITY_DENIED` 产生处） | 主循环、委派成员、团队成员、技能、普通子 Agent 的所有工具调用都经过这里 |
| 可见性 | 有交互界面时，Agent 能看到「可以申请」的工具：已有能力 ∪ 自身上限（含其 MCP/技能/连接器）∪ 即时开启的布尔能力（不含委派）；没有界面时与以前完全相同 | 模型要先能调用，才能触发请求；委派还依赖协作设置（对象、深度），不做即时开启；上限之外的 MCP/技能/连接器仍不出现在工具列表里，避免大量工具定义 |
| 交互界面（surface） | 只有桌面 `/api/chat/send/stream`（`sendChatMessage` 收到真实 `sseEmitter` 且非 `background`） | JSON 路由、远程渠道、任务与后台都没有能显示卡片的人 |
| 已有授权在无界面上下文 | 生效（只是不会再弹新请求） | 授权本身就是用户的决定，范围由用户选（本次任务 / 本项目或本对话 24 小时） |
| 账本存储 | **独立文件** `<home>/desktop/capability-grants.json`，不是 `state.json` 集合 | 见第 4 节 |
| 「一直开启」写哪里 | 本对话生效的设置作用域：项目覆盖里有 `capabilities` 时写项目覆盖，否则写全局；项目覆盖与全局取交集，全局没有的能力项目覆盖无法单独开启，此时卡片不提供「一直开启」并说明原因 | 遵守「项目覆盖与全局取交集」这一既有规则；不在用户不知情时放宽全局 |
| 「一直开启」的同时 | 也写一条本次运行的授权 | 本轮的设置快照在开轮时已冻结，不加运行授权这次调用仍会被拒 |
| 手机提出的放宽 | 不变：同步来的放宽仍待桌面确认；本流程本身就是桌面上的点击，修改经正常 Agent 命令后作为桌面编辑同步出去 | 规则 4 |
| 超时 | `min(契约 promptTimeoutMs = 120 s, 运行剩余时间)`；运行截止先到 → `BUDGET_EXHAUSTED`；取消 → `ABORTED`；用户拒绝或超时 → `CAPABILITY_DENIED` 加「不要重试」提示 | 与工具授权弹窗一致，运行预算仍然有效 |
| 并发 | 同一运行、同一 Agent、同一决定类型、同一组能力的并发请求合并成一张卡片，一次点击放行全部 | 并行工具调用不该刷出多张相同卡片 |
| 声音是否随「基于已有 Agent」复制 | 与身份、人设一起，仅在勾选「同时复制身份、人设与声音」时复制 | 声音属于「这个 Agent 是谁」，默认不复制以免两个 Agent 难以区分 |

## 3. 判定（`src/domain/agent/capabilityElevation.js`）

纯函数，只依赖领域与契约：

- `effectiveScope({member, parent, base, grants, context, now})` → `{capabilities, base, ceiling, grantIds}`：`effective = base ∪ (ceiling ∩ 有效的超出父级授权) ∪ 有效的即时开启授权`；顶层 Agent 没有父级，超出父级的授权对它无效。
- `decideCapability({toolId, args, tool, member, parent, base, grants, context, now})` → `{decision, reason?, missing, effective, options?, projectOptionScope?, alwaysUnavailable?, wouldPrompt?, grantIds}`：
  1. 工具不在本运行的工具白名单 → `deny-ceiling`（`whitelist`）。
  2. 旧版（未迁移）Agent → `allowed`（与以前相同）。
  3. 有效能力已允许 → `allowed`（`base` 或 `grant`）。
  4. 求最小缺失原子集合（同样大小时优先上限内的组合）；没有任何组合能允许（未分类工具）→ `deny-ceiling`（`unclassified`）。
  5. 缺失项有上限外的 → `enable-own`；全部在上限内且有父级 → `elevate-beyond-parent`；全部在上限内但没有父级（被调用方收窄的顶层 scope）→ `deny-ceiling`（`narrowed`）。
  6. 没有交互界面 → `deny-no-surface`（附 `wouldPrompt`）。
  7. 选项：超出父级 `run / project / deny`（无项目时 `project` 的含义是本对话 24 小时，`projectOptionScope: 'chat'`）；即时开启 `run / always / deny`（项目覆盖且全局缺少时去掉 `always`）。
- `requestableCapabilities` 决定可见性；`capabilityPromptText`、`capabilityOptionLabel`、`elevationText` 取契约文案。

工具需要哪些能力沿用 `toolCapabilityAllowed` / `declaredCapabilityRequirement`（含 MCP 服务 ID、技能 ID）。连接器目前不经执行器（外部工具走审批流），原子语法与判定已覆盖，供以后接入。

## 4. 账本（为什么不是 state.json，也不是知识/记忆）

文件：`<home>/desktop/capability-grants.json`，`{ version: 1, grants: [GrantRecord] }`。写入：同目录临时文件 → fsync → rename；文件 0600、目录 0700；读取时逐条校验，未知字段丢弃；损坏文件改名为 `.corrupt-<time>` 并按空账本处理（只会少授权，不会多授权）。唯一写入者是 `src/services/agent/capabilityElevation.js`（`capabilityElevation.boundary.test.js` 检查导入关系）。

GrantRecord：`id`（`cg_<uuid>`）、`agentId`、`atoms`、`kind`（`elevate-beyond-parent` | `enable-own`）、`scope`（`run` | `project` | `chat`）、`runId`、`projectId`、`chatId`、`parentAgentId`、`toolId`、`requestId`、`decidedBy: 'user'`、`createdAt`、`expiresAt`、`bootId`（仅运行级）。

清理：每次读写都去掉已过期项和其他进程（重启前）留下的运行级授权；撤销直接删除；运行结束时（`sendChatMessage` 的 finally）删除该运行的运行级授权并关闭仍在等待的卡片。运行级授权另有契约上限 6 小时作兜底。

选独立文件而不是 `state.json` 集合：

1. `state.json` 是同步、导出、bootstrap 与派生索引的来源；独立文件在结构上保证授权不会进入手机同步、提示词、页面数据或 Markdown 导出，而不是靠每条路径记得过滤。
2. 授权写入不应推进状态修订号、触发 checkpoint 提交或派生索引。
3. 独立的 0600 权限；在数据目录下，文件安全门禁对 Agent 写入硬拒绝、读取需要用户审批。
4. 损坏时只影响授权（按空处理），不会波及主状态。
代价：不参与状态事务；写入是同步的读-改-写，单进程内不会交错（一个数据目录只有一个服务进程，由服务锁保证）。

不放进知识或记忆：知识与记忆会进入检索和提示词、会同步到手机，并且有模型可调用的工具能读写（知识工具、记忆写入）。如果授权在里面，模型可以读到、伪造或被提示注入改写；授权必须且只能来自用户对一个进行中请求的点击。

## 5. 流程

```text
工具调用 → executeTool：无授权视图允许？── 是 → 运行
                │否
                ▼
        decideCapability（实时读取该 Agent 在本运行/项目/对话的有效授权）
          allowed（授权覆盖）→ 以提升后的 scope 运行（base 仍不含授权），结果 meta 记录
          deny-*            → 与以前相同的 CAPABILITY_DENIED（meta 记录判定）
          prompt            → 读取 Agent 名称与设置作用域 → 合并相同请求 →
                              SSE capability_request + 执行场景阶段「临时授权」(running) →
                              等待 min(120 s, 运行剩余)；取消/截止/超时各自结束 →
                              POST /api/capability-requests/respond {requestId, decision}
                                run     → 运行级授权
                                project → 本项目（或本对话）24 小时授权
                                always  → updateAgentProfile（P1 回执，preserveSelection）+ 运行级授权
                                deny    → CAPABILITY_DENIED + 「不要重试」提示
                              → 重新判定 → 运行；执行场景阶段完成/失败；capability_request_closed
```

SSE `capability_request`：`requestId, kind: 'capability', decision, agentId, agentName, parentAgentId, parentName, capabilities[], capabilityLabel, toolId, prompt, reason, options[{id,label}], note?, projectOptionScope, settingsScope, chatId, runId, turnRequestId, projectId, expiresAt`。`capability_request_closed`：`requestId, agentId, reason`（granted / denied / timeout / budget / aborted）。

HTTP（`src/http/capabilityRoutes.js`）：

| 路由 | 权限 | 说明 |
| --- | --- | --- |
| `POST /api/capability-requests/respond` `{requestId, decision}` | local-write | 校验 UUID 与决定词；只接受该请求提供的选项；未知、已结束或属于其他数据目录 → 404；重复点击 → 409 |
| `GET /api/capability-grants[?agentId=]` | local-read | 有效授权（含标签），不返回 `bootId` |
| `POST /api/capability-grants/revoke` `{id}` | local-write | 未知 → 404 |

桌面界面（`desktop-ui/features/approvals/`）：卡片沿用工具授权弹窗的样式，`role=dialog`、`aria-modal`、标题与说明关联、按钮组有图例，新卡片出现时焦点移到第一个选项（只移一次）；请求已结束时提示「没有保存任何授权」；「一直开启」后重新读取页面数据。「临时授权」列表在每个 Agent 的设置页（表单之外，因为表单在编辑前是只读的）和 自定义 → 权限与隐私 中，可撤销。新建 Agent 的页头有「只读起步（推荐）/ 基于「X」」选择、勾选「同时复制身份、人设与声音」及一行说明。五种语言在 `desktop-ui/translations.js`（同时生成 `ios/Melo/Localizable.xcstrings`）。

## 6. 安全推理

- 授权只能由 `respondCapabilityRequest` 对注册表中的进行中请求产生；`createGrant` 只接受进行中的请求 ID。请求 ID 只出现在桌面 SSE 流里，不进提示词和工具输出；没有列出进行中请求 ID 的路由。
- 工具输出、模型文本里的「已批准」「decision: always」「requestId=…」不产生任何效果（`executor.capabilityElevation.test.js` 的提示注入用例）。
- 数据目录下的账本对 Agent 的文件写入硬拒绝（`sensitivePaths` 的 `melo_internal`），读取需要审批。
- 成员永远拿不到上限以外的能力，除非用户按规则 4 点了即时开启；超出父级的授权在成员设置收回该能力后立即失效（判定时与上限求交）。
- 没有交互界面时既不显示也不扩大可见工具，拒绝结果与以前逐字相同。
- 路由在本机来源检查之后，严格校验输入；跨数据目录的请求 ID 被拒绝。

## 7. 不在本次范围

- 图片任务快速路径（`chatExecutionRunner` 内的图片任务分支）与供应商原生工具（原生网页搜索、原生生图）在模型请求前按基础能力决定，不弹卡片；函数工具 `web_search`、`image` 照常可申请。
- 用户在界面上显式启动的团队（team plan），主 Agent 没有委派能力时仍直接拒绝。
- 手机端实现（第 9 节）。

## 8. 测试

| 层 | 文件 | 覆盖 |
| --- | --- | --- |
| 契约 + 领域 | `src/domain/agent/capabilityElevation.test.js` | 29 条判定夹具、文案与到期夹具、原子语法、授权有效性、上限、最小缺失集合、可见性、scope 描述在收窄/成员切换/实时视图中的传递，1500 组伪随机不变量 |
| 账本 | `src/persistence/capabilityGrantLedger.test.js` | 记录校验、过期/重启前运行级授权清理、容量、原子写入、0600/0700、损坏文件隔离 |
| 服务 | `src/services/agent/capabilityElevation.test.js` | 提示 → 运行级授权 → 下次运行再问；项目授权跨重启、24 小时到期（虚拟时钟）；无界面；上限；超时/截止/取消；合并；撤销与运行结束；伪造与跨数据目录；「一直开启」写全局 / 项目覆盖 / 不提供 |
| 边界 | `src/services/agent/capabilityElevation.boundary.test.js` | 账本只由服务写；服务只被执行器、路由、轮次生命周期引用；其他模块不出现账本文件名 |
| 运行时 | `src/tools/executor.capabilityElevation.test.js` | 经真实执行器与成员路径的全部规则（含提示注入、撤销中途生效、合并、取消、审计进入工具记录） |
| HTTP | `src/http/capabilityRoutes.http.test.js` | 校验、404/400/403、真实服务分发 |
| 新建 Agent | `src/services/agent/agentCreateStarter.test.js`、`src/domain/agent/capabilities.test.js` | 起步集、「基于已有 Agent」复制范围、不复制渠道/令牌、之后独立、已有 Agent 不变 |
| 界面 | `desktop-ui/features/approvals/controller.test.js`、`features/agents/controller.test.js`、`features/chat/controller.test.js` | 卡片、无障碍、决定、错误、列表与撤销、语言切换、与契约文案一致、新建流程、事件入队出队 |
| 浏览器（Mac） | `desktop-ui/capabilityElevation.browser.test.js` | main 委派 Builder → Builder 需要『知识与记忆』→ 卡片 → 本对话 24 小时 → `search_history` 运行 → Builder 设置页列出 → 撤销 → 账本为空；无页面错误 |

## 9. 手机交接（下一位工程师）

契约：`shared/protocol/agent-loop.json` → `capabilityElevation`（已嵌入 `ios/Melo/AgentLoopContract.swift`，`AgentLoopContract.shared.raw["capabilityElevation"]`），夹具 `fixtures.capabilityElevation.{decisions,prompts,expiries}`。

手机必须对齐的决定：

1. 判定顺序与结果词表完全按第 3 节；`decisions` 夹具里的 `input` 用原子数组表示能力，期望值 `effective`、`missing` 是按契约顺序（布尔键顺序，然后 MCP 服务、技能、连接器按 ID）排列的原子数组。
2. 有效能力公式、授权生效条件（同 Agent；`run` 同运行、`project` 同项目、`chat` 无项目时同对话；未撤销；`expiresAt > now`）、`grantExpiry` 时长（运行级 6 小时兜底，项目/对话 24 小时）。
3. 授权不烘焙进 scope；每次工具调用实时判定；成员从父级的无授权基础能力起算。
4. 可见性：只有能弹卡片时才显示可申请的工具（`jitVisible` 不含委派；上限外的列表能力不显示）。
5. 没有交互界面（后台、快捷指令、远程）时与现在逐字相同地拒绝。
6. 选项与文案用契约原文；五种语言的界面文案已在 `ios/Melo/Localizable.xcstrings`（与桌面同一份目录）。
7. 手机自己的账本：本机文件（建议 `Application Support/…/capability-grants.json`，完全保护类），不进 iCloud/同步、不进提示词和记忆，只能由用户点击产生。
8. 新 Agent 起步集 `newAgentStarter`；「基于已有 Agent」的复制范围同桌面（能力、协作、上下文来源、模型；勾选才复制身份/人设/声音；从不复制渠道、令牌、头像、名称）。注意手机的「这台手机上」设备能力（联网、生成图片、手机数据）是独立的手机授权，不由本契约改变。
9. 手机上的「一直开启」若修改的是桌面同步来的 Agent 设置，仍走现有「手机提出的放宽需桌面确认」流程；本机运行可先用运行级授权继续。

TODO（手机）：在 `ios/Tests/SharedContractTests.swift` 增加 `capabilityElevation` 夹具运行器（需要先有 Swift 版 `decideCapability`）；`ChatStore` 审批队列接入卡片；手机账本与撤销界面。

## 10. 验证记录（2026-10-20，用户 Mac）

- 日常 `npm test -- --base bbe8096`：日常选定范围通过（JS 4139/4151，12 跳过；语法；文档链接；两项设置浏览器验收；共用渲染 4/4；32 组 Swift，`SharedContractTests` 读取新契约通过）。第一次运行发现两处需补的派生项：新的源码读取测试未登记（已登记到 `module-annotations.json`），手机场景包的目录散列过期（已重建，同时补上另一线程界面统一留下的 `executionPanel.css` 散列）。
- 真实浏览器（Mac Chrome）：`capabilityElevation.browser.test.js` 通过；`agentSettings`、`agentSettingsSecurity`、`agentPersona`、`committedSave`、`language`、`liveRun` 浏览器回归通过。
- 在线只读检查：退出并重新打开用户的 Melo（确认只有一个 `MeloDesktop` 与一个 `node src/server.js`，健康检查通过）；用浏览器打开 Agent 页、切换「基于「Main agent」」、打开 自定义 → 权限与隐私，所有非 GET 请求在浏览器内拦截（实际 0 次），页面导航只改写 `GET /api/bootstrap` 的返回。结果：0 控制台错误、0 页面错误、0 失败响应；用户现有 6 个 Agent 均出现在起点选择中；用户数据未被写入。
- 隔离 home 与 fixture 模型；没有用真实模型、真实委派或实体手机验收。
