# Melo 总览：当前事实、功能索引与接手入口

更新时间：2026-10-24（Australia/Melbourne）。这是所有 Melo 工作线程共用的人工维护入口：顶部依次是当前事实、功能索引和最新交接；按日期的阶段过程（含日期、提交与当次验证数字）在 [总览历史交接](docs/handoffs/overview-history-20261019.md)。

## 1. 先看这里

- Mac 工作仓库：`/Users/mortred/Desktop/melo/Melo Desktop Project`；Android Integration 的 WSL 工作仓库：`/home/zhouy/workplace/Melo`。Codex 的独立任务目录不一定是实际 Git checkout，接手必须核对 `git rev-parse --show-toplevel`。
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
| 聊天与 agent loop | 手机与桌面同一循环（prepare → invoke-model → finalize），公共循环/预算策略现由 `shared/agent/` 同源执行，配置契约为 `shared/protocol/agent-loop.json`；10-23 已接入共享 `goal.js`：原始目标/补充、无工具交付检查、最多两次有预算纠偏；取消普通首步必搜，成员回执贯通团队，见[综合实施与验收](docs/agent-harness-implementation-20261023.md)（任务与基准集成验收均通过）；10-24 已覆盖安装桌面与 iPhone 0.7.10（42），数据保留及实际使用检查见[安装回执](docs/dual-update-20261024.md)；七项双端对齐修复 `ee8eb3f` / `3ad091c` 已推送并装入双端；桌面聊天页 / 输入区 / 发送管线已拆到 `desktop-ui/features/chat/`（P2c） | [修复与 10-19 日常回执](docs/mobile-desktop-alignment.md)；10-20 完成状态误分类修正与 Claude B1/B2 复核见[专项](docs/completion-status-fix-20261020.md)；真实供应商与长后台另验 |
| 记忆 | #2 并发写事务预约修复已通过 Mac/Linux 回归与完整日常；项目记忆本与个人档案已接入；项目来源手写记忆经独立可选通道（`/api/project-memory-sync` ↔ `/v1/project-memory`）同步；桌面记忆页 / 记忆本 / 回复页脚已拆到 `desktop-ui/features/memory/`（P2a） | [记忆架构](docs/memory-architecture.md)（以顶部现行约定为准）、[A7 回执](docs/mobile-desktop-alignment.md)；私人同步服务未部署新版 |
| 知识资料与成果 | 本机分段索引（SQLite FTS + 本地 embedding），按对话/项目开关过滤；两端按问题切段检索，旧 8 份 / 24000 字前置限制已移除 | [Agent 演进 P2/P4](docs/agent-evolution-20261015.md)、[A3/A5 回执](docs/mobile-desktop-alignment.md) |
| 设置、模型连接与账号 | 五语界面 `2cae1cd`；手机 Codex 设备码 OAuth `85ac3a5`、应用切换取消修复 `14e602f` | 用户真实授权尚未确认；同码恢复限同一进程；[五语](docs/interface-languages-20261015.md)、[模型连接](docs/llm-connections.md) |
| 双端同步 | v1 线协议冻结；Agent 能力与项目记忆走可选通道，旧服务只让扩展待同步，聊天同步照常 | [双端修复](docs/mobile-desktop-alignment.md)；私人同步服务需部署本版代码后启用新通道 |
| 工具、MCP 与网页 | 免费 MCP 默认启动 `f3dba1a`；连接器 / MCP / 会话授权 / 技能管理 `7ae2292`；手机系统数据工具 `2e47868`（默认全关）；两端网页打开与截图（10-18） | [MCP 启动](docs/mcp-startup-20261015.md)、[手机系统数据](docs/ios-device-data-20261016.md)；实体数据调用与真机 WKWebView 待验 |
| 搜索路由 | 自然餐饮/住宿/产品推荐与相关追问进入搜索；禁止联网、引用、闲聊、本地/App 边界保留，按当前能力说明不可用 | [#3 实施](docs/github-issues-implementation-20261020.md)；受控 HTTP 测试，真实供应商另验 |
| 图片、视频与附件 | 10-21 双端已接应用内拍照、确认进入草稿、原件与传输副本分开；[实现与验收](docs/test-cost-camera-plan-20261021.md)，实时会话暂缓；iPhone 后置拍照四流程已由用户真机确认，见[装机回执](docs/phone-camera-install-20261021.md)。桌面/手机请求 `quality: high`，10-15 单次实测 Codex 服务回报 low；手机图片链与保存防重复已接生产入口；多图逐张、2K/4K、视频抽帧已合入主线 | 10-20 #4 二次修复旧工作区归属与回看图片引用；原生预览/原尺寸/保存/冷启动重开均通过，原件 SHA 不变；[修复回执](docs/issue-4-legacy-preview-20261020.md)、[实施证据](docs/github-issues-implementation-20261020.md)；见[图片承载计划](docs/image-capacity-plan-20261015.md)；[图片体验](docs/image-ux-20261016.md)、[多图与视频](docs/image-video-plan-20261016.md)；真实账号画质待验 |
| 语音 | TTS 路由与停止修复（10-17 审计）；手机朗读要点化并按回复语种选声（10-18）；桌面朗读按 Agent 卡片模式 / 音色 / 风格，已知 Agent 默认概要（10-22） | [审计与实施状态](docs/architecture-agent-context-audit-20261017.md)；真机朗读待验 |
| 授权、审批与任务 | #1 审批期间持有文件身份，阻止 inode 复用（`47da231` 已推送，[实施](docs/github-issues-implementation-20261020.md)）； 模型 / 工具 / 授权共用截止与取消，超时后迟到批准零写入（A2）；手机权限首次迁移与撤销修正 `85c51f7`；桌面审批界面样式在 `desktop-ui/features/approvals/approvals.css`（工具/文件审批 JS 仍在 app.js，P2c）；能力请求卡片与「临时授权」列表在 `desktop-ui/features/approvals/`（10-20）；手机卡片进 `ChatStore` 审批队列，账本与判定在 `ios/Melo/CapabilityElevation{,Runtime,Views}.swift`（10-20） | [A2 回执](docs/mobile-desktop-alignment.md)、[手机权限](docs/phone-permission-fix-20261016.md) |
| 桌面壳与界面 | 当前安装源码 `897b77a`，原生启动与数据保留通过；神经总览 `22bcd1b`；双端低饱和黑金 M 图标；10-15 记录的阅读 / 预览 / 文件 WIP 已于 10-17 收入 `8cd3eff`；10-20 桌面工作面统一（`surfaceUnify.css` 最后载入：间距、13px 基准字号、控件、工作面不透明度、去旧绿色），手机未动、知识青灰身份色待用户决定 | [10-20 统一](docs/ui-unify-20261020.md)、[双端安装](docs/dual-reinstall-20261019.md)、[银河与留白](docs/galaxy-clarity-20261016.md)、[图标](docs/design/logo-muted-20261016/README.md)；`desktop-ui/app.js` 仍是中央入口（导航、组合、render() 保护、设置 / 资料 / 审批 / TTS 等页面）；记忆 / 项目页（P2a）、Agent 设置（P2b）、聊天（P2c）已拆到 `desktop-ui/features/` |
| 桌面宠物 | 10-22 并入 `Melo.app`（方案 C）：`desktop-pet/` 独立包、仓库外媒体钉哈希、`DesktopPet.swift` 启停、系统设置「桌面宠物」开关与真实状态；真包冷启动 / 对话 / 开关 / 退出联动已验 | [并入文档](docs/desktop-pet-integration-20261022.md)、[桌宠说明](desktop-pet/README.md)；素材生产线仍在 `/Users/mortred/Documents/New project/desktop-pet` |
| iPhone | 实体机 10-24 原位覆盖到 0.7.11 (43)，16 对话 / 163 消息 / 6 Agent / 25 图两次回读一致（[回执](docs/phone-overwrite-install-20261024.md)）；10-22 曾覆盖到 0.7.9 (41)，15 对话 / 151 消息 / 6 Agent / 24 图两次回读一致（[回执](docs/phone-overwrite-install-20261022.md)）；此前 0.7.8 (40) 已覆盖并启动，原 12 对话 / 137 消息 / 6 Agent、账号偏好和 21 张原图经两次回读保留；用户确认拍照四流程与实际回复正常 | [10-21 拍照版安装](docs/phone-camera-install-20261021.md)；个人签名到期 10-28 20:52（Melbourne）；镜头切换和后台恢复另验 |
| Android 桌宠 | 10-22 分支 `feature/android-desktop-pet`（0.8.0 (17)）：「系统 → 桌宠」开关后金冬天 / 大肥鱼以自有前台服务常驻其他 App 之上，窗口只按当前动作的不透明包围盒布局；拖动贴边、单击换动作、双击系统语音识别 → 专用「桌宠」对话 → 朗读与气泡、长按菜单；自动动作沿用桌面「优先待机、动作后休息 30–60 秒」；素材不进 Git，`assets/pet/catalog.json` 记录 hash 与 Release `android-pet-assets-1`，Gradle `preparePetAssets` 构建时校验 / 下载 | [android/README.md → 桌宠](android/README.md)、[verification.md](android/verification.md)；JVM 144、Lint 零 Error、Debug / R8、Emulator `PetOverlayFlowTest` 2/2 通过；Fold6 真机（朋友测试）、三星省电、真实语音未验，PR 待用户决定合入 |
| 远程渠道 | Telegram（10-16）、Discord（10-17）按用户决定归档，配置与历史保留 | [Telegram 归档](docs/telegram-archive-20261016.md)、[Discord 归档](docs/discord-archive-20261017.md) |
| 架构维护 | B2 执行节点、B3 自定义页与桌面 token 已合入；当前拆分质量与剩余 B4/B5 见[10-21 核对](docs/architecture-split-review-20261021.md)。方案已获批执行 P0–P2；P0 已交付：生成的功能地图、`npm run scope`、`npm run boundaries`、纯文档选组纠正与本总览重整；P1 项目 / Agent 提交回执已交付；P2 完成：P2a 记忆页、项目页拆入 `desktop-ui/features/` 并补齐 `bootstrapError` 重新拉取；P2b Agent 设置；P2c 聊天状态 / 事件与其余 CSS，`render()` 只调功能钩子，共享请求层为 `sharedApi.js` | [方案与第 8 节执行修订](docs/architecture-maintainability-plan-20261019.md)；P1 / P2 状态以最新交接为准；[独立审计](docs/claude-architecture-review-20261019.md)确认的提交后刷新失败回归已在 `46554b2` 修复，日常选定范围通过 |
| 发布 gate | 10-21 降本已本地提交 `8304aab`：[实现与校准](docs/test-cost-camera-plan-20261021.md)；纯文档 CI 先计划并省去重型任务，局部 UI 按整组和实际依赖选取，Swift 复用编译但每次执行测试；日常按功能、反向依赖、隐式边与平台选组；任务 `--files` / 集成 `--base` / 强制 `--all`；先预检、JS / 资源 / Swift 去重；公共 / 未知边界保留扩大，发布完整 gate 保留 | [统一检测规则](docs/testing-workflow.md)（AGENTS / CLAUDE 共用）、[实施验证](docs/test-selection-implementation-20261020.md)：最终工具 29/29，隔离完整日常、两项浏览器与 32 Swift 通过；本地模型资源项补测 3/3 |

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

### 2026-10-26 — melo主线（Codex）— 自修改与隔离开发能力专项审计
- 用户本轮只要求先审计，未授权实施；源码基准 `b39823f`，开始时工作树干净。交付[能力审计报告](docs/self-development-capability-audit-20261026.md)，没有修改产品代码、真实账号/聊天/图片或其他线程工作。
- 已有：文件读搜改、shell/Git、通用协作、权限与文件备份。缺口：受管理源码副本、OS/数据隔离、持久开发作业、绑定精确版本的测试/只读审查、合并与独立更新。已安装桌面指向产品源码目录，`test:full` 仍包含安装，不能直接当隔离开发验证。
- 验证：796 个运行时文件机械检索及关键调用链阅读；15 个现有测试文件 273/273 通过，无跳过；临时仓库通过真实 executor/工具得到 20 条记录（16 次夹具授权），实证测试失败仍能获准 merge、shell 不受工具开关的进程级限制。无真实模型/产品窗口/手机验收；纯文档检查 `run-a30ZUI` 通过。证据 `.tmp/self-development-audit-20261026/`。
- GitHub 只读 API：master 未保护，rulesets / branch rules 为空；没有修改远端。报告按保护运行环境→开发作业→验收合并→发布/手机控制分批，待用户选择后实施；仅文档本地提交，不推送、不 git pp、不安装。

### 2026-10-26 — 设计 Melo（Codex）— 剩余审计分批修复
- 状态：实现批次 0–5 已本地合入，依次为 `bf828fa` / `c37b0f8` / `02213c0` / `58158dd` / `07c3b46` / `4e3858d`。批次 6 独立方案已写，分支 `codex/audit-6-plan-20261026`；未推送/安装。详见[逐批回执](docs/audit/remediation-2026-10-26.md)与[台账](docs/audit/ledger.md)。
- 行为/配置：L5 相关性或引用、L16 subjectKey、L15 五语预算已修，J5/J6 已有真实 runner 回归；replyLocale/请求头/事件 ID 与 serverText 接通，v1 历史同步兼容。默认模型、显示名、本机服务集中，素材来源显式配置，七项高级设置及环境目录守卫已验。
- 桌面 UI：notify、EditSession、三级标题、四种操作按钮、空状态/术语、单一转义与 scene token 完成。浏览器验证取消/失败重试/Enter/五语/密度；修正导航边框、语言菜单遮挡、通知覆盖、输入压窄与发送超出窗口。场景按实际控件高度限高并内部滚动。
- 手机：MeloType/MeloTheme 同源；四个 concept ID 在双端目录和界面消费；补齐 26 条插值格式，动态状态/回退先翻译，用户原文保留。H18 先剔除 SwiftUI 插值/用户原文误报，再修 6 处实际字号。词条与五语 Bundle 读取均有检查，完整 iPhoneOS 未签名编译通过。
- 验收：最后代码快速 `run-Qa1s4U` / 集成 `run-eHENTL` 均 GREEN：4678 JS、设置浏览器、37 Swift（含共享契约）、Android JVM/Lint/Debug/Release，0 跳过/隔离复测。所有规则新增0；目标 H1/H2/H3/H4/H7/H8/H9/H10/H13/H15/H18/H19=0、H14=5，17 机器探针 closed。CI 比较当前和目标/前一基线，不允许新命中靠抬高基线通过。
- 下一步：[J2/J3/J8 独立实施方案](docs/audit/architecture-plan-2026-10-26.md)已明确入口、评分、兼容边界与验收，仍 open；J6 旧注释已清理。H5/H20 按要求保留；H6/H17/J4 不属于本轮目标。手机真机、真实远程同步与发布安装另验。最后文档/基线快速 run-juEJci、集成 run-ySP23x 均过：34 文件 / 121 项，两档约13秒，未重复产品全量。

### 2026-10-26 — Melo 主线（Claude）— 规则扫描基线与审计台账
- 线程 ID：e02f4818；状态：已提交并合入 master（`61f7fe7`），未推送。
- 行为：审计从手工 grep 改为 `node scripts/audit-inventory.mjs`（20 条规则 × 834 文件，写 `docs/audit/inventory-<日期>.json` 与 `report-<日期>.md`；`--baseline` 报增量）；`docs/audit/ledger.md` 记 17 条机器探针与判断类条目状态；自测 `scripts/audit-inventory.test.js`。
- 验证：集成档完整日常 GREEN（JS 4624 / 两组浏览器 / Swift 37）；基线：探针 14 关 3 开，CSS 原始色 0、搜索规划器合一；变差项：按钮类名 26 种、空状态口吻增多。
- 未完 / 下一步：把 `--baseline` 接进 CI 当增长门禁；规则误报收敛（H1 状态字符串、iOS 自检文件）；判断类 J2 / J3 / U1–U6 交 Codex 排期；桌面 / 手机术语对表（U10）未做。

### 2026-10-24 — Melo 主线（Claude）— 日常回归分两档，门禁加机器守卫与紧凑摘要
- 线程 ID：e02f4818；状态：已提交（`ccdcb04`），分支 `claude/test-cost-20261024`，待合入 master。
- 行为：`npm test -- --files` 旧=碰到公共文件即全部 4500 个 → 新=快速档（所属功能组 + 反向依赖闭包 + 从测试源码检测出的真实服务测试）；`--base` / 无参 / `--all` / `--files --full` = 集成档（10-20 旧规则不变，合并前跑一次）；地图过期在预检直接失败而不是跑全量；同机单运行器锁与负载等待；JS 阶段全部超时类失败时一次串行隔离复测并记入 summary.json，真实失败不重试。文件 / 接口：scripts/test-plan.js、test-impact.js、verify-daily.js、test-stage-runner.js，新 test-tap-summary.js、test-run-guards.js；CI 仍走集成档。
- 验证：门禁改动按规则扩大为完整日常：JS 4605 / 4604 过 / 1 跳过、设置浏览器验收、Swift 37 组，无复测；实测 stateStore.js 537→190、config.js 537→318、叶子改动两档相同；证据 `.tmp/test-cost-20261024/.tmp/test-runs/run-meD28k/summary.json`。
- 未完 / 下一步：A 的"测试 ↔ 覆盖模块"映射版与 D（浏览器测试共享夹具）未做；Codex / Claude 按 docs/testing-workflow.md「两档节奏」执行；合入 master 后其他 worktree 才拿到新运行器。

### 2026-10-23 — melo主线：目标保持、工具续跑与完成判断审计（仅方案）
- 基准 `da86326`，用户要求先审计三个问题。原始用户消息有保存；多轮工具调用存在；无调用文字会结束循环，后置完成回执不负责继续补做。日历只读工具还会误入操作完成分类。
- 实际入口：共享 `turn.js` / `completion.js`、桌面 `invokeModelNode` / `finalizeNode`、subAgent / skillExecutor、iOS AgentLoop / 两种传输、Android SharedChatAgent；[完整证据与方案](docs/agent-goal-completion-audit-20261023.md)。模块记录与当前线程登记已同步，产品代码没有修改。
- 验证：既有 Node 专项 246/246、Swift 3 组重新执行通过；新增本地受控回放复现“读取后追问并终止”，对照回放证明工具可以串联；相关来源但未回答天气的回执反例已确认。证据 `.tmp/agent-goal-audit-20261023/`；Android 为源码层，未做真机或真实模型验收。
- 状态：文档阶段本地提交，未推送。下一步待实施目标/证据契约、有界结束前检查和全入口接线；不能直接把所有 partial 改成重试。原始故障轮次尚未定位，需发生端/时间才能核对真实 trace；保留所有账号、原图、数据及其他线程成果。

### 2026-10-22 — Melo 主线（Claude）— 桌面与手机对齐：Agent 语音风格、本机定位开关、翻译门禁
- 线程 ID：e02f4818；状态：已提交并合入 master（`1b01739` / `691b628` / 进度 `ce8399d`），已推送 origin/master；桌宠线程 `c7ccbd7`–`ae43446` 同批推送。
- 行为：桌面朗读 旧=只念全文 → 新=按 Agent 卡片模式 / 音色 / 风格（概要：整段到齐后 `/api/tts/voice-text` 提炼再念；全文：逐句流式；关闭：不自动念），已知 Agent 默认概要；定位 旧=逐次弹窗 → 新=Agent 页「这台电脑上」设备本地开关，默认关、不同步（`localPreferences.agentDevice`），保存失败勾选回退；权限弹窗中文按钮、联网搜索设置走共享编辑条、手机 Agent 页字段名改中文、翻译门禁 `desktop-ui/i18nCoverage.test.js`（ui 模板未翻译中文直接红灯）。跨端：手机不变，本机开关与「这台手机上」同义。
- 验证：完整日常（JS 4506、两组设置浏览器、Swift 37）GREEN；两遍满负载各 7 个服务启动超时隔离复测全过；桌宠皮肤测试需主检出的非 Git 资产（主检出 7/7）；证据 `.tmp/ui-consistency-20261022/.tmp/test-runs/run-jTYqLR`、`run-Raez5K`、`run-gwQwms`。
- 未完 / 下一步：用户 22:00 手机覆盖安装（Xcode）并自测定位；桌面端由主线从 master 重装；安卓桌宠 PR #16 CI 红（功能地图未重新生成）未合；配置：桌面自动朗读默认改为概要，无数据 / 凭证影响。

### 2026-10-22 — 桌宠并入 Melo 安装包（方案 C）：Melo 管理启停，系统设置加「桌面宠物」开关
- 桌宠代码（控制进程、Melo 桥接、对话窗口、原版 host 适配、测试、`PC2005-cloud/dsh-pet` v0.3.7 全部源码与 MIT 许可）进入仓库 `desktop-pet/`（独立 CommonJS 包，`package.json` 钉 Electron 37.10.3）。大文件不入 Git：金冬天 WebM、关键帧审计与大肥鱼原版 WebM 放仓库旁 `../desktop-pet-assets`，`npm run import:pet-skin` 校验后导入并链接，`skins/winter/manifest.json` + `assets.lock.json` 钉住哈希（本次 `winter-106-12keys-sr-flow-fe6cf9b45399`，皮肤包重建后再跑一次导入即可）。Git LFS 未安装，按任务备选方案处理。
- `npm run build:desktop` 经 `scripts/bundle-desktop-pet.js` 把代码、生产依赖、两套皮肤和带桌宠身份的 `runtime/DSHPet.app` 装进 `Melo.app/Contents/Resources/desktop-pet/`，外层签名与启动不变；包体 130MB → 808MB。`desktop-app/DesktopPet.swift` 负责启停与状态：`UserDefaults melo.desktopPet` 开则服务就绪后用包内 Electron 带起（`MELO_BASE_URL` 传实际端口），关则 POST 控制服务 `/quit`；桌宠在 profile 写 0600 的 `runtime.json`（进程号、控制地址、口令），自行退出时 Melo 把开关同步为关并通知页面实时刷新；Melo 退出先停桌宠再停服务。设置行在「通用与外观」本机一组末尾，状态文字取真实运行状态，五语词条已补，网页版不显示。
- 验收（本机真包，`~/Applications/Melo.app` 已覆盖安装）：桌宠测试新位置 35/35（原 33 + 运行记录 2）、导入脚本 3/3、设置行 3/3；冷启动偏好关不启动；偏好开 3 秒内桌宠作为 Melo 子进程出现，`/health` 带口令 200 / 不带 401；菜单打开对话发一句真实消息，主助手回复「收到。」；设置页下拉「关闭」保存后桌宠经 `/quit` 退出、偏好 0，再改「开启」保存后桌宠回来、行变「运行中」；桌宠自己「退出桌宠」后开关实时变关；Melo 退出 1 秒内桌宠一起结束；重开按开关恢复。证据与边界见[桌宠并入文档](docs/desktop-pet-integration-20261022.md)。
- host 死亡守卫（Codex P2，另一会话转告）：DSH host 自己退出时控制进程随即结束并删记录，Melo 开关置关、再开启即重建；真机 `kill -9` host 验证通过。
- 强杀 / 崩溃守卫：Melo 以只持写端的 stdin 管道启动桌宠（`MELO_PET_OWNER_PIPE`），`owner-pipe.cjs` 读到 EOF 即退出；真机 `kill -9` Melo 后 1 秒内桌宠与服务都结束、无遗留进程。装包脚本新增「控制进程本地 require 必须已复制」校验（曾漏装该文件，Electron 停在错误对话框）。
- 日常回归（任务文件全列，扩大为完整日常）：JS 4484 项在满负载下 8 失败 + 5 取消（超时类、非本任务文件），隔离复测后剩 3 个浏览器旅程，空载 3/3 通过；两组设置浏览器旅程通过；Swift 37/37；Android 阶段本机无 Java 为环境红灯（CI 覆盖）。发布 gate 新增媒体校验步骤。未验证：桌宠右键菜单退出（本轮点的是应用菜单，同一 `shutdown()`）、双击打开对话（本轮用应用菜单）、Android 阶段（本机无 Java，CI 覆盖）。旧入口 `~/Desktop/melo桌宠.app` 与 `melo桌宠.command` 已按用户要求移入废纸篓（10-22 18:08），以后只用 Melo 里的开关；素材生产线目录不受影响。其他线程文档 WIP 保留。


### 2026-10-22 — 桌宠：大肥鱼命名、金冬天待机间隔与12帧动作
- 正式项目 `/Users/mortred/Documents/New project/desktop-pet`；基于 `PC2005-cloud/dsh-pet` v0.3.7 / `90ddd827fd9661958752855e899da452063ceaa5`，保留原host/config/physics/renderer和原皮肤，默认名「大肥鱼」。桌面两个入口共用单实例；原错误壳、旧七动作/四帧/慢速包分别备份于外部 `desktop-pet-backups/`。
- 用户纠正：要减少自动触发频率，不是动画减速；上一轮慢放已撤回。`upstream/runtime/electron-helper/sprite.js` 仅对winter启动和非待机动作结束设置30–60秒冷却，随机链在待机片段结束时检查截止时间；冷却期间持续待机，之后仍可能随机抽中额外待机。点击/右键/API点播和工作状态不受此门槛影响，大肥鱼保持上游调度。
- `skins/winter/` 升级到 `winter-106-12keys-4c22ac51e3f2`：106组各12张绘制帧，共1272张，30fps短alpha过渡封装；普通动作恢复1.6秒循环，待机呼吸6.4秒循环。完整图集/关键帧/内置image_gen提示词与源路径在 `animation-work-v3/`；仍是关键帧动画，不等同连续视频级流畅度。版本迁移保留位置/尺寸/选肤并备份旧包。
- 本轮30/30回归（含5项真实PetSprite原型冷却/手动绕过/大肥鱼不变等状态机检查）；106段完整解码/alpha/时长通过；从桌面入口重启后的106个实际安装哈希一致。真实renderer七个Winter动作及大肥鱼挥手共8项ended，最终恢复Winter并原生可见待机。[当前验收](/Users/mortred/Documents/New%20project/desktop-pet/evidence/ANIMATION-V3-20261022.md)、[完整交接](/Users/mortred/Documents/New%20project/desktop-pet/TASK-HANDOFF.md)。
- Melo对话继续由 `main.cjs` / `melo-client.cjs` / `dialog/` 双击或右键打开，直通主助手 `/api/chat/send/stream` 与工具/审批/取消，换肤不重建聊天；本轮未改桥接或Melo运行时代码/账号/安装包，也未重复真实模型调用。前轮工具/同对话验收保留历史证据；DSH专属服务、多屏/音频/全部106项人工审美和长期稳定性未新增验收。外部非Git WIP，产品只改文档，其他线程工作保留，无提交推送。

### 2026-10-21 — melo主线（Codex）— 拍照版 iPhone 保留数据覆盖安装
- 线程 `01a13b2e-5446-7042-bb5e-773129746c7e`；测试降本 `8304aab` 与双端拍照 `6fba8db` 已推送。按晚间授权，实体 iPhone 同标识原位覆盖到 0.7.8（40），未卸载；本阶段仅版本元数据与文档本地提交，无 git pp / 新推送。
- 安装前完整私有备份，安装后与使用后回读：原 12 对话 / 137 消息 / 6 Agent、4 个账号偏好指纹及 21 张原图全部保留；新增拍照 JPEG 4032×3024 留在草稿。旧聊天与登录态直接观察通过，拍照四流程和实际回复由用户在实体手机确认；镜像黑屏与输入限制、存档证据边界如实记录。
- 验证：本轮 4421 JS、37 Swift、两组浏览器及 Release 签名、安装、启动、数据回读通过；[安装回执](docs/phone-camera-install-20261021.md)，证据 `.tmp/camera-phone-install-20261021/` 与 `.tmp/test-runs/run-rpfIe6/`。个人签名到期 10-28 20:52（Melbourne）。
- 本次单次安装已完成，不重复安装；前后镜头切换、相机后台恢复及照片发送识别另验。实时语音/连续画面继续暂缓；后续文档 push 取消前一代码 CI 的覆盖缺口单独跟进，不能称远端全量代码 CI 已通过。其他线程文档 WIP 保留。
### 2026-10-22 — 安卓桌宠（Claude）— 金冬天悬浮在其他 App 上，双击与 Melo 对话
- 分支 `feature/android-desktop-pet`（worktree `.tmp/android-pet-20261022`，基于 `77679bb`），PR [#16](https://github.com/MortredVigoss/Melo/pull/16)；素材 Release [`android-pet-assets-1`](https://github.com/MortredVigoss/Melo/releases/tag/android-pet-assets-1)（zip 133 MiB，构建时 `preparePetAssets` 按 catalog hash 自动下载），测试包 Release [`android-pet-test-1`](https://github.com/MortredVigoss/Melo/releases/tag/android-pet-test-1)（debug 签名 APK 219.5 MB，需允许未知来源 + 悬浮窗 / 通知 / 麦克风 / 电池优化）。
- 实现：`android/app/src/main/java/com/melo/android/pet/`（`PetOverlayService` 前台服务 + 三个 `TYPE_APPLICATION_OVERLAY` 窗口、`PetScheduler` 纯 Kotlin 动作链、`PetSettingsScreen`「系统 → 桌宠」、`PetPreferences` 本机偏好、`PetSpeechInput` / `PetDialogue` / `PetChat`），`assets/pet/player.html` 双 `<video>` 播 VP9+alpha，`android/scripts/import-pet-skins.mjs` + `scripts/android-pet-assets.js` 可重跑导入（480×270、CRF 32、alpha 包围盒），`catalog.json` 提交、`skins/` 忽略。版本 0.8.0 (17)。说明见 [android/README.md → 桌宠](android/README.md)。
- 验证：JVM 144、Lint 零 Error、Debug / R8；Emulator Android 16 `PetOverlayFlowTest` 2/2（解码 / 单击 / 拖动贴边 / 长按菜单 / 双击 → Fixture 识别 → Fixture 模型 → 气泡与专用对话 / 换肤 / 关闭重建）；手工截图确认桌宠在系统桌面之上。日常 `npm test -- --files …` GREEN；PR #16 对 `28e1410` 的 CI：Android（含 x86_64 Emulator 完整套件）、File safety、macOS Swift 通过，Linux 因 `architecture/modules.json` 未随新脚本重生成而失败，`08215be` 已补；本分支尚未合入主线代码：MELO_OVERVIEW.md / PROGRESS.md 以及两份桌面桌宠文档（`docs/desktop-pet-integration-20261022.md`、`desktop-pet/README.md`）按 master `fc68a9f` 逐字同步，只为让 PR 无冲突、相对链接可查（`git merge-tree` 对 master 干净）；CI 以 PR 合并引用为准。详见 [android/verification.md](android/verification.md)。
- 未验 / 下一步：Fold6 真机（朋友测试）、三星省电、真实语音识别与朗读、锁屏恢复；移动类动作在手机上原地播放不挪窗口；PR 合入由用户决定。桌面端并入与 `desktop-pet/` 目录由另一线程负责，本线程未动。
### 2026-10-21 — melo主线（Codex）— 代码拆分现状核对
- 用户询问现有拆分质量；以 `2ee8da7` 静态核对 B2/B3、共享核心与剩余 B4/B5。入口已变薄，聊天上下文仍有 56 项、11 个业务服务仍依赖整页组装；跨目录图发现聊天 controller/view 的 1 个循环组，未当作已复现运行故障。
- [核对记录与建议顺序](docs/architecture-split-review-20261021.md)；后端依赖检查通过，完整图 619 模块的循环已逐条确认。此静态核对文档已随 `8304aab` 本地提交；未实施 B4/B5，后续按用户决定。

### 2026-10-21 — melo主线（Codex）— GitHub 简介与简要更新日志
- 用户要求更新 GitHub 简介和更新日志；延续英文、兼容多模型、简述改动的既定口径。About / README 补 Android 当前开发状态，README 更新到 10-21；CHANGELOG 补本轮功能与修复，旧长段压缩为用户可读摘要。
- 本轮仅文档与仓库简介，未改产品代码、账号或数据；`npm test -- --files README.md CHANGELOG.md MELO_OVERVIEW.md PROGRESS.md` 通过（4 文件 / 102 相对链接）；发布后回读远端。不重跑安装 gate、不运行 git pp，其他线程 11 行文档 WIP 保留。

### 2026-10-21 — melo主线（Codex）— Claude B3 / context2 与主线最终组合
- 用户授权最终检查、修复、更新文档并一起推送；合并 `2b62830`、`d21bd04`，测试修正 `2076271`。B1/B2/B3 与远端 `5e1e3af`、Claude 最终 `27bc8f7` 都已核对，未合入重复的旧 context 分支。
- 修复手机 `TopicDividers` 同步/等长编辑缓存失效、`ChatStore → ChatGPTAccount / Network` 参考内容污染搜索和完成判断，以及看图分析丢失本轮时间；原文决定政策，参考仍送模型。详见[组合回执](docs/claude-final-integration-20261021.md)。
- 全部组合与发布 GREEN：4420 JS、37 Swift、Android 124 JVM / Lint / Debug / Release、浏览器、桌面构建安装与原生启动；完整 iOS 模拟器构建及发送/同步审计通过。B3 样式 75 状态 / 9,023 元素零差异。
- 桌面实际旧回复、新 Sol 6.1 回复及冷启动均显示“回答已交付”，0 工具/来源。原有 684 条消息、账号、Agent、项目、资料和原图保持；新增 4 条 QA 消息。现有 14 天规则清理 3 份旧执行详情，保留边界详见回执。手机未做本轮实体安装或缓存命中率测量。
- 其他线程 11 行文档 WIP 单独保留；仅发布已核对的本轮整合，不运行 git pp。

### 2026-10-20 — melo主线（Codex）— 普通回复完成状态与 Claude B1/B2 核对
- WIP：[专项](docs/completion-status-fix-20261020.md)。已复现“连通性检查”被当成研究请求；修正共享/桌面搜索动词与禁止工具的网络策略。普通回答显示“回答已交付”；真实研究/操作的证据规则保留。
- 旧场景仅在已完成、匹配回复和零工具/来源的条件下只读纠正，不改历史消息和落盘场景。Core 已同步生成到 iOS。
- RED → 最终目标 188/188；组合 4370 JS + 5 预检 / 35 Swift 全过。原生旧回复重开与新一轮真实 Sol 6.1 回复均显示“回答已交付”，零工具/来源。Claude 三节点主体及绑定、七场景轨迹一致，B1 Chrome 显式保存 7/7；最终完整发布已通过，后续组合见本页最新回执。
- 账号/原图/历史保留；其他线程 11 行 WIP 单独保留；用户授权测试通过后推送，不运行 git pp。

### 2026-10-21 — Android / Shared Core Integration（已合入共同主线）

用户批准将 Mobile 整合到最新主线，分支 `codex/integrate-mobile-core-20261020`；父基线为 master `8772e92` 与 Mobile `2d36dbd`，源码验证点 `009134a`。保留主线 UI P2、统一检测、完成回执、Session Events、项目生命周期和历史图片修复，接入 Android Context / Task Cache / 独立 HTTP Search。Node 保持 Tool Schema，通过 Adapter 使用配置的 HTTP Search；Router 和执行许可共同保留禁止联网/占屏边界。

[PR #15](https://github.com/MortredVigoss/Melo/pull/15) 在五项 CI 全绿后以 `6ab1adf` 合入 `master`，合并树与验证 Head `edfccac` 一致。远端 11 条已包含分支以 expected-SHA lease 清理，现只保留 `master`；WSL 本地也已同步。Linux 4384 JS pass / 0 fail / 1 macOS 专用 skip（补齐本机缺 FFmpeg 的 12 项），macOS 35 Swift suites + Native Lifecycle + unsigned iOS App 编译通过；Node/Android/JavaScriptCore 的 11 个 Replay 一致。Android 124 JVM + 73 Android 16 Runtime、两项本机 Desktop Browser、语法/生成物通过，后端 0 cycles。后台索引误隔离新记忆的竞态已修，四份并行 Fixture 通过。未运行完整安装发布 gate、未操作 Fold6 或真实模型账号。详见 [Integration 回执](docs/mobile-integration-20261020.md)。


### 2026-10-20 — melo主线（Codex）— #4 历史图片修复与原生验收
- `e4e378a` / `a115577`：图片按可信生成位置恢复，修复既有错误登记；兼容任务回看替换展示附件 ID/URL。入口 `savedImages.js`、`imageRecords.js`；消息、原图及文件工具权限不改写。
- 最终专项 16 HTTP + 2 浏览器、关联 982 项及完整发布 4356 JS / 35 Swift、安装/启动/浏览器全绿。原生旧图实点、原尺寸、NSSavePanel 保存与冷启动再开均通过；1289 × 1221、2,090,093 字节，副本与原件 SHA 相同。
- 37 份基线文件无缺失，原图/账号/聊天线程字节不变，仅状态版本变化；[专项回执](docs/issue-4-legacy-preview-20261020.md)。按用户授权推送关闭 #4，其他线程 11 行文档 WIP 保留，不运行 git pp。此前纯文本完成状态提示不在本次范围。

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
| Android 原生 / 手机操作 | `android/app/src/main/java/com/melo/android/`；`device/DeviceAgent.kt`、`DeviceTaskLoop.kt`、`DeviceContextBudget.kt`、`MeloAccessibilityService.kt`、`AppCatalog.kt` | per-Chat 文字 Job；Chat 内显式进入手机操作并捕获角色 / 项目 / 模型，设备独占。完整 App 搜索、有界恢复、原生本步确认、重观察后验证可见结果；取消 / 息屏停止。凭证用本机 Keystore，原始屏幕与 App 列表不落盘同步；各平台分别验收 |
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
| 安卓桌宠（Claude Code） | worktree `.tmp/android-pet-20261022` · 分支 `feature/android-desktop-pet` | 10-22 Android 悬浮桌宠：前台服务悬浮窗、纯 Kotlin 动作链、「系统 → 桌宠」设置页、双击语音对话与朗读、可重跑素材导入与 Release 包、Gradle 自动拉取 | PR [#16](https://github.com/MortredVigoss/Melo/pull/16)、测试包 [`android-pet-test-1`](https://github.com/MortredVigoss/Melo/releases/tag/android-pet-test-1)；JVM 144 / Lint 0 Error / Debug / R8 / Emulator 2 项 UI flow 通过；真机由朋友测试，未装 Fold6 |
| melo审计修复（Cowork） | `01a11623-b29c-70c7-8ee0-bb21a1e6eef3` | 10-17 三路只读审计 → 四批修复：TTS 路由、上下文预算/窗口/压缩同源、逐轮上下文入用户消息、Discord 归档、Agent 成员/循环/审批加固、分层 gate 传递闭包、文档对齐；10-19 手机 agent loop 对齐桌面（共享 `agent-loop.json`）；10-19 架构方案 P0 执行 → P2a 记忆 / 项目页拆分 → P2b Agent 设置拆分 → P2c 聊天拆分（P2 完成）；10-20 Agent 能力临时提升与即时开启（桌面 + 共享规则 + 手机端） | 沙箱全量 JS 回归与基线一致；用户机器日常 gate 见本次提交；[审计与实施状态](docs/architecture-agent-context-audit-20261017.md) §7；P2c / P2b / P2a / P0 见[历史交接](docs/handoffs/overview-history-20261019.md) |
| melo主线 | `01a13b2e-5446-7042-bb5e-773129746c7e` | 10-23 [目标完成闭环综合实施](docs/agent-harness-implementation-20261023.md)：共享目标检查接主聊天/成员/技能与双端；4,544 项 JS / 37 组 Swift、浏览器和 Android 检测通过，iOS 完整构建通过；10-21 测试降本 `8304aab`、双端原生拍照 `6fba8db` 已推送；iPhone 0.7.8（40）覆盖、数据保留、用户真机拍照及回复确认（[安装回执](docs/phone-camera-install-20261021.md)）；[拆分静态核对](docs/architecture-split-review-20261021.md)；七项双端对齐、架构审计与 GitHub issue 修复；10-20 双端覆盖更新与真实使用检查 | [14 条问题实施](docs/github-issues-implementation-20261020.md)此前全部关闭，装机后 #4 重新打开并完成二次修复，见[原生验收](docs/issue-4-legacy-preview-20261020.md)；[双端更新](docs/dual-update-20261020.md)：桌面 abe1d20 / iPhone 0.7.7 (39)，数据保留、完整发布 gate 与真实回复已核对；其他线程 WIP 保留 |
| melo主线（历史·2026-10-15） | `01a10bf2-e092-7862-87fe-2f237a8fb6a0` | 架构、审计、记忆、function calling、日常 gate 和手机 OAuth；本次只补遗漏 | 已完成补录；授权核心已提交，当时相关共享文件的他线程 WIP 已于 10-17 收入 `8cd3eff`；[build23 回执](docs/handoffs/melo-thread-backfill-20261015.md#historical)，产品任务交新主线 |
| 设计 Melo | `01a1161a-1919-79c1-9764-8709bb0e2e2d` | 五语 / 图像质量 / MCP / Agent 设置已完成；10-20 测试选组审计后按用户授权完成漏选修复、功能 / 平台选组、预检去重与统一开发规范 | [实施与验证](docs/test-selection-implementation-20261020.md)：工具 29/29，隔离全日常与 32 Swift 通过；产品业务和其他线程 WIP 保留，本地提交未推送。历史 Agent 验收见 `docs/agent-settings-20261016.md` |
| melo ui | `01a10bf3-d7b9-7832-a351-8b0f78e9c552` | 10-16 UI 设计语言审计：主视觉统一，新增浮层/设置/控件接入不完整；仅审计 | 六类差异与手机 Form 待验项见[审计报告](docs/ui-language-audit-20261016.md)；桌面实看/样式采样，手机源码层；此前[银河与留白](docs/galaxy-clarity-20261016.md)验证保留 |
| 读取 melo ui 方案 | `01a1103d-0c3b-77d4-96dc-ea499d455020` | 2026-10-06 读取、单次成功派发、按指定 turn 只读跟进与 Library 截图交付；2026-10-15 补历史证据 | 辅助线程无产品代码/提交；288/291 项为旧轮次结果，详细边界见[辅助线程回执](docs/handoffs/melo-thread-backfill-20261015.md#ui-helper) |
| melo iphone | `01a11116-8469-74a2-9815-8ce59b702afa` | 10-16 三线程功能/UI 对齐，Agent 首屏新建/移除旧语气、项目校验及新黑金 M，已覆盖 0.5.19 (25) | 本地 `5c975aa`；3575 JS/23 Swift/90 专项及模拟器通过；实体安装/启动/数据保留已验，实体 UI/真实模型未复验；`docs/ios-align-install-20261016.md` |
| melo副线 | `019d5db3-d2cd-70c2-bc8f-955d36099219` | 固定源码统计口径、早期 pre-push evaluation 协议；OpenClaw/桌宠历史工作独立 | 2026-10-21 再统计 205,993 行（含空行/注释，不含 ios）；既定四目录及扩展名 `find` / `wc -l` 退出码 0；仅文档 WIP 与快照更新，无产品验收或提交；桌宠入口见[副线回执](docs/handoffs/melo-thread-backfill-20261015.md#secondary) |
| melo全量代码统计（Claude Code） | `46a2bdcb-e8d9-4826-bf92-2fde11eff56a` | 2026-10-22 用户要求统计全部 Melo 代码含桌宠；新增全量口径，与副线四目录口径并列，不替代 | HEAD `7750d8f` + 未忽略 WIP：自写代码 258,612 行（非空 240,931，1,528 文件；测试 91,581），其中产品仓库 249,790、外部 8,822（旧站 site 4,691、桌宠素材线去重 1,861、melo-universe 1,158、跑分自写脚本 1,112）。口径：`git ls-files --cached --others --exclude-standard` 下 js/mjs/cjs/jsx/ts/tsx/swift/kt/kts/py/sh/command/applescript/cc/gyp/html/css；排除 dsh-pet 上游 37,957、生成 bundle（`ios/Melo/Scene/`、两份 `agent-core.js`、`upstream/lib/melo-host.mjs`、`shared-core.js`）、JSON/xcstrings/YAML、外部 venv/SWE-bench/requests 副本与桌宠旧工作目录。同时副线四目录口径为 208,937。只读统计，无产品验收或提交 |
| melo网站 | `019dce6e-faae-7850-a8bb-db48b737b928` | 2026-10-15 核对神经网络四区、外放标签和连续镜头源码/快照差异；首页有界轴向转动，非各层无限自转 | 独立本地 WIP，无 Git 元数据/可核实提交；历史 13 单元/22 浏览器未重跑；本轮静态核对旧站 9/9 散列与桌面副本一致；详见[网站交接](</Users/mortred/Documents/New project/melo-universe/HANDOFF-20261015.md>)，Safari/用户验收/发布待验 |
| Benchmark Melo on a major platform | `01a139e9-2509-7623-8cb7-4df16b2d0c86` | Melo 核心在 Mac，六个编码工具经外部适配接 Docker；2026-10-15 核对历史证据与当前 diff | 历史3/3、目标3/3/回归158/158、对照0/3；Requests81项非计分错误；外部WIP未产品化；非当前树验收；详见[跑分回执](docs/handoffs/melo-thread-backfill-20261015.md#benchmark)与外部 HANDOFF；GitHub英文README/About/12标签已发布 `39cc759` |

外部跑分证据：`/Users/mortred/Documents/New project/benchmarks/melo-swe-docker-agent-20261014/report.md`。网站旧目录 `site/`、`/Users/mortred/Desktop/melo_web` 与 `melo-universe/` 是不同产物；不能自动互相覆盖。

## 7. 保留的产品决定

- 2026-10-17 用户要求 Android 与其他端保持一致，避免各端自行维护核心功能。后续通用能力按共享 Core / 平台 Adapter 划分：Skill、Tool 注册与路由、Loop / 取消 / 结果语义须同源维护并共同验证；平台实现差异显式声明。仅共用 Sync Schema 或同名 Tool 不能称为核心已统一；手机独立运行、设备本地权限与凭证边界保留。共享 Runtime 的具体落地方式尚未选定或实现，本约束不等于已完成三端重构。

- 2026-10-17 用户要求统一整条执行逻辑并质疑 Google 浏览器抓取及 Codex 能力解释。已形成[具体设计审阅稿](docs/specs/2026-10-17-shared-agent-search-design.md)：同源本机 JS Core 为推荐路线，Native / HTTP Search 优先，Playwright 仅显式 fallback；这是建议而非用户已选定 Runtime。Hosted Tool 的支持须验证实际连接，不能由 API transport / Function Calling 推断；凭证不因统一配置而自动进入资料同步。

- 2026-10-17 用户认可共用 Agent Core + Platform Adapter，并要求先检查循环、共享状态、Memory / Context 和真实能力清单。方向认可不等于 Runtime spike 或迁移已完成；[当前检查](docs/agent-core-audit-20261017.md)确认的边界应先进入修复与 Conformance。

- 副线统计沿用 `src`、`desktop-ui`、`desktop-app`、`scripts` 下 `js/mjs/cjs/ts/tsx/jsx/swift/sh/applescript/json/html/css` 文件的 `wc -l` 合计，含注释和空行，不含 `ios/` 及目录外内容；不是全平台总代码量，历史结果不代替实时统计。
- 2026-10-15 用户最新决定：仅用户明确要求才运行 `git pp` 或等价脚本；不自动审查、重审或推送。测试、本地提交、已授权修复持续推进。被要求运行时仍保留推送门禁。
- 保持现有暗色神经网络语言；“太空”增加内部密度与深度。导航悬停原位放大约 3–5% 并变亮，不偏移出屏。
- 任务空间由真实执行事件驱动，支持并行、独立折叠和历史回看，及时展示结果。细线发光神经突触、深紫活动区、轻透来源卡片；未逐项验收的视觉目标不能写成已完成。
- 搜索来源网站默认最相关 5 个，展开最多 10 个；引用是额外标记，不先排除被引用网站。区分搜索命中、实际读取、最终引用，不编造淘汰理由。
- 手机独立聊天与跨端同步分开；对话可选角色和模型。自有账号注册等待用户配置 Supabase，区别于模型平台 OAuth。
- 本地语义检索不要求额外软件。“额外快速”默认关闭，仅按已配置连接分配判断任务，不改变回答模型。
- 保护聊天、角色、草稿、图片、设置和凭证；覆盖安装前后检查数据。源码/夹具/真实服务/签名安装/用户验收分层报告。

## 8. 所有线程的更新协议（用户于 2026-10-15 要求）

### 2026-10-20 — melo副线 — Codex 累计 token 粗估
- 线程 `019d5db3-d2cd-70c2-bc8f-955d36099219`；只读查询本机 `~/.codex/state_5.sqlite`，按 name/title/cwd 的 Melo 关联、已知 OAuth 调查及递归子任务筛选 628 条，累计字段合计约 2,236,775,048 token（统计期间本任务仍增长）。
- 15 条现存日志末尾累计记录合计约 1,416,798,675；其余 613 条约 819,976,373 依赖数据库，缺少可用末尾日志。旧记录存在总数与分项不一致的占位值，未做请求级重算或 fork 继承去重，故不能称精确净消费或严格下限。
- 范围包含网站、跑分、审查及早期混合 OpenClaw 内容；不含 Claude 自身开发用量，不统计 Melo 应用运行时调用。缓存为输入子集，推理为输出子集，不重复相加；本数字不是实际账单或订阅额度折算。
- 本轮仅本地只读统计与文档 WIP / 快照更新，无模型服务调用、账号操作、产品 gate、提交或推送；下一步如需精确归因，应取得旧日志并处理跨任务继承与混合任务边界。

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
| Android 桌宠 | `npm run check:android`；`ANDROID_SERIAL=emulator-5554 npm run test:android:connected`（含 `PetOverlayFlowTest`，需 `appops`/`pm grant` 由测试自行授予）；素材 `node android/scripts/import-pet-skins.mjs verify`，重导入 `import`、发布 `bundle --tag` |
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

### 2026-10-21 — Claude — 手机缓存前缀、话题分隔、长文闪退（最终 `27bc8f7`，纳入本轮组合）

- 用户选 1B+2B；主体（逐轮内容后置、search_history 隔离、话题卡 + read_history + 原文摘录、记忆本 + 个人档案）已由他线程 10-17 落地。旧分支 `claude/context-20261017` 重复，不合并。
- 本轮补：手机指令只留稳定内容、逐题内容与时间后置、按对话缓存键；对话中话题分隔（共享 `src/shared/conversationTopics.js`，手机经 agent core）；手机长文（约 2 万汉字）在记忆召回中闪退的修复。详见 [方案第七节](docs/context-memory-plan-20261017.md)。
- 与 B5（拆 `ChatStore.swift`）可能冲突：本轮在 ChatStore 只改发送前的组装几行，逻辑放在新文件。未验证：真实账号下手机缓存命中率、实体机。

### 2026-10-23 · Codex · Agent 执行闭环综合实施
- 用户已授权综合来稿后直接实施。当前改动见 [实施方案](docs/agent-harness-implementation-20261023.md)：共享 `goal.js` 保留原目标/补充、无工具交付检查、最多两次纠偏；主聊天/成员/技能/iOS/Android 接入同一决策，保持原权限和预算。
- 工具副作用分类、MCP 只读提示、取消固定首搜与回答丢弃；团队汇总保留成员回执。账号/原图/聊天无需迁移，其他线程两份方案文档保留。
- 验证：桌面脚本模型真实 HTTP 与 iOS AgentLoop 的日历→场馆→天气通过；Android JVM/lint/两种构建、iOS 无签名构建通过；完整日常 4,544 项 JS / 37 组 Swift / 两组浏览器通过（`.tmp/test-runs/run-kaxHiz/report.json`）。`--base 3368d11` 集成同样通过（`.tmp/test-runs/run-slmyzX/report.json`）；本次本地阶段提交，证据归档 `.tmp/agent-harness-20261023/`。脚本模型不代表真实供应商语义准确率或真机验收。无 push、git pp 或安装。

### 2026-10-24 · Codex · 目标闭环版双端覆盖安装与直接推送
- 用户授权本机与原 iPhone 覆盖安装，以及直接 git push；源码 `1f0e57d`，桌面已覆盖，iPhone 0.7.9（41）→0.7.10（42），签名身份与数据目录不变，无卸载/清空/git pp，其他线程两份未提交方案指纹未变。
- 完整备份与安装前后回读通过：桌面原 20 聊天/722 消息、6 Agent/1 项目/26 成果和账号配置保留；手机原 16 聊天/161 消息、6 Agent/3 个账号偏好/24 张原图一致。系统启动快照和缓存差异单独列明，不混作业务数据。
- 完整发布 gate 全绿（4,549 JS、37 Swift、两组浏览器、Android 检查及桌面打包/安装/原生启动/生命周期/服务冒烟）；iOS Release 签名、安装、启动通过。桌面真实回复与旧图预览由 Codex 操作验证，手机三项实测由用户确认“没问题”。[安装回执](docs/dual-update-20261024.md)与 `.tmp/dual-update-20261024/` 留有证据。真实日历闭环与长期后台另验，当前手机个人签名到期 10-28 20:52（Melbourne）。

### 2026-10-24 · Codex · 智能模式方案复核与选择器要求
- 用户补充明确要求：模型选择器并列固定模型（例如 Sol 6.1 / Astra 6）与「智能（自动）」，UI 随功能同步。已补入 [方案第 8 节](docs/smart-model-routing-plan-20261023.md#8-2026-10-24-代码复核与-ui-补充codex)。当前仅设计 WIP，未改产品代码、未下线旧功能。
- 当前源码复核：旧 judge 有实测优先与规则短路，关闭 extraFast 后仍有独立分类请求；升档必须接续当前工具账本和总预算。补齐连接边界、流式控制、回退一致性、单模型零判断开销、跨端共享核心及 UI 验收，实际执行范围正向用户确认。未提交/推送/安装；原 Claude 方案内容保留。

### 2026-10-24 · Codex · 智能模式 P0–P3 已落地
- 用户已明确授权直接实施 P0–P3，三端 UI 包含固定模型和智能模式；实现本地提交 `6f10396`，未推送/安装。另一个 agent-loop-dehardcode 方案保持未动。
- P0 已移除旧 extraFast 判断器、设置/API、独立浏览器线和关闭开关后的隐藏分类请求；通用短请求传输用于语音/核验，保留并迁移其测试。隔离 home 专项 34/34 通过，证据 `.tmp/smart-routing-20261024/p0-targeted.log`。
- P1/P2 已接入共享 `shared/agent/modelRouting.js`、桌面设置/选择器/循环：显式档位、同连接默认、3 秒判断和隔离缓存、预算内一次升档、动态副作用强档下限。桌面组合专项 69/69、最新增量 37/37；实际浏览器保存/重载/固定与智能切换通过，旧 API 返回 405、无页面异常。
- P3 iPhone/Android 原生设置、候选顺序、对话模式同步、实际传输和回执已接线；Swift 循环含共用夹具、缓存和副作用计数通过，iOS 完整模拟器构建通过。Android 模拟器 HTTP 夹具与最终复验通过（同连接判断计数 1、外部连接 0、缓存零增量、一次升档）；最后 Kotlin 接线修正的 JVM/Lint/Debug/Release 重验通过。
- 完整日常组合 `npm test -- --base 458c3c0` GREEN：4,549 JS、37 Swift、设置浏览器、Android JVM/Lint/双构建及生成物检查，目录 `.tmp/test-runs/run-LpZwCA/`。其后新增超时取消 4/4、对话模式同步 9/9 定向回归通过。详细边界见[实施文档第 9 节](docs/smart-model-routing-plan-20261023.md#9-实施状态2026-10-24)，专项证据 `.tmp/smart-routing-20261024/`。
- 模式配置保留既有固定选择；智能不跨连接，除非用户明确开启。专用图片服务保持原配置。真实账号、聊天、原图未写入或覆盖安装；未作真实服务收费或 iPhone 真机验收，不以构建/模拟器代替。后续按用户要求再推送或原位安装，不自动 git pp。

### Codex · 跨提供方/语言/本机配置治理（2026-10-24，已实现并通过组合验收）

用户授权按 A–G 审计实施，基准 `5afb0be`；实际落点、配置登记与兼容边界见 [专项记录](docs/portability-hardening-20261024.md)。连接目录/实测/声明决定视觉和推理行为，默认模型集中；自定义声音按类型/配置地址识别，保留转写配置。任务 owner 校验现有 Agent，团队明确选成员，频道别名来自配置。语言出口/事件 ID 与参数、三端能力 UI、五语图片意图、搜索配置与逐请求隔离已接线；项目回复语言的保存、继承、恢复自动经真实冷加载验证。
最终 `npm test -- --base 5afb0be` GREEN：4,578 JS、37 Swift、设置浏览器、Android JVM/Lint/Debug/Release、生成物及依赖检查，证据 `.tmp/test-runs/run-pHqzcA/report.json`。完整 iOS Simulator App 构建通过（`.tmp/portability-20261024/ios-frozen-build.log`）；各专项与先红后绿日志见 `.tmp/portability-20261024/`。已修复旧夹具语言/共享路径依赖；视频取消测试保留原断言，独立及最终组合均通过。
实现本地提交 `9ef3691`，未发布、未安装、未作真实收费模型或外部 F5 包验收。语言/能力保持设备本地，严格旧同步协议不加未知字段；各端保留本机选择。保留其他线程 `docs/agent-loop-dehardcode-plan-20261023.md`；后续按用户指示推送或安装，不自动 git pp。

### Codex · 运行逻辑复审（2026-10-24，六项已按下方交接修复）

用户要求先审计再报告。基准 `dadd38b`；[审计记录](docs/runtime-logic-audit-20261024.md) 确认 3 项 P1（iPhone 生图拒绝遗留发送状态、同 URL 不同连接串用能力、失败视觉探测阻断重测）及 3 项 P2（Edge 选择被 MiniMax 优先级覆盖、缓存不应用新正文/证据预算、旧任务风险污染新任务路由）。五项在隔离 home/模拟传输/真实临时缓存复现，iPhone 项由完整控制流静态确认，未作真机验收。
现有相关回归 50/50 通过，反例与日志见 `.tmp/logic-audit-20261024/`；这批组合漏测尚未修复，不能沿用上一轮 GREEN 作为修复证明。本轮只新增审计文档及交接 WIP，产品代码、账号、原图不变；未提交/推送/安装/git pp，其他线程方案原样保留。后续已获授权完成修复，当前状态以下方交接为准。

### Codex — 2026-10-24 六项逻辑修复与跨端验收

- 用户授权“都去修了”，基准 `dadd38b`；[专项审计及修复记录](docs/runtime-logic-audit-20261024.md)保留原反例与验收入口。本线程仅测试与本地提交，不运行 git pp、推送或覆盖安装真实设备。
- iPhone `ChatStore.swift` 在持久化消息/图片和登记发送状态之前检查所选连接的图片能力；`ImageWorkflowVerification.swift` 原生模拟器覆盖同端点不同连接、拒绝零调用、存储原图字节与草稿冷加载保留、改配置后同聊天重试。
- `shared/agent/modelCapabilities.js`、`imageSettings.js`、`services/modelRouting/routing.js` 绑定所选连接身份/凭据/能力；失败探测只记诊断，`llmConnections.test.js` 逐个模拟超时/401/429/误识别后成功请求，显式禁用保持零调用。
- `tts.js` 遵守显式服务选择，失败不跨服务，旧空值配置保持回退兼容并捕获异步前环境；`desktop-ui/app.js` API 语音选项写明确提供方。
- `webSearchTool.js` 查询与 URL/304 缓存统一按当前预算返回，SQLite 回归验证结果/正文/证据一致和磁盘原文保留。
- `shared/agent/modelRouting.js` 仅继承当前话题风险；三端共用判断输入，续问/未完成目标与本轮风险仍保留。更新共享包、Swift/Android 适配与跨端夹具；PhoneRoutingHost 与 Android SmartRouting 的实际判断请求均有断言。
- 显式文件范围完整日常验收通过：4,586 JS、37 Swift、设置浏览器、Android JVM/Lint/Debug/Release；iPhone Debug 构建与原生诊断通过；Android 专项模拟器 1 个集成测试通过、0 跳过，内含共享夹具和实际本地请求计数。最终整批 `npm test -- --base dadd38b` 通过，37 组 Swift 仅复用编译并重新执行测试；iPhone 跟随全局默认连接的身份分支另完成最终构建及原生诊断。
- 证据：`.tmp/logic-fixes-20261024/`、`.tmp/test-runs/run-hyoCFT/`、最终 `.tmp/test-runs/run-yoDiS7/`。真实服务、实体设备、长期后台另验。测试设备已清理；他线程方案 SHA-256 未变。

产品修复本地提交 `99d2fca`；未推送或覆盖安装。

### Codex — 2026-10-24 本机全部更新（安装验收完成，推送随后暂停）

- 按用户授权覆盖更新这台 Mac 的应用、内置桌宠与本地服务；包含智能模式、跨提供方/语言改进及六项逻辑修复。安装补丁 `89162c3`，详细结果见 [本机更新回执](docs/local-update-20261024.md)。本轮没有安装手机、不运行 git pp。
- 已安装应用从打包时写入并验证的项目目录启动，环境覆盖优先；原生测试隔离 WebKit 存储，用户正常运行保持原持久存储。修正运行态冒烟的语言夹具。
- 最终完整发布 gate 全 GREEN：4,591 JS、37 Swift、Android 四项、设置与运行态浏览器、桌宠资产、原生生命周期、构建/签名/安装、桌面与 Launchpad 启动。完整日常校准另通过，证据 `.tmp/local-update-20261024/` 与 `.tmp/test-runs/run-cd1Z4o/`。
- 完整备份已核对；安装后 4,664 原文件全部相同。真实使用后原 21 聊天/724 消息、账号、项目/成果、833 图片保留；6 Agent 仅新增空 replyLanguage，原字段严格一致。运行状态、索引和验证对话变化已单列。
- 原账号实发收到“更新验证通过”，执行面板“回答已交付”；历史生成图实际预览 1289 × 1221。固定模型与智能入口可见，桌宠保持原开启并运行，应用停留在新对话页待用。
- 首轮锁屏期间原生超时及夹具问题已保留记录；用户解锁后最终验收通过。原计划直接推送 master；用户随后暂停，推送未执行。两份他线程未提交文档保持，不把构建/模拟测试代称手机真机验收。

### Codex — 2026-10-24 全仓审计补齐（执行中，暂缓推送）

用户提供全仓审计并要求一起修完，撤回本轮立即 push。包含 push 的命令被自动审批拦截，未执行；此前本机安装验收已完成。按 [补齐方案](docs/audit-followthrough-20261024.md) 先复核已修项，再收敛搜索/工具/意图/核验、配置与路径、桌面/手机 UI。保留账号和他线程两份原稿；后续只本地提交，等待用户重新要求推送。

### Codex — 2026-10-24 意图共享入口原样迁移

按审计补齐计划把桌面意图模块原样放入 shared/agent/retrieval/intentRouter.js，旧入口保留 re-export；除 import 路径外正文逐行相同。本阶段尚未改变规则或手机行为。显式范围日常 GREEN：4,591 JS、37 Swift、设置浏览器、Android JVM/Lint/Debug/Release；证据 `.tmp/test-runs/run-S8tZgs/`。首次未加载 Java/SDK 的环境失败保留于 `.tmp/audit-followthrough-20261024/`，最终使用已核实的 Homebrew 工具链。下一步独立修正规则/工具策略/核验与流式行为，仍不推送。

### Codex — 2026-10-24 审计执行层修正（WIP）

落实 [补齐方案的执行层](docs/audit-followthrough-20261024.md)：共享检索入口/可用工具目录、明确工具限制、桌面与 iOS 同源意图、核验使用实际回答模型、工具后流式。Android 已接共享目录。专项 285 项及追加修复 46 项通过，最终组合回归在跑；首次全量发现两处历史/预算联动已修，失败证据保留。当前源码尚未提交/安装/推送，UI/配置/路径仍待做，账号和两份他线程原稿未动。

### 2026-10-24 · 审计执行层验收收尾（Codex）
搜索规划与能力目录、共享意图、实际模型核验、工具后流式修正完成。完整 JS/Android/设置浏览器通过后，Swift 发现日期补充丢失任务，保留原断言补齐，日期专项及 37 Swift 套件全过。证据 .tmp/audit-followthrough-20261024/ios-complete.log、agent-daily-verified.log；后一日志保留首次 Swift 失败。配置与 UI 尚在后续阶段；不推送，不覆盖真实用户数据。

### 2026-10-24 · UI 公共入口原样迁移（Codex）
app 的 escapeHtml/showFlashToast 与授权页 formatTime 原样移至 html/feedback/format，调用不变。显式范围检查 run-gYnPbj：JS、设置浏览器、所选 Swift 均通过；后续才做反馈和格式语义统一。安装路径/行为配置是另批 WIP。

### 2026-10-24 · 审计配置与 UI 补齐（Codex，集成验收中）

- 入口 shared/agent/runtimeBehavior、src/runtime/runtimeBehavior、desktop-ui/behaviorSettings：配置/环境覆盖/UI/真实执行接通，默认不变；安装保护、向量隔离、限额归位见[实施及逐项结案](docs/audit-followthrough-20261024.md)与[配置说明](docs/runtime-configuration.md)。
- 公共反馈/链接对话框、日期数字/转义、提交状态、CSS/场景 token、iOS 语义字体与同源语言已接线。图片快捷路径也遵守禁用工具。浏览器检出取消复选框显示残留并修复，继续验收。
- 当前未提交 WIP：图片回放 6/6、向量隔离 15/15、iOS App 无签名构建通过；整批待验。证据 .tmp/audit-followthrough-20261024/；无安装/迁移/push/git pp，他线程原稿未改。

审计集成补充：真实浏览器保存/重试/取消/环境锁/链接草稿已通过；截图追加动态按钮与历史回执本地化。组合 run-TpIrou 4,607 个断言过，但本地向量 worker 退出 SIGABRT，整轮失败。已改队列排空/原生 dispose/退出隔离，真实推理与连续重启 4/4；最终整批重跑，仍未安装/推送。

### 2026-10-24 · 全仓审计补齐最终交接（Codex）

- [逐项结案与验收](docs/audit-followthrough-20261024.md)、[运行配置](docs/runtime-configuration.md)已更新；执行层 e05e65f，UI 原样入口 2beeaa5，本阶段配置/路径/界面/手机与边界修复本地提交 5222034。用户要求仍为不 push、不 git pp。
- 整批 run-ZkYuyB：4,609 JS、37 Swift、Android 四项、设置浏览器、生成器/资源全过；最后聊天表单修正按影响计划 run-jr7vsn 105 文件/652 项及设置浏览器通过。没有以专项替代先前整批；未重复无关移动构建。
- iOS 完整 App 无签名构建通过。浏览器已实际验证保存/失败/取消/环境覆盖、链接草稿、固定与智能选择、历史图片和英文回执；截图已复查。向量 worker 退出崩溃经真实推理/排空/连续重启修复，失败日志保留。
- 本批未覆盖安装、未碰账号/聊天/原图；他线程两份原稿指纹一致。实体设备、真实模型和发布安装另验。本批无剩余代码修复；下一步仅按用户要求推送/覆盖安装。


## 2026-10-26 — 本线程：隔离开发作业第一版

- 用户在自开发审计后授权实施；按推荐第一版交付候选代码、版本绑定证据和只读审查，停在待合并。分支 `codex/self-development-20261026`，基准 `346e175`；实现阶段 `0f6cbff`，修正待提交。未推送或安装。
- `src/development/` 管理独立源码/Git、Docker 临时卷、断网执行、长命令日志/停止和启动恢复；`/api/development/*`、`development_job` 工具与桌面「工具与任务 → 隔离开发」提供实际入口。测试/审查绑定源码树，原仓库推进或证据变动使旧批准失效；敏感文件变更另需人工核对。审查必须实际读过证据和改动文件。
- 手机使用同一个作业 ID 投影到 v1 任务检查点；iPhone/Android 展示状态与验收摘要，禁止把检查点当作桌面执行/批准。纯 `test:full` 不安装；安装独立为 `release:verify` 且位于所有纯验证之后。
- 验证：专项 35/35；完整快速档 `run-PvvS16`：JS 4704/4704、设置浏览器、Swift 37 组、Android JVM/Lint/Debug/Release 全过，无跳过/超时复测；iPhone 完整未签名构建成功。容器隔离、Git/原生依赖、恶意符号链接回传拒绝、取消清理和浏览器/HTTP/执行器闭环均实测；模型为确定性夹具。长命令约608秒正常退出；首次脚本计时断言错误已记录修正。
- 测试环境在独立工作树准备：依赖、离线模型、素材链接及哈希校验；未改真实账号或共享素材。Melo 自身已提交模块在真实容器19/19，源码树不变。证据 `.tmp/self-development-implementation-20261026/`；完整说明见[实施文档](docs/self-development-implementation-20261026.md)。
- 下一步：最终文案/修正提交、明确基准集成档，再合入主线。自动合并/发布/回滚、Mac/iPhone隔离运行器、真模型与真机验收属于后续阶段；本版不声称已实现完整自更新闭环。
