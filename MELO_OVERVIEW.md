# Melo 总览：架构、线程改动与接手入口

更新时间：2026-10-18（Australia/Melbourne）。这是所有 Melo 工作线程共用的人工维护入口。

## 1. 先看这里

- 真正产品仓库：`/Users/mortred/Desktop/melo/Melo Desktop Project`。Codex 当前保存项目 `New project` 指向 `/Users/mortred/Documents/New project`，不能混淆。
- Android / Mobile Use 本会话使用 Windows 主机上的 WSL checkout `/home/zhouy/workplace/Melo`（同一 GitHub origin），当前分支 `codex/mobile-use-features`；此路径与上面的 macOS checkout 分属不同主机。
- 本文保存当前事实、架构边界、跨线程交接和待验事项；`PROGRESS.md` 保存意图时间线；专项文档保存详细证据；Git 保存代码历史。`codex.md` 是自动生成快照，不手改。
- 接手顺序：本文 → `CLAUDE.md` → `git status --short` → 本次模块的实际 diff / 源码与证据。正常工作不用完整回读线程。
- 记录缺失、线程更新时间晚于交接、源码与文档冲突时，只定向读该线程近期相关轮次，再补本文；不要靠旧总结覆盖新代码。
- 2026-10-15 已确认通知的 8 条线程全部完成补录回复；当前主线复核总览、源码/Git 与关键证据，集中归档详细回执。完成补录不等于产品任务全部验收；详见第 8 节与核对报告。
- 本文不是自动监控：各线程必须在实际改动后主动更新。未更新的线程或未记录的 diff 应标为“待归属/待核对”。

## 2. 当前交付与阻塞

| 项目 | 当前事实 | 下一步 / 边界 |
| --- | --- | --- |
| Android / Mobile Use | 0.4.0 Task Cache 已实现并覆盖安装 Fold6：Exact / 模板零 LLM、Similar 一次改写、Miss Probe、自动写回及 Chat 编辑 / 删除 | 91 JVM / 33 runtime / 4 viewport UI、Lint / R8 / 签名通过；Fold6 Exact 0 请求 1.182s、Similar 1 请求 7.169s、冷启动及 CRUD 实测。入口变化会停止或安全转 Probe；[Cache 证据](docs/android-task-cache-20261016.md)。不等同全部 repo / Samsung 场景验收 |
| Android / App Discovery | 0.5.1 (13) 已同签名覆盖 Fold6；准确名称 / 包名优先打开，小候选与显式浏览清单 | 原 10 Chat / 1 角色保留；folded 首轮 12 步受阻，退出旧搜索页后 5 步 / 23.806s 核对「设置」，两轮无 list_apps。跨包恢复 / 额外窗口恢复仍待修。[实机证据](docs/evidence/app-discovery-fold6-051-20261017.json)；113 JVM / Lint / R8 / 签名，本版前的同逻辑 runtime 40，详 verification |
| Android / Samsung 窗口 | 0.4.2 已同证书安装；修正启动后的目标窗口交接，无法取得时停止；99 JVM / 34 runtime / Lint / R8 / 签名通过 | 同一最终 APK 的 folded / unfolded 微信截图均可读，tree 仍 0 节点；外部 ADB 搜索框坐标 + ASCII 输入成功，未发送消息；[证据与边界](docs/wechat-window-capture-20261016.md)。完整视觉输入 / 中文 IME 与 Fold Cache 布局隔离未实现 |
| Android / Chat Phone Use | 0.5.0 已同证书安装；普通 Chat 按需 invoke phone_use，结果回当前对话；产品 `954b382` | 109 JVM / 39 runtime / Lint / R8 / 签名通过；Fold6 展开模式真实 Maps 查询 9 步及“第二家”追问 5 步通过，普通问答不启动设备；[证据](docs/chat-phone-use-20261017.md)。小红书 / 本版 folded 实测、微信输入 / Fold Cache 分区待做；Phone Use 开启暂非 Streaming；已确认查询默认占屏的路由缺口：Android 尚未接入 Search；核心能力分离与搜索优先待实现 |
| Shared Agent Core / Search | 0.6.0 (14) 已接 Node / Android 真实 Chat 的同源 Router / Tool Contract / Search / Guard；已合入主线 `84abfa9`；R8 Preview 已同签名覆盖 Fold6 并启动 | 314 Node + 203 相关回归、115 JVM / Lint / Debug / R8、52 Emulator 执行与 42 Fixtures。实机展开安装前后 11 Chat / 1 角色、UID / 安装历史及两项 Accessibility 设置保留，无启动 Crash；[装机证据](docs/evidence/shared-agent-fold6-install-060-20261018.json)。未发真实请求，Fold6 Core 执行 / 两种姿态功能与 iOS 原生待验；Skill / Context / Memory / records 继续迁移；[开发证据](docs/shared-agent-search-20261018.md) |
| 手机 Codex 登录 | `85ac3a5` 接独立设备码 OAuth；`14e602f` 修应用切换取消；0.5.17 (23) 已签名覆盖并启动，用户数据核对保留（含当时共享 WIP） | 同码恢复限同一进程，强杀/系统回收后需新验证码；用户真实授权尚未确认，交新主线跟进 |
| 手机图片链 | 原图、编辑意图、失败保留与重试、结果保存/历史恢复已接生产入口；HTTP/原生夹具通过 | 手机真实账号权限、生成/修图画质待用户登录后验证；登录不自动生图 |
| 手机保存反馈 | 共享成功记录、绿色已保存、并发保护及重复确认；聊天/图库/预览共用；已含在 0.5.18 (24) 实体包 | 23 Swift/模拟器实际照片写入及取消/重启通过；本轮签名安装启动通过，实体照片权限仍单列；见 `docs/ios-photo-save-20261015.md` |
| MCP 启动 | 图表、PDF、Mermaid、本地 Playwright 默认启动；移除首启询问，并修复原生 NVM PATH 导致服务无法连接 | 63 项 MCP + 浏览器专项、两次真实冷启动通过；开关与调用授权保留，见 `docs/mcp-startup-20261015.md` |
| 桌面图片链 | 10-15 只读实查默认 `codex-oauth`，未指定图像型号/质量；10-14 生产编辑回执为 `gpt-image-2-codex`、成图 `quality: low` | API 配置默认 Sunburst 2.5 不等于 Codex 已调用它；未接入 `xhigh/max`，不能称默认满血；见本页图像默认值核对 |
| 阅读密度 / 图片预览 | 阅读/预览UI仍共享WIP；10-15原生桌面复现生成图预览失败：旧签名URL403、原件仍在，同文件任务回看重签200且SHA一致 | 已确认访问生命周期缺陷，尚未修复；完整[图片承载治理计划](docs/image-capacity-plan-20261015.md)覆盖原件/衍生/缓存/内存/恢复；历史366 UI不代表已覆盖过期和重启 |
| 双端 Logo | 10-16 简洁低饱和黑金 M 已替换双端正式资源；电脑已实际安装 | 17 个资源散列、尺寸/alpha、安装包签名、Finder 新图标、原生启动及资料核对通过；手机资源已更新但实体包未安装，见 [交接](docs/design/logo-muted-20261016/README.md) |
| 桌面神经总览 | `22bcd1b` 已提清双端银河；本轮桌面中枢按可用高度下移最多 30px，给顶部悬停放大留白 | 18 项神经 UI 回归通过，原生首页已刷新；1320×860 顶部完全聚焦仍在画面内；[证据](docs/galaxy-clarity-20261016.md)。手机安装边界沿用前轮 |
| 手机权限 / 文件 | 权限状态、文件/目录授权、预览、确认导入已接入；10-15 当前树 21 组 Swift / 共享渲染和模拟器编译通过 | 源码仍 WIP；10-14 模拟器交互证据与本次编译分开；iCloud/第三方文件授权及实体权限流程待验，不把后续集成包等同专项真机验收 |
| 执行面板 | 桌面多段公开摘要与 API 白名单回执；手机已补独立 Responses/兼容 API/Anthropic 回执并保留历史 | 手机 `2afe9dd`，0.5.18 (24) 已装；协议/持久化/模拟器详情通过，真实服务回执本轮未发请求；v1 同步不传新增 api 字段 |
| Agent 演进 P0–P4 | 已实现并迁移 6 Agent / 26 成果，14 对话保留；审查修正 `4680530` 已在桌面运行：同步放宽需桌面确认、项目受全局上限、知识只读检索、团队/预算/人设边界修正 | [实施与迁移](docs/agent-evolution-20261015.md) / [审查修正与回执](docs/agent-review-fixes-20261015.md)；仅用户要求 git pp。3554 JS / 23 Swift 日常通过，真实模型协作和真机单列 |
| 发布 gate | 当前 `npm test` 为日常按边界检查，`npm run test:full` 为完整发布 gate | 各记录的旧计数只属于当次源码；本次纯文档整理未重跑产品测试 |
| 项目边界 | A/B 已交付：创建显式归属、执行器绑定能力、无项目聊天按需独立目录；文件面板/每次删除确认/遗留文件管理已合入本地 master `7ae2292` | [架构加固](docs/arch-hardening-20261015.md) / [UI 功能对齐](docs/ui-function-alignment-20261016.md)；项目聚合模型和完整删除级联仍见项目专项 |

2026-10-18 Fold6 0.6.0 的 brunch / 导航漏路由与历史解释误操作已在 0.7.0 (15) 源码修复；用户已认可 [Research / 折叠执行卡 / Markdown 规格](docs/specs/2026-10-18-research-execution-markdown-design.md)。同源 Core 接任务证据、Scene 和上轮记录上下文；Android 持久化真实步骤、区分受阻 / 部分完成，接默认折叠卡与共同 Markdown 解析。147 Node、117 JVM、Lint / Debug / R8、Cover 22 项通过，其他回归和展开继续验；私人 Fold6 尚未装本版，当前 Windows ADB 无设备，未发真实请求。既有诊断见 [Search 实机诊断](docs/shared-agent-search-20261018.md)。

详细手机证据：[`docs/mobile-image-edit-20261014.md`](docs/mobile-image-edit-20261014.md)。

## 3. 整体架构与代码地图

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
| 桌面界面 | `desktop-ui/app.js`、`neural*.css`、`executionPanel*` | 暗色神经导航、聊天、设置、执行回看；局部更新保留焦点与草稿 |
| 神经导航 / 场景 | `desktop-ui/neuralLayout.js`、`neuralMotion.js`、`neuralShell.js`、`neuralSatellite.js`、`neuralScene3D.js` / `neuralScene.js` | 同一空间模型驱动 DOM、GPU/Canvas 与拾取；10-16 两端共享清晰星核与薄云层，布局/持续动画不变，见 UI 交接 |
| 传输 / 路由 | `src/server.js`、`src/http/` | HTTP/SSE、来源检查、声明式路由与生命周期；不承载新增领域业务 |
| 请求运行边界 | `src/runtime/requestContext.js`、`requestScope.js`、`processOwnership.js` | 入口捕获 home、环境、身份、路径和取消信号；异步执行不重读可变全局 home |
| 领域服务 | `src/services/`；`src/desktopStore.js` 为兼容入口 | chat / task / settings / agent / workspace 等业务；新增业务放领域服务 |
| 项目 / 工作区边界 | `src/services/project/`、`src/services/workspace/`、`src/domain/project/`、`src/services/chat/portableWorkspace.js` | 项目与聊天工作目录已显式绑定，聊天文件生命周期由 `chatWorkspaceFiles.js` 管理；UI 跟随当前聊天。项目聚合与资产生命周期完整重构仍见专项 |
| 纯领域 / 持久化辅助 | `src/domain/`、`src/persistence/` | 纯实体与可复用持久化辅助；保持依赖方向，抽模块先逐字节移植 |
| 状态与检查点 | `src/state/stateStore.js`、`chatPersistence.js`、`chatManifest.js`、`statePayload.js` | 原子事务；规范化 home 隔离；不可变消息 checkpoint 与单调清单修订 |
| Agent 设置 | `desktop-ui/app.js`、`agentSettings.css`、`settingsEdit.js`、`src/services/agent/agentMutations.js` | 单一编辑页、页头新增、全局新建、跨渠道显式保存；旧 Mood UI/双端提示注入已停用，旧数据兼容；见 [设置验收](docs/agent-settings-20261016.md) |
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
| 手机文件 | `ios/Melo/LocalFileAccess.swift`、`LocalFilesView.swift`、`LocalPermissionsView.swift` | 本机目录书签、撤销、路径约束、预览与确认导入；授权不自动上传 |
| 外部官网原型 | `/Users/mortred/Documents/New project/melo-universe/src/{data,neural-geometry,scene,navigation,main}.js`、`styles.css` | 独立 Three.js / Vite SPA；连通神经图、真实投影命中、History API 管理三级 hash 路由，`onFrame` 进度协调相机/滚动/正文；不接产品模型、账号或收款，旧站与桌面导出分别保留 |
| 外部 SWE-bench 适配 | `/Users/mortred/Documents/New project/benchmarks/melo-swe-docker-agent-20261014/{run_melo.mjs,container_tools.py,run_batch.py}` | 调用产品正常消息入口，在独立基准进程替换六个工具运行函数并自动授权；产品仓库没有Docker功能改动或接入提交；评分不覆盖桌面权限/手机 |
| GitHub 公开介绍 | `README.md`、`CHANGELOG.md`、GitHub About（`MortredVigoss/Melo`） | 10-18 按源码重写简短英文介绍，突出多模型兼容、项目、记忆与 Agent 协作；公开改动说明只写用户可感知的大方向，协议、参数、路径和验收细节留在专项文档 |

### 设计线程模块补充（2026-10-15 核对，源码仍 WIP）

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

## 4. 各线程登记与最近交接

线程名称是协作归属，不是 Git 分支；同文件可能由多个线程共享修改。

| 线程（原名） | ID | 最新交接 / 实际范围 | 状态与证据 |
| --- | --- | --- | --- |
| Android / Mobile Use（本会话） | `01a13a56-c8c5-7d21-a108-d761aee8c657` | 10-18 合入远端 `84abfa9`（Merge `7a668c7`），保留新 Tool records / MCP / RunBudget / Memory；继续 A 的 Node / Android 同源 Search | [0.6.0 证据](docs/shared-agent-search-20261018.md)：公共查询不默认占屏，Hosted 要有连接 proof 与真实来源；52 次 Emulator 测试执行 / 115 JVM，通过构建。未覆盖私人 Fold6；iOS 仅同源 bundle / Adapter 源码，不能称全端完成 |
| melo审计修复（Cowork） | `01a11623-b29c-70c7-8ee0-bb21a1e6eef3` | 10-17 三路只读审计 → 四批修复：TTS 路由、上下文预算/窗口/压缩同源、逐轮上下文入用户消息、Discord 归档、Agent 成员/循环/审批加固、分层 gate 传递闭包、文档对齐 | 沙箱全量 JS 回归与基线一致；用户机器日常 gate 见本次提交；[审计与实施状态](docs/architecture-agent-context-audit-20261017.md) §7 |
| melo主线 | `01a13b2e-5446-7042-bb5e-773129746c7e` | 架构 A/B、文件生命周期/能力配置/管理入口已对齐；10-18 核对主要源码后精简 GitHub 产品介绍与更新记录 | 功能历史证据见[实施回执](docs/ui-function-alignment-20261016.md)；本轮仅文档与 About，源码基线 `e4fed5c`，链接/命令/GitHub Markdown 渲染通过，详见末尾交接 |
| melo主线（历史·2026-10-15） | `01a10bf2-e092-7862-87fe-2f237a8fb6a0` | 架构、审计、记忆、function calling、日常 gate 和手机 OAuth；本次只补遗漏 | 已完成补录；授权核心已提交，相关共享文件仍有他线程 WIP；[build23 回执](docs/handoffs/melo-thread-backfill-20261015.md#historical)，产品任务交新主线 |
| 设计 Melo | `01a1161a-1919-79c1-9764-8709bb0e2e2d` | API 观测、阅读/图片保留共享 WIP；五语/图像质量/MCP 已提交；本轮统一 Agent 设置并清除 Mood | Agent 日常 3573 JS / 23 Swift、浏览器与原生桌面通过，见 `docs/agent-settings-20261016.md`；现有聊天/Agent 保留，手机未重装 |
| melo ui | `01a10bf3-d7b9-7832-a351-8b0f78e9c552` | 10-16 UI 设计语言审计：主视觉统一，新增浮层/设置/控件接入不完整；仅审计 | 六类差异与手机 Form 待验项见[审计报告](docs/ui-language-audit-20261016.md)；桌面实看/样式采样，手机源码层；此前[银河与留白](docs/galaxy-clarity-20261016.md)验证保留 |
| 读取 melo ui 方案 | `01a1103d-0c3b-77d4-96dc-ea499d455020` | 2026-10-06 读取、单次成功派发、按指定 turn 只读跟进与 Library 截图交付；2026-10-15 补历史证据 | 辅助线程无产品代码/提交；288/291 项为旧轮次结果，详细边界见[辅助线程回执](docs/handoffs/melo-thread-backfill-20261015.md#ui-helper) |
| melo iphone | `01a11116-8469-74a2-9815-8ce59b702afa` | 10-16 三线程功能/UI 对齐，Agent 首屏新建/移除旧语气、项目校验及新黑金 M，已覆盖 0.5.19 (25) | 本地 `5c975aa`；3575 JS/23 Swift/90 专项及模拟器通过；实体安装/启动/数据保留已验，实体 UI/真实模型未复验；`docs/ios-align-install-20261016.md` |
| melo副线 | `019d5db3-d2cd-70c2-bc8f-955d36099219` | 固定源码统计口径、早期 pre-push evaluation 协议；OpenClaw/桌宠历史工作独立 | 2026-10-17 再统计 189,424 行（含空行/注释，不含 ios）；只读源码统计，非产品验收；桌宠入口见[副线回执](docs/handoffs/melo-thread-backfill-20261015.md#secondary) |
| melo网站 | `019dce6e-faae-7850-a8bb-db48b737b928` | 2026-10-15 核对神经网络四区、外放标签和连续镜头源码/快照差异；首页有界轴向转动，非各层无限自转 | 独立本地 WIP，无 Git 元数据/可核实提交；历史 13 单元/22 浏览器未重跑；本轮静态核对旧站 9/9 散列与桌面副本一致；详见[网站交接](</Users/mortred/Documents/New project/melo-universe/HANDOFF-20261015.md>)，Safari/用户验收/发布待验 |
| Benchmark Melo on a major platform | `01a139e9-2509-7623-8cb7-4df16b2d0c86` | Melo 核心在 Mac，六个编码工具经外部适配接 Docker；2026-10-15 核对历史证据与当前 diff | 历史3/3、目标3/3/回归158/158、对照0/3；Requests81项非计分错误；外部WIP未产品化；非当前树验收；详见[跑分回执](docs/handoffs/melo-thread-backfill-20261015.md#benchmark)与外部 HANDOFF；GitHub英文README/About/12标签已发布 `39cc759` |

外部跑分证据：`/Users/mortred/Documents/New project/benchmarks/melo-swe-docker-agent-20261014/report.md`。网站旧目录 `site/`、`/Users/mortred/Desktop/melo_web` 与 `melo-universe/` 是不同产物；不能自动互相覆盖。

## 5. 保留的产品决定

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

## 6. 所有线程的更新协议（用户于 2026-10-15 要求）

1. 开工读本文并核对 git status；认领相关模块与文件。发现未记录改动先标“待归属”，不能按线程名猜作者。
2. 每个可验证步骤或改变架构/行为/接口/数据/视觉后，更新本文对应模块和线程行，再在第 8 节追加简短交接（详细证据放专项或归档文档）；失败、回退、取消与未完也要记录。
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

## 7. 验证入口

| 改动边界 | 常用检查 |
| --- | --- |
| 日常变更 | `npm run test:plan`、`npm test`；按 `docs/testing-workflow.md` 确认范围 |
| 完整发布 | `npm run test:full`；含构建、安装和启动阶段，注意并行线程/运行中用户任务 |
| 手机 | `npm run test:ios`，再独立记录编译、签名、安装、数据核对、真机 UI 和真实服务 |
| UI / 架构 | `npm run test:ui`、`npm run test:architecture`、`npm run test:architecture-performance` |
| 记忆 / 同步 | `npm run test:memory`、`npm run test:mobile-sync`、`npm run test:sync-contract` |
| 模型 / 工具 / 图片 | `npm run test:models`、`npm run test:function-calling`、`npm run test:image-workflow` |

## 8. 补录完成登记与接手索引

### 2026-10-16 — melo副线 — 刷新固定范围统计
- 2026-10-17 用户再次要求统计，相同四目录及扩展名命令返回 189,424 行，退出码 0；仅文件计数，文档 WIP 和派生快照更新，不代表产品验收。后续须重新统计。
- 同日用户再次要求统计，重新执行相同范围命令，最新 180,648 行，退出码 0；下方 179,438 为同日较早快照。本轮仍仅更新文档及派生快照，无产品测试或提交。
- 线程 `019d5db3-d2cd-70c2-bc8f-955d36099219`；按既定四目录与扩展名执行 `find ... -print0 | xargs -0 wc -l`，结果 179,438 行，退出码 0；仅源码文件行数证据，不含手机目录，不代表测试或用户验收。
- 本轮仅总览与进度文档 WIP、刷新派生快照；保留其他线程改动，未提交、推送或运行产品 gate；后续统计须重跑，数值会随共享源码变化。

2026-10-15 主线通过逐线程状态快照确认，8 条被通知线程的本次补录均为 `completed`，且本地对应记录存在。重复实现按实际源码归属合并：UI 辅助线程保留派发/截图证据，产品实现归 `melo ui`；设计增强与手机登录、文件权限分别记录。

| 已完成补录的线程 | 详细交接入口 |
| --- | --- |
| melo主线（历史·2026-10-15） | [登录交付及生命周期](docs/handoffs/melo-thread-backfill-20261015.md#historical) |
| 设计 Melo | [API 观测](docs/handoffs/melo-thread-backfill-20261015.md#design-api)、[阅读与图片保存](docs/handoffs/melo-thread-backfill-20261015.md#design-reading) |
| melo ui | [神经场景交接](docs/handoffs/melo-ui-20261015.md)、[原始回执](docs/handoffs/melo-thread-backfill-20261015.md#ui)、[B 图标落地](docs/design/logo-cosmic-20261015/IMPLEMENTATION.md) |
| 读取 melo ui 方案 | [派发、历史测试与 Library 截图](docs/handoffs/melo-thread-backfill-20261015.md#ui-helper) |
| melo iphone | `01a11116-8469-74a2-9815-8ce59b702afa` | 10-16 三线程功能/UI 对齐，Agent 首屏新建/移除旧语气、项目校验及新黑金 M，已覆盖 0.5.19 (25) | 本地 `5c975aa`；3575 JS/23 Swift/90 专项及模拟器通过；实体安装/启动/数据保留已验，实体 UI/真实模型未复验；`docs/ios-align-install-20261016.md` |
| melo副线 | [统计口径、评估协议与桌宠](docs/handoffs/melo-thread-backfill-20261015.md#secondary) |
| melo网站 | [原型与版本边界](docs/handoffs/melo-thread-backfill-20261015.md#website)、[项目专项交接](</Users/mortred/Documents/New project/melo-universe/HANDOFF-20261015.md>) |
| Benchmark Melo on a major platform | [历史跑分边界](docs/handoffs/melo-thread-backfill-20261015.md#benchmark)、[项目专项交接](</Users/mortred/Documents/New project/benchmarks/melo-swe-docker-agent-20261014/HANDOFF-20261015.md>) |

历史意图只在 [`PROGRESS.md`](PROGRESS.md) 维护，代码提交以 Git 为准；本文不再复制整份时间线。

### 2026-10-15 — melo主线 — 合并重复与核对冲突

- 状态：8/8 线程补录完成；总览现状、代码地图和待验事项已核对，长回执归档且保留原始证据。
- 修正：前后台恢复/进程结束、已安装/真实验收、UI 已提交/设计 WIP、Swift 20/21、SWE 评分/完整环境错误、网站 History/hash 与有界旋转、统计不含 iOS。详细依据见[核对报告](docs/handoffs/melo-doc-reconciliation-20261015.md)。
- 验证：逐线程完成状态、本地路径/锚点/源码与关键日志，`git diff --check`、进度快照；本轮没有产品实现改动、模型请求或安装。
- 下一步：第 2 节所列用户手机授权、真实图片服务、实体文件/照片权限、手机独立 API 元数据采集与视觉/性能验收继续待验。

### 2026-10-15 — 设计 Melo — 核对图像默认值与满血条件
- 线程 ID：`01a1161a-1919-79c1-9764-8709bb0e2e2d`；状态：只读审计完成，记录 WIP；产品行为与用户配置未改。
- 实际接口：运行中 `/api/health` / `/api/bootstrap` 确认 `.tmp/melo-home-user`，引擎 `codex-oauth`、语言模型 `gpt-6.1-sol`；`src/images/imageSettings.js` / `desktop-ui/imageControls.js` 中 Sunburst 2.5 仅为 Images API 型号默认值，`codexImageEngine.js` 生图/编辑请求均不指定图像型号或质量。
- 跨端差异：`ios/Melo/ImageWorkflow.swift` 的 API 默认仍为 `gpt-image-2`；`CodexOAuth.swift` 同桌面采用裸 `image_generation`，服务决定型号。桌面与手机质量枚举均未接入 `xhigh/max`。
- 证据：`.tmp/image-default-audit-20261015/audit.json`（仅安全字段）；既有 `.tmp/mobile-image-edit-20261014/codex-recheck.json` 的编辑响应报告 `gpt-image-2-codex`，成图 `quality: low`。这是单次历史实测，不能推断所有请求或当前上游隐含映射。
- 官方核对：[Sunburst 型号页](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)、[图像工具参数](https://developers.openai.com/api/docs/guides/tools-image-generation) 支持明确选择 Sunburst 与 `xhigh/max`；公开 API 文档不等于 Codex 私有通道已支持。未发模型请求、未安装/更改设置；本轮不重跑产品 gate。
- 未完 / 下一步：若要保证 Sunburst 最高档，需分通道接入明确型号与 `quality: max`、同步手机，并验证账户能力及实际回执；当前不能标为“默认满血”。

### 2026-10-15 — Benchmark Melo on a major platform — 更新 GitHub 英文项目介绍
- 线程 ID：`01a139e9-2509-7623-8cb7-4df16b2d0c86`；状态：公开英文README已发布 `39cc759`（前序 `a303f49`）；About和12个主题标签已更新；此交接及短进度保留本地WIP。
- 行为：早期CLI、零依赖与旧记忆默认说明 → 个人AI执行工作区；说明macOS/iPhone职责、模型连接、内置ONNX记忆、工具授权、模块化架构和源码启动。按用户“英文就好，中文删掉”，删除README.zh-CN.md和切换链接。
- 文件/接口：`README.md` 与 GitHub `MortredVigoss/Melo` About/Topics；没有虚构官网/许可证/全集评分，也没有发布产品源码WIP。无手机或运行行为变更。
- 验证：文档相对链接、npm脚本名称、GitHub Markdown渲染与限定diff检查通过；远端README blob与本地相同，中文README返回404，简介/12标签回读一致。本地主线安全合并公开文档，前后45项其他WIP字节散列一致，此前未推送的5条产品/内部文档提交未随本次发布。未跑产品gate/安装或调用模型。
- 证据：`.tmp/github-profile-20261015/publication.json`、`remote-verification.json`；[公开英文README](https://github.com/MortredVigoss/Melo/blob/master/README.md)。重读共享文档后只补本线程内容，并运行 `npm run progress:codex`。
- 未完/下一步：公开介绍不替代真实账号、当前源码树和手机验收；Docker产品化、大样本评分及其他线程WIP仍按原交接推进。本轮未变更域名、仓库可见性、权限或发布包。

### 2026-10-15 — 设计 Melo — 五语界面系统
- 线程 ID：`01a1161a-1919-79c1-9764-8709bb0e2e2d`；状态：已本地提交 `2cae1cd`（质量前序 `fcb52d7`）；远端预审环境缺失，未推送。范围：中/英/韩/日/西班牙语；系统设置及左下快捷入口；手机同步接入。
- 已核对：当前没有语言层，`localSettings.js` 仅写固定中文；本机偏好由 `src/domain/settings/localPreferences.js` 校验，手机使用 UserDefaults。保留已有共享 WIP。
- 实现：`desktop-ui/i18n.js` / `translations.js` 显式静态词条、`languageControls.js` 左下入口，偏好 `interfaceLanguage`；手机同词条生成 `Localizable.xcstrings`、原生菜单及本机设置。用户文本与模型提示不翻译，保存失败保留原语言与草稿。
- 验证：语言浏览器及单元 7/7（五语、刷新保持、草稿、保存失败重试）；当前共享树 `npm test` 3496 JS + 23 Swift、语法/设置浏览器通过；独立 UI 370/370。实际桌面原生切换中→英→中与模拟器英文主页检查通过，修正手机按钮重叠。证据 `.tmp/language-20261015/`。
- 隔离提交树：367 UI、73 图像、21 Swift/共享渲染与模拟器构建通过；只提交本次语言变更，旧设计和其他线程 WIP 保留。入口 `docs/interface-languages-20261015.md`；未更改用户默认中文、手机账号或聊天资料。原生设置日语预览遇到模拟器既有凭据错误，菜单触控/其他子页与实体机仍待验。

### 2026-10-15 — melo主线 — 图片预览故障与承载计划

- 用户确认电脑端报错；原生点击复现，旧地址403/过期，原文件2,090,093字节存在，任务回看同文件重签200且SHA一致。当前仅调查/计划，未修产品实现。
- [方案](docs/image-capacity-plan-20261015.md)：P0访问恢复→资源盘点→原件可靠保存→缩略图/内存→磁盘缓存回收→大历史/排队→双端验收。已核对生成目录漏统计、预览文件生命周期、Base64/解码峰值与分散限额；尚未压测容量上限。
- 证据：`.tmp/image-capacity-audit-20261015/` 的签名状态、存储快照、源码散列；没有生成模型请求、清数据或安装。其他线程语言/质量/OAuth WIP保留。

### 2026-10-15 — 设计 Melo — 默认高质量与真实回执
- 状态：质量链路已本地提交 `fcb52d7`，界面与隔离暂存修正已进入 `2cae1cd`；用户明确要求生成质量改高。桌面默认/设置、生图和编辑链路及手机请求均传 `quality: high`；运行中用户 imageSettings 已只修改质量为 high，保留原引擎和账号。
- 文件：`src/images/imageSettings.js` / `codexImageEngine.js`、`src/services/chat/imageTask.js` / `imageEditFastPath.js`、`src/tools/builtins/imageTool.js`，桌面 `imageControls.js`、手机 `ImageWorkflow.swift` / `CodexOAuth.swift`。回执保留请求和实际质量，禁止把请求值当成服务结果。
- 验证：72 项图像协议测试通过；一次合成图真实请求确认工具参数 high、HTTP 200，但 Codex 服务回报 low。证据 `.tmp/language-20261015/quality-live.json` 与 PNG；未换付费通道、未自动重生成。
- 未完：上游没有按 high 执行，不能声称实际高质量已实现。当前桌面服务已重启加载并回读 high（PID 59032，`desktop-live.json`）；手机仅装独立模拟器，未覆盖实体机。`git pp` 因本机预审可执行文件缺失 ENOENT 停止，未推送或绕过。

### 2026-10-15 — melo iphone — 图片保存明确反馈并防止重复写入
- 线程 ID：`01a11116-8469-74a2-9815-8ce59b702afa`；状态：WIP，保留现有语言/图片/桌面共享改动，不混合提交。
- 行为：各入口局部忙碌且每次重复写入 → 全入口共用本机成功记录和进行中保护；首次成功绿色标记，重启保留，第二次询问“取消/再保存一份”。失败可重试，取消无写入，处理后新图独立。
- 接入：`ios/Melo/ImagePhotoSave.swift`、`ImageViews.swift`、`ios/Tests/ImagePhotoSaveTests.swift`、工程/测试脚本；新提示加入现有五语词条和生成资源。只申请照片添加权限，不读取实体相册、不改变模型或原图字节；桌面交互原则写入 `docs/mobile-desktop-alignment.md`。
- 验证：23 组 Swift、4 项 JS/共享资源、语言专项及 Debug 模拟器构建通过。专用模拟器实际照片 6→7，重复提示/取消仍 7，确认再存后 8；重启标记和长按入口共用确认已验。证据 `.tmp/ios-photo-save-20261015/`，专项 `docs/ios-photo-save-20261015.md`。
- 失败与修正：首次共享词条哈希校验失败，重生成 Scene 后通过；main-actor 默认参数警告修复。原生试版确认 popover 隐藏取消按钮，改为显式双按钮 alert 并重新编译/点击核对。
- 未完：未签名或覆盖实体手机，真机触感/相册待验；旧版历史保存无法追溯，系统分享不在本防重复范围。未发真实模型请求，未改手机权限/账号/已有聊天。后续安装核对完整共享树及版本，不把本次局部验收当发布 gate。

### 2026-10-15 — melo主线 — 项目边界与图片治理对齐

- 状态：用户提供项目审计后完成当前源码核对；[项目专项](docs/project-architecture-plan-20261015.md)为待实施计划，未改产品或迁移数据。
- 核对：后端 UI 选中值回退、无项目 APP_ROOT、上下文分流仍在；首页通常显式 null，新项目已有独立目录，共享同步协议已有 goal/agentOverrides；用户编辑与自动重建记忆的移动行为不同。
- 建议：项目配置统一解析，本机工作区/授权独立绑定，运行/审批捕获目标快照；无项目按需持久目录，原图走稳定资产引用。图片预览 P0 独立修，原件自动回收等生命周期规则稳定；详见两份计划的依赖顺序。
- 证据：`.tmp/project-architecture-audit-20261015/source-manifest.json` 的27份源码散列（HEAD 2cae1cd 加共享WIP）；验证为静态调用路径、文档链接与diff，未运行产品gate/原生操作或模型请求。保留全部其他线程WIP。

### 2026-10-15 — melo主线 — Agent 方案执行位置

- 用户已批准 Agent / 能力 / 协作 / 知识成果 P0–P4；开发在 `.tmp/agent-evolution-20261015/worktree`（分支 `codex/agent-evolution-20261015`），详细进度见该目录 `docs/agent-evolution-20261015.md`。当前原目录和运行应用未替换。
- P0 人设/保存/双端字段已接通，23 组 Swift、内置 Agent 浏览器保存/失败/Markdown 导入导出通过；正在去除带入共享 WIP 后验收待提交范围。现有图片预览 focus 断言在原树也失败，单独保留边界；P1–P4 未完成。

### 2026-10-15 — melo主线 — Agent P0 预审 C，等待修正方案确认

- P0 本地提交 `85500e3` 通过独立日常 gate 与模拟器构建，但 git pp 确认冷加载后的频道/语音旧表覆盖新值，另发现原生 Markdown 导出缺少落盘路径；评级 C / 高风险，推送被阻止，未部署。
- 已停止继续改代码，隔离复现并写成[修正方案](docs/agent-p0-review-remediation-20261015.md)。需按 CLAUDE.md §4 / EVALUATION.md 确认新方案后修 P0、重审，再继续 P1–P4；这些后续阶段仍未实现。

### 2026-10-15 — melo主线 — Agent P0 修正验证

- 用户答复“按修正方案继续”；已消除冷加载旧频道/语音表回写，用新提交数据发布缓存，并保留完整聊天检查点语义。
- Markdown 接原生保存桥；干净树定向 18/18、新进程红绿回归与浏览器成功/取消/失败通过，独立原生保存/取消与未保存草稿 UTF-8 字节一致性通过。原生导出首次暴露的缺失导入已修正。
- 详见[修正方案与证据](docs/agent-p0-review-remediation-20261015.md)；独立分支修正提交/重审进行中，未替换用户应用或迁移真实数据。P1–P4 等 P0 重审通过后继续。

### 2026-10-15 — 设计 Melo — 免费 MCP 默认启动
- 线程 ID：`01a1161a-1919-79c1-9764-8709bb0e2e2d`；状态：已本地提交 `f3dba1a`，当前桌面生效，未推送。用户明确授权无需额外支出的 MCP 默认启动、删除开机选择弹窗，覆盖旧版首启点击政策。
- 核对：旧弹窗只控制 AntV / Markdown2PDF / Mermaid；启动默认另含本地 Playwright。AntV 使用官方免费远程渲染，其余三个本机运行；Browserless 及自定义配置不自动扩展授权。当前真实用户配置四项原已开启，未改账号、图像质量或聊天数据。
- 实际文件：`src/config.js` 新默认及旧未答复标记迁移；`src/mcp/init.js` 保留启动接线并隔离测试外部进程；`desktop-ui/app.js` 删除弹窗和选择回调，旧 dispatcher 删除。后续手动关闭持久保留；角色授权与单次调用审批不变。
- 验证：新迁移及极简 PATH 冷进程回归先红后绿；MCP 63/63，浏览器启动/刷新/服务重启专项 1/1。原生真实启动发现 NVM Node 所在目录没进 PATH，四服务均未连接；已在 `src/mcp/client.js` 补本 Node 安装目录并保留显式服务 PATH。重启后四服务全部连接，Browserless 关闭，无启动弹窗；14 对话/1项目/6角色保留。
- 证据：`.tmp/mcp-startup-20261015/desktop-path-fixed.json`（PID 79771）及 red/green/browser 日志。共享树日常 JS 3493/3494，已有图片预览焦点断言失败，独立复跑同样失败（主线也已记录）；不改无关 WIP。隔离暂存树 `npm test` 通过：3485 JS / 1 项未复制打包模型而跳过、语法、设置/加速浏览器、21 Swift/共享渲染；179.6 秒。第二次原生冷启动 PID 86552 四项已连接，退出旧进程已清理。没有模型/生图/真实业务工具调用；详见 `docs/mcp-startup-20261015.md`。

### 2026-10-15 — melo主线 — Agent P0 第二次预审 C

- 首轮批准修正已提交 `99937f7` 并通过定向、干净日常与原生导出验收；第二次 git pp 仍阻止推送，原因是新发现的长人设跨版本同步回归，另有原生翻译覆盖缺口。
- 独立复现旧合法 30000+30000 合并为 60016，旧端拒绝整份 snapshot；远端分支仍为 `39cc759`，未部署或迁移用户数据。
- 已停止代码改写，待确认[第二次修正方案](docs/agent-p0-sync-compatibility-plan-20261015.md)：保持 v1 无损往返，不可表示的新文档明确待同步，其他数据继续；补齐原生词条。P1–P4 未实施。

### 2026-10-15 — melo主线 — 旧端兼容修正获批并实施

- 用户批准[旧端兼容方案](docs/agent-p0-sync-compatibility-plan-20261015.md)。第二次预审为 C / 中风险，未推送；当前修正保留 v1 四字段传输，内部单份人设不变，无法无损转换时保留全文并显示待同步，聊天继续同步。
- 当前实施分支已转到干净的 `.tmp/agent-evolution-20261015/p0-verification`；旧 `worktree` 停在 detached 99937f7，保留带入的其他线程 WIP，不再用于实施。
- 修正提交 c2b7f33：冻结旧服务的 HTTP 往返、桌面冷启动、待同步期间并发修改、Swift 长人设/UTF-16/项目覆盖通过。日常 gate 3505 JS / 21 Swift 组通过，英文 Agent / 图片入口模拟器点验通过；第三次预审待完成，不代表已发布。
- P1–P4 仍按原授权等待 P0 重审通过后继续；用户应用、账号、真实数据未替换。

### 2026-10-15 — melo主线 — 按需审查与能力约束实施
- 用户已要求自主完成 P1–P4，取消自动 git pp 及 C/D 重复确认流程；规则已同步 CLAUDE.md、AGENTS.md、EVALUATION.md。
- 第三次旧流程预审为 C，发现显式冲突选择被待同步人设挡住；正在实施恢复副本及明确选择优先，保留旧协议。未推送。
- 当前实现树为 `.tmp/agent-evolution-20261015/p0-verification`，分支 `codex/agent-evolution-20261015`；P1 能力模块/迁移预览/执行约束已写入，正在回归；P2–P4 继续实施。共享产品源文件与用户安装包尚未替换。

### 2026-10-15 — P2 知识与成果
自动代码块改为成果，历史迁移要求标题、来源对话、助手代码正文和语言匹配；人工代码资料不按格式误迁移。知识选择与上下文排除成果，长资料预算截取并提示，原文保留。定向 10/10 与 21 Swift 组通过；尚未替换用户应用。

### 2026-10-15 — Agent P3 / P4 接入（melo主线）
- 配置 Agent 的委派/团队已接顺序、并行、复核循环；成员用自身人设与模型，能力与上级取交集。结构化交接、逐成员用量、超时/预算/取消、同工作区写成员排队，任务及聊天均可启动。旧 agent 名称保留兼容别名。
- 知识统一使用本机分段索引（SQLite FTS + 可用的本地 embedding）；按对话选用资料过滤，修订更新与删除清理；目录索引仍需原文件授权，按 home/对话/工作区隔离，不自动导入知识或上传。向量计算有两秒等待预算，失败回退全文检索。
- 手机仍可编辑人设；能力定义通过可选 `/v1/agent-settings` 通道同步并只读展示，执行记录展示结构化交接。旧 v1 人设协议不改；旧同步服务返回 404 时，能力设置留在本机待同步，聊天同步照常完成。新增通道有共享 schema、冲突版本/显式选择，凭证、文件授权不进入同步。
- P3 核心 29/29、现有回归 33/33，P4 索引/同步 5/5，工具/委派/依赖 42/42；iOS 模拟器构建成功。完整日常 gate 和共享树集成在进行，不能据此称真机或真实账号协作已验收。用户授权直接迁移现有 Agent；实际迁移回执后补。

### 2026-10-15 — 实际 Agent / 成果迁移回执
- 主线已停止旧应用/后端，取得真实 `.tmp/melo-home-user` 独占锁；6 个 Agent 已迁移，26 条旧自动片段转为成果，14 段对话保留。重新启动进程冷读确认 6/26/14；人设、频道和语音与迁移备份逐项一致。19 条成果可匹配原助手代码，7 条源对话已删除，按用户指定的 26 条清单保留并标记迁移证据。
- 完整备份与迁移清单位于 `desktop/backups/agent-capabilities-1792042864153-c3c9e7bc-418f-453a-bd06-612ffe6c4e1c/`。没有删除用户资料；知识集合现为空，成果可以在成果页查看。
- 共享源码保留原有 MCP 启动、图片/文件权限、阅读密度与执行摘要 WIP；仅解决本阶段合并冲突。原共享文件备份在 `.tmp/agent-evolution-20261015/shared-before-integration/`。
- 最新本地功能提交：`cf8128c`（P3/P4）、`908c74a`（checkpoint 迁移/媒体输出权限）、`4704985`（独立同步服务协议）、`ca1803a`（验收适配/手机翻译）。未运行新的 git pp、未推送。
- 合并后的 iOS 模拟器编译通过，Melo-Agent-QA-20261015 原生界面核对 Agent 页面、只读详情及“能力设置尚未从电脑同步”的真实状态。首次启动出现模拟器后台凭证准备提示，关闭后可浏览；未登录真实账号、不代表真机同步验收。

### Agent 最终集成验收（2026-10-15）
完整 `npm run test:full` 为 GREEN：3536/3536 JS、23 Swift 组、语法、设置/快速浏览器、桌面打包安装、Desktop 与 Launchpad 启动、桌面流程、运行时浏览器、人设契约全部通过。日志 `/tmp/melo-agent-integrated-full3.log`。随后加强取消后的写锁排空：即使执行器已返回取消，底层工具未结束也不释放工作区；41/41 协作/取消/子 Agent/技能/依赖回归通过（`/tmp/melo-writer-drain.log`），16/16 状态/能力回归见 `/tmp/melo-integrated-post-migration-regression.log`。
实际数据迁移已完成，不再等待批准或 git pp。手机可选能力同步的服务代码已交付，尚未部署用户远端同步服务或验证实体手机；不把模拟器/HTTP 夹具称为真机或真实模型团队验收。

### 2026-10-15 — 用户授权直接推送与兼容性介绍
- 用户明确要求 git push，不运行 git pp 或额外 Codex 审计；发布范围为已提交主线与本线程 Agent P0–P4，保留其他线程未提交 WIP。
- 英文 README 增加模型/接口/MCP 兼容表，Claude 作为支持服务正常介绍；同时写清能力按端点/账号而异、旧版同步服务继续同步聊天、新能力同步需升级私人服务。GitHub About 已采用相同中性定位。
- 推送前在干净实施树合并当前 master，仅文档追加位置发生冲突，双方记录均保留；源码合并后运行日常回归。本轮未替换用户安装包或再次迁移数据。
- 本轮日常检查 GREEN：3528/3528 JS、21 Swift 组、824 文件语法及两组浏览器检查；112.9 秒，`/tmp/melo-agent-push-daily-20261015.log`。完整安装 gate 沿用上轮集成证据，不标成本轮重跑。

### 2026-10-15 — melo iphone — 对齐与装机前回归
- 用户授权对齐及覆盖。已读主线/设计/UI 最新交接并核对源码，按 `docs/ios-align-install-20261015.md` 顺序执行；10-14 build23 缺完整源码快照，差异参考 10-13 基线，不冒充全是本次新增。
- 新增手机成果分类/详情、独立请求 API 白名单回执与旧同步回声保留；项目生成保留版本。Agent/五语/阅读与神经资源、图片保存和文件权限的现有 WIP 一并验证。
- 本轮 23 Swift、80 同步、22 UI/资源/语言契约通过，模拟器编译通过；实体仍为 0.5.17 (23)，已完成聊天/配置/执行/图片备份，EditDrafts 空目录单独核对。签名、覆盖及原生画面检查进行中。
- API 新回执先存手机本机，不扩展冻结 v1 线协议；桌面协作只读、私人服务升级和真实模型/长后台验收边界保留。证据 `.tmp/ios-align-install-20261015/`。

### 2026-10-15 — melo iphone — 0.5.18 (24) 已覆盖并启动
- 上述装机前阶段完成：个人签名/同 bundle 和 team 覆盖、启动 PID 26056、实际版本回读及 Device Hub 真机神经首页均已核对；ChatGPT 登录标识、9 对话/5 Agent 保留。
- 聊天/偏好/草稿/UserDefaults/三张原图与索引逐字节一致；执行记录 JSON 内容一致。源代码/API/成果差异、平台依赖、安装及模拟器证据详见 `docs/ios-align-install-20261015.md`；下轮源码基线 `.tmp/ios-align-install-20261015/after/`。
- 独立 API/版本生成修正提交 `2afe9dd`；成果与翻译依赖共享 Agent WIP，未顺手提交他线程实现；未运行 git pp 或推送。旧偶发退出、长期后台、真实模型和实体文件/照片授权未在本轮宣布修复或完成。

## UI Logo 探索交接（2026-10-15）

- 用户明确选择第 3 张 B「黑冰星窗」：圆润厚玻璃 M、黑金星空；神经网络 Logo 已舍弃，应用内神经场景继续保留。
- 母版：`assets/brand/melo-black-ice-master.png`（1254×1254，内置 image_gen 从已选 B 编辑）；提示词、方案与实施边界在 [Logo 交接](docs/design/logo-cosmic-20261015/IMPLEMENTATION.md)。五方案提交 `4f4048b`，本轮为正式资源与共用导出改动。
- 实际入口：`scripts/render-app-icons.mjs` 统一生成 macOS ICNS/iconset/预览与 iOS 120/180/1024 PNG；两个旧 Swift 入口转发，避免重新生成旧 Logo。iOS 保持不透明正方形，Mac 应用平台圆角和透明边距；SVG 为同图嵌入兼容文件，非手绘矢量。
- 已验证：17 个导出文件散列、13 个 PNG 尺寸/alpha；两个 Swift 入口；64px 实看。桌面构建与签名通过，包内 ICNS SHA 一致；iOS 模拟器构建通过，三个包内 PNG 解码后的像素完全一致。最初字节比较因 Apple CgBI 优化不同，已改为解码比较，并非图像损坏。
- 证据：`.tmp/logo-icons-20261015/{export-verification,bundle-verification}.json` 与双端构建日志。基于当前共享源码构建，不将图标专项称为全库功能回归。
- 电脑补安装：用户反馈电脑未变化后，确认 `/Users/mortred/Applications/Melo.app` 仍含旧 ICNS；基于已安装包只替换图标并重签名，去签名后的可执行字节一致，旧包保存在 `.tmp/logo-desktop-install-20261015/previous.bundle`。桌面快捷方式仍指向主安装包；Finder 列表/简介实际显示 B 图标。
- 本轮边界：签名/ICNS 散列通过，42 项配置/聊天/Agent 文件散列未变；退出后 `desktop/state.json` 散列改变，不宣称该文件逐字节一致。用户已手动允许重签名触发的 macOS 桌面目录授权；健康接口正常，点击原生“重新打开”后进入工作空间，UI 与存储均确认 14 对话/1 项目/6 Agent，运行 home 保持原路径。
- 本轮证据：`.tmp/logo-desktop-install-20261015/installation-verification.json` 与 `server-sample.txt`，Finder 实看在本线程工具回执。本轮电脑图标安装与启动验收完成；未覆盖安装手机，未跑产品全库 gate。下一步手机正常安装时验证相同母版图标。

### 2026-10-15 — melo主线 — Agent 审查修正完成集成
- 审查中的发布/迁移状态已过期：远端 master=`5b2d9f7`，真实迁移已完成。本轮确认同步越权等源码问题后修正，未运行 git pp 或推送。
- 修正范围及逐项依据见 [审查修正](docs/agent-review-fixes-20261015.md)：远端加权待桌面确认、全局权限上限、团队迁移预检、回复预算、只读知识检索、围栏解析及复核循环；保留用户拥有的内置人设。
- 隔离实现 `51882bd` / `f4546c5` 已整合共享源码，保留其他线程顶栏删除、手机新增测试及生成资源。共享树 `npm test` GREEN：3554 JS、834 文件语法、两组浏览器、23 Swift / 共享渲染，181.3 秒；证据 `/tmp/melo-agent-audit-shared-daily.log`。
- 本地修正提交 `4680530`；后端已重启到该版本（PID 71003），原生窗口正常、确认接口拒绝无来源请求。14 聊天 / 6 Agent / 26 成果 / 1 项目保留；42 个配置/正文/Agent 文件散列一致，主状态仅频道轮询时间及修订变化。证据 `.tmp/agent-review-fixes-20261015/runtime-restart/{before,after}.json`。本轮未做完整发布 gate、真机重新安装或真实模型协作。

### 2026-10-15 — Claude 架构复审 — 加固实施说明（待实施）
- 复审结论：状态常驻、派生索引离开提交路径、循环依赖清零、声明式路由、协议单一来源、测试自动发现均已落地；剩余重点是前端单体整页重建、项目 R1 未实施。（2026-10-17 核对：Agent 能力已改为环境作用域、缺失即拒，`src/tools/executor.js`；前端已是键控 morph，但补救层仍在，见 `docs/architecture-agent-context-audit-20261017.md` A-9。）
- 用户批准先做两项，见[实施说明](docs/arch-hardening-20261015.md)：A 执行器从请求上下文自行解析能力作用域（只可收窄、无法解析即拒绝）；B 项目 R1（创建不读 UI 选中、空字段不造文案、无项目不回退 APP_ROOT/process.cwd，按需聊天独立目录）。仅文档，未改代码。

### 2026-10-15 — melo主线 — 架构加固 A 完成，B 继续
- 用户已批准 `docs/arch-hardening-20261015.md`；实施在现有隔离树 `codex/arch-hardening-20261015`，共享运行源码尚未替换。
- A 在 turnLedger 事务捕获冻结能力，执行器自行解析且仅允许收窄；委派/技能/团队与原生能力共用上下文，未知身份拒绝，旧版使用显式 legacy。
- 新验收先红（3 失败 / 1 通过）后绿；69 项专项、11 项作用域/真实 HTTP 验收，日常 3553 JS / 21 Swift / 831 语法及浏览器通过（144.3 秒）。首次日常遇到旧 Markdown 测试固定事件循环等待的时序误报，改为等待现有完成 Promise 后全绿。日志 `/tmp/melo-hardening-a-{red2,acceptance,focused,daily2}.log`。
- B 将按需创建聊天目录，旧程序目录需用户明确确认；不迁移真实数据，不运行 git pp 或推送。

### 2026-10-15 — melo主线 — 架构加固 B 实现与边界验证
- B 明确创建归属；任务/审批从显式聊天继承，执行载荷同样绑定。项目对话单请求；旧占位文本仅在显示/prompt 隐藏，不改旧记录。
- turnLedger 冻结工作区；首次文件操作分配 `workspaces/chats/<id>` 并写入聊天 manifest，0700、冷进程重读与真实 pwd/file_write 验证。旧程序目录须在项目设置明确勾选确认，确认绑定 canonical 路径及设备/inode。
- 文件、bash、图片、PDF/XLSX 不再回退 cwd。安全例外仅覆盖当前已验证的生成目录内容，配置、目录根、兄弟聊天及逃逸链接仍受保护；既有权限继续匹配工作区。
- 主要入口：`projectMembership.js`、`toolWorkspace.js`、`workspacePolicy.js`、`executor.js`、`chatManifest.js` 与项目界面。先红 5 项；浏览器/安全 34 项、冷启动/PDF 边界 69 项通过。日常 JS 3563/3563、837 文件语法、两组浏览器及 21 Swift 全部通过（143.1 秒）；共享整合待完成。日志 `/tmp/melo-hardening-b-{red,acceptance3,boundary-final2,daily3}.log`。
- 本轮不迁移真实数据，不自动确认程序目录；未运行 git pp 或推送。

### 2026-10-15 — melo主线 — 架构加固 A/B 已整合验收
- 当前状态：本地 master 的 A=`33660c6`、B=`b02438a`；前述“待实施/继续整合”均为阶段交接，已由本条完成。逐项验收、源文件入口、行为与边界见 [架构实施回执](docs/arch-hardening-20261015.md#当前整合状态)。
- 共享日常 GREEN：3572 JS / 844 语法 / 两组浏览器 / 23 Swift，150.4 秒；依赖图 388 模块、0 环。隔离真实命令、文件写入、冷进程重读、项目默认目录写入、拦截计数与浏览器确认通过。首轮共享夹具沿用被删顶栏按钮，改为现有快捷键后通过，保留他线程界面。
- 共享其他 WIP 保留；三方整合备份与测试日志在 `.tmp/arch-hardening-20261015/`。源代码已本地提交，未 git pp/推送；真实数据不迁移、不删除、不代确认旧程序目录。
- 当前应用未运行，本轮未重装/重启；14 聊天 / 6 Agent / 26 成果 / 1 项目只读核对，0 运行中聊天。下一步可按文档逐项复核；真实模型、实体手机与完整安装 gate 属于后续发布验证。

### 2026-10-15 — melo主线 — 用户要求直接推送已完成
- 按用户本轮“git push”执行 `git push origin master`，远端接受 `5b2d9f7..1553314`，包含架构 A/B 与验收文档。未运行 git pp。
- 推送仅包含已提交内容；共享树现有 WIP 保留，应用及真实数据未变动。本条为本地推送回执，未新增代码或重复测试。

## UI Logo 简化方向（2026-10-16）

- 用户最新反馈：B 黑冰星空仍太复杂，改成普通低饱和黑金；最新设计要求覆盖此前星空/厚玻璃方向，仅限品牌 Logo。
- 本轮交付：[简洁 M 设计稿、完整提示词与验证边界](docs/design/logo-muted-20261016/README.md)，内置 image_gen 编辑并复制实际 PNG 入项目；炭黑背景、香槟金几何 M，视觉核对无星空/神经纹理/厚玻璃。
- 10-16 用户确认“去换了吧”：`assets/brand/melo-muted-gold-master.png` 作为正式母版，共用导出器与两端资源已更新；17 个资源散列、PNG 尺寸/alpha 和小尺寸视觉通过。
- 电脑已覆盖图标并重签名：基于当前安装包，只变更图标及签名，去签名后的可执行文件字节一致；桌面快捷方式继续指向 `/Users/mortred/Applications/Melo.app`。Finder 列表/简介实际显示低饱和黑金 M。
- 运行验收：健康接口正常；启动页一度等待超时，点击原生“重新打开”后进入同一 home。14 对话/1 项目/6 Agent 保留；42 项配置/聊天/Agent 文件逐字节一致，主状态文件仅活动页、渠道轮询时间与修订号变化。
- 证据：`.tmp/logo-muted-install-20261016/{export-verification,installation-verification}.json`；旧包为同目录 `previous.bundle`，Finder 与原生 UI 实看在本线程回执。仅图标专项，无完整功能 gate；手机 PNG 资源已同步，未覆盖安装实体手机。

### 2026-10-16 — 设计 Melo — Agent 设置统一完成
- 用户要求清除 Sharp/Warm 等情绪残留、补齐新增 Agent、消除旧版设置样式。确认新增按钮被神经布局隐藏，两套旧编辑器并存；本轮统一为一个编辑页与页头新增入口。
- 实际入口 `desktop-ui/app.js` / `agentSettings.css`、`agentMutations.js`、双端 Agent prompt；存量 mood 字段保留兼容、停止注入，不改用户人设和账号数据。功能与范围见 [Agent 设置交接](docs/agent-settings-20261016.md)。
- 已修复渠道切换后另一侧草稿未提交；全局新建、双击防重、失败重试、权限保留、五语及三种宽度验收通过。共享日常 GREEN：3573 JS、845 语法、两组浏览器、23 Swift，175.9 秒；日志/截图 `.tmp/agent-settings-20261015/`。
- 实际桌面重启 PID 61208，新入口及清理后的 UI 已原生核对；14 聊天/6 Agent/1 项目保留，42 个配置/正文文件散列不变，主状态只发生设置/修订/频道绑定变化。独立暂存树补验 27 JS / 21 Swift 通过，源码本地提交 `dc67fa0`，未推送；未重新安装手机，未做真实远端模型或渠道调用。

### 2026-10-16 — melo主线 — Telegram 归档实施（本地提交 `538f745`）
- 用户决定暂时归档 Telegram；按 [实施记录](docs/telegram-archive-20261016.md) 停用轮询、连接测试、外发、提醒重试及设置入口，保留配置/历史/源实现。Discord 和共用语音设置仍可用。
- 在 `codex/telegram-archive-20261016` 实施，已合入统一 Agent 设置提交 `7bb8180`，保留他线程 WIP。后端专项 13 项、真实 HTTP 与浏览器归档验收通过；日志 `/tmp/melo-telegram-archive-focused2.log`、`/tmp/melo-telegram-archive-browser3.log`。
- 源码已整合共享树，日常 GREEN：3575 JS、848 文件语法、两组浏览器、23 Swift，168.4 秒；日志 `/tmp/melo-telegram-archive-daily2.log`。首次回归暴露旧 Telegram prompt 断言及新增语言资源未生成，均已修正。未运行 git pp 或推送。
- 实际应用已重启，健康接口 PID 87776、原生首页正常；6 个 Agent 均显示频道归档，无 Telegram 轮询锁。清理了已退出 PID 61208 留下的旧锁。14 聊天 / 6 Agent / 26 成果 / 1 项目保留，42 个配置与正文文件散列一致，频道配置一致；证据 `.tmp/telegram-archive-20261016/runtime/{before,after}.json`。本轮不重新安装手机、不测试真实 Bot 外发。

### 2026-10-16 — melo iphone — 对齐计划与基线
- 已核对主线/设计/UI 实际 diff，基线 `.tmp/ios-align-install-20261016/`；计划见 [本轮对齐](docs/ios-align-install-20261016.md)。发现手机 Mood 控件、项目默认占位提示及创建校验需补齐；其余主线执行器加固为桌面职责。
- UI 总览的“仍为设计稿”已过期：定向读最新 melo ui 回执确认用户已要求替换，当前正式资源为低饱和黑金 M；本轮手机一起带入。尚未测试/构建/覆盖安装。
### 2026-10-16 — melo主线 — 用户要求 git push 已完成
- 已执行 `git push origin master`，远端接受 `1553314..04a13c5` 共 6 个提交，包含 Telegram 归档、统一 Agent 设置与简洁黑金图标；`git ls-remote` 核对远端 master=`04a13c57aeb6e8b2d3bb9e96c5b3d6f900c0d315`，与本地 HEAD 一致。
- 未运行 git pp，未把共享树未提交改动纳入推送，未重启应用或修改真实数据；不重复产品测试。本条为本地推送回执，其他线程继续保留现有 WIP。

### 2026-10-16 — melo iphone — 原生差距修正与构建
- 已补 Agent 首屏新建、去除旧语气 UI/冲突摘要、项目显式归属验证与旧占位隐藏；实际文件及测试见 [本轮记录](docs/ios-align-install-20261016.md)。共享 WIP 保留。
- Debug/签名 Release 初版通过，模拟器 Agent 编辑/保存已查看，私有备份完成；当前整库日常有桌面超时，定向排查中，尚未覆盖手机。真实模型/远端能力服务/长后台仍独立待验。

### 2026-10-16 — melo iphone — 0.5.19 (25) 覆盖完成
- Agent/项目/图标对齐独立提交 `5c975aa`，共享 WIP 保留；功能、实际文件和边界见 [安装回执](docs/ios-align-install-20261016.md)。按本次当前源码构建，不以历史测试代替验收。
- 日常最终 GREEN：3575 JS、848 语法、两组浏览器、23 Swift；90 项专项与模拟器实际交互/神经首页/任务空间通过。前两轮计时失败已定向和完整复跑通过，原日志保留，无放宽阈值。
- Mortred (3) 已覆盖 0.5.19 (25)、启动 PID 27434；9 聊天/5 Agent/3 图片及配置保留，草稿/执行记录 JSON 相同。实体 UI 查看时用户已在其他 App，未再次打断，未称实体画面验收。
- 本机基线 `.tmp/ios-align-install-20261016/after`；IPA 与 build.json 在 `ios/dist`。真实模型、远端能力服务、实体权限和长后台仍待专项；桌面执行工具/协作并未移植到手机。

### 2026-10-16 — melo iphone — 自然图片请求与连续缩放
- 用户要求移除手机“生图/图片模式”、修复首次没有执行图片请求、双端自然缩放，并适当扩大桌面对话区；不更改账号、原图或保存防重复机制。
- 只读实体数据确认 10-15 14:22Z 的对比度/颜色调整请求被持久化为 analyze，14:23Z 后续请求才为 edit；非根据猜测归因网络。隐私数据仅留本机私有备份，公开证据只存分类结果。
- 计划顺序：1）自然图片意图及双端回归；2）移除手动模式，保留附件/连接设置；3）手机系统原生弹性缩放和桌面连续缩放；4）扩大桌面对话区；5）针对性测试、模拟器构建与界面核对。
- 本轮基线：`.tmp/image-ux-20261016/before/`，共享 WIP 保留。已实现自然修图/做图分流及移除模式，手机 `ImageZoomView.swift` 使用 UIScrollView，桌面 `imageZoom.js` 连续缩放/拖动/弹性上限；对话最大阅读宽 860→980，内部边距缩小。
- 验证完成：3600 JS/23 Swift 日常 gate、160 图片专项、2 浏览器测试、Debug 模拟器构建及原生首条修图/缩放集成夹具通过。模拟器双击/拖动/复位已实查；修正预览层长按菜单拦截平移。详情和边界见 [`docs/image-ux-20261016.md`](docs/image-ux-20261016.md)。
- 本轮代码已本地提交 `20c00bb`；已有未跟踪的桌面预览整合继续保留共享 WIP，不混合提交。未覆盖实体手机、未重启桌面应用、未发真实生成请求；手机当前安装仍为 0.5.19 (25)，真机双指触感待新版安装后验证。

### 2026-10-16 — melo UI 功能对齐 — 文件生命周期（实施中）
- 用户决定删除聊天时每次询问是否同时删文件。方案与范围见 [UI 功能对齐](docs/ui-function-alignment-20261016.md)。隔离分支 `codex/ui-function-alignment-20261016`，尚未合入共享树。
- 新增 `workspace/chatWorkspaceFiles.js`：只处理 Melo 分配的聊天目录，移动项目后仍保留原目录的归属；手机 tombstone 留下待确认记录，历史孤立目录可发现。`bootstrap/workspaceSnapshot` 跟随聊天；桌面普通聊天提供文件入口，删除弹窗与系统状态提供文件去留入口。
- 隔离目录验证：工作区/状态已有 13 项、新增生命周期 5 项通过，覆盖无目录不创建、拒绝未确认/旧确认、保留后删除、活动聊天/目录替换/符号链接、历史孤立目录。尚未完成浏览器、五语、整库 gate，不代表真实数据/安装验收。
- 下一步：浏览器确认交互，白名单与能力开关、管理入口及路由核对；保留共享 WIP，不自动 git pp/推送。

### 2026-10-16 — melo UI 功能对齐 — 配置与入口验证
- 能力白名单改为名称多选，未知已存 ID 保留并标示不可用；旧版待迁移标记及展开区可见。本地文件/命令全局连接器开关退场，Agent 能力控制自动上下文，用户仍能查看成果。
- `managementActions.js`/`advancedPage.js` 补外部连接器 CRUD/资源/提示词/工具、MCP 保存配置重连、按聊天撤销临时授权、技能导入/写盘/重载/扫描。实际核对 `/api/tasks/run*` 进入统一聊天执行器，继续保留；三个直接写文件/命令 HTTP 入口返回 410，冒烟改走审批。
- 文件/审批/能力/页面专项 92 项通过；Agent 编辑与能力同步安全浏览器通过，文件生命周期与连接器 CRUD/实际 loopback 调用通过。后续整合用例发现自定义技能选择被旧校验退回内置，已修正并继续复测。所有浏览器网络仅本机夹具。
- 增补聊天切换统一项目选中、目录别名、写入符号链接边界及运行中审批阻止聊天删除；最终共享树日常 gate 待完成。未安装、未动真实文件/授权、未推送。

### 2026-10-16 — melo UI 功能对齐 — 技能目录隔离补正
- 整库暴露 `skillsDisk.js` 硬编码旧全局目录；首次写盘测试的唯一 `ui-fixture-skill/SKILL.md` 已验证内容后移回隔离证据区，未修改已有技能。现按请求 home 捕获 `desktop/skills`，两个 home 并发读写删隔离、旧状态技能保留已补回归。
- 本机浏览器完整管理流程已通过，包含真实落盘路径断言；技能读写不再回落全局旧目录。细节与失败/修复证据见 [实施说明](docs/ui-function-alignment-20261016.md)。最终日常检查中，未合并、安装、审查或推送。

### 2026-10-16 — melo UI 功能对齐 — 隔离验收完成
- 四组实现完成，日常 GREEN：3604 JS / 21 Swift、语法及浏览器，182.6 秒。实际文件、API、专项、失败修正与边界见 [实施回执](docs/ui-function-alignment-20261016.md#隔离树最终验收)。
- 文件浏览与每次删除选择框截图已实看；真实 HTTP 夹具覆盖保留/清理/取消、外部连接器操作、技能落盘与单聊天授权撤销。正在保留共享 WIP 整合，尚未重启安装、git pp 或推送。

### 2026-10-16 — melo主线 — UI 功能对齐已合入
- 实现本地提交 `7ae2292`，隔离实施 `ecd9ce9`；暂存树与隔离验证树一致，其他线程的阅读/图片预览/执行摘要/手机文件 WIP 保留。历史“待整合”阶段由本条完成。
- 电脑每次删聊天询问文件去留；文件面板跟随聊天，可预览/打开 Finder。手机同步删除保留本机文件，在存储管理待处理；项目目录不会被聊天删除连带清理。能力白名单、迁移标记和连接器/MCP/会话授权/技能管理同步完成。
- 共享 `npm test` GREEN：3613 JS、859 文件语法、设置/快速浏览器、23 Swift，113.3 秒。日志 `/tmp/melo-ui-alignment-shared-daily.log`；三方备份、截图和 `verification.json` 在 `.tmp/ui-function-alignment-20261016/`。实现与失败修复详见 [回执](docs/ui-function-alignment-20261016.md#共享整合回执)。
- 尚未重启或覆盖安装应用，未 git pp/推送；真实模型、远端连接器/MCP、原生 Finder、手机文件去留界面与完整发布 gate 不在本轮验收内。

### 2026-10-16 — Claude — iPhone 系统数据工具（分支待整合）
- 用户要求手机端接入苹果系统数据。分支 `claude/ios-device-tools-20261016` 本地提交 `8165a3c`（基于 `411cb42`，工作树 `.tmp/ios-device-tools-20261016`），未合入共享源码，未推送。
- Codex 对话可调用日历、提醒、通讯录、当前位置。默认全关，按类型在设置里开启，只存本机不进同步；读取直接执行，每次写入弹窗确认。API 连接与图片生成不提供手机工具。
- 验证：新 `DeviceToolsTests` 已接入 iOS gate 并做过变红验证；Codex 假服务器两轮往返和轮数上限；模拟器真实 EventKit/通讯录/定位自检通过；工作树 `npm test` GREEN（3603 JS、22 Swift）。写入确认弹窗未在真实对话里实看，未真机安装。详见该分支 `docs/ios-device-data-20261016.md`。
- 整合注意：工程文件新增 4 个文件条目；ContentView、SettingsView、ChatStore 各只有一处挂接，和本树未提交的 iOS WIP 合并时核对这几处。

### 2026-10-16 — melo iphone — Claude 系统数据整合与安装计划
- 用户要求检查 Claude 改动、写 MD、覆盖安装及 git push。核对 `8165a3c` 相对 `411cb42` 的 18 个文件；当前共享 WIP 55 项完整保留，基线 `.tmp/claude-device-review-20261016/`。
- 顺序：审读及修正结果截断/授权撤回/记录隐私 → 分支整合及回归 → 签名构建 → 私有备份及覆盖启动/数据比对 → 文档和已确认提交推送。不执行 git pp。
- 已修正截断 JSON、权限撤回/取消、定位摘要留存、确认备注及本地查询被强制联网五项。当前树 3613 JS/24 Swift/859 语法/浏览器日常 GREEN；Debug、确认弹窗允许/拒绝与模拟器系统 API 通过。详情见 [复核记录](docs/ios-device-data-20261016.md)。最终签名/覆盖及推送进行中。

### 2026-10-16 — melo iphone — Claude 复核、0.5.20 覆盖与推送完成
- 已审读并整合 `8165a3c`，修正五项边界；代码提交 `2e47868`。功能/文件、测试、WIP 范围及安装证据见 [完整回执](docs/ios-device-data-20261016.md#最终覆盖与推送回执)。
- 当前树日常 3613 JS / 24 Swift / 859 语法及浏览器通过；模拟器系统 API、实际确认弹窗允许/拒绝通过。最终签名 Release 成功，实体 0.5.20 (26) 已覆盖并启动 PID 28681。
- 10 聊天/6 Agent/5 图片及账号、草稿完整保留；执行记录语义一致，其余仅运行日志变化。默认手机数据权限全关，未替用户启用，真实模型/实体数据工具/双指触感/长后台仍独立待验。
- 已推送源代码 `04a13c5..2e47868`，本回执随文档提交继续推送；其他线程 WIP 保留。仅操作本线程模拟器并已关闭，未重启桌面。证据 `.tmp/claude-device-review-20261016/`。

### 2026-10-16 — Claude — 双端整合（分支 `claude/cross-platform-unify-20261016`，待整合到主树）

- 能力按执行设备生效：电脑 Agent 能力只管电脑；手机按 Agent 单独授权联网、图片和手机数据（本机保存、不同步，协议不变）。旧的设备级手机数据只迁给默认 Agent。`5f2effd`
- 共享契约 `shared/protocol/contracts.json` 同时驱动 JS 与 Swift 测试（链接提取、来源键、工具回传）；修正手机来源键与桌面编码不一致。`997ca68`
- 兼容层收口：删两个转发文件与依赖检查豁免；迁移脚本报告改存备份目录。本机 `state.json` 中已有的迁移报告未动，需用户同意再瘦身。计划与边界见 [双端整合](docs/cross-platform-unify-20261016.md)。
- 验证：日常 `npm test` 与 23 个 Swift 套件通过；模拟器看过 Agent 页本机权限。未验证：真实登录下的手机审批弹窗、实体机。下一步：ChatStore 拆分、同步通道表、app.js 拆分。

### 2026-10-16 — melo主线 — Claude 双端整合复核
- 用户要求检查 Claude 改动。实际主线已含 `aa4ae43` / `c4c977b` / `ee79b3c` / `30d95b4`，上方“分支待整合”阶段记录已过期；本轮按这四个提交审读，保留所有共享暂存/WIP。
- 发现 P1：首次权限加载会将刚开启的设备数据误当旧数据，自动授给 Melo；FakeSource 复现未单独授权却读取 1 次。P2：全局关掉后 Agent 开关整项禁用，无法撤销旧授权。位置、复现和建议见 [完整复核](docs/claude-cross-platform-review-20261016.md)。
- JS 专项 13/13、25 Swift 组与共用渲染通过；当前测试未覆盖上述两边界。证据 `.tmp/claude-cross-platform-review-20261016/`。只新增审查文档/交接 WIP，未改产品代码/真实数据/现有暂存内容，未 git pp、安装或推送；下一步修复两项并做原生权限界面验收。

### 2026-10-16 — melo主线 — 手机权限修正与交付计划
- 用户批准修完 P1/P2、合并、同步手机并 git push。四项 Claude 提交已在主线，按 [交付计划](docs/phone-permission-fix-20261016.md) 修正首次迁移和撤销入口，补计数/原生 UI 回归，再构建同包覆盖手机并核对数据，最后推送。
- 基线 `30d95b4`；已有暂存/共享 WIP 已备份，三线程最新实现与 0.5.20 安装基线继续核对。未改变真实权限、未安装或推送；不运行 git pp，不重启桌面。

### 2026-10-16 — melo主线 — 手机权限修正验证通过
- `PhoneAgentPermissions.load` 改为纯读取，`MeloApp.init` 在设置可操作前一次迁移；Agent 开关在设备关闭时允许已有授权撤回。文件/回归和边界见 [交付记录](docs/phone-permission-fix-20261016.md)。
- 新回归旧代码先失败；修正版 25 Swift 组、共享日常 gate、Debug 模拟器和签名 Release 通过。模拟器实际点击日历授权从开到关，关闭后禁止新授予，落盘确认不含日历。
- 仍为本轮 WIP；实体覆盖和数据比对即将进行。没有启用真实手机权限，没有运行 git pp。

### 2026-10-16 — melo主线 — 手机权限修正已覆盖 0.5.21
- 两项权限修正通过日常 3616 JS / 857 语法 / 4 浏览器 / 25 Swift，Debug/签名 Release、模拟器真实撤销与冷启动落盘通过。实际文件、证据与边界见 [交付回执](docs/phone-permission-fix-20261016.md)。
- 实体同包更新 0.5.21 (27)，启动 PID 29156；已实看神经首页、登录标记、10 对话/6 Agent。私有比较确认 10 聊天/6 Agent/5 图片和原配置保留，执行记录语义不变；仅新增权限迁移记录及正常运行日志。
- 旧版设备授权只继承给默认 Melo，未替其他 Agent 开启权限；真实模型/实体数据调用/远端同步/长后台仍为独立验证边界。保留原安装基线和共享 WIP，正在仅提交本轮片段并推送；未 git pp。

### 2026-10-16 — melo主线 — 权限修正与 Claude 主线已推送
- 本轮修正提交 `85c51f7`；Claude 四项实现已在 master，无需重复合并。`git push origin master` 已接受 `fd258b4..85c51f7`，远端 SHA 已匹配；最终回执另作纯文档提交。
- 手机 0.5.21 (27) 已覆盖、启动、实看首页并核对数据，详见 [完整交付记录](docs/phone-permission-fix-20261016.md)。原 6 个暂存文件与其他共享 WIP 保留；本轮模拟器已关闭，未 git pp/重启桌面。

### 2026-10-16 — Claude — 多 Agent 协作与项目整合（分支 `claude/agent-team-20261016`）

- 一个委派开关（同时写入同步用的协作字段）；团队与委派同一规则：发起的 Agent 必须开委派，成员必须在它的委派对象里。协作面板按名字勾选、按勾选顺序执行，不可用时说明原因。
- 团队回复由发起的 Agent 汇总，失败或超预算时用固定格式摘要，不再显示原始 JSON；并行模板改为并行调研后由最后一位复核；复核循环带上一轮交接；团队有总时间和总 token 上限。
- 项目可设默认 Agent（项目内新对话使用）和默认团队，只存电脑、不进同步。计划与验证边界见 [协作整合](docs/agent-team-20261016.md)。
- 未验证：真实模型下的汇总质量；用户现有 Agent 委派均为关闭，需用户自行开启。手机端无团队功能。
- 手机端团队（同分支）：手机按同一规则在本机运行团队（同步的协作设置决定谁能组队；成员单次文字调用，联网需发起者与成员都在本机开启；15 分钟总时间，无 token 总上限）。控制栏“团队”只作用于下一条消息。共享契约新增交接、计划、执行顺序三组；模拟器经真实发送路径验证。未验证：真实账号、实体机。

### 2026-10-16 — Android / Mobile Use — 保留手机工作并更新主线

- 线程 ID：`01a13a56-c8c5-7d21-a108-d761aee8c657`；用户要求 pull 后开新分支继续 Mobile Use。WSL checkout `/home/zhouy/workplace/Melo`，当前 `codex/mobile-use-features`。
- 先以 `554776b` 保存上轮已验但未提交的 0.2.3 Home 修复；`git pull --no-rebase origin master` 合入 `2e8b533`，merge 为 `7c2fe6f`。仅 README / PROGRESS 冲突：保留新版主线说明与归档，并保留 Android 入口和五条本地进度；package scripts 同时保留双方入口。
- 合并后逐字核对 `android/` 与本地修复一致、`ios/` / `mobile-sync/` / `shared/protocol/` 与上游一致；本轮 36 JVM tests / Debug 构建、90 mobile-sync tests、41 schema / contract tests 全通过。日志在本会话 `work/melo-mobile-branch-{android,sync}.log`。
- 本轮只同步代码与本地分支，未使用真实 provider、操作手机或发布。旧 runtime / Release / 安装证据不充当合并后实机验收；下一步继续原生 Launcher / 搜索恢复的完整实机验证，游戏启动尚无完成结论。

### 2026-10-16 — Android / Mobile Use — repo 审视与下一步

- 线程 ID：`01a13a56-c8c5-7d21-a108-d761aee8c657`；用户要求全面审视 repo 并决定下一步。基线 `964bc7b`，范围为三端架构、Android 工具与聊天、Node 权限/文件工具、同步契约与构建检查；不是逐行全库审查。
- 新跑 `npm run test:unit`：3642 tests，3608 pass / 15 fail / 19 skip。8 个浏览器失败缺 Chrome 默认路径，1 项缺 Ruby；6 个文件身份替换检查在单独重跑也失败。临时目录对照：未持有 FD 20/20 复用编号，持有 FD 0/20；仅本机 WSL 证据，不外推 macOS 或 Android 点击执行器。
- [详细审视](docs/mobile-use-repo-review-20261016.md) 含 13 项发现、源码行号、重现入口和验收边界。建议先补 Mobile Use TaskOutcome / 动态目标校验 / 有界恢复，再处理按对话 Job 和聊天内嵌；并行修本地测试基线、Android gate、Kotlin 行为契约。存储与 UI 热点先按基准/变更边界治理。
- 本轮产品源码、用户数据、凭证与实机保持；只增加审视和交接文档。报告不将成功 Tool、模型结束语、代码量或旧测试计数当作当前真实任务完成率；下一阶段实现尚未开始。

### 2026-10-16 — Android / Mobile Use — Core v1 与聊天内嵌

- 线程 ID：`01a13a56-c8c5-7d21-a108-d761aee8c657`；用户认可审视优先级并要求开始，当前 `codex/mobile-use-features`。新增 `DeviceTaskLoop` / `DeviceContextBudget` / `DeviceTargetPolicy`，接回 `DeviceAgent` / `MeloAccessibilityService`；ChatEngine 按 Chat 管理 Job，MainActivity 内嵌本机设备任务时间线。
- 旧“模型停止即可完成”改为显式 finish 与可见事实重查；Node 重新校验、坐标 / 提交按钮本步确认、无进展 / 错误恢复和 Context 限制。任务捕获角色 / 项目 / 模型且设备独占，删除所属 Chat 后停止动作；步骤原始参数 / 截图不入本机持久化或 portable sync。新字段兼容旧资料，Keystore / package id 保留。
- 当前 59 JVM、24 Emulator runtime、2 viewport UI、9 工程 tests、Lint 0 errors、Debug / R8 Release 与 856 文件语法检查通过；签名 / 四 ABI 16 KiB alignment 已验。同证书 Preview 在 Emulator 覆盖安装 / 冷启动通过，保留其测试聊天 / 角色计数。详细命令和边界见 [交付](docs/mobile-use-core-20261016.md)；证据 `.tmp/mobile-use-*` / Gradle reports / 本会话 outputs。
- Android daily / full gate 与独立 CI 定义已接入，runtime runner 在修改前拒绝个人手机或多个 ADB 设备。没有推送、运行远端 CI、使用真实模型或操作 Fold6；原 Node WSL identity 六项、Kotlin 新团队行为契约和存储 benchmark 后续单列。

### 2026-10-16 — Android / Mobile Use — Fold6 循环修复与 Task Cache 接续

- 线程 `01a13a56-c8c5-7d21-a108-d761aee8c657`；用户授权实测后，0.3.0 暴露“设置已打开却重复启动到 30 步”的失败。0.3.1 独立限制同目标启动，返回 already_foreground，并支持同 App 可见并列 pane 选择 / 同窗 finish；覆盖式 modal 仍使旧窗口失效。
- 最终 67 JVM / 25 Android 16 Emulator runtime、Lint 0 errors、Debug / R8 Release、签名 / 四 ABI alignment 通过。首份 0.3.1 实机 5 步打开设置、10 步进入 Bluetooth，均 finish 重查成功；手机 Key / 资料保留。后加 modal guard 属最终 Emulator gate，APK hash 和验证层级见 [实机记录](docs/mobile-use-fold6-20261016.md)。
- 用户明确新功能应为 Task Cache，认可 Exact / 模板 Hit 零 LLM、Similar Hit 自动精简改写、Miss Probe、成功自动写回及编辑 / 删除；[已认可规格](docs/specs/2026-10-16-android-device-scripts-design.md)。旧 Run 没有原始目标参数，不能伪造脚本；该阶段尚未实现 Cache；现已由下方 0.4.0 最终交接接续。

### 2026-10-16 — Android / Task Cache — 首轮生产接线

- 用户将需求明确为类似 Cache 的自动路由，而非仅手动保存：Exact / 参数模板 Hit 本机；Similar Hit 允许一次精简模型改写；Miss Probe，成功后自动写回。规格 `fee951d` 已获明确认可，不再重复问许可。
- 已写 Recorder / Validator / Router / Runner / Planner、本地 AppData 字段和 Chat 管理入口；暂时 ID / 原始参数不入脚本，编辑后待验证，覆盖式 modal 和 selector 不匹配停止。相似计划不能发明新 selector、弱化完成条件或篡改绑定参数；否则 Probe。完成结果与可信 Cache 通过同一 Room document 更新，避免取消或并行编辑复活条目。
- 首轮 84 JVM tests 通过（含 3 项 MockWebServer planner checks）；当前仅本机 JVM 层，UI / Native Cache 端到端、Lint / R8 / 签名包和 Fold6 待验。原 0.3.1 结果是历史边界；下一步做 Probe → Cache → 无连接 Exact Hit、Similar 改写、编辑 / 删除 / 重启和失败不重放的实际链路。

### 2026-10-16 — Android / Task Cache — 0.4.0 最终验证与 Fold6 安装

- 线程 `01a13a56-c8c5-7d21-a108-d761aee8c657`，分支 `codex/mobile-use-features`；用户已认可 Similar 自动改写。Exact / 模板 Hit 无 Key 或模型调用，Similar 受约束一次 plan，Miss Probe；成功自动 Cache，Chat 可编辑 / 删除，修改后待验证。
- 91 JVM、33 Android runtime、4 组 cover / unfolded UI flow、Lint / Debug / R8 / signature / alignment 通过。真实 Fold6 同证书升级，5 Chat / 1 角色计数保留，原 Key 没有读取或迁移。
- 首次 Probe 8 请求后写回；旧 Bluetooth 入口与当前首页不匹配时安全回退 Probe 2 请求并更新，未盲目 Back。随后 Exact 0 请求 1.182 秒、Similar 1 请求 7.169 秒、Miss 2 请求、冷启动 0 请求、编辑 / 手动运行 / 删除均验证。JSON 动作修改属于 Emulator UI 证据。
- [完整记录与边界](docs/android-task-cache-20261016.md) / [脱敏实机 receipt](docs/evidence/android-task-cache-fold6-20261016.json)。新包 SHA `180949a7334378c407250899e23e699a19d45c32027f85ff23e9e513d05e3cde`；旧 Run 不可转换、无稳定 selector / 纯坐标不可缓存、Similar 无可靠改写则 Probe。下一阶段可扩展语义检索与稳定起始页面；不把 Emulator viewport 当作全折叠 / 省电验收。未推送或 git pp。

### 2026-10-17 — Android / Samsung 微信截图 — 0.4.1 中间验证

- 线程 `01a13a56-c8c5-7d21-a108-d761aee8c657`；用户要求看最新微信失败，并明确需考虑 Fold 两种模式。原记录 cancelled / 20 steps / 21 model requests，旧摘要只说明得到图像，不保证窗口正确。
- 0.4.1 95 JVM / 34 Android runtime、Lint / Debug / R8 / signature / alignment 通过；同证书安装保留 6 Chat / 1 角色。展开模式微信窗口和截图正确，外屏仍选中 Samsung 手势层，已保存正反例，不能按自动化测试通过就称实机全修复。
- [诊断](docs/wechat-window-capture-20261016.md) / [脱敏回执](docs/evidence/wechat-window-041-20261017.json)。下一步补启动窗口时序与不可观察时停止；仍无证据证明微信针对 Melo 限制，输入 / 发送未测。用户提出参考 AutoInput，讨论视觉坐标 + 独立输入 Backend；尚未安装新插件 / IME / Shizuku。未推送 / git pp。

### 2026-10-17 — Android / Samsung 微信截图 — 0.4.2 双屏最终验证

- 线程 `01a13a56-c8c5-7d21-a108-d761aee8c657`；补充有界的启动窗口交接检查，获取不到目标立即停止，防止把 Samsung 手势层误当微信继续循环。保留 0.4.1 外屏失败证据。
- 99 JVM / 34 Android runtime、Lint / Debug / R8 / signature / alignment 通过；同证书覆盖安装保留 7 Chat / 1 角色与其他辅助服务。安装 APK SHA 与交付一致。
- 最终 0.4.2 同包 folded 968×2376、unfolded 1856×2160 均强制 Probe，均 3 steps / 3 model requests、com.tencent.mm / 0 节点，模型明确确认画面可读，finish 重查通过。只读，原消息发送任务未重跑；[详细证据](docs/evidence/wechat-window-042-20261017.json)。
- 参考 AutoInput 的讨论另用外部 Windows ADB 验证微信搜索字段“新截图 → 坐标点击 → ASCII 输入 → 截图核对 → 清除”可行，0 消息发送。它不是 Melo 生产输入功能，中文 / 新 IME / Shizuku / MediaProjection 未接入；Fold Cache 布局隔离仍待做。没有私聊截图入仓库，没有推送 / git pp 或整个 repo gate。

### 2026-10-17 — Android / Chat Phone Use — 已认可设计与接线检查点

- 线程 `01a13a56-c8c5-7d21-a108-d761aee8c657`；用户明确“生硬”来自单独入口，希望普通 Chat invoke Skill，并回复 Go ahead。采用高层 phone_use Tool 调用现有 DeviceAgent，原 Chat 继续整理结果；不以关键词分类或另装插件替代。微信输入暂缓。
- 当前代码 WIP：统一 Chat 输入、按需执行、每 Chat 能力开关、Cache 管理；research 实时 Probe，action 复用已有 Cache。子任务捕获同一模型 / 角色 / 项目，停止联动，查询返回所属 Chat，保留下一条草稿。
- JVM 109 与首轮新增 5 项 Native 链路通过；原后台测试暴露 launch identity / teardown 问题，已修正夹具；第二轮因 Emulator 内存耗尽中断，不计通过。最终 gate、签名包与实机尚待验，不称全交付。[设计](docs/specs/2026-10-17-chat-phone-use-design.md)。

### 2026-10-17 — Android / Chat Phone Use — 0.5.0 最终交付

- 产品 `954b382`，设计 `375a1b2`；普通 Chat 注册高层 phone_use，按需执行现有设备 Agent、原对话续答，移除模式切换。research 强制实时 Probe，action 沿用 Cache；停止、上下文快照、草稿和删除事务边界保留。
- 109 JVM / 39 Android runtime、Lint / Debug / R8 / signature / alignment 全通过；首轮夹具身份失败和第二轮 Emulator OOM 分开保留，不计作成功。最终先构建再运行新 Emulator，完成后已关闭。
- 同证书覆盖 Fold6，安装前后 7 Chat / 1 角色及其他辅助服务保留；另留一个 QA Chat。最终 APK 实机普通问答无设备调用，Maps 当前列表查询 9 步 / 53.543 秒，引用“第二家”重新核对 5 步 / 31.531 秒，均回同一 Chat 最终回复；系统日志记录 App 自身返回。没有预订 / 致电 / 导航 / 发消息或代点确认。
- [交付与准确边界](docs/chat-phone-use-20261017.md) / [脱敏回执](docs/evidence/chat-phone-use-fold6-050-20261017.json)。Phone Use 开启本版暂非 Streaming。小红书与本版 folded 未实测；微信输入后置、Fold Cache 分区仍待做。未推送 / git pp / 远端 CI 或整个 repo gate。
### 2026-10-16 — melo主线 — Agent 循环与卡死边界审查
- 用户要求检查遇到 bug 是否死循环。当前主对话 10、成员最多 20、技能最多 16、团队复核最多 5、手机工具 6 轮；主对话同一永久错误实测重复 10 次后停止，未发现外层无限重试。
- 隔离复现：hook 在超时/取消之外等待；不合作成员超时后持续持有工作区，下一写成员未启动即超时；团队总结绕过总时限。实际代码位置、触发条件、修复顺序及边界见 [审查报告](docs/agent-loop-audit-20261016.md)。
- 已有专项 55/55，新行为探针 6/6（含缺陷复现，不是已修复）；证据 `.tmp/agent-loop-audit-20261016/`。仅审查文档/交接 WIP，无产品改动/真实调用/安装/推送，保留共享暂存；下一步补统一运行截止时间、重复失败停止和写任务隔离恢复。

### 2026-10-16 — melo ui — 设计语言一致性审计
- 用户只要求审计。当前主视觉、五区身份色、共享 Swift 主题来源基本一致；六类差异集中在浮层材质、管理弹窗、设置页卡片、未定义文字 token、下拉识别及操作文案。具体文件/复现/修正顺序见[审计报告](docs/ui-language-audit-20261016.md)。
- 实际定位：`neuralGlass.css` 对照 `styles.css`、`localSettings.css`、`language.css`、`managementActions.js`；手机 `EditableDocument` / `ConversationContextPicker` / `TeamSheet` 的 Form 底层材料仍需原生验证。
- 验证为原生桌面首页截图、同服务 1320×860 浏览器页面与浮层截图/计算样式、双端源码；证据 `.tmp/ui-language-audit-20261016/`，含源码散列。不代表完整功能/性能/实体手机验收；未触发模型、权限或保存操作。
- 报告独立本地提交 `1610519`；本线程总览/短进度片段为 WIP，已有共享暂存保留。未改产品代码、安装、git pp 或推送。下一步如进入实施，先统一浮层/对话框与文字 token，再收敛管理页/控件并补原生手机视觉验收。

### 2026-10-16 — melo主线 — 执行计时与图片进度计划
- 用户要求实时思考秒数、最终用时、图片百分比与完成时间；按[实施方案](docs/execution-timing-20261016.md)从执行时间戳和已保存成果计算，云端无进度不伪造百分比。
- 桌面聊天/任务空间及手机原生聊天一起对齐；当前仅方案 WIP，保留原共享暂存。基线 `.tmp/execution-timing-20261016/`；下一步计时与成果进度回归、界面验证及本轮本地提交。

### 2026-10-16 — melo主线 — 执行计时与图片成果进度完成
- 桌面聊天/任务空间秒表与最终用时、完成日期已落地；图片按实际保存张数显示百分比与处理用时。手机原生聊天和共用场景同步显示。实现文件、接口边界与验收见[交付记录](docs/execution-timing-20261016.md)。
- 当前树日常 3659 JS / 863 语法 / 设置浏览器 / 26 Swift 通过；独立提交内容另做定向回归，Debug 编译与模拟器聊天/任务空间实看一致。证据 `.tmp/execution-timing-20261016/`。
- 单张云端无内部百分比时显示成果 0→100，多张按保存数量；预览/失败不算完成。原有真实数据与共享暂存保留，功能本地提交 `c0e0725`；独立提交版本 10 项 JS/浏览器和 24 Swift 通过。未 git pp、推送、桌面重启或实体覆盖。

### 2026-10-17 — melo iphone — 双端对齐、覆盖和发布计划
- 用户要求检查 Claude、手机对齐/覆盖、git push，补充桌面同步。已读三线程总览和实际 diff，Claude 手机团队/图片并发已在主线，最新计时尚未装机；README 团队边界已过期。
- 按[本轮计划](docs/dual-platform-align-20261017.md)顺序修双端团队汇总时限、统一浮层和原生表单材料、验共用神经场景及计时，再签名备份覆盖与推送。基线 `1bb030c`，6 个已有暂存与共享 WIP 保留。
- 当前仅计划与源码审读完成；实体手机已连接解锁，未安装/推送，未改真实权限或账号。

### 2026-10-17 — melo iphone — 双端团队边界与材料修正
- `src/agents/team.js` 与 `ios/Melo/AgentTeam.swift` / `ChatStore.swift` 的汇总受原团队剩余预算约束；超时/取消明确失败，桌面迟到回执丢弃。14 项 JS 和 26 组 Swift 通过。
- 桌面 `neuralGlass.css` / `language.css` 和手机三个原生表单统一材料；浏览器辅助色层级已定位修正，原生视觉与完整日常继续验证。详见[对齐记录](docs/dual-platform-align-20261017.md)。
- 同包 0.5.24 (30) Debug 构建中，实体 0.5.23 已私有备份；已有暂存/WIP 保留，尚未装机/推送。

### 2026-10-17 — melo iphone — 完整源码发布范围确认与日常验证
- 用户最新明确提交并推送其他线程全部 WIP；原有仅本轮片段提交计划被覆盖。手机与桌面安装将对应同一份完整产品源码，账号数据及本地备份不入 Git。
- 当前完整树日常 3663 JS / 863 语法 / 设置与 extra-fast 浏览器 / 26 Swift GREEN；团队授权/顺序、并发取消、图片首轮与缩放夹具通过，原生团队/资料/知识页材料与神经场景已实看。
- 两个浏览器测试竞态已修正并复跑通过，失败日志保留；详见 [完整记录](docs/dual-platform-align-20261017.md)。68 个候选文件敏感内容/大文件扫描无发现，下一步签名 Release、私有备份、手机及桌面覆盖和推送。真实供应商/长后台仍为独立边界。

### 2026-10-17 — melo iphone — 完整版本双端覆盖完成
- 用户授权的全部产品 WIP 已提交 `8cd3eff`；0.5.24 (30) 签名 Release 同包覆盖实体手机并启动 PID 31417。11 聊天/6 Agent/图片/草稿/配置保留，仅运行日志更新，未改账号或权限。
- 桌面原生 app 已构建、覆盖并正常重启，健康接口源码 `8cd3eff0af9a`、干净树、PID 26309；原 home、14 聊天/1 项目/6 Agent 与连接配置保留。神经首页、团队浮层实看通过。
- 安装及逐文件对比见 [双端回执](docs/dual-platform-align-20261017.md#双端安装回执)。日常 3663 JS / 26 Swift 与原生夹具通过；真实模型/远端同步/长后台未重验。最终英文 README 和回执随文档提交推送，不发布私有备份或签名包。

### 2026-10-17 — melo iphone — 完整版本已推送 GitHub
- `2e8b533..063fd11` 推送 master 成功，远端 SHA 与 README blob 已核实一致；全部产品 WIP 收入 `8cd3eff`，两端已安装该源码，工作树干净。完整 [回执](docs/dual-platform-align-20261017.md#github-发布回执) 含验证边界。
- 本条为最终文档回执，随文档提交继续推送；没有运行 git pp、发布签名包或上传私有备份。用户可直接使用已覆盖的手机 0.5.24 (30) 和桌面版。

### 2026-10-16 — Claude — 多图、尺寸、上传上限与视频（分支 `claude/media-20261016`）

- 多张图默认逐张修改（说“合成”才合成），两端共用判断用例；2K/4K 尺寸两端可选，Codex 不接受时如实降级；大图以副本发送，不再卡 20–24 MB；电脑视频 ≤500 MB 文件流上传、抽帧加多并可存为知识；手机可选 10 分钟内视频在本机抽帧和转写。详见 [方案与结果](docs/image-video-plan-20261016.md)。
- 未验证：真实账号 2K/4K、视频回答质量、手机语音转写授权路径、实体机。

### 2026-10-17 — Claude — 回复进行中可改设置、中途补充、主界面显示步骤（同分支 `claude/media-20261016`）

- 回复中可换 Agent / 模型 / 项目 / 团队、加图片视频、语音输入，均从下一条消息生效；回复中输入框发送即“补充”：手机停止当前请求并带上补充重新开始，电脑在下一步模型调用前插入（无下一步则结束后作为下一条发送）。
- 对话里实时列出正在进行的步骤（与任务空间同源）。详见 [方案与结果](docs/live-run-controls-20261017.md)。
- 未验证：真实模型补充质量、实体机上的补充与逐张修改实际体验。
- 已合并 master（含 0.5.24 对齐）并推送 `eb61608..8b84de3`；手机签名 Release 0.6.0 (31) 覆盖安装并启动，安装前私有备份在 `MeloDeviceBackups/v060-20261017`，前后比对 11 对话、图片、偏好保留，仅运行日志变化。桌面原生 app 未重建，仍运行 `8cd3eff`，补充与步骤显示需重建后才在桌面生效。

### 2026-10-17 — Claude — 来回换话题与跨对话记忆方案（待用户选择）

- 现状：电脑同一对话原文窗口约 6 万 token、超 8 万压成一份摘要；手机约 48 KB 原文、无摘要。无话题意识。本机 24 轮记录提示缓存命中约 4%（每轮变化的记忆/资料插在历史前）。跨对话：自动事实默认只在本对话，项目共享说明/资料/审批任务但不共享讨论结论；聊天记录搜索不分项目。
- 方案与评分见 [方案](docs/context-memory-plan-20261017.md)；推荐“缓存友好顺序 + 话题分段 + 个人档案与项目记忆本”。仅文档，未改代码。

### 2026-10-17 — Android / Mobile Use — 同步主线并核清搜索缺口

- 用户要求 pull、解释工具配置，并指出餐厅查询直接占屏不合理；随后提出抽出核心功能。本轮只读审查能力，没有操作手机或调用真实模型。
- 从 `039bfba` 合入 `origin/master` 的 20 个新 commit，远端尖端 `6adc270`；两份共享进度文档冲突均保留双方记录。上游主要更新桌面 / iOS 的媒体、运行控制、上下文与 Agent 加固；Android 与 pull 前逐字一致，源码 pull 不会更新手机上已安装的 0.5.0。
- Android 普通 Chat 只注册 `phone_use(goal,purpose)`，设备子任务只注册 `android_device`，10 个 action 为 observe / list_apps / open_app / tap / type_text / swipe / back / home / wait / finish；list_apps 搜的是已安装 App，不是互联网。ChatPhoneUse 的现行 instructions 明确要求餐厅研究使用手机，故缺少搜索优先策略及相应 Tool，不能归因于模型没有主动搜索。
- Node 的 Built-in Registry 有 30 个 ID（含 agent 兼容 alias），含 web_search / fetch_url / 6 个 browser action；实际按 SearchPlan、Capabilities、MCP 配置过滤。iOS 的 WebSources 亦有按能力开启的 native web_search；两者均未接到 Android。静态注册不代表用户当前运行实例启用了全部工具。
- 后续方向：将 Tool Contract / Router 与 Chat UI 分离，Skill 定义策略，Search 返回可引用来源，Phone Use 处理明确的 App 操作或只有 App 能提供的资料；平台 Adapter 保留各端执行方式，Android 必须能独立工作。此方向尚未实现，不能仅加 Prompt 就宣称能搜索。
- 新跑目标 Function Calling / Search Router / Context Budget / Sync Contract 共 71 tests，全部通过；日志 `.tmp/pull-tools-check-20261017.log`。未跑完整 repo gate、Android runtime 或实体机；未安装 / 推送 / git pp。PROGRESS 合并后超过 500 行，按协议压缩较旧约 70% 条目，保留记录 commit 与现有归档。

### 2026-10-17 — Android / Mobile Use — 三端核心一致性约束

- 用户进一步明确 Android 不能与其他端各管各的，核心抽取需服务后续维护。本轮补读手机对齐协议、主线 / 设计 / UI 的现有交接、共享契约及三端 Chat 真实入口；状态是设计约束登记，没有产品实现。
- 当前 Node Chat Runner、Swift ChatStore、Kotlin ChatEngine / ChatToolLoop 各有执行链。共享 `sync.schema.json` 已由三端使用；`contracts.json` 的 Tool Replay / Team 行为 Fixture 由 JS / Swift 消费，Android 尚未接入该行为集合。共享资料同步不代表共享执行核心。
- 下一步收敛为同源 Core：先聚焦 Tool Registry、Router、Skill 策略和 Tool Loop / 结果 / 取消；平台 Adapter 负责网络传输、OS 权限、存储及本地设备能力。各端共同消费 Conformance Fixtures，通用能力差异显式暴露，不能把缺 Search 静默替换成占屏。共享 Runtime 方案需进一步设计，未承诺已有单一执行实现。
- 保留 Android / iOS 独立使用及原资料、凭证，不把统一核心解释成必须依赖桌面在线。当前只更新共用决策及计划，未重跑产品测试 / 操作手机 / 安装 / 推送；前轮 71 项是 pull 后目标回归证据，不是核心统一验收。

### 2026-10-17 — Android / Mobile Use — 简化 App 发现步骤

- 用户指出 list_apps 像固定先列 200 个、应简化步骤。本轮确认没有写死该顺序：旧默认 100、上限 200 且可空 query，指令强调先 discovery；已有 open_app 可本机精确解析标签，动作也已返回新画面。当前 Windows ADB 未发现 Fold6，未宣称读到用户最近操作记录。
- 修复现有 Android Adapter：准确名称 / 包名优先直接打开；只有候选不足才定向查询，默认 10 / 定向上限 20，空查询或大页显式 browse=true；精确匹配不夹带模糊建议，重名保留消歧，空 open_app 拒绝。已有动作观察优先复用，最终 finish 的重观察和其他停止 / 权限规则保留。此为 OS 特有能力修复，共享 Core 与 Search 仍待设计实现。
- 113 JVM / 40 Android 16 runtime、Lint 零 Error、Debug / R8 Release 及 test APK 构建通过。三协议 HTTP Fixture 直接按名找到第 265 个 App，设备子任务仅 open_app / finish 两次模型请求，Host 验证另做 observe；不是整个 Chat 零 LLM 或真实 provider 性能结论。真实 Service 标签启动、无 query 无列表回传、小页 / 分页及原 Chat / Cache / 取消回归通过。
- 首轮新增测试揭示精确查询仍夹带模糊候选；另调整旧 Fixture 的有效目标以分别测试错误累计 / 重复启动保护，未降低原断言。失败、最终日志与准确边界见 [verification](android/verification.md)。构建后才启本轮 Emulator，runtime 完成已关闭；未操作实体手机、签名发行 / 覆盖安装、推送 / git pp 或整个 repo gate。

### 2026-10-17 — Android / Mobile Use — 0.5.1 覆盖与真实 Probe 验收

- 用户连接并解锁 Fold6 后授权继续；安装 0.5.1 (13)，同证书 / 已安装 SHA 与签名包一致，原 10 Chat / 1 角色及其他辅助服务保留。只新增一个本轮 QA Chat，沿用本机模型连接，没有读取 / 迁移 Key。
- 最终版本 113 JVM、Lint / Debug / R8、签名及四库 alignment 通过；40 runtime 为 `00b0e73` 同逻辑、版本号更改前的基线，最终版本未重跑 Emulator，以免和实体 ADB 抢连接。ADB 40/41 曾触发一次服务重启，后续先检查版本，再复用 Windows 5037。
- folded 首轮真实 Probe 12 步 / 54.132s，含名称错误、窗口恢复与导航，最终 Settings Intelligence 伴随包被严格窗口校验停止；保留 needs_user。此前仅凭末步作出“整轮已走直接路径”的判断过早，已完整补读并更正。
- 手动仅 Back 退出旧搜索页后，同 QA Chat 重试：Probe 5 步 / 23.806s，实时读取标题「设置」、终态重查并续答；含一次 swipe stale_screen 拒绝与重新观察。两轮均无 list_apps，但不等于最短两请求已在实机实现，也不等于跨包恢复已修。完整[脱敏回执](docs/evidence/app-discovery-fold6-051-20261017.json) / [准确边界](android/verification.md)。
- 结束无运行任务，回到 QA 结果；本版展开模式 / 其他 App / 微信 / restaurant 查询未复验，共享 Core / Search 与 Task Cache Fold 隔离仍待做。无推送 / git pp / 远端 CI 或整个 repo gate。

### 2026-10-17 — Android / Mobile Use — Shared Agent Core / Search 设计审阅稿

- 用户要求统一全部业务执行逻辑；本轮核对 Node / Swift / Kotlin 真实入口及官方 Hosted Tool / JS engine 资料，纠正“API 调用没有工具”的过度概括。现有 Codex 路径声明服务端 web_search，不是启动 Codex CLI；用户 Proxy 的同等能力未验证。
- [设计稿](docs/specs/2026-10-17-shared-agent-search-design.md)对比同源本机 JS / 统一服务 / 改写语言栈，推荐 Node + JSCore + Android JS engine 承载同一 Core；先验证运行条件，再逐字提取与独立变更策略，保留手机独立运行。
- Search 建议统一能力 / 配置 / 来源语义，默认经验证的 Native 或已配置 HTTP Backend；Playwright / Google 为显式 fallback。没有 Backend 时如实反馈，不静默占屏。Core / Adapter 边界及分层验收已写清；HTTP 供应商不擅自购买，密钥不加入资料同步。
- 本轮只有文档，已做引用路径和 diff 检查；没有产品代码 / 新依赖、模型请求、JS engine 或账号能力实测、手机操作、构建安装、推送或 git pp。具体 Runtime 方案待用户确认，下一步按认可方案做 spike，不能称已统一。

### 2026-10-17 — Android / Mobile Use — Agent Core 前置检查

- 用户认可 Core + Adapter 后要求先审现有执行链。本轮直接核对 Node / Kotlin / Swift 主入口，枚举 30 个 Desktop Built-in ID（含 alias）、4 个内置轻量 Skill；Android 是 phone_use + android_device 的 10 个 action，未接 Desktop Search / Skill Registry。没有读取用户 Mac 的活动配置或自定义 Skill 内容。
- 生产函数隔离探针复现 Skill Match Cache 跨 home 定义碰撞；永久失败为 10 模型 / 2 执行，相同成功读取为 10 / 10。Android 复现旧约束被 60 条窗口丢弃、长 instructions 拒绝短问、跨轮相同 call ID 执行两次。总 deadline 缺口为静态证据；未将摘要中的可见验证当成完整业务证明。
- 65 Node 既有回归 + 3 Node 诊断、116 JVM（含 3 新诊断）通过。第一次 Gradle init 注入没有生效，未当作诊断通过；最终核对 XML 后清理自有临时测试源码。诊断 GREEN 表示确认现状，不是修复验收。
- [详细检查](docs/agent-core-audit-20261017.md) / [脱敏结果和 hash](docs/evidence/agent-core-audit-20261017.json)；本机 Canvas 位于 Windows `.cursor/projects/empty-window/canvases/melo-agent-core-audit-20261017.canvas.tsx`。没有改产品逻辑、请求真实模型、读凭证 / 私聊、操作手机、Emulator / Swift 验证、安装、CLI review / git pp 或推送；共享 Core / Runtime spike 仍未实现。

### 2026-10-17 — Shared Agent Core — 逐字移植入口

- 用户已确认 A。前置修复 `ff0f128`：61 Node / 115 JVM 通过；Swift 测试源码未在 macOS 执行。
- 纯 URL / Request Policy / Skill Catalog 已逐字移入 `shared/agent`，Search Router 函数体逐字保留并由 factory 注入 Host；旧入口兼容，专项回归通过。
- Runtime spike / 生产接入与 Search API-first 政策仍在推进；不得用本阶段称三端已统一或已装新 APK。

### 2026-10-17 — Shared Agent Core — 本机 Runtime 检查点

- Node Main / Android Chat 与 Device Probe 使用同一 Turn reducer；资源有版本 / hash，Host 保留网络 / 存储 / 原生保护，Service 无 Activity 验证通过。
- 63 Node 定向 / 115 JVM / 34 Emulator runtime / Lint / Debug / R8、898 文件语法检查通过。日常 gate 的旧环境与排版失败见专项，不称全绿。
- iOS 仅打包 / Adapter / Conformance 源码，JS renderer gate 通过但 Swift skipped；生产入口未切换。Search、Skill 调度、Context / Memory、Task Cache 仍按计划继续，不将本阶段称整库统一。
- 详细记录 `docs/shared-agent-runtime-20261017.md`；未访问真实模型或私人手机，隔离 Emulator / ADB 5048 已关闭，默认 USB ADB 未动；无 push / git pp。

### 2026-10-18 — melo主线 — GitHub 介绍与公开更新记录精简

- 用户要求先整体扫代码再重写介绍，公开改动说明只保留大方向。按 `e4fed5c` 的结构与近期 diff 核对模型接入、Agent/工具权限、项目/记忆、媒体、CLI 和手机同步；这是介绍事实核对，不是逐行安全审计或完整运行验收。
- `README.md` 收拢为用途、兼容性、平台分工和必要安装说明；`CHANGELOG.md` 的 10-17 更新压成 5 条。核对 `src/shared/channelAvailability.js` 后修正 Discord 仍可接入的旧说法；详细架构与验收文档保留。
- GitHub About 已更新并读回一致，突出 Claude / OpenAI / OpenRouter / 本地模型兼容。公开文案继续英文；以后更新只写用户可感知的变化，内部实现细节留在专项文档。
- 文档相对链接、安装/测试命令、英文与格式检查通过；GitHub Markdown 渲染的标题、7 个章节、6 行兼容表和 3 个命令块通过。证据 `.tmp/github-copy-20261018/`；本条随文档提交，发布目标为 GitHub `master`，远端提交及文件散列在发布后核对。
- 仅文档/仓库元数据；未运行 `git pp`、产品回归、真实模型请求或双端安装，未修改用户数据。

### 2026-10-18 — Android / Shared Core — 接住最新主线

- 用户要求先 pull，已合入远端 `84abfa9`（iPhone 0.7.0 / Tool 协议与记录 / MCP / Memory / RunBudget）；Search 未提交内容先存入 Git stash，合并后继续。
- Core Guard 保留上游 Tool records 与预算，并按 Registry ID 接受 MCP wire name；旧 Router 的 self-description 政策迁入 portable 模块。Xcode 工程重新生成同时保留 SpeechText / SharedAgentCore 及上游版本。
- 72 项定向离线回归通过；不是完整 gate 或 iOS 原生验收，未请求真实服务 / 操作私人手机 / 安装 / push / git pp。

### 2026-10-18 — Shared Agent Core — API-first Search 检查点

- 用户要求先看最新 repo 再继续；已 Merge `84abfa9`，恢复受保护 WIP，接住主线的稳定 Tool definitions、MCP wire name、ToolInvocationRecord、三协议、RunBudget 与 Memory，而非回退旧 Main Loop。
- Node / Android 真实 Chat 使用同源 Router / Source Contract / Provider 编码 / Guard；公共查询选 verified Hosted 或 configured HTTP，未知能力和 HTTP 失败不自动启动 Browser / Phone。设备任务仍走原生保护。
- Hosted proof 绑定连接身份且 24h 过期；Source completed + 来源才算已检索，工具缺证据返回明确未验证。兼容 HTTP / Brave 均用 Fixture，凭证绑定 endpoint 且只存本机，配置 Schema 共用但尚未自动 Sync。
- 314 Node + 203 相关回归、最后 UI 16 tests；115 JVM / Lint / Debug / R8、42 同源 Fixtures，Cover 43 + 展开 9 Emulator 执行通过。真实 Desktop 设置页 Playwright 验证、两种 Native 尺寸截图及 APK hash / 签名 / alignment 已核对；[详细边界](docs/shared-agent-search-20261018.md)。
- Fold6 / One UI 8.5 与 iOS 原生仍待验；Skill 调度 / Tool records / Context / Memory / Task Cache 按计划继续。当前未访问真实账号、操作私人手机、覆盖安装、push / git pp；Emulator / ADB 5048 / QA server 与 Browser 已清理。
