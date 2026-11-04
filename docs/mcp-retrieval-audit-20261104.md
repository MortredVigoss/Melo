# Melo MCP 与网页检索审计 · 2026-11-04

状态：本文件前八节保留改造前审计。后文「实施回执」和「访客实测」记录已经在当前桌面生效的修复。未推送或重装手机。
源码基准：`2ca7fa391b6697745beaa974d93ab6ae22a552fa`，开工时工作树干净。

## 1. 结论

用户描述的“工具有但没用上、回答像搜索摘要”有代码依据，但不能归结为缺少某一个 MCP，也不能据此判定 Claude 那次具体用了什么工具。

Melo 已有多轮工具循环、网页正文提取、浏览器和目标检查。主要缺口在：标准 HTTP MCP 没接通；部分 MCP 返回内容在转换时丢失；工具发现与连接健康处理不完整；网页证据把预览、截断正文和成功读取混在一起；旧匿名搜索链路可靠性不足。

建议先修“接得上、结果不丢、阅读状态准确”，再接小红书及一个通用搜索/正文服务。继续增加循环轮数不能解决这些问题。

## 2. 方法、范围与当前事实

- 已读入口规范、总览和相关源码，使用 `architecture/modules.json` 与 `npm run scope` 核对依赖。没有把模块地图当成函数级证据。
- 实际读取当前默认数据目录 `.tmp/melo-home-user` 的配置与 Agent 授权字段，只输出布尔值、ID 和数量，没有输出密钥、Cookie 或对话正文。旧 `~/.melo` 是历史目录，未用其旧配置作当前结论。
- 对运行中的 `GET http://127.0.0.1:43127/api/mcp/servers` 做只读查询：返回 `playwright`、`mermaid`、`antv-chart`、`markdown2pdf`。这是服务登记状态，不是每个工具成功执行的证明。
- 当前默认配置没有自定义 `mcpServers`，没有保存 HTTP 搜索后端和其凭据，Tavily/SerpAPI key 为空，没有保存域名 Cookie。六个全局 Agent 配置均允许 network 与上述四个 MCP；某些项目覆盖、特定对话限制仍可能收紧。
- 核对最近现有搜索日志 `2026-10-27.jsonl`：35 条中，4 次 web-search 全失败；31 次 url-fetch 中 30 次返回成功（20 次 Jina、10 次 direct），1 次失败。日志中的“成功”仍不等于拿到了需要的正文。**这是 10 月 27 日的记录，不是今天重新跑出的联网结果。**
- 对照 10 月 27 日真实模型专项：曾遇搜索 403、浏览器授权 120 秒超时和只读到天气页导航。壳 PATH 已另行修正；不把旧 PATH 缺陷当作当前未修问题。
- 跑了 11 个现有测试文件，116/116 通过，0 失败/跳过。另运行 9 个隔离边界探针和 1 个真实子进程生命周期探针，复现下述缺口。现有测试通过不代表这些新发现已修复。
- 联网核对了 MCP 规范与小红书、Playwright、Browserless、Tavily、Firecrawl 的维护者文档；没有部署、登录或调用第三方账号。

## 3. 执行链路、状态与边界

### 3.1 MCP

`src/server.js` 启动 / MCP 路由 → `src/mcp/init.js:initMcpServers` → `presets.js:buildEffectiveMcpServers` → `manager.js:bootstrapMcpServers/connectMcpServer` → `client.js:connect/listTools` → 独立 `mcpRegistry`。

每轮 `prepareNode.js` → `mcpRegistry.toolsForAgent` → Agent 白名单 / toolGroups / requestPolicy / capabilityScope → `createFunctionCallingSession` → 模型 → `invokeModelNode.js` 按 wire name / ID 找工具 → `executor.js` 能力与审批、预算、取消 → `manager.js:buildMcpTool.run` → `client.callTool` → `mcpResultToToolResult` → 模型消息与 `sharedAgentCore.results` → `goal` 检查 → 完成回执 / 执行面板。

共享状态：配置文件只读加载、manager `_clients`、registry 的工具与函数名 Map、每轮固定工具列表 / scope、审批账本、工具调用记录、执行场景。连接异常由 manager 转成状态；调用超时由 client 拒绝 Promise；executor 转成工具失败。

### 3.2 搜索与读取

`prepareNode` / `sharedSearchPlan` → `shared/agent/search.js`、检索路由 → `registry.js` 注册的 `createCompatibleSearchTool(legacyWebSearchTool)` 与原始 `fetchUrlTool`。

- `web_search`：配置 HTTP 后端则调用共享适配器；旧路径使用搜索提供方 / 缓存 / 最多四个候选正文提取。
- `fetch_url`：社交域名先 `socialLinkReader`；普通 URL 按 auto / 显式模式走 Jina、direct、Playwright、CDP 或外部 reader。
- 结果 → executor → `sharedAgentCore.results` → `completionObservation` → `goalReviewRequest/reviewGoal` → `completionReceipt`。

特别排除误判：`src/services/search/sharedFetchAdapter.js` 强制 direct，但当前 `registry.js` **没有注册这个适配器**，只是其测试引用。不能将它写成桌面生产路径只读静态页的原因。

### 3.3 外部连接器与移动端

- “外部 MCP 连接器”走 `externalConnector` 的自定义 HTTP manifest/health/context/invoke 路径，与 stdio MCP 注册路径不同。
- iPhone `DeviceTools.swift:PhoneToolContext` 提供本机工具、`open_url` / 截图及历史工具；`WebPageTools.swift` 使用非持久 WKWebView。同步 MCP 白名单不等于具备桌面 MCP 执行器。
- Android `SharedSearchAdapter.kt` 的 fetch 是 HTTP 文本读取，共享策略负责格式，不等于桌面浏览器/MCP。此轮只核对相关入口，不宣称移动端全功能对齐审计。

停止条件：追到工具发现、模型可见性、执行/取消、结果证据与 UI 状态消费边界。第三方库和平台内部不逆向；登录页/反爬挑战不绕过；真实对照任务与手机端验收留作实施后的独立门禁。

## 4. 按影响排序的问题

### P1-01：预览和截断正文会被记作正文读取，完成检查缺少可靠分级

- `fetchUrlTool.js:278` 接受 `readSocialLink` 的任何非空 body，包括 `share-preview:*`。
- `src/runtime/sharedAgentCore.js:52` 传给完成观察的只有 URL 和 output，没有传 `meta.via`、原始长度或截断状态。
- `shared/agent/completion.js:88` 因此给这些结果写 `reading: extracted`；探针显示分享卡片和 4 万字截断页都如此。source text 本身还会截到 16,000 字。
- `goal.js:54` 给检查模型的普通每条证据最多 2,000 字、整体 16,000 字；通用 MCP 只有普通工具观察，最多先保留 4,000 字，没有独立 URL/source/read-status 记录。
- 目标检查确实存在，提示词也明确“搜索摘要不是正文”。但 `reviewGoal` 主要验证证据 ID 是否成功、是否非空，语义充分性仍依赖检查模型；宿主错误标注会削弱这层检查。不能说每个摘要必然被判完成。
- 修法：统一 `snippet / preview / partial / full / blocked`、URL、正文范围、截断和读取方式；按用户所需事实读取相关段落/续页；摘要不能冒充“阅读全文”，但简单事实查证也不应机械要求全文或固定来源数。

### P1-02：MCP 接入年代较早，“外部 MCP”界面不能替代标准 HTTP MCP

- `client.js:25` 固定发 `2024-11-05`；`manager.js:163` 只构造 `McpStdioClient`；`server.js:735` 的 connect 要求 command。
- `externalConnector.js` 则 GET `/manifest` / `/health`、POST `/context` / `/invoke`；没有 MCP initialize、tools/list、tools/call 协议。给它小红书 `/mcp` URL 会请求 `/mcp/manifest`。manifest 还最多保留 12 项、去掉 inputSchema。
- 因而不能直接粘贴现代 MCP URL 就正常使用。可以通过额外 stdio 桥接进来，但这不是当前已经内置或验证过的能力。
- 修法：统一标准 MCP 配置（stdio 与 Streamable HTTP，按协商版本兼容），支持认证状态、分页、通知、错误与取消。旧自定义 HTTP 连接器保留兼容并准确命名，不能无迁移直接改成另一种协议。
- 固定旧版本不代表所有 MCP 都失效：本机现有四个服务仍登记成功；缺口是覆盖面和协商实现。

### P1-03：MCP 结果转换会丢正文和图片

`client.js:258:mcpResultToToolResult`：

| 输入 | 实际传出的内容 |
| --- | --- |
| 仅 structuredContent 含正文 | `(no output)` |
| resource 内嵌 text 正文 | 只剩 `[resource: URL]` |
| image 的实际图像数据 | 只剩 `[image: image/png]` |

这是实际转换函数探针结果。只返回普通 text 的工具不受此问题影响；当前 MCP 截图转换路径不等同于内置 `web_screenshot` 的图像传递。

修法：保留结构化结果、资源正文与图片附件；原始结果受大小上限约束存入可追溯证据，给模型按需取用。不能把所有大型 JSON 一次塞进 prompt。

### P1-04：工具可能未发现，或服务已死仍显示连接

- `client.js:listTools` 只读一次，不处理 nextCursor；探针中第二页 detail 工具完全消失。
- `_handleMessage` 忽略服务通知，包括工具列表变化；服务新增工具不会刷新。
- 子进程 close 只改 client 标志，没有通知 manager/registry。真实隔离子进程退出后，`getActiveMcpServers` 仍含它，工具仍已注册；UI 的已连接来自这份列表。
- 修法：分页完整发现、tools/list_changed 更新、连接退出清理、退避重连（只恢复连接，不自动重做有副作用调用），将配置/连接/工具可用分别展示。

### P1-05：上层停止了，进行中的 MCP 请求没有收到取消

- executor 已有取消与超时 race，不能说整个 Melo 没有取消保护。
- 但 `buildMcpTool.run(args, context)` 没传 `context.signal`；client 固定等待最多 60 秒且没有取消通知。隔离探针在开始后 abort，底层 call 仍正常返回。
- 影响：用户看到停止，MCP 中进行中的浏览器/写操作仍可能继续。此次没有用真实写操作验证副作用。
- 修法：请求 ID 关联取消和预算；超时发送标准取消、丢弃迟到结果，并清楚标识第三方无法确认终止的状态。不得直接杀掉被其他对话共用的服务器。

### P2-06：默认搜索与平台读取策略不足以保障深度回答

- 最近现有日志证实匿名搜索链路曾全败；配置也没有独立可靠搜索凭据。今天未新发真实搜索请求，不能保证这些服务现在仍报相同错误。
- 旧 web_search 最多选四个候选读正文，默认每页 6,000 字，社交域名默认跳过自动正文提取；找到小红书搜索摘要不会自动转换成站内搜索/读笔记。
- 单独 fetch_url 默认输出最多 20,000 字；桌面工具没有 offset/page/find 参数。不断读同一个长页面不等于读到了末尾。
- 修法：搜索找候选、专门 reader/平台 MCP 取正文、质量不足时升级浏览器；长文按页/段继续读。优先改善成功率和证据组织，不盲目提高轮数或把所有网页全文重复发送。

### P2-07：授权与诊断界面没有解释“为什么这个工具没被用”

- 当前全局六个 Agent 并非都被 MCP 白名单挡住；允许的 MCP 在 `prepareNode` 合并，toolGroups 把 MCP 视作 core，并没有再按任务关键词统一裁掉。
- 然而每个 MCP 包装工具都 requiresPermission=true，即便有 readOnlyHint；等待上限 120 秒。已有真实浏览器任务因此超时。
- 服务器已连接不代表本次任务已授权、已发现目标工具、模型确实收到工具、成功执行并收到正文。
- 修法：诊断页/执行面板分层显示这些状态和具体原因；允许用户对明确可信的只读范围授予本任务/会话权限。不能只因第三方声明 readOnlyHint 就自动放行，更不能删除写操作确认。

### P2-08：服务预设与手机能力需要一并更新

- 小红书目前没有预设、没有站内 search/detail 适配；分享链接 reader 不能替代它。
- Browserless 仍保留“包没有锁定、不可用”的旧占位；维护者现在提供正式 HTTP 服务。不能直接解禁旧 npm 包名，应更新接入与认证方案。
- iPhone/Android 没有复用桌面通用 MCP 执行链。电脑接通小红书不自动让手机接通；iPhone 非持久 WKWebView 也不会自动继承 Safari/桌面登录。
- 修法：手机显示同一服务目录、登录/授权/工具与证据状态；可直连的 HTTP MCP 通过移动 Host 接入，本机 stdio 服务经用户授权的桌面中继。桌面离线必须明确不可用，不能假装降级后仍是相同来源。

## 5. 当前生态核对（维护者资料，不代表已在 Melo 验收）

| 候选 | 可补什么 | 接入条件与结论 |
| --- | --- | --- |
| [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) | search_feeds 搜索、get_feed_detail 读笔记及评论 | 社区项目，非小红书官方服务；HTTP `/mcp`，该实现的站内详情用 feed_id/xsec_token，不代表公开分享页必须登录。适合作为只读搜索/详情候选；发布、评论、点赞等另行授权。未安装或扫码 |
| [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp) | 浏览器导航、可访问性快照、交互后读取 | Melo 已有固定版本；先改善现有接线/权限/结果，不能声称没有浏览器，也不因名字相同假定最新文档所有能力都在已装版本 |
| [Tavily MCP](https://github.com/tavily-ai/tavily-mcp) | 搜索、提取、地图和爬取 | 有标准远程接入和账号认证；是否付费/额度按用户选择另核对，未注册或开通 |
| [Firecrawl MCP](https://github.com/firecrawl/firecrawl-mcp-server) | 搜索、正文、动态页面内容处理 | 文档区分搜索摘要与 scrape 正文；有 HTTP 与本地部署方式。不能把装了它当作自动读过全文 |
| [Browserless MCP](https://docs.browserless.io/mcp/browserless-mcp-server/setup) | 浏览器读取/交互的可选后端 | 正式托管 HTTP 接口，需账号 token/OAuth。取代过期的不可用提示要走正式接入，不能默认开启收费服务 |

协议依据：[MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、[Streamable HTTP 基线](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。这两页用作明确可复查的兼容基线，不宣称是所有服务使用的最新协议；实施时按 SDK 支持版本和握手协商，不换一个硬编码日期了事。

## 6. 推荐方案与执行顺序

评分为本次工程判断，非性能跑分。

| 方案 | 分数 | 判断 |
| --- | --- | --- |
| 仅增加小红书和搜索 MCP | 6/10 | 新来源能补一部分，但正文丢失、证据分级、假连接和取消仍在 |
| **统一 MCP 适配与阅读证据，再补少量来源** | **9/10，推荐** | 保留现有循环和账号，直接处理已复现缺口；可以分批验收 |
| 重写整个 Agent 循环 | 4/10 | 本轮证据不支持这个投入，回归面大且不解决平台登录和搜索后端可用性 |

1. **基础修复**：结果信封/正文分级、分页/断线/取消；补上述探针对应的正式红绿回归。对旧配置做兼容，不更改用户 Agent 权限。
2. **标准连接与只读接入**：版本钉住的维护中 SDK 评估后替换手写 transport，统一 stdio/HTTP；先小红书搜索+详情，再选一个通用搜索/正文服务。新增/导入配置、连接测试、登录过期、每 Agent 授权和诊断 UI 同批落地。
3. **读取策略与移动端**：以实际缺口决定 search→read→必要交互/续读；统一 source/read-status/coverage 证据。桌面、iPhone、Android UI 和 Host 同步；手机不能运行的本地能力明确显示执行设备。
4. **真实对照验收**：用户原任务或新的同题对照，保留模型、可见工具、实际调用、来源、阅读范围、耗时、费用/用量、回执。需要用户平台登录时只在平台界面授权。

## 7. 验收条件

- 分页第二页工具可发现；新增/移除通知和子进程退出可改变可用工具；UI 不显示假连接。
- text、structuredContent、内嵌 resource、图片都正确传给模型/证据，不出现正文变成占位符。
- 预览、摘要、截断、登录墙、导航壳都准确标注；要求读末尾/评论时确实拿到对应内容，不能只凭 ok:true 完成。
- 取消前零执行；取消过程中底层收到取消、迟到结果不入库；不重复可能已发生的发布/评论/写操作。
- 小红书：实际 search 返回 ID/token 后读详情，引用可回查；登录失效明确提示，不拿搜索卡片冒充详情。只读验收不触发发布/互动。
- 动态网页、长文章末尾事实、无搜索结果、403/超时、授权拒绝/无人响应、来源冲突各有覆盖。
- 三端显示服务来源、读取深度、失败原因一致；桌面离线/手机独立网络状态明确。
- 产品修改按 scope 计划跑快速与基准集成；共享契约修改生成 agent-core 并验证 Swift/Kotlin。真实账号/真机/浏览器不以单测代替。

## 8. 覆盖、未覆盖与复现证据

已覆盖的源码入口/函数：
- `src/mcp/{init,presets,client,manager,toolId}.js`：启动、配置、握手、发现、转换、注册和退出。
- `src/tools/{mcpRegistry,registry,toolGroups,executor,permissions}.js`：可见工具、能力/审批、分发和取消。
- `src/domain/agent/{agentTools,capabilities}.js`、`src/services/chat/execution/{prepareNode,invokeModelNode}.js`：Agent 白名单、工具合并和模型调用位置。
- `src/services/connector/{externalConnector,externalConnectorMutations,connectorPrompts,connectorRollup}.js` 与 domain normalize：自定义 HTTP 与模型入口边界；不将手工按钮等同模型工具。
- `src/tools/builtins/{webSearchTool,fetchUrlTool}.js`、`src/services/search/{sharedSearchAdapter,sharedFetchAdapter,socialLinkReader,searchLimits,searchTask}.js`：读取路线、输出上限、社交预览、适配入口核对。
- `src/runtime/sharedAgentCore.js`、`shared/agent/{search,completion,goal}.js`：证据传递与完成检查。
- `desktop-ui/advancedPage.js`、Agent capabilityChoices / 授权辅助代码：状态与配置展示，未做本轮浏览器交互验收。
- iPhone `DeviceTools.swift`、`WebPageTools.swift`、`WebPageText.swift`、`SharedAgentCore.swift`、`AgentLoop.swift`、`WebSources.swift`；Android `SharedSearchAdapter.kt`：相关工具 Host 和读取边界，非移动端逐文件审计。

未覆盖：用户描述的具体 Melo/Claude 对照记录（未提供任务 ID/原文）；今天新发真实模型检索；第三方登录后的读取/反爬成功率；HTTP MCP 各认证流的实连；Swift/Android 构建、真机和所有 UI 状态；第三方代码安全审计。原因：此次是检查和方案，没有安装/登录/修改授权，也不将历史证据当新实测。

证据目录：`.tmp/mcp-audit-20261104/`（隔离探针、测试 TAP、范围报告、脱敏状态摘要）。

复现：
```sh
node .tmp/mcp-audit-20261104/probe.mjs
node .tmp/mcp-audit-20261104/lifecycle.mjs
MELO_HOME=/private/tmp/melo-mcp-audit-20261104/test-home node --test src/mcp/init.test.js src/mcp/manager.test.js src/mcp/startup.test.js src/mcp/toolId.test.js src/tools/mcpRegistry.test.js src/tools/toolGroups.test.js src/runtime/nativeSearchEvidence.test.js src/runtime/searchCacheEvidence.test.js shared/agent/completion.test.js shared/agent/goal.test.js shared/agent/research.test.js
```

探针开发时首版未先发 request/calls 就送 result，被共享循环以 UNKNOWN_RESULT 正确拒绝；补齐事件序列后才得到本报告结果。未更改产品来让探针通过。生命周期夹具只启动自己创建的 Node 子进程，结束后已清理连接，未触碰运行中四个 MCP。

## 实施边界（11-04，已授权）
采用方案 B。启动/高级设置 → initMcpServers/buildEffectiveMcpServers → manager.connectMcpServer → 已锁版本的 SDK 和独立回环服务 → 分页发现 → 仅登记已审核的社交查询工具 → prepareNode / capabilityScope（委派仍取交集）→ executeTool → callTool(signal) → completionObservation / goalReviewRequest。连接失败不登记；停用、子进程退出和目录改变时撤销旧工具。网页返回预览/部分/正文须分别记录；图片走已有模型图片输入。新 Agent 经 agentEquipment 和初始内置配置取默认；存量配置只做一次增量，与用户后续撤销兼容。停止于上游响应/实际设备边界：无需写操作来验证检索，不读取个人私信，不将一次握手等同于登录或取到平台正文；手机本机和桌面服务可用性分别记录。沿用上文覆盖表和探针，补真实本地进程、HTTP、权限撤销与证据回归。

### 实施回执
- 接入 [小红书 v2.7.2](https://github.com/xpzouying/xiaohongshu-mcp/releases/tag/v2.7.2)、[抖音 v0.1.0](https://github.com/yunsur/douyin-mcp/releases/tag/v0.1.0)。按 OS/架构校验 SHA-256；服务绑定随机回环端口，每次启动使用新令牌，账号存于各自的服务目录。只发现并分发五个审核过的读取方法；上游增发的方法不自动授予。用户既有自定义服务器仍逐次走原审批。
- 桌面「自定义 → 高级 → MCP 服务」区分设置、连接、工具目录和平台登录。两平台可扫码/检查；也可手动添加 HTTPS 或本机 HTTP MCP，Bearer 可选。旧 HTTP manifest 连接器保持原数据协议。Browserless、Tavily、Firecrawl 是手动填写的 HTTP 服务候选，不自动订阅付费服务；未实现 OAuth 登录。
- 官方客户端锁定 2.0.0，HTTP 支持 JSON/SSE，stdio 保留最小 PATH 支持；分页、工具目录变更、子进程退出、陈旧句柄撤销、停止传到底层。MCP 结构化正文、嵌入资源、图片走现有工具/模型链路；单次最多四张/约 4 MiB Base64，文本 32k 字，能力/内容上限仍然有效。
- 社交搜索卡仅作候选，真实详情才附来源；抖音作品描述不证明观看了视频。普通 fetch 分页返回下一偏移；分享预览、被截断的页面和视频元数据不算完整正文。未登录的“成功但无内容”不签发来源。手机共享读取规则和 Agent 设置，但没有复用桌面登录或在手机安装这些服务。
- 真实上游隔离发现小红书 2、抖音 3；只测两项上游的站内搜索时均无已读来源；公开网页途径另见下文。定向 299 项通过；用户存档副本演练 6 个 Agent、24 段聊天、734 条消息及附件引用相同，账号配置逐字节一致。工作过程证据见 `.tmp/mcp-reader-20261104/`，平台登录后的正文实测单列。

- 桌面运行实例：原有 4 个 MCP 与新增 2 个均在运行；按实际目录经过每个 Agent 的两层权限过滤，6/6 各可用 5 项；独立浏览器实际展开高级页，核对到了两套扫码/状态按钮以及 2+3 个工具。向两服务发未携带令牌的握手，两者原生均返回 401。
- 安装目录未替换。运行前保留原主目录完整备份；对实际运行后的存档再比对：24 段聊天、734 条消息（含附件引用）、资料记录、账号配置一致。脱敏回执：`.tmp/mcp-reader-20261104/{acceptance.json,desktop-ui-live.log,unauthenticated.json,live-final.jsonl}`。
- 组合回归另发现分页参数的工具说明曾挤占小上下文模型的历史预算。现已精简参数说明；保留原上限与 L4/U2、L5 原断言。

### 访客实测：不用登录也可以打开部分作品

2026-11-04，在这台 Mac 上从空白测试目录调用 Melo 的实际工具，用两条 `site:` 查询搜索“上海共青森林公园”。未提供任何平台账号、浏览器 Cookie 或第三方数据 API Key。先直接验证工具链，再用隔离的真实模型对话验证调度；没有用私信、评论发布或下载视频作为验收。

| 平台 | 找到什么 | 实际打开后取得什么 |
| --- | --- | --- |
| 小红书 | 站外索引 4 个候选 | [公园笔记](https://www.xiaohongshu.com/explore/69f8b5500000000035029791) 的作品 ID 与笔记详情相符，取到 546 字作者正文，`extracted`（文字，不含评论或图片识别）。几条旧短链落到登录/不可用页，没有当作正文。 |
| 抖音 | 站外索引 4 个候选 | [公园作品](https://jingxuan.douyin.com/m/video/7568302360376790323) 取到 288 字作者文案，`partial`。另一条[公园越野](https://jingxuan.douyin.com/m/video/7632707595035289701)用网页与 MCP 详情两条路径均读到同一份 219 字文案，账号调用计数 0；没有说已观看视频或读取评论。 |

- 原因：默认站内 MCP、搜索引擎索引、作品移动公开页是三条不同入口，同一作品桌面端可能只返回 JS 空壳。GitHub [xiaohongshu-cli](https://github.com/tamnd/xiaohongshu-cli#how-it-reads-data) 和 [XHS-Downloader](https://github.com/JoeanAmier/XHS-Downloader) 也区分公开分享页与受限接口；部分商业中介不要求平台账号，但需要自己的服务密钥，本轮未接入。没有对照 Claude 的工具日志，不能据此断定其路径。
- 实现：`web_search` 对显式平台域名查询使用公开搜索 HTML，在网页工具中标明 DuckDuckGo；只留下该域的单个作品候选。模型不能把卡片当详情。`fetch_url` 及相应本机 MCP 详情先尝试公开作品页；核对页面内作品 ID，再返回作者正文或文案。受限页、外域重定向、推荐流、只有标题或无正文均不能签发已读证据。访客请求对社交 MCP 和使用账号的读页回退有执行层限制；站内搜索和评论不保证可用。
- 对应源码：`shared/agent/{search,retrieval/requestPolicy}.js`、`src/mcp/{publicPost,manager}.js`、`src/services/search/publicPlatformIndex.js`、`src/tools/builtins/{webSearchTool,fetchUrlTool}.js`。回归含 ID 不符/登录墙、限定域名、候选与正文分级、取消、禁止使用账号、小窗口和跨页续读。
- 脱敏实查数据：`.tmp/mcp-reader-20261104/{guest-chain.json,guest-xhs.json,public-live.json}`。现有桌面正常重启沿用原目录，服务重新登记 2+3 个读取工具。有效范围为本次两个样本，不能外推所有帖子、站内排名、全部评论或真机。

- 真实模型验收：全新临时桌面资料目录，不复制历史/平台 Cookie，只使用 Melo 现有模型连接；测试实例不开账号 MCP。普通中文问题询问一篇上海共青森林公园笔记中的细节，未指定工具。模型自己先 `web_search` 后 `fetch_url`，两次均成功，给出原链接与确实出现在作者正文中的游乐设施，最终执行场景 `completed`。这是访客路径的端到端验收，未以它代替平台原生账号接口的验证。脱敏回执：`.tmp/mcp-reader-20261104/guest-real-turn/receipt.json`。

- 最终选定范围门禁 `run-qe79QA` GREEN：JS 4784/4784（零跳过、零失败），Swift 37 套，设置浏览器、Android JVM/Lint/Debug/Release、生成契约与共享渲染均通过。没有执行发布、真机安装或推送。
