# Melo 总览：当前事实、功能索引与接手入口

更新时间：2026-10-20（Australia/Melbourne）。这是所有 Melo 工作线程共用的人工维护入口：顶部依次是当前事实、功能索引和最新交接；按日期的阶段过程（含日期、提交与当次验证数字）在 [总览历史交接](docs/handoffs/overview-history-20261019.md)。

## 1. 先看这里

- 真正产品仓库：`/Users/mortred/Desktop/melo/Melo Desktop Project`。Codex 当前保存项目 `New project` 指向 `/Users/mortred/Documents/New project`，不能混淆。
- 本文保存当前事实、功能索引、架构边界、跨线程登记和最新交接；`PROGRESS.md` 保存意图时间线；专项文档保存详细证据；Git 保存代码历史；`architecture/modules.json` 是生成的功能地图。`codex.md` 是自动生成快照，不手改。
- 接手顺序：本文 → `CLAUDE.md` → `git status --short` → `npm run scope -- <改动文件>`（只报告受影响功能、另一端与选组）→ 本次模块的实际 diff / 源码与证据。正常工作不用完整回读线程。
- 记录缺失、线程更新时间晚于交接、源码与文档冲突时，只定向读该线程近期相关轮次，再补本文；不要靠旧总结覆盖新代码。
- 2026-10-15 已确认通知的 8 条线程全部完成补录回复；当前主线复核总览、源码/Git 与关键证据，集中归档详细回执。完成补录不等于产品任务全部验收；详见[历史交接](docs/handoffs/overview-history-20261019.md)的补录登记与[核对报告](docs/handoffs/melo-doc-reconciliation-20261015.md)。
- 本文不是自动监控：各线程必须在实际改动后主动更新。未更新的线程或未记录的 diff 应标为“待归属/待核对”。

## 2. 当前事实

每个功能只保留一个现行状态和证据入口。测试数字只属于当次源码，见所链带日期的回执；当前树需重新运行 `npm test`（日常）或 `npm run test:full`（发布）。过程与旧状态见[历史交接](docs/handoffs/overview-history-20261019.md)。

| 功能 | 现行状态 | 证据 / 待验 |
| --- | --- | --- |
| 项目与工作区 | 创建显式归属、执行器绑定能力、无项目聊天按需独立目录（A `33660c6` / B `b02438a`）；文件面板、每次删除询问文件去留与遗留文件管理 `7ae2292` | [架构加固](docs/arch-hardening-20261015.md)、[UI 功能对齐](docs/ui-function-alignment-20261016.md)；项目聚合模型与完整删除级联见[项目专项](docs/project-architecture-plan-20261015.md)；P1 提交回执已交付，桌面项目页已拆到 `desktop-ui/features/projects/`（P2a，[架构方案](docs/architecture-maintainability-plan-20261019.md)） |
| Agent、技能与团队 | Agent 演进 P0–P4 已实现，6 Agent / 26 成果已迁移；审查修正 `4680530`；统一设置页 `dc67fa0`；团队与委派同一规则，手机本机可运行团队；10-20 能力临时提升 / 即时开启与新 Agent 只读起步、「基于已有 Agent」（桌面 + 手机，手机以本机权限为上限） | [实施与迁移](docs/agent-evolution-20261015.md)、[审查修正](docs/agent-review-fixes-20261015.md)、[设置](docs/agent-settings-20261016.md)、[协作](docs/agent-team-20261016.md)、[能力临时提升](docs/capability-elevation-20261020.md)；真实模型协作与真机单列 |
| 聊天与 agent loop | 手机与桌面同一循环（prepare → invoke-model → finalize），公共循环/预算策略现由 `shared/agent/` 同源执行，配置契约为 `shared/protocol/agent-loop.json`；七项双端对齐修复 `ee8eb3f` / `3ad091c` 已推送并装入双端；桌面聊天页 / 输入区 / 发送管线已拆到 `desktop-ui/features/chat/`（P2c） | [修复与 10-19 日常回执](docs/mobile-desktop-alignment.md)；真实供应商与长后台另验 |
| 记忆 | #2 并发写事务预约修复已通过 Mac/Linux 回归与完整日常；项目记忆本与个人档案已接入；项目来源手写记忆经独立可选通道（`/api/project-memory-sync` ↔ `/v1/project-memory`）同步；桌面记忆页 / 记忆本 / 回复页脚已拆到 `desktop-ui/features/memory/`（P2a） | [记忆架构](docs/memory-architecture.md)（以顶部现行约定为准）、[A7 回执](docs/mobile-desktop-alignment.md)；私人同步服务未部署新版 |
| 知识资料与成果 | 本机分段索引（SQLite FTS + 本地 embedding），按对话/项目开关过滤；两端按问题切段检索，旧 8 份 / 24000 字前置限制已移除 | [Agent 演进 P2/P4](docs/agent-evolution-20261015.md)、[A3/A5 回执](docs/mobile-desktop-alignment.md) |
| 设置、模型连接与账号 | 五语界面 `2cae1cd`；手机 Codex 设备码 OAuth `85ac3a5`、应用切换取消修复 `14e602f` | 用户真实授权尚未确认；同码恢复限同一进程；[五语](docs/interface-languages-20261015.md)、[模型连接](docs/llm-connections.md) |
| 双端同步 | v1 线协议冻结；Agent 能力与项目记忆走可选通道，旧服务只让扩展待同步，聊天同步照常 | [双端修复](docs/mobile-desktop-alignment.md)；私人同步服务需部署本版代码后启用新通道 |
| 工具、MCP 与网页 | 免费 MCP 默认启动 `f3dba1a`；连接器 / MCP / 会话授权 / 技能管理 `7ae2292`；手机系统数据工具 `2e47868`（默认全关）；两端网页打开与截图（10-18） | [MCP 启动](docs/mcp-startup-20261015.md)、[手机系统数据](docs/ios-device-data-20261016.md)；实体数据调用与真机 WKWebView 待验 |
| 搜索路由 | 自然餐饮/住宿/产品推荐与相关追问进入搜索；禁止联网、引用、闲聊、本地/App 边界保留，按当前能力说明不可用 | [#3 实施](docs/github-issues-implementation-20261020.md)；受控 HTTP 测试，真实供应商另验 |
| 图片、视频与附件 | 桌面/手机请求 `quality: high`，10-15 单次实测 Codex 服务回报 low；手机图片链与保存防重复已接生产入口；多图逐张、2K/4K、视频抽帧已合入主线 | 10-20 #4 已加入稳定图片登记及旧历史恢复，聊天/预览/保存共用受信入口，原图不改写；[实施证据](docs/github-issues-implementation-20261020.md)，未重做用户历史图片实点；见[图片承载计划](docs/image-capacity-plan-20261015.md)；[图片体验](docs/image-ux-20261016.md)、[多图与视频](docs/image-video-plan-20261016.md)；真实账号画质待验 |
| 语音 | TTS 路由与停止修复（10-17 审计）；手机朗读要点化并按回复语种选声（10-18） | [审计与实施状态](docs/architecture-agent-context-audit-20261017.md)；真机朗读待验 |
| 授权、审批与任务 | #1 审批期间持有文件身份，阻止 inode 复用（`47da231` 已推送，[实施](docs/github-issues-implementation-20261020.md)）； 模型 / 工具 / 授权共用截止与取消，超时后迟到批准零写入（A2）；手机权限首次迁移与撤销修正 `85c51f7`；桌面审批界面样式在 `desktop-ui/features/approvals/approvals.css`（工具/文件审批 JS 仍在 app.js，P2c）；能力请求卡片与「临时授权」列表在 `desktop-ui/features/approvals/`（10-20）；手机卡片进 `ChatStore` 审批队列，账本与判定在 `ios/Melo/CapabilityElevation{,Runtime,Views}.swift`（10-20） | [A2 回执](docs/mobile-desktop-alignment.md)、[手机权限](docs/phone-permission-fix-20261016.md) |
| 桌面壳与界面 | 当前安装源码 `897b77a`，原生启动与数据保留通过；神经总览 `22bcd1b`；双端低饱和黑金 M 图标；10-15 记录的阅读 / 预览 / 文件 WIP 已于 10-17 收入 `8cd3eff`；10-20 桌面工作面统一（`surfaceUnify.css` 最后载入：间距、13px 基准字号、控件、工作面不透明度、去旧绿色），手机未动、知识青灰身份色待用户决定 | [10-20 统一](docs/ui-unify-20261020.md)、[双端安装](docs/dual-reinstall-20261019.md)、[银河与留白](docs/galaxy-clarity-20261016.md)、[图标](docs/design/logo-muted-20261016/README.md)；`desktop-ui/app.js` 仍是中央入口（导航、组合、render() 保护、设置 / 资料 / 审批 / TTS 等页面）；记忆 / 项目页（P2a）、Agent 设置（P2b）、聊天（P2c）已拆到 `desktop-ui/features/` |
| iPhone | 实体机 0.7.4 (36) 已覆盖并启动，登录标识与对话 / Agent / 图片保留 | [双端安装](docs/dual-reinstall-20261019.md)；`ChatStore.swift` 仍集中协调（P4 拆分）；真实服务与长后台另验 |
| 远程渠道 | Telegram（10-16）、Discord（10-17）按用户决定归档，配置与历史保留 | [Telegram 归档](docs/telegram-archive-20261016.md)、[Discord 归档](docs/discord-archive-20261017.md) |
| 架构维护 | 方案已获批执行 P0–P2；P0 已交付：生成的功能地图、`npm run scope`、`npm run boundaries`、纯文档选组纠正与本总览重整；P1 项目 / Agent 提交回执已交付；P2 完成：P2a 记忆页、项目页拆入 `desktop-ui/features/` 并补齐 `bootstrapError` 重新拉取；P2b Agent 设置；P2c 聊天状态 / 事件与其余 CSS，`render()` 只调功能钩子，共享请求层为 `sharedApi.js` | [方案与第 8 节执行修订](docs/architecture-maintainability-plan-20261019.md)；P1 / P2 状态以最新交接为准；[独立审计](docs/claude-architecture-review-20261019.md)确认的提交后刷新失败回归已在 `46554b2` 修复，日常选定范围通过 |
| 发布 gate | 日常已按功能、反向依赖、隐式边与平台选组；任务 `--files` / 集成 `--base` / 强制 `--all`；先预检、JS / 资源 / Swift 去重；公共 / 未知边界保留扩大，发布完整 gate 保留 | [统一检测规则](docs/testing-workflow.md)（AGENTS / CLAUDE 共用）、[实施验证](docs/test-selection-implementation-20261020.md)：最终工具 29/29，隔离完整日常、两项浏览器与 32 Swift 通过；本地模型资源项补测 3/3 |

## 3. 功能索引

生成的功能地图 [`architecture/modules.json`](architecture/modules.json)（`npm run generate:module-map`；手写输入只有 [`architecture/module-annotations.json`](architecture/module-annotations.json)）列出每个功能的公开入口模块、跨功能依赖、HTTP 路由、桌面界面文件、手机对应、共享契约、测试组与隐式依赖（生成器、原生桥、`/shared/*.js` 服务映射、读源码的测试）。改动前运行 `npm run scope -- <文件…>`：只报告受影响功能、应核对的另一端、当前选组及原因，不改变 `npm test`。`npm run boundaries` 输出 bootstrap / stateStore / 扇出 / `uiState` 写入边界报告。

| 功能（地图 ID） | 桌面主要入口 | 手机对应 | 共享契约 · 测试组 |
| --- | --- | --- | --- |
| `projects` | `src/services/project/projectMutations.js`、`projectService.js`；`src/services/workspace/`；`desktop-ui/features/projects/` | `PersonalWorkspace.swift`、`WorkspaceProjection.swift` | sync-schema · `test:conversation-foundations` |
| `agents` | `src/services/agent/agentMutations.js`、`src/agents/team.js`；`desktop-ui/features/agents/`、`teamPanel.js` | `AgentProfile.swift`、`AgentEditSession.swift`、`AgentTeam.swift` | sync-schema、cross-platform · `test:markdown-files` |
| `chat` | `src/services/chat/chatExecutionRunner.js`、`sendChatMessage.js`、`src/runtime/agentLoopContract.js`；`desktop-ui/features/chat/` | `AgentLoop.swift`、`AgentLoopRuntime.swift`、`AgentLoopContract.swift`（生成） | **agent-loop**（`shared/protocol/agent-loop.json`）、reply-document · `test:prompt-pipeline`、`test:function-calling` |
| `memory` | `src/memory/`、`src/services/memory/memoryManagement.js`；`desktop-ui/features/memory/` | `MemoryFacts.swift`、`MemoryFactsView.swift` | sync-schema · `test:memory` |
| `knowledge` | `src/memory/knowledgeIndex.js`、`src/services/chat/knowledgeContext.js`、`src/services/artifact/` | `AgentProfile.swift`（MobileKnowledge）、`PersonalWorkspace.swift` | — |
| `settings` | `src/services/settings/`、`src/config.js`；`desktop-ui/localSettings.js`、`settingsEdit.js`、`llmConnections.js` | `SettingsView.swift`、`LLMConnections.swift`、`CodexOAuth.swift`、`EditDraft.swift` | `test:models`、`test:settings-design` |
| `sync` | `mobile-sync/`、`src/services/remote/mobileSync.js`、`src/http/mobileSyncRoutes.js` | `SyncWorkspace.swift`（含生成段）、`WorkspaceProjection.swift` | sync-schema · `test:mobile-sync`、`test:sync-contract` |
| `tools` | `src/tools/executor.js`、`registry.js`、`src/mcp/`、`src/services/connector/` | `DeviceTools.swift`、`WebPageTools.swift`、`LocalFileAccess.swift` | agent-loop（工具信封）· `test:tools-evidence-trail` |
| `media` | `src/images/`、`src/media/`、`src/services/chat/image*.js`；`desktop-ui/imagePreview.js` | `ImageWorkflow.swift`、`ImageViews.swift`、`VideoStudy.swift` | `test:image-workflow` |
| `voice` | `src/services/tts/`、`src/http/ttsRoutes.js`、`src/services/media/voiceRewrite.js` | `VoiceInput.swift`、`SpeechText.swift` | `test:tts` |
| `approvals` | `src/services/approval/`、`src/services/task/`、`src/safety/`；`desktop-ui/features/approvals/approvals.css` | `ChatStore.swift`（审批队列） | `test:audit-fixes` |
| `desktop-shell` | `desktop-ui/app.js`、`neural*.js`、`src/services/desktop/bootstrap.js`、`desktop-app/main.swift` | 场景经 `ios/scripts/build-scene.py` 打包 | `test:ui` |
| `iphone` | — | `ChatStore.swift`、`ContentView.swift`、`MeloApp.swift` | `test:ios` |

基础设施另列 `platform`（`src/state/`、`src/runtime/`、`src/http/` 传输）、`channels`（已归档渠道）、`tooling`（脚本与 gate）。

## 4. 最新交接

### 2026-10-20 — melo主线（Codex）— #7 已关闭，#11 项目生命周期验证
- 状态：#1/#4/#3/#9/#2/#5/#6/#8/#7 已推送关闭。#8 主线 a2551cf、Android 5f3d834；#11 验证中，之后 #12/#10/#13/#14。
- #6：组合主线完整日常 4303 JS + 35 Swift 与 iPhone simulator 构建成功。Android 05592af 已推送，CI 39365644626 全绿，模拟器 66/66；详见完成回执。
- #8：复用 ExecutionScene/ToolInvocationRecord/ExecutionRecord，同源生成稳定事件 ID；UI 和模型历史对得上。无回执的副作用保持 unknown，回看不执行；参数正文不进入规范事件，既有 Android 有界脱敏详情继续保留并关联事件 ID。
- 文件/证据：[完成回执](docs/completion-receipts-20261020.md)、[Session Events](docs/session-events-20261020.md)，src/shared/sessionEvents.js、shared/agent/execution.js、Node 记录/上下文、Swift 原生桥和共享执行面板；Node 三协议 HTTP、落盘与零重放计数、Core/DOM 专项 160/160。
- 边界：隔离工作树、隔离数据与受控 HTTP；真实模型/实体设备未验，未安装应用、运行 git pp 或改真实账号。主线日常 4314 JS + 35 Swift、iPhone simulator 构建通过；Android 5f3d834 的 CI 39366995591 全过。#7 已逐字移植预算，正接原文回读、压缩边界与来源开关，见 [Android 上下文](docs/android-context-20261020.md)。
- #7：主线 fd0dfd7 / ab8240a、Android ef276a5 已推送且 issue 已关闭；4322 JS / 35 Swift 与 Android CI 39375015622（68/68、零跳过）通过。三次 ART 崩溃证据和修正保留在专项文档。
- #11：[项目生命周期](docs/project-lifecycle-20261020.md)，主线 89dc1af / Android ee0f66b；主线 4331 JS / 35 Swift 与 iPhone simulator 构建、Android CI 39377354163（69/69、零跳过）全过，按授权发布关闭。
- #12：[Memory Schema 边界](docs/memory-schema-boundary-20261020.md)，39bd465 逐字移植、e64bfe6 接线；4335 JS / 35 Swift 与 Linux/macOS CI 39377921633 全过，按顺序发布关闭。下一项 #10 Android CI 39378706877 验证中，之后 #13/#14。

### 2026-10-20 — melo审计修复（Cowork / Claude）— 能力临时提升与即时开启（iPhone 端）
- 接手桌面交接（专项第 9 节）：Swift 判定核心与 35 条共享夹具（0 跳过）、本机账本与请求代理、唯一卡口 `DeviceToolContext.perform`（主回复与团队成员、三条连接）、卡片与「临时授权」列表、新建 Agent 起点。入口与映射、差异见[专项](docs/capability-elevation-20261020.md) 9.1–9.3；契约新增 `capabilityElevation.phone`（只增不改，桌面忽略）。
- 上限是本机按 Agent 的手机权限（运行开始快照 ∩ 当前）；托管搜索、生图与图片任务仍按原开关不弹卡；设备手机数据开关与系统权限是外层边界。账本 `Application Support/Melo/capability-grants.json`：不同步、不备份、不进提示词 / 记忆 / 导出，只由卡片按钮对进行中请求 ID 产生。
- 验证：`CapabilityElevationTests` 与 33 组 Swift、模拟器 Debug 构建 0 警告；日常 `npm test -- --base 5872d7d` 选定范围通过（JS 4147/4159，12 跳过）。签名 0.7.5 (37) 等待 Mac 钥匙串授权、实体手机 unavailable，未安装；真实模型、真机卡片交互未验。
- 下一步：用户允许钥匙串后完成签名构建、手机连上后覆盖安装并回读版本；不运行 git pp、不推送。

### 2026-10-20 — 设计 Melo（Codex）— 按功能和平台选组已实施
- 用户已授权完整落实审计并统一 Codex / Claude / 人工规范；入口 `scripts/{test-plan,test-impact,test-stages,verify-daily,scope}.js`、`ios/scripts/test.py`，规则见 [testing-workflow](docs/testing-workflow.md)，证据见 [实施记录](docs/test-selection-implementation-20261020.md)。
- 已补 UI → 后端文件安全接线漏选；任务范围 / 共享树范围显式区分；功能反向依赖、tooling、手机资源与 Swift 输入分组；预检前置、生成器 / iOS JS 去重；公共 / 未知边界保留全量。
- 交付：脚本、对应回归、架构登记与 Markdown；最终工具 29/29、scope 6/6；隔离副本完整日常 4162 JS 通过 / 1 模型资产项跳过（补测 3/3）、两项浏览器、共享渲染与 32 Swift 通过；本地提交见本条提交。证据 `.tmp/test-selection-implementation-20261020/`；同时进行的手机能力提升 WIP 不归本线程。
- 后续开发按统一规范先看计划、任务检测，再做批次集成；未知依赖 / 地图过期必须修复，禁止为缩小范围删测试或放宽断言。未安装、未推送、未运行 git pp；当前共享树的手机 WIP 仍由对应线程验收。

### 2026-10-20 — 设计 Melo（Codex）— 日常测试范围与重复执行审计
- 线程 ID：`01a1161a-1919-79c1-9764-8709bb0e2e2d`；用户质疑小改动总跑四千多项。本轮只审计，以开始时干净的 `5872d7d` 为源码基准；实际入口 `scripts/{test-plan,verify-daily,scope}.js`、`ios/scripts/test.py`，报告见[专项](docs/test-selection-audit-20261020.md)。
- 确认：后端 / 架构 JSON 触发 469 个 JS 文件 + 两项设置浏览器 + 32 Swift；纯桌面 82 文件；iOS 资源也触发 Swift。共享树 / 旧基准扩大范围；已登记的 UI → 文件安全测试边反而漏选；iOS 两份 JS 重复执行，manifest 预检过晚造成回跑。
- 验证：计划矩阵与遗漏断言；选组 / scope / 地图工具回归 15/15（约 2.05 秒）。复核能力提升三次 4151 项 JS 日志及最终 466.9 秒日常；这些为历史回执，本轮未重跑完整产品 gate。证据 `.tmp/test-selection-audit-20261020/`。
- 交付仅审计 / 总览 / 短进度文档，本地提交见本条提交；没有改测试门禁或产品。收尾出现其他线程的 `shared/protocol/agent-loop.json` / `ios/Melo/AgentLoopContract.swift` WIP，保留且不纳入本轮验收。下一步按报告先补漏选、提前预检，再拆平台与功能选组；未推送、未运行 git pp。

### 2026-10-20 — melo审计修复（Cowork / Claude）— Agent 能力临时提升与即时开启（桌面 + 共享规则）
- 线程 ID：`01a11623-b29c-70c7-8ee0-bb21a1e6eef3`；用户拍板七条规则（上限=Agent 自身设置；超出父级与自身缺少都须运行时点击；运行级 / 24 小时项目或对话级授权可撤销；独立账本不进记忆与同步；新 Agent 只读起步并可「基于已有 Agent」；审计）。本线程只做桌面与共享契约，手机由下一位工程师接手。
- 入口：契约 `shared/protocol/agent-loop.json` 的 `capabilityElevation` 与 `fixtures.capabilityElevation`（已嵌入 `AgentLoopContract.swift`）；领域 `src/domain/agent/capabilityElevation.js`、`capabilityScope.js`；账本 `src/persistence/capabilityGrantLedger.js`（`<home>/desktop/capability-grants.json`）；服务 `src/services/agent/capabilityElevation.js`；卡口 `src/tools/executor.js`；路由 `src/http/capabilityRoutes.js`；界面 `desktop-ui/features/approvals/`、Agent 页新建流程。设计、安全推理、测试与手机交接见[专项](docs/capability-elevation-20261020.md)。
- 验证：日常 `npm test -- --base bbe8096` 通过（JS 4139/4151、语法、文档、两项设置浏览器、共用渲染 4/4、32 组 Swift）；能力提升真实浏览器回归（委派 → 卡片 → 本对话 24 小时 → 工具运行 → 列表 → 撤销）及 Agent 设置相关浏览器回归在 Mac 通过；重启用户 Melo 后只读在线检查 Agent 页、新建流程、权限页 0 控制台错误、0 写请求。 隔离 home 与 fixture 模型，不是真实模型或实体应用验收。
- 下一步：手机工程师按专项第 9 节实现 Swift 判定、`SharedContractTests` 夹具运行器、手机账本与卡片；不运行 git pp。


此前交接（原文见[历史交接](docs/handoffs/overview-history-20261019.md)，新者在后）：10-19 双端逻辑只读审计 → 七项修复与最终日常 → 双端覆盖安装与数据保留 → 架构维护成本审计与方案 → GitHub 权限只读核对 → 架构方案 P0 执行 → 架构方案 P2a 记忆页与项目页 → 架构方案 P2b Agent 设置 → 架构方案 P2c 聊天拆分 → Claude 架构 P0–P2 独立审计 → 已提交保存恢复 R1 修复。

## 5. 整体架构与代码地图

保留模块化单体。桌面/CLI/远程渠道共用 Node 业务核心；iPhone 有独立 Swift 聊天与模型通道，通过共享同步协议交换工作区数据。网站和基准工具独立于产品运行时。

Telegram 于 2026-10-16、Discord 于 2026-10-17 按用户决定暂时归档：关闭设置入口、轮询、语音运行时和外发，原有配置与历史对话保留。政策入口 `src/shared/channelAvailability.js`，行为、恢复条件与验证见 [Telegram 归档](docs/telegram-archive-20261016.md)、[Discord 归档](docs/discord-archive-20261017.md)。

```text
桌面 Swift 壳 → desktop-ui → HTTP / SSE ┐
CLI / 远程消息渠道 ─────────────────────┤
                                      ↓
入口上下文 → 领域服务 → 对话执行图 → providers / 模型
                ↓          ↓                 ↓
         状态事务与检查点   工具/审批/任务    流事件/图片产物
                ↓          ↓                 ↓
        后台增量记忆索引   执行记录 ←──────────┘
                ↓
          检索与提示词构建

iPhone Swift UI → ChatStore → 独立 Codex OAuth / API 连接
          ↕ 工作区同步（与独立聊天分开）
    mobile-sync ↔ 桌面业务核心
```

| 层 / 入口 | 代码定位 | 职责与约束 |
| --- | --- | --- |
| 桌面壳 / CLI | `desktop-app/main.swift`、`src/index.js` | 原生生命周期、安装启动和命令入口；核对实际 app / PID / home |
| 桌面界面 | `desktop-ui/app.js`、`desktop-ui/features/{memory,projects,agents,chat}/`、`neural*.css`、`executionPanel*` | 暗色神经导航、聊天、设置、执行回看；局部更新保留焦点与草稿；功能模块约定见 `desktop-ui/features/README.md` |
| 神经导航 / 场景 | `desktop-ui/neuralLayout.js`、`neuralMotion.js`、`neuralShell.js`、`neuralSatellite.js`、`neuralScene3D.js` / `neuralScene.js` | 同一空间模型驱动 DOM、GPU/Canvas 与拾取；10-16 两端共享清晰星核与薄云层，布局/持续动画不变，见 UI 交接 |
| 传输 / 路由 | `src/server.js`、`src/http/` | HTTP/SSE、来源检查、声明式路由与生命周期；不承载新增领域业务 |
| 请求运行边界 | `src/runtime/requestContext.js`、`requestScope.js`、`processOwnership.js` | 入口捕获 home、环境、身份、路径和取消信号；异步执行不重读可变全局 home |
| 领域服务 | `src/services/`；`src/desktopStore.js` 为兼容入口 | chat / task / settings / agent / workspace 等业务；新增业务放领域服务 |
| 项目 / 工作区边界 | `src/services/project/`、`src/services/workspace/`、`src/domain/project/`、`src/services/chat/portableWorkspace.js` | 项目与聊天工作目录已显式绑定，聊天文件生命周期由 `chatWorkspaceFiles.js` 管理；UI 跟随当前聊天。项目聚合与资产生命周期完整重构仍见专项 |
| 纯领域 / 持久化辅助 | `src/domain/`、`src/persistence/` | 纯实体与可复用持久化辅助；保持依赖方向，抽模块先逐字节移植 |
| 状态与检查点 | `src/state/stateStore.js`、`chatPersistence.js`、`chatManifest.js`、`statePayload.js` | 原子事务；规范化 home 隔离；不可变消息 checkpoint 与单调清单修订 |
| Agent 设置 | `desktop-ui/features/agents/`（含 `agents.css`、`agentSettings.css`）、`settingsEdit.js`、`src/services/agent/agentMutations.js` | 单一编辑页、页头新增、全局新建、跨渠道显式保存；旧 Mood UI/双端提示注入已停用，旧数据兼容；见 [设置验收](docs/agent-settings-20261016.md) |
| 对话执行 | `src/services/chat/`、`src/agents/` | 入队、上下文/预算、模型请求、工具续接、取消与落盘；同聊天串行，不同聊天可并行 |
| 供应商 | `src/openai.js`、`src/providers/` | Codex / API / Anthropic 协议与流解析；原生 function calling 接入 Melo 自身执行器 |
| 工具 / 授权 | `src/tools/`、`src/safety/`、`src/services/approval/` | 校验参数、权限、工作区与执行身份；外部副作用不因网络失败盲重放 |
| 图片 | `src/images/`、`src/services/chat/imageTurn*`；`ios/Melo/ImageWorkflow.swift` | 明确分析/生成/编辑意图，绑定真实原图，保存产物与失败；不要把语言模型名当图片型号 |
| 记忆 / 检索 | `src/memory/`、`src/retrieval/`、`src/runtime/derivedIndexing.js` | 内置 ONNX 多语 embedding worker、本地 SQLite/FTS/向量、事实作用域与增量派生；使用记录只计实际进入 prompt |
| 执行事件 | `src/shared/executionScene.js`、`executionMetadata.js`、`src/services/chat/executionPipeline.js` | 真实工具/模型轮次、公开摘要、结果、token/耗时白名单；未知保持未知，历史查看不重跑 |
| 手机原生 | `ios/Melo/ChatStore.swift`、`ContentView.swift`、`SettingsView.swift`、`MeloApp.swift` | 本机聊天、角色、草稿、设置、图片和前后台；桌面关机不应阻断独立聊天 |
| 手机授权 | `CodexOAuth.swift`、`ChatGPTAccount.swift`、`CodexLoginView.swift`、`Keychain.swift` | 设备码 / PKCE / 身份签名 / 刷新；新键 `codexAccounts`，连接 ID 保留 `chatgpt`；不复制桌面 token |
| 手机同步 / 共享渲染 | `mobile-sync/`、`ios/Melo/SyncWorkspace.swift`、`ios/Melo/Scene/`、`ios/scripts/build-scene.py` | schema 生成 JS/Swift 约束与共用样例；共享资源 manifest/hash；同步不是模型登录 |
| 手机上下文与团队 | `PhoneContext.swift`、`AgentProfile.swift`、`AgentTeam.swift`、`ChatStore.swift` | 与桌面共用容量默认值；消息原文保留、话题卡可回读；同一份过滤证据用于主请求/核实/成员，成员读取项目覆盖并受父级工具范围与自己的预算限制 |
| 项目来源记忆扩展 | `mobile-sync/projectMemoryProtocol.js`、`src/services/chat/projectMemorySync.js`、`ProjectMemoryProjection` | `/v1/project-memory` 和 `/api/project-memory-sync` 独立可选通道；不伪造聊天来源；旧服务继续同步聊天，该扩展保留待同步；冲突与恢复日志保留 |
| 手机文件 | `ios/Melo/LocalFileAccess.swift`、`LocalFilesView.swift`、`LocalPermissionsView.swift` | 本机目录书签、撤销、路径约束、预览与确认导入；授权不自动上传 |
| 外部官网原型 | `/Users/mortred/Documents/New project/melo-universe/src/{data,neural-geometry,scene,navigation,main}.js`、`styles.css` | 独立 Three.js / Vite SPA；连通神经图、真实投影命中、History API 管理三级 hash 路由，`onFrame` 进度协调相机/滚动/正文；不接产品模型、账号或收款，旧站与桌面导出分别保留 |
| 外部 SWE-bench 适配 | `/Users/mortred/Documents/New project/benchmarks/melo-swe-docker-agent-20261014/{run_melo.mjs,container_tools.py,run_batch.py}` | 调用产品正常消息入口，在独立基准进程替换六个工具运行函数并自动授权；产品仓库没有Docker功能改动或接入提交；评分不覆盖桌面权限/手机 |
| GitHub 公开介绍 | `README.md`、`CHANGELOG.md`、GitHub About（`MortredVigoss/Melo`） | 10-18 按源码重写简短英文介绍，突出多模型兼容、项目、记忆与 Agent 协作；公开改动说明只写用户可感知的大方向，协议、参数、路径和验收细节留在专项文档 |

### 设计线程模块补充（2026-10-15 核对；当时的共享 WIP 已于 10-17 收入 `8cd3eff`）

| 模块 | 实际文件 / 接口 | 当前边界 |
| --- | --- | --- |
| 公开摘要与 API 回执 | `src/providers/reasoningSummary.js`、`streams.js`、`anthropic.js`、`src/openai.js` → `src/services/chat/executionPipeline.js` → `src/shared/executionMetadata.js` / `executionScene.js`；`src/server.js` 提供 `/shared/executionMetadata.js` | 公开摘要 delta/done/part/item/terminal 去重合并，24,000 字符上限；token 缺失不补零，耗时为本机观测；不记录隐藏推理、凭证或完整响应体 |
| 神经任务空间详情 | `desktop-ui/executionPanel.js` / `.css`、`executionDetails.js`、`executionViewport.js`；`ios/Melo/Scene/` 共享资源 | 最新回执、分轮可滚动摘要、完整详情；摘要滚轮不误触相机；历史仅读已存 sidecar，失败/取消保留已有回执；手机独立采集须另核对 |
| 阅读与输入 | `desktop-ui/app.js`、`styles.css`、`localSettings.css`、`neural.css`、`neuralGlass.css`、`executionPanel.css`；`ios/Melo/ContentView.swift` / `ReplyContentView.swift` | 标准正文 14px、2–4 行后内部滚动；重绘保留草稿/滚动，窗口折行与删字回缩；移除顶部 Quick actions，快捷键及输入区角色/模型保留；手机动态字体保留 |
| 图片预览与保存 | `desktop-ui/attachmentCards.js` → `imagePreview.js`；`localSettings.js` 的 `nativeSettings('saveImage')` → `desktop-app/main.swift`；`ios/Melo/ImageViews.swift` 的 `ImageContextActions` / `ImagePhotoExport` | 桌面原生保存面板写原始字节，取消/失败可重试；来源限主框架本机 origin，解码与 64 MB 限制；手机长按预览/保存/分享/继续修改，照片仅按需申请添加权限 |

### 数据与失败语义

- 数据目录由实际 `MELO_HOME` 决定，不凭默认路径猜当前用户数据。一个 home 由一个后端拥有；测试用隔离 home。
- 业务通过 `updateStateAtomically` 更新最新状态，网络和用户等待在短事务外；拒绝过期快照覆盖。
- checkpoint 先写，原子清单替换为提交点；再同步派生索引。索引失败不把已保存消息报成未保存；持久修订回执支持恢复。
- 状态按规范化 home 常驻缓存；生产派生索引由独立 worker 增量追平，维护命令可走同步路径。冷启动仍读历史，消息正文未分页；bootstrap 仍组装整体数据后按基准传变化字段，不是所有接口都已实体化。性能夹具使用模型/embedding 桩，不能推断真实端到端速度。
- SQLite 同时含独立长期记忆、用户编辑和 `memory_hits`，不能把整个数据库删作缓存。删除来源对话后其事实停止自动调用，保留可检查记录。
- 请求身份与运行身份关联执行/审批；相同完成请求可回放已存结果，中断或副作用结果不明需要明确新请求。
- iPhone 设置默认只读，明确编辑和保存；失败/冲突保留草稿。图片仅在没有其他对话/草稿/编辑链引用时清理。
- Codex 授权后台暂停新轮询、回前台恢复同码；临时网络有限退避；主动取消阻止迟到保存；一次性 token 交换结果不明不自动重放。
- 手机待授权设备码仅在 `ChatGPTAccount` 内存中保留，不支持进程结束后的待授权恢复；已登录凭证单独写 Keychain。验证码过期需重新申请，不能把前后台恢复描述成重启恢复。
- 手机模型目录使用 Codex 兼容版本 `0.180.0`；历史真实 GET 对比发现 `0.157.0` 漏掉 Sol 6.1。内部连接 ID `chatgpt` 只是迁移兼容标识，不表示仍调用旧 SIWC；API 连接可独立选择，执行器仍为 Melo。

架构详证：[`docs/backend-architecture.md`](docs/backend-architecture.md)、[`docs/architecture-performance-2026-10-13.md`](docs/architecture-performance-2026-10-13.md)、[`docs/memory-architecture.md`](docs/memory-architecture.md)。记忆文档下半历史默认值不覆盖其顶部现行约定。

## 6. 各线程登记

线程名称是协作归属，不是 Git 分支；同文件可能由多个线程共享修改。

| 线程（原名） | ID | 最新交接 / 实际范围 | 状态与证据 |
| --- | --- | --- | --- |
| melo审计修复（Cowork） | `01a11623-b29c-70c7-8ee0-bb21a1e6eef3` | 10-17 三路只读审计 → 四批修复：TTS 路由、上下文预算/窗口/压缩同源、逐轮上下文入用户消息、Discord 归档、Agent 成员/循环/审批加固、分层 gate 传递闭包、文档对齐；10-19 手机 agent loop 对齐桌面（共享 `agent-loop.json`）；10-19 架构方案 P0 执行 → P2a 记忆 / 项目页拆分 → P2b Agent 设置拆分 → P2c 聊天拆分（P2 完成）；10-20 Agent 能力临时提升与即时开启（桌面 + 共享规则 + 手机端） | 沙箱全量 JS 回归与基线一致；用户机器日常 gate 见本次提交；[审计与实施状态](docs/architecture-agent-context-audit-20261017.md) §7；P2c / P2b / P2a / P0 见[历史交接](docs/handoffs/overview-history-20261019.md) |
| melo主线 | `01a13b2e-5446-7042-bb5e-773129746c7e` | 七项双端修复已推送并覆盖两端；10-19 新增架构维护成本审计与分期方案；10-19 GitHub 权限只读核对；10-19 Claude 架构 P0–P2 独立审计与 R1 修复；10-20 核对并按序实施 yrlf 的 14 条 issues | [双端修复](docs/mobile-desktop-alignment.md) / [装机保留](docs/dual-reinstall-20261019.md)已验；[架构方案](docs/architecture-maintainability-plan-20261019.md)已本地提交 `db9f7ba`，用户已批准执行 P0–P2（执行修订见方案第 8 节）；本次[审计及修复](docs/claude-architecture-review-20261019.md) R1 已在 `46554b2` 修复，日常选定范围全部通过，已随 `401ae4b` 推送；[14 条 issues 核对](docs/github-issues-review-20261020.md)已转入[按序实施](docs/github-issues-implementation-20261020.md)，#1 修复 `47da231` 已推送、issue 已关闭，双平台 CI 通过；#4 `94e76cb` 已推送、issue 已关闭；#3 `1c48b6a` 已推送、issue 已关闭；#9/#2/#5 已推送关闭；#6 已关闭，#8 已关闭，#7 已关闭；#11 跨端验证中 |
| melo主线（历史·2026-10-15） | `01a10bf2-e092-7862-87fe-2f237a8fb6a0` | 架构、审计、记忆、function calling、日常 gate 和手机 OAuth；本次只补遗漏 | 已完成补录；授权核心已提交，当时相关共享文件的他线程 WIP 已于 10-17 收入 `8cd3eff`；[build23 回执](docs/handoffs/melo-thread-backfill-20261015.md#historical)，产品任务交新主线 |
| 设计 Melo | `01a1161a-1919-79c1-9764-8709bb0e2e2d` | 五语 / 图像质量 / MCP / Agent 设置已完成；10-20 测试选组审计后按用户授权完成漏选修复、功能 / 平台选组、预检去重与统一开发规范 | [实施与验证](docs/test-selection-implementation-20261020.md)：工具 29/29，隔离全日常与 32 Swift 通过；产品业务和其他线程 WIP 保留，本地提交未推送。历史 Agent 验收见 `docs/agent-settings-20261016.md` |
| melo ui | `01a10bf3-d7b9-7832-a351-8b0f78e9c552` | 10-16 UI 设计语言审计：主视觉统一，新增浮层/设置/控件接入不完整；仅审计 | 六类差异与手机 Form 待验项见[审计报告](docs/ui-language-audit-20261016.md)；桌面实看/样式采样，手机源码层；此前[银河与留白](docs/galaxy-clarity-20261016.md)验证保留 |
| 读取 melo ui 方案 | `01a1103d-0c3b-77d4-96dc-ea499d455020` | 2026-10-06 读取、单次成功派发、按指定 turn 只读跟进与 Library 截图交付；2026-10-15 补历史证据 | 辅助线程无产品代码/提交；288/291 项为旧轮次结果，详细边界见[辅助线程回执](docs/handoffs/melo-thread-backfill-20261015.md#ui-helper) |
| melo iphone | `01a11116-8469-74a2-9815-8ce59b702afa` | 10-16 三线程功能/UI 对齐，Agent 首屏新建/移除旧语气、项目校验及新黑金 M，已覆盖 0.5.19 (25) | 本地 `5c975aa`；3575 JS/23 Swift/90 专项及模拟器通过；实体安装/启动/数据保留已验，实体 UI/真实模型未复验；`docs/ios-align-install-20261016.md` |
| melo副线 | `019d5db3-d2cd-70c2-bc8f-955d36099219` | 固定源码统计口径、早期 pre-push evaluation 协议；OpenClaw/桌宠历史工作独立 | 2026-10-20 再统计 201,234 行（含空行/注释，不含 ios）；既定四目录及扩展名 `find` / `wc -l` 退出码 0；仅文档 WIP 与快照更新，无产品验收或提交；桌宠入口见[副线回执](docs/handoffs/melo-thread-backfill-20261015.md#secondary) |
| melo网站 | `019dce6e-faae-7850-a8bb-db48b737b928` | 2026-10-15 核对神经网络四区、外放标签和连续镜头源码/快照差异；首页有界轴向转动，非各层无限自转 | 独立本地 WIP，无 Git 元数据/可核实提交；历史 13 单元/22 浏览器未重跑；本轮静态核对旧站 9/9 散列与桌面副本一致；详见[网站交接](</Users/mortred/Documents/New project/melo-universe/HANDOFF-20261015.md>)，Safari/用户验收/发布待验 |
| Benchmark Melo on a major platform | `01a139e9-2509-7623-8cb7-4df16b2d0c86` | Melo 核心在 Mac，六个编码工具经外部适配接 Docker；2026-10-15 核对历史证据与当前 diff | 历史3/3、目标3/3/回归158/158、对照0/3；Requests81项非计分错误；外部WIP未产品化；非当前树验收；详见[跑分回执](docs/handoffs/melo-thread-backfill-20261015.md#benchmark)与外部 HANDOFF；GitHub英文README/About/12标签已发布 `39cc759` |

外部跑分证据：`/Users/mortred/Documents/New project/benchmarks/melo-swe-docker-agent-20261014/report.md`。网站旧目录 `site/`、`/Users/mortred/Desktop/melo_web` 与 `melo-universe/` 是不同产物；不能自动互相覆盖。

## 7. 保留的产品决定

- 副线统计沿用 `src`、`desktop-ui`、`desktop-app`、`scripts` 下 `js/mjs/cjs/ts/tsx/jsx/swift/sh/applescript/json/html/css` 文件的 `wc -l` 合计，含注释和空行，不含 `ios/` 及目录外内容；不是全平台总代码量，历史结果不代替实时统计。
- 2026-10-15 用户最新决定：仅用户明确要求才运行 `git pp` 或等价脚本；不自动审查、重审或推送。测试、本地提交、已授权修复持续推进。被要求运行时仍保留推送门禁。
- 保持现有暗色神经网络语言；“太空”增加内部密度与深度。导航悬停原位放大约 3–5% 并变亮，不偏移出屏。
- 任务空间由真实执行事件驱动，支持并行、独立折叠和历史回看，及时展示结果。细线发光神经突触、深紫活动区、轻透来源卡片；未逐项验收的视觉目标不能写成已完成。
- 搜索来源网站默认最相关 5 个，展开最多 10 个；引用是额外标记，不先排除被引用网站。区分搜索命中、实际读取、最终引用，不编造淘汰理由。
- 手机独立聊天与跨端同步分开；对话可选角色和模型。自有账号注册等待用户配置 Supabase，区别于模型平台 OAuth。
- 本地语义检索不要求额外软件。“额外快速”默认关闭，仅按已配置连接分配判断任务，不改变回答模型。
- 保护聊天、角色、草稿、图片、设置和凭证；覆盖安装前后检查数据。源码/夹具/真实服务/签名安装/用户验收分层报告。

## 8. 所有线程的更新协议（用户于 2026-10-15 要求）

1. 开工读本文并核对 git status；认领相关模块与文件。发现未记录改动先标“待归属”，不能按线程名猜作者。
2. 每个可验证步骤或改变架构/行为/接口/数据/视觉后，更新第 2 节对应功能的现行状态和线程行，再在第 4 节“最新交接”追加简短交接，上一条最新交接原文移入 `docs/handoffs/overview-history-*.md`（保留日期 / 提交，详细证据放专项或归档文档）；失败、回退、取消与未完也要记录。
3. 条目写：日期、线程名/ID、目标、旧→新行为、实际文件/接口、跨端影响、提交或 WIP、验证命令与结果、证据、未完/下一步。不能只写“已完成”。不写凭证、验证码、token 或用户图片内容。
4. 同时按 `CLAUDE.md` 更新 `PROGRESS.md` 的短意图记录，运行 `npm run progress:codex`。本文是人工现状，快照生成器不得覆盖本文。
5. 产品提交后补提交 hash；纯文档检查点由 Git 追溯，避免为记录自身 hash 连续提交；其他线程的 WIP 不混合暂存/提交，不 amend。共享文档编辑前重新读最新文件，只改自己的段落，保留别人新增条目。
6. 外部网站/桌宠/跑分在实际项目记录详细证据，并在本文留交接入口；新 Melo 线程加入登记表。
7. 手机“对齐”先从本文三线程登记/交接和实际 diff 建计划；只有记录过期、缺失或冲突时定向补读近期相关轮次。功能、接口、Bug、UI/特效都必须核对。
8. 历史记录过长时归档到 `docs/handoffs/` 并保留索引，当前事实、待验和下一步始终留在本文。旧测试计数不得充当新树 gate。

### 交接条目模板

```markdown
### YYYY-MM-DD — 线程名 — 目标
- 线程 ID：...；状态：WIP / 已提交（hash）/ 已回退。
- 行为：旧 → 新；文件 / 接口：...；架构及跨端影响：...。
- 验证：命令、结果与实际层级；证据：路径。
- 未完 / 下一步：...；数据、配置、凭证影响：...。
```

## 9. 验证入口

| 改动边界 | 常用检查 |
| --- | --- |
| 改动前定位 | `npm run scope -- <文件…>`（只报告）、`npm run boundaries`；新增文件 / 路由 / 跨功能 import 后 `npm run generate:module-map` |
| 日常变更 | `npm run test:plan`、`npm test`；按 `docs/testing-workflow.md` 确认范围；纯说明文档只做相对链接检查 |
| 完整发布 | `npm run test:full`；含构建、安装和启动阶段，注意并行线程/运行中用户任务 |
| 手机 | `npm run test:ios`，再独立记录编译、签名、安装、数据核对、真机 UI 和真实服务 |
| UI / 架构 | `npm run test:ui`、`npm run test:architecture`、`npm run test:architecture-performance` |
| 记忆 / 同步 | `npm run test:memory`、`npm run test:mobile-sync`、`npm run test:sync-contract` |
| 模型 / 工具 / 图片 | `npm run test:models`、`npm run test:function-calling`、`npm run test:image-workflow` |

### 2026-10-20 — melo主线（Codex）— #10 发布与 #13 容量基线
- #10 手机正式分支 db69337 已推送；7584df4 的 CI 39379418326 JVM/Lint/Debug/R8 和 emulator 72/72 通过，GitHub 已关闭。[布局缓存](docs/fold-cache-20261020.md)，不等于 Fold6 真机验收。
- #13 WIP：[容量基线](docs/capacity-baseline-20261020.md)、scripts/bench-capacity.js 与 capacity-fixture.js，隔离 home 1k/10k/50k 消息；原始报告 bench/capacity/baseline-20261020.json。冷线程 hydrate 为主要成本，暂不改分页语义。
- 统计与实际 CLI 回归 3/3；完整日常待验。未修改用户数据或安装应用。下一步完成 #13 发布，再做 #14 共用任务评测。

#13 回执：基于 4d8e871 的完整日常 147.2 秒通过，35 Swift 组全绿，新增实际 CLI 回归已接自动发现；准备按授权推送关闭。容量测量与原始样本已入库，暂未改分页，具体决定见专项文档。

#13 验证补充：初次日常 4337 通过、内置模型缺失导致 1 跳过；已按固定 hash 准备资产并补跑 3/3 零跳过。提交 27285c3 已到 master，准备关闭 #13。

### 2026-10-20 — melo主线（Codex）— #14 共用任务评测
- [任务回放](docs/task-replay-20261020.md)：11 项任务、同源 Runner/Scorer、完整 SessionEvent 比较与固定数据/bundle hash；独立标记 fixture token/虚拟时间，不宣称真实 LLM 成功率。
- 回放检出并修正：明确未执行的未知工具不再把研究误判为操作；实际/未知副作用仍保守。真实文件 shared/agent/taskReplay.js、taskScore.js、completion.js 和原生测试/CI。
- Node 专项 25/25，Node/VM/JavaScriptCore 一致；Android 及完整日常待验。#13 已推送关闭；当前只剩 #14。没有安装或用户数据变动。

#14 主线集成回执：基于 6a5a171 的完整日常 4356/4356 JS、35/35 Swift 通过，零跳过；图片预览等待实际 fit 初始化后全套通过。Node/JavaScriptCore 的 11 项任务及事件一致。Android 首轮 CI 39382785730 在 emulator 阶段失败，正在读报告，尚未发布或关闭 #14。

#14 主线远端：aa83db2 / CI 39391968956 Linux 与 macOS 全绿；三份已下载报告与本机逐字段对比一致。Android 首轮实际 73/73 用例通过，失败仅在卸载后的报告收集；b6f375d 第二轮 39392779228 正在 emulator 阶段。生产分支尚未发布 #14。

#14 Android 报告链路：前两轮均 73/73，报告文件导出失败；最终 a11183b 改运行期 localhost/ADB reverse 上报并校验本轮 UUID，真实 HTTP 收集回归通过。CI 39394944470 待验；正式分支仍保持已完成的 #13/#10，不提前关闭 #14。

### 2026-10-20 — melo主线（Codex）— GitHub 剩余问题最终验收
- #1–#13 已逐项验证、推送并关闭；#14 实现/验证完成，准备正式推送关闭。主线产品 aa83db2，手机产品 a11183b；保留原共享工作树的他线程 WIP。
- #14 11 项同源任务在 Node / JavaScriptCore / Android JavaScriptSandbox 的完整事件、回执、成本相同；修正了拒绝工具导致研究误判为操作的问题。脚本/数据/验收见 [专项](docs/task-replay-20261020.md)。
- 主线 4356/4356 JS、35/35 Swift；远端 CI 39391968956 Linux/macOS 通过。Android CI 39394944470 JVM/Lint/Debug/R8、73/73 emulator 和本轮报告收集/比较通过，下载 XML 与报告再次核对。
- #10 布局缓存、#11 生命周期、#12 SQLite 边界、#13 容量基线已在对应专项留记录。真实模型质量、Fold6/iPhone 实体设备及安装验证另计；账号和数据未变，无 git pp。

最终发布回执：GitHub #1–#14 均已关闭，实时 open issue 查询为 0；#14 完成评论 https://github.com/MortredVigoss/Melo/issues/14#issuecomment-6287315760 。主线 8175263、手机 379db49 已推送，后续提交仅补本条文档回执。代码与 CI 验证点仍为 aa83db2 / a11183b，无未完 issue 工作。
