# Melo 总览：架构、线程改动与接手入口

更新时间：2026-10-15（Australia/Melbourne）。这是所有 Melo 工作线程共用的人工维护入口。

## 1. 先看这里

- 真正产品仓库：`/Users/mortred/Desktop/melo/Melo Desktop Project`。Codex 当前保存项目 `New project` 指向 `/Users/mortred/Documents/New project`，不能混淆。
- 本文保存当前事实、架构边界、跨线程交接和待验事项；`PROGRESS.md` 保存意图时间线；专项文档保存详细证据；Git 保存代码历史。`codex.md` 是自动生成快照，不手改。
- 接手顺序：本文 → `CLAUDE.md` → `git status --short` → 本次模块的实际 diff / 源码与证据。正常工作不用完整回读线程。
- 记录缺失、线程更新时间晚于交接、源码与文档冲突时，只定向读该线程近期相关轮次，再补本文；不要靠旧总结覆盖新代码。
- 2026-10-15 已确认通知的 8 条线程全部完成补录回复；当前主线复核总览、源码/Git 与关键证据，集中归档详细回执。完成补录不等于产品任务全部验收；详见第 8 节与核对报告。
- 本文不是自动监控：各线程必须在实际改动后主动更新。未更新的线程或未记录的 diff 应标为“待归属/待核对”。

## 2. 当前交付与阻塞

| 项目 | 当前事实 | 下一步 / 边界 |
| --- | --- | --- |
| 手机 Codex 登录 | `85ac3a5` 接独立设备码 OAuth；`14e602f` 修应用切换取消；0.5.17 (23) 已签名覆盖并启动，用户数据核对保留（含当时共享 WIP） | 同码恢复限同一进程，强杀/系统回收后需新验证码；用户真实授权尚未确认，交新主线跟进 |
| 手机图片链 | 原图、编辑意图、失败保留与重试、结果保存/历史恢复已接生产入口；HTTP/原生夹具通过 | 手机真实账号权限、生成/修图画质待用户登录后验证；登录不自动生图 |
| 桌面图片链 | 10-15 只读实查默认 `codex-oauth`，未指定图像型号/质量；10-14 生产编辑回执为 `gpt-image-2-codex`、成图 `quality: low` | API 配置默认 Sunburst 2.5 不等于 Codex 已调用它；未接入 `xhigh/max`，不能称默认满血；见本页图像默认值核对 |
| 阅读密度 / 图片预览 | 阅读/预览UI仍共享WIP；10-15原生桌面复现生成图预览失败：旧签名URL403、原件仍在，同文件任务回看重签200且SHA一致 | 已确认访问生命周期缺陷，尚未修复；完整[图片承载治理计划](docs/image-capacity-plan-20261015.md)覆盖原件/衍生/缓存/内存/恢复；历史366 UI不代表已覆盖过期和重启 |
| 桌面神经总览 | 放大、五区分段图标和中枢加密已在 `b96c48a`；当前核心 JS 无未提交差异 | 347 项是 10-10 历史 UI 回归；加密后的 GPU/功耗、现安装包和用户最终验收未复验；样式后续 WIP 见设计线程 |
| 手机权限 / 文件 | 权限状态、文件/目录授权、预览、确认导入已接入；10-15 当前树 21 组 Swift / 共享渲染和模拟器编译通过 | 源码仍 WIP；10-14 模拟器交互证据与本次编译分开；iCloud/第三方文件授权及实体权限流程待验，不把后续集成包等同专项真机验收 |
| 执行面板 | 桌面多段公开摘要按轮合并，API 回执白名单保存与历史回看；2026-10-15 核对实际 diff 仍 WIP | 无摘要不补造；手机共享渲染已打包，但独立请求端新增数据采集不在该轮范围；当次真实请求未返回摘要，多段合并为协议样本证据 |
| 发布 gate | 当前 `npm test` 为日常按边界检查，`npm run test:full` 为完整发布 gate | 各记录的旧计数只属于当次源码；本次纯文档整理未重跑产品测试 |

详细手机证据：[`docs/mobile-image-edit-20261014.md`](docs/mobile-image-edit-20261014.md)。

## 3. 整体架构与代码地图

保留模块化单体。桌面/CLI/远程渠道共用 Node 业务核心；iPhone 有独立 Swift 聊天与模型通道，通过共享同步协议交换工作区数据。网站和基准工具独立于产品运行时。

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
| 神经导航 / 场景 | `desktop-ui/neuralLayout.js`、`neuralMotion.js`、`neuralShell.js`、`neuralSatellite.js`、`neuralScene3D.js` / `neuralScene.js` | 同一空间模型驱动 DOM、GPU/Canvas 与拾取；分段五色图标、三阶段导航、内部密度；已提交与后续样式 WIP 分界见 UI 交接 |
| 传输 / 路由 | `src/server.js`、`src/http/` | HTTP/SSE、来源检查、声明式路由与生命周期；不承载新增领域业务 |
| 请求运行边界 | `src/runtime/requestContext.js`、`requestScope.js`、`processOwnership.js` | 入口捕获 home、环境、身份、路径和取消信号；异步执行不重读可变全局 home |
| 领域服务 | `src/services/`；`src/desktopStore.js` 为兼容入口 | chat / task / settings / agent / workspace 等业务；新增业务放领域服务 |
| 纯领域 / 持久化辅助 | `src/domain/`、`src/persistence/` | 纯实体与可复用持久化辅助；保持依赖方向，抽模块先逐字节移植 |
| 状态与检查点 | `src/state/stateStore.js`、`chatPersistence.js`、`chatManifest.js`、`statePayload.js` | 原子事务；规范化 home 隔离；不可变消息 checkpoint 与单调清单修订 |
| 对话执行 | `src/services/chat/`、`src/agents/` | 入队、上下文/预算、模型请求、工具续接、取消与落盘；同聊天串行，不同聊天可并行 |
| 供应商 | `src/openai.js`、`src/providers/` | Codex / API / Anthropic 协议与流解析；原生 function calling 接入 Melo 自身执行器 |
| 工具 / 授权 | `src/tools/`、`src/safety/`、`src/services/approval/` | 校验参数、权限、工作区与执行身份；外部副作用不因网络失败盲重放 |
| 图片 | `src/images/`、`src/services/chat/imageTurn*`；`ios/Melo/ImageWorkflow.swift` | 明确分析/生成/编辑意图，绑定真实原图，保存产物与失败；不要把语言模型名当图片型号 |
| 记忆 / 检索 | `src/memory/`、`src/retrieval/`、`src/runtime/derivedIndexing.js` | 内置 ONNX 多语 embedding worker、本地 SQLite/FTS/向量、事实作用域与增量派生；使用记录只计实际进入 prompt |
| 执行事件 | `src/shared/executionScene.js`、`executionMetadata.js`、`src/services/chat/executionPipeline.js` | 真实工具/模型轮次、公开摘要、结果、token/耗时白名单；未知保持未知，历史查看不重跑 |
| 手机原生 | `ios/Melo/ChatStore.swift`、`ContentView.swift`、`SettingsView.swift`、`MeloApp.swift` | 本机聊天、角色、草稿、设置、图片和前后台；桌面关机不应阻断独立聊天 |
| 手机授权 | `CodexOAuth.swift`、`ChatGPTAccount.swift`、`CodexLoginView.swift`、`Keychain.swift` | 设备码 / PKCE / 身份签名 / 刷新；新键 `codexAccounts`，连接 ID 保留 `chatgpt`；不复制桌面 token |
| 手机同步 / 共享渲染 | `mobile-sync/`、`ios/Melo/SyncWorkspace.swift`、`ios/Melo/Scene/`、`ios/scripts/build-scene.py` | schema 生成 JS/Swift 约束与共用样例；共享资源 manifest/hash；同步不是模型登录 |
| 手机文件 | `ios/Melo/LocalFileAccess.swift`、`LocalFilesView.swift`、`LocalPermissionsView.swift` | 本机目录书签、撤销、路径约束、预览与确认导入；授权不自动上传 |
| 外部官网原型 | `/Users/mortred/Documents/New project/melo-universe/src/{data,neural-geometry,scene,navigation,main}.js`、`styles.css` | 独立 Three.js / Vite SPA；连通神经图、真实投影命中、History API 管理三级 hash 路由，`onFrame` 进度协调相机/滚动/正文；不接产品模型、账号或收款，旧站与桌面导出分别保留 |
| 外部 SWE-bench 适配 | `/Users/mortred/Documents/New project/benchmarks/melo-swe-docker-agent-20261014/{run_melo.mjs,container_tools.py,run_batch.py}` | 调用产品正常消息入口，在独立基准进程替换六个工具运行函数并自动授权；产品仓库没有Docker功能改动或接入提交；评分不覆盖桌面权限/手机 |

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
| melo主线 | `01a13b2e-5446-7042-bb5e-773129746c7e` | 统一架构和集成、模型/工具、登录与图片；本次建立共用文档 | 当前承接；build23 待用户登录反馈 |
| melo主线（历史·2026-10-15） | `01a10bf2-e092-7862-87fe-2f237a8fb6a0` | 架构、审计、记忆、function calling、日常 gate 和手机 OAuth；本次只补遗漏 | 已完成补录；授权核心已提交，相关共享文件仍有他线程 WIP；[build23 回执](docs/handoffs/melo-thread-backfill-20261015.md#historical)，产品任务交新主线 |
| 设计 Melo | `01a1161a-1919-79c1-9764-8709bb0e2e2d` | 2026-10-15 补 API 观测与阅读/图片交接；另只读核对默认图像通道，确认 Sunburst 配置不等于当前 Codex 型号 | 两组仍 WIP；桌面实测与手机模拟器证据分列，手机照片写入、独立采集待验；详见[设计回执](docs/handoffs/melo-thread-backfill-20261015.md#design-api)及 `docs/execution-panel.md`、`docs/chat-density-20261014.md` |
| melo ui | `01a10bf3-d7b9-7832-a351-8b0f78e9c552` | 10-08 分段五色神经图标/纵深与启动专项；10-10 总览放大、图片浮层及中心加密；10-15 只补历史交接 | UI 核心已收进 `b96c48a`；现样式另有设计线程 WIP。历史 347 项与原生截图非当前验收；[核对与失败边界](docs/handoffs/melo-ui-20261015.md) |
| 读取 melo ui 方案 | `01a1103d-0c3b-77d4-96dc-ea499d455020` | 2026-10-06 读取、单次成功派发、按指定 turn 只读跟进与 Library 截图交付；2026-10-15 补历史证据 | 辅助线程无产品代码/提交；288/291 项为旧轮次结果，详细边界见[辅助线程回执](docs/handoffs/melo-thread-backfill-20261015.md#ui-helper) |
| melo iphone | `01a11116-8469-74a2-9815-8ce59b702afa` | 权限与文件访问、目录书签、预览、确认导入文本/PDF；10-15 按用户澄清复核当前接入 | WIP；当前 21 组 Swift / 共享渲染与模拟器编译通过；`docs/ios-permissions-files-20261014.md`；实体文件授权待验 |
| melo副线 | `019d5db3-d2cd-70c2-bc8f-955d36099219` | 固定源码统计口径、早期 pre-push evaluation 协议；OpenClaw/桌宠历史工作独立 | 2026-10-15 补文档交接；脚本静态核对与 `bash -n` 通过；176,085 是 10-14 历史统计，非当前计数；桌宠入口见[副线回执](docs/handoffs/melo-thread-backfill-20261015.md#secondary) |
| melo网站 | `019dce6e-faae-7850-a8bb-db48b737b928` | 2026-10-15 核对神经网络四区、外放标签和连续镜头源码/快照差异；首页有界轴向转动，非各层无限自转 | 独立本地 WIP，无 Git 元数据/可核实提交；历史 13 单元/22 浏览器未重跑；本轮静态核对旧站 9/9 散列与桌面副本一致；详见[网站交接](</Users/mortred/Documents/New project/melo-universe/HANDOFF-20261015.md>)，Safari/用户验收/发布待验 |
| Benchmark Melo on a major platform | `01a139e9-2509-7623-8cb7-4df16b2d0c86` | Melo 核心在 Mac，六个编码工具经外部适配接 Docker；2026-10-15 核对历史证据与当前 diff | 历史3/3、目标3/3/回归158/158、对照0/3；Requests81项非计分错误；外部WIP未产品化；非当前树验收；详见[跑分回执](docs/handoffs/melo-thread-backfill-20261015.md#benchmark)与外部 HANDOFF |

外部跑分证据：`/Users/mortred/Documents/New project/benchmarks/melo-swe-docker-agent-20261014/report.md`。网站旧目录 `site/`、`/Users/mortred/Desktop/melo_web` 与 `melo-universe/` 是不同产物；不能自动互相覆盖。

## 5. 保留的产品决定

- 副线统计沿用 `src`、`desktop-ui`、`desktop-app`、`scripts` 下 `js/mjs/cjs/ts/tsx/jsx/swift/sh/applescript/json/html/css` 文件的 `wc -l` 合计，含注释和空行，不含 `ios/` 及目录外内容；不是全平台总代码量，历史结果不代替实时统计。
- `git pp` 在 push 前评估，C/D 或无法解析评级时阻止 push；C/D 后 Claude 先按意见重提方案交用户判断。现行依据为 `EVALUATION.md`、`CLAUDE.md` 与 `scripts/codex-review.sh`；后续修复以 Git 和现源码为准。
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

2026-10-15 主线通过逐线程状态快照确认，8 条被通知线程的本次补录均为 `completed`，且本地对应记录存在。重复实现按实际源码归属合并：UI 辅助线程保留派发/截图证据，产品实现归 `melo ui`；设计增强与手机登录、文件权限分别记录。

| 已完成补录的线程 | 详细交接入口 |
| --- | --- |
| melo主线（历史·2026-10-15） | [登录交付及生命周期](docs/handoffs/melo-thread-backfill-20261015.md#historical) |
| 设计 Melo | [API 观测](docs/handoffs/melo-thread-backfill-20261015.md#design-api)、[阅读与图片保存](docs/handoffs/melo-thread-backfill-20261015.md#design-reading) |
| melo ui | [神经场景交接](docs/handoffs/melo-ui-20261015.md)、[原始回执](docs/handoffs/melo-thread-backfill-20261015.md#ui) |
| 读取 melo ui 方案 | [派发、历史测试与 Library 截图](docs/handoffs/melo-thread-backfill-20261015.md#ui-helper) |
| melo iphone | [文件权限接入与本次复核](docs/handoffs/melo-thread-backfill-20261015.md#iphone) |
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

### 2026-10-15 — melo主线 — 图片预览故障与承载计划

- 用户确认电脑端报错；原生点击复现，旧地址403/过期，原文件2,090,093字节存在，任务回看同文件重签200且SHA一致。当前仅调查/计划，未修产品实现。
- [方案](docs/image-capacity-plan-20261015.md)：P0访问恢复→资源盘点→原件可靠保存→缩略图/内存→磁盘缓存回收→大历史/排队→双端验收。已核对生成目录漏统计、预览文件生命周期、Base64/解码峰值与分散限额；尚未压测容量上限。
- 证据：`.tmp/image-capacity-audit-20261015/` 的签名状态、存储快照、源码散列；没有生成模型请求、清数据或安装。其他线程语言/质量/OAuth WIP保留。

### 2026-10-15 — 设计 Melo — 五语界面系统
- 线程 ID：`01a1161a-1919-79c1-9764-8709bb0e2e2d`；状态：实现与验证完成，正在本地提交；远端预审环境缺失。范围：中/英/韩/日/西班牙语；系统设置及左下快捷入口；手机同步接入。
- 已核对：当前没有语言层，`localSettings.js` 仅写固定中文；本机偏好由 `src/domain/settings/localPreferences.js` 校验，手机使用 UserDefaults。保留已有共享 WIP。
- 实现：`desktop-ui/i18n.js` / `translations.js` 显式静态词条、`languageControls.js` 左下入口，偏好 `interfaceLanguage`；手机同词条生成 `Localizable.xcstrings`、原生菜单及本机设置。用户文本与模型提示不翻译，保存失败保留原语言与草稿。
- 验证：语言浏览器及单元 7/7（五语、刷新保持、草稿、保存失败重试）；当前共享树 `npm test` 3496 JS + 23 Swift、语法/设置浏览器通过；独立 UI 370/370。实际桌面原生切换中→英→中与模拟器英文主页检查通过，修正手机按钮重叠。证据 `.tmp/language-20261015/`。
- 隔离提交树：367 UI、73 图像、21 Swift/共享渲染与模拟器构建通过；只提交本次语言变更，旧设计和其他线程 WIP 保留。入口 `docs/interface-languages-20261015.md`；未更改用户默认中文、手机账号或聊天资料。原生设置日语预览遇到模拟器既有凭据错误，菜单触控/其他子页与实体机仍待验。

### 2026-10-15 — 设计 Melo — 默认高质量与真实回执
- 状态：质量链路已本地提交 `fcb52d7`，界面与隔离暂存修正随语言提交；用户明确要求生成质量改高。桌面默认/设置、生图和编辑链路及手机请求均传 `quality: high`；运行中用户 imageSettings 已只修改质量为 high，保留原引擎和账号。
- 文件：`src/images/imageSettings.js` / `codexImageEngine.js`、`src/services/chat/imageTask.js` / `imageEditFastPath.js`、`src/tools/builtins/imageTool.js`，桌面 `imageControls.js`、手机 `ImageWorkflow.swift` / `CodexOAuth.swift`。回执保留请求和实际质量，禁止把请求值当成服务结果。
- 验证：72 项图像协议测试通过；一次合成图真实请求确认工具参数 high、HTTP 200，但 Codex 服务回报 low。证据 `.tmp/language-20261015/quality-live.json` 与 PNG；未换付费通道、未自动重生成。
- 未完：上游没有按 high 执行，不能声称实际高质量已实现。当前桌面服务已重启加载并回读 high（PID 59032，`desktop-live.json`）；手机仅装独立模拟器，未覆盖实体机。`git pp` 因本机预审可执行文件缺失 ENOENT 停止，未推送或绕过。
