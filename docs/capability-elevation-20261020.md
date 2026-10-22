# Agent 能力临时提升与即时开启（2026-10-20，桌面端 + 共享规则 + iPhone）

范围：桌面端实现、双端共享的规则契约，以及 iPhone 端实现（第 9 节，同日由接手工程师完成）。入口：[总览](../MELO_OVERVIEW.md)、[后端架构](backend-architecture.md)。

## 1. 用户拍板的规则

1. **上限是 Agent 自己的设置。** 成员可以临时拿到父级（如 main）没有、但自己设置允许的能力；永远拿不到自己设置不允许的能力（除非用户按规则 4 即时开启）。成员有效能力 = (成员 ∩ 父级) ∪ (成员 ∩ 该成员在本上下文的有效授权)。
2. **超出父级必须用户在运行时点击确认**，例如「Builder 需要『修改文件』，Melo 没有这个能力 —— 仅本次任务 / 本项目 24 小时 / 拒绝」。从不静默放行。没有交互界面（远程渠道、无头、后台）时与以前完全相同地拒绝。
3. **授权会过期**：随运行结束（`run`），或 24 小时（`project`，绑定该项目；无项目时为 `chat`，绑定该对话）；随时可撤销，撤销对下一次工具调用生效。
4. **即时开启 Agent 自身缺少的能力**（main 或任何自身设置缺少该能力的 Agent，包括主循环）：「此 Agent（Melo）需要『运行命令』：仅本次 / 一直开启 / 拒绝」。「一直开启」通过正常的 Agent 修改命令（P1 回执）改设置，写本对话当前生效的作用域（全局或项目覆盖）；「仅本次」写一条运行级授权。成员自身设置缺少时弹的是这一种，而不是规则 2。
5. **授权账本是独立存储，不是知识/记忆**：模型工具不能读写，从不进入提示词；只能由用户在本机来源的 HTTP 路由上对一个进行中的请求 ID 做出决定而产生；能跨重启保存（项目级授权）并清理过期项；只在桌面本机，不同步到手机（手机有自己的账本）。
6. **新建 Agent 默认拥有全部基础能力**（用户 2026-10-22 改定，原为只读起步）：读取文件、修改文件、运行命令、联网、知识与记忆、生成媒体开启；委派只有主 Agent 默认开启；MCP/技能/连接器为空。新建流程提供「基于已有 Agent」。两个以上调研成员同时运行时，它们那一轮不写入（关闭修改文件、运行命令、生成媒体，保留 MCP/技能/连接器），否则写入租约会让它们排队；单独运行或顺序执行的成员保留自己的完整能力。本机定位不在能力集内（2026-10-22）：与手机的「这台手机上」一致，桌面定位是每个 Agent 在「这台电脑上」单独开启的本机开关（本地偏好，不同步，默认关闭），开启后不再逐次弹窗；「联网」只包含网页搜索与读取网页。
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

桌面界面（`desktop-ui/features/approvals/`）：卡片沿用工具授权弹窗的样式，`role=dialog`、`aria-modal`、标题与说明关联、按钮组有图例，新卡片出现时焦点移到第一个选项（只移一次）；请求已结束时提示「没有保存任何授权」；「一直开启」后重新读取页面数据。「临时授权」列表在每个 Agent 的设置页（表单之外，因为表单在编辑前是只读的）和 自定义 → 权限与隐私 中，可撤销。新建 Agent 的页头有「全部基础能力（推荐）/ 基于「X」」选择、勾选「同时复制身份、人设与声音」及一行说明。五种语言在 `desktop-ui/translations.js`（同时生成 `ios/Melo/Localizable.xcstrings`）。

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
| 手机契约 | `ios/Tests/SharedContractTests.swift` | 全部 `fixtures.capabilityElevation`（29 条判定、3 条文案、3 条到期）经 Swift 判定核心；手机工具表与手机权限一一对应 |
| 手机运行时 | `ios/Tests/CapabilityElevationTests.swift` | 手机判定表、账本（文件、重启、24 小时到期、损坏、不备份）、撤销下一次生效、并发合并、无界面拒绝、上限、团队成员超出主 Agent、超时 / 运行截止 / 取消、「一直开启」、提示注入、卡口与运行记录、新 Agent 起步集与「基于已有 Agent」、同步能力放宽 |
| 浏览器（Mac） | `desktop-ui/capabilityElevation.browser.test.js` | main 委派 Builder → Builder 需要『知识与记忆』→ 卡片 → 本对话 24 小时 → `search_history` 运行 → Builder 设置页列出 → 撤销 → 账本为空；无页面错误 |

## 9. iPhone 端（2026-10-20 实现）

原交接要求（契约 `capabilityElevation` 与夹具、判定顺序、公式、时长、不烘焙授权、可见性、无界面拒绝、契约文案、手机自己的账本、起步集、「一直开启」遇到同步设置走待桌面确认）全部落实如下。

### 9.1 实现

| 部分 | 文件 | 要点 |
| --- | --- | --- |
| 判定核心 | `ios/Melo/CapabilityElevation.swift` | 纯 Foundation；结果词表、原子语法与顺序、授权有效性、`effective = base ∪ (ceiling ∩ 超出父级授权) ∪ 即时开启授权`、最小缺失集合、选项、时长、文案全部读契约；授权从不写进 scope |
| 手机映射 | 契约 `capabilityElevation.phone` | 手机布尔（日历、提醒事项、通讯录、当前位置）、手机权限原子、手机工具 → 原子表、手机措辞（超时文案、「这台手机上的」设置）；桌面忽略此节 |
| 账本与请求 | `ios/Melo/CapabilityElevationRuntime.swift` | `Application Support/Melo/capability-grants.json`；原子写入、`completeUntilFirstUserAuthentication`、排除备份；读取逐条校验（未知原子、非用户决定一律丢弃），清理过期与上次启动的运行级授权，损坏文件改名 `.corrupt-<time>` 后按空处理；请求注册表、合并、超时、取消；唯一写入者是私有的 `respond → createGrant` |
| 卡口 | `DeviceToolContext.perform`（`ios/Melo/DeviceTools.swift`） | 主回复与团队成员、Codex / Chat Completions / Anthropic 三条连接的每个手机工具调用都先经 `gate`；写入类工具批准后与执行中途的复查也用实时判定 |
| 接线 | `ios/Melo/ChatStore.swift` | 上限 = 该 Agent 的手机权限（运行开始快照 ∩ 当前）；成员以主 Agent 为父级；卡片进入与设备写入确认共用的审批队列；运行结束释放运行级授权并关闭未答卡片；「一直开启」经与 Agent 页开关相同的路径写手机权限并加运行级授权 |
| 界面 | `ContentView.swift`、`CapabilityElevationViews.swift`、`AgentEditor.swift`、`LocalPermissionsView.swift` | 卡片沿用设备写入确认的系统弹窗（标题、说明、契约选项按钮）；「临时授权」列表在 Agent 页「这台手机上」下方与 设置 > 权限与文件；新建 Agent 的起点选择 |
| 新建 Agent | `ios/Melo/AgentStarter.swift` | 同步能力写起步集；「基于已有 Agent」复制能力、协作（去掉自己作为委派对象）、上下文来源、模型；勾选才复制身份 / 人设（指令文档、描述、mood）；从不复制 ID、名称、头像、图标 |
| 记录 | `ExecutionRecord` 阶段「临时授权」 + `ExecutionToolCall.capability` | 等待、允许（范围、到期）、一直开启、拒绝、超时、取消；被拒调用标记为未执行；阶段 ID 用独立审计 ID，不用请求 ID |

### 9.2 能力映射

| 手机能力（`PhoneCapability`） | 原子 | 走卡口的手机工具 | 说明 |
| --- | --- | --- | --- |
| 联网搜索 `network` | `network`（契约布尔） | `open_url`、`web_screenshot` | 托管网页搜索（Codex `web_search`、团队成员搜索）是供应商原生工具，按基础权限决定、不弹卡片（同第 7 节） |
| 生成与修改图片 `generateMedia` | `generateMedia`（契约布尔） | 无 | 图片任务路径与原生生图在请求前按基础权限决定（同第 7 节） |
| 日历 `calendar` | `calendar`（手机布尔） | `calendar_list_events`、`calendar_create_event` | 设备「手机数据」开关（含系统权限）是外层边界，授权不能绕过 |
| 提醒事项 `reminders` | `reminders` | `reminders_list`、`reminders_create`、`reminders_complete` | 同上；写入仍逐次确认 |
| 通讯录 `contacts` | `contacts` | `contacts_search` | 同上 |
| 当前位置 `location` | `location` | `location_current` | 同上 |
| — | — | `read_history` | 不受能力门控：手机上由同步来的上下文来源 `memory` 决定（上下文设置，不是能力） |
| 同步来的桌面能力（读取文件…委派、MCP / 技能 / 连接器） | 契约原子 | 无 | 手机循环不以它们门控；判定核心与夹具覆盖；若将来手机工具需要，「一直开启」写入本机同步设置，成为桌面待确认的放宽（`AgentCapabilityWidening`），本次运行用运行级授权继续 |

### 9.3 与桌面的差异及原因

1. **上限来源**：手机执行一直由本机按 Agent 的权限（「这台手机上」）决定，同步来的桌面能力只约束桌面执行；所以上限是 `PhoneAgentPermissions`，快照取运行开始时（中途放宽从下一次运行生效，撤销下一次调用生效，与原手机行为一致）。
2. **手机原子**：多四个手机布尔，排在契约布尔之后；可见性 = 契约 `jitVisible` ∪ 手机布尔，并且仍受设备开关（手机数据开关与系统权限、实时搜索开关）约束；这些开关关闭时与以前逐字拒绝，不弹卡片。
3. **交互界面**：应用在前台即有界面，每次判定实时检查；运行开始时在后台则不显示可申请的工具（同桌面无界面）。卡片打开后切到后台，卡片保留，回来仍可回答；系统收回后台时间或停止回复时卡片关闭并取消。
4. **「一直开启」作用域**：手机权限没有全局 / 项目之分，审计写「这台手机上的设置」；项目覆盖不能单独开启的规则（`alwaysUnavailable`）只在同步能力路径出现。
5. **超时文案**：桌面原文让模型告诉用户「在 Melo 桌面端允许」，手机改用契约 `phone.texts.timeoutOutput`（「在这台 iPhone 弹出的授权卡片中允许」）。其余模型可见文案与审计文案为契约原文。
6. **卡片形态**：系统 alert（与设备写入确认相同），按钮即契约选项，「拒绝」为取消角色；iOS alert 自带焦点与无障碍，无需桌面的焦点 / 图例处理。界面文字用桌面同一份目录词条，手机新增 3 行在 `ios/native-translations.js`。
7. **新建 Agent**：手机的「这台手机上」权限不复制、也不由起步集改变（交接第 8 点），新 Agent 保持手机默认；手机没有每 Agent 的声音、渠道与令牌，勾选复制的是身份与人设；图标与头像一样不复制。
8. **账本位置与保护**：与聊天数据同目录、同保护级别（锁屏后台回复期间仍可读，避免运行中项目授权失效），排除 iCloud 备份；iOS 沙箱代替桌面的 0600 / 0700。
9. **夹具**：29 条判定夹具全部用 Swift 核心判定；夹具里的桌面工具 ID 经测试内的 `toolCapabilityAllowed` 移植换成需求（手机运行时只用自己的工具表）；跳过清单机制保留，目前为空。

### 9.4 未做 / 边界

- 没有真实模型、真实团队委派或实体手机上的卡片交互验收；模拟器构建、离线 Swift 套件与日常 gate 见第 10 节。
- 桌面同步通道收到手机提出的能力放宽仍按既有流程待桌面确认；手机目前没有工具会触发这条路径。

## 10. 验证记录（2026-10-20，用户 Mac）

- 日常 `npm test -- --base bbe8096`：日常选定范围通过（JS 4139/4151，12 跳过；语法；文档链接；两项设置浏览器验收；共用渲染 4/4；32 组 Swift，`SharedContractTests` 读取新契约通过）。第一次运行发现两处需补的派生项：新的源码读取测试未登记（已登记到 `module-annotations.json`），手机场景包的目录散列过期（已重建，同时补上另一线程界面统一留下的 `executionPanel.css` 散列）。
- 真实浏览器（Mac Chrome）：`capabilityElevation.browser.test.js` 通过；`agentSettings`、`agentSettingsSecurity`、`agentPersona`、`committedSave`、`language`、`liveRun` 浏览器回归通过。
- 在线只读检查：退出并重新打开用户的 Melo（确认只有一个 `MeloDesktop` 与一个 `node src/server.js`，健康检查通过）；用浏览器打开 Agent 页、切换「基于「Main agent」」、打开 自定义 → 权限与隐私，所有非 GET 请求在浏览器内拦截（实际 0 次），页面导航只改写 `GET /api/bootstrap` 的返回。结果：0 控制台错误、0 页面错误、0 失败响应；用户现有 6 个 Agent 均出现在起点选择中；用户数据未被写入。
- 隔离 home 与 fixture 模型；没有用真实模型、真实委派或实体手机验收。
- iPhone 端（同日，接手工程师）：`SharedContractTests` 35 条能力提升夹具（29 判定 + 3 文案 + 3 到期，0 跳过）；新套件 `CapabilityElevationTests` 与全部 33 组 Swift 通过；模拟器 Debug 构建成功、无新增警告；日常 `npm test -- --base 5872d7d` 选定范围通过（JS 4147/4159，12 跳过；语法、文档链接、生成器与依赖预检、共享渲染预检、两项设置浏览器验收、33 组 Swift）。签名构建 0.7.5 (37) 停在 Mac 钥匙串授权（codesign 等待超过 3 分钟，未代为确认），实体手机 Mortred (3) 当时 unavailable，未安装；没有真实模型或真机卡片交互验收。
