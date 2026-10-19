# Melo 下一步 Issue Backlog

发布更新（2026-10-19）：已按最新主线 `b64fe54` 修订并创建 14 个 GitHub Issues，见 [编号索引](github-issue-index-20261019.md)。A05 已修不建单；A02 当前复测通过，转并发调查；UI P2 已完成，A13 收窄至 Backend。本文件下文保留原固定 SHA 审查，不代表每项仍是当前未修故障。

基线：`master @ 83654dd1d59e854c3d347924bf604258b44eaab1`；`codex/mobile-use-features @ bcdb276f9d9a9282c9cecc69e4a58875ec34cb72`。日期：2026-10-19（Australia/Sydney）。

只读分析固定 master 与 Android 工作分支，检查真实入口、最近改动、历史待办和离线回归。不是全部源码逐行审查、完整安全审计或真实任务成功率测评。未合并、改产品代码、Push、创建 GitHub Issue、操作手机或使用真实模型凭证。

先修已复现故障，再统一 Loop / Tool / Session 的决策与记录边界。暂不整体换 DSH；Eval 放在 Core 收敛之后。

GitHub：Open Issues 0，Open PR 0；以下编号为本地建议，未创建远端工单。

S：小范围修正；M：跨模块修正；L：需分阶段迁移。仅表示相对工作量，未做实施 PoC，不是工期承诺。

## 建议执行顺序

- 第一批：有明确 RED 的修正：A01, A02, A03, A04, A05, A10。可以拆成独立的小提交。A10 先建立可复现的检查入口，不能靠忽略 A01 / A02 得到绿色。
- 第二批：逻辑统一：A06, A07, A08, A09。先讨论接口和迁移边界，延续用户选择的本机 JS Core + Adapter，不自动合并或换整个 DSH Runtime。
- 第三批：平台体验与容量：A11, A12, A13, A14, A15。按需求与实际瓶颈选择；Eval 不作为开始收敛 Core 的前置条件。

## 建议 Issue

### A01 · P1 · 修复 inode 复用导致的文件身份校验失效

范围：master / Linux-WSL；类型：已复现 Bug；相对工作量：M–L。

批准时记录的目录被删除重建后，文件系统可能复用相同 dev / ino。当前校验仍接受旧身份，隔离探针中删除了替换目录里的新文件。

证据：固定 master 构建 Native Addon 后，相关 dirfd / file tools 回归仍失败。独立 8 次临时目录探针均复用 inode、均未拒绝、替换文件均被删除。仅证明本机 WSL/Linux 场景；未验证远程利用或 macOS 行为。

第一步：复用现有 dirfd 体系核对审批前后资源所有权，设计能区分被替换对象的持有与复查方式。birthtime 在本机部分试次也相同，不能只追加一个毫秒时间戳检查。

验收：

- Linux 与 macOS 上，审批期间替换文件或父目录时拒绝提交，替换对象保持完整
- 正常编辑、移动、回收与恢复仍通过
- 取消、超时和失败释放持有的 FD，不扩大文件授权

前置：无

源码：

- [src/safety/dirfdOps.js:371](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/safety/dirfdOps.js#L371)
- [src/safety/dirfdOps.checked.test.js:66](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/safety/dirfdOps.checked.test.js#L66)
- [src/tools/builtins/phase2a.fileTools.test.js:331](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/tools/builtins/phase2a.fileTools.test.js#L331)

本轮诊断：[melo-review-20261019-inode.json](evidence/melo-review-20261019-inode.json)

### A02 · P1 · 修复项目页手写记忆保存时的 SQLite 锁错误

范围：master / 项目记忆保存；类型：已复现 Bug；相对工作量：M。

新建项目成功后，保存第一条手写记忆就可能返回 HTTP 500，直接阻断项目记忆功能。

证据：现有 projectMemorySync.http 测试在全组及串行专项均失败。独立新 home 通过真实服务复现：POST /api/projects=200，POST /api/projects/memory-book=500 / database is locked；有效 Fixture Token 的 GET /api/project-memory-sync=200。不是把同步鉴权失败误判成数据库故障。

第一步：定位保存路径中的 SQLite 连接、事务、Schema 初始化和迭代器生命周期；根因尚未最终定位。先保留当前真实 HTTP RED，不以增加重试次数掩盖失败。

验收：

- 新 home 和已有项目都能创建、读取和编辑手写记忆
- 与后台索引、项目记忆同步并行时不会返回 database is locked
- 失败不报告虚假成功；重启后数据、冲突版本与重放一致

前置：无

源码：

- [src/services/memory/memoryManagement.js:66](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/services/memory/memoryManagement.js#L66)
- [src/memory/projectBook.js:304](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/memory/projectBook.js#L304)
- [src/http/projectMemorySync.http.test.js:11](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/http/projectMemorySync.http.test.js#L11)

本轮诊断：[melo-review-20261019-sync-probe.json](evidence/melo-review-20261019-sync-probe.json)

### A03 · P1 · 让自然推荐请求获得正确的 Search 能力

范围：master / API Key Search；类型：路由探针已复现；相对工作量：M。

用户正常说‘Surry Hills 有什么好吃的饭店’时，API Key 路径可能没有可调用的 Search Tool，从而只凭模型知识回答。

证据：主线 buildSearchPlan 对三个自然餐厅 / brunch 推荐问法均返回 none / no-web-intent / exposedNetworkTools=[]；显式 search 问法会开放 web_search 与 fetch_url。Codex 路径仍可能单独携带 Native Search，不能据此断言所有 Provider 都不能搜索。

第一步：对照 Android 分支现有共享 Router 收敛意图与能力判断；围绕当前任务、限制、后续追问和连接能力组织路由，避免只加一个 brunch 特判。

验收：

- 公开、时效性推荐可以调用可用的 Search Backend，并保留来源
- 明确禁止联网、闲聊和用户指定 App 的内部搜索保持原有边界
- Search 不可用时说明原因，不自动占用手机屏幕

前置：无

源码：

- [src/retrieval/searchRouter.js:151](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/retrieval/searchRouter.js#L151)
- [src/services/chat/chatExecutionRunner.js:943](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/services/chat/chatExecutionRunner.js#L943)
- [shared/agent/search.js:1](../shared/agent/search.js#L1)

### A04 · P1 · 修复历史图片短期签名过期后的预览和下载

范围：master / 历史图片；类型：源码与生命周期探针确认；相对工作量：M。

图片原件仍在，但历史消息保留的 URL 已过期或属于旧进程，预览和下载失败。

证据：签名默认 10 分钟、密钥按进程生成；探针验证过期或新模块实例均拒绝旧签名。imagePreview 直接复用 img.src，onerror 仅显示失败，下载再次请求同一 URL。历史专项也记录过原件存在、旧 URL 403；本轮未重做原生 UI 实点。签名过期本身是正常设计。

第一步：基于可信登记的附件 / Artifact 身份解析并刷新访问 URL，使预览、下载和聊天图片消费同一入口。不要仅解码旧 p 参数就给任意路径重签。

验收：

- 超过 TTL、重启、换端口、重开历史后仍能查看和保存原图
- 刷新有次数上限，区分过期、缺文件和损坏
- 原件 SHA 不变；跨 home、越界路径和软链接目标仍被拒绝

前置：无

源码：

- [desktop-ui/imagePreview.js:24](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/desktop-ui/imagePreview.js#L24)
- [src/web/urlSigning.js:32](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/web/urlSigning.js#L32)
- [docs/image-capacity-plan-20261015.md:66](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/docs/image-capacity-plan-20261015.md#L66)

本轮诊断：[melo-review-20261019-probes.json](evidence/melo-review-20261019-probes.json)

### A05 · P1 · 统一协议层与 Core 的单轮 Tool Batch 上限

后续状态（2026-10-19）：本工作分支已修复并通过 9 / 32 / 33 个调用的生产 Loop 回归；见 [收尾与证据](mobile-branch-wrap-20261019.md)。下文保留审查时的原始基线。

范围：mobile 分支 / Node Host；类型：已复现契约冲突；相对工作量：S。

协议层接受的合法批次进入共享 Core 后被 INVALID_BATCH 拒绝，整轮无法继续。这个问题属于未合入主线的工作分支。

证据：Parser 上限为 32；Node createCoreTurn 未传 callsPerRound，Core 默认 8。探针中 8 个调用通过，9 和 32 个调用均由 Parser 接受、由 Core 拒绝。Android 当前明确要求每次只调用一个工具，不把它的 single() 单独报成批量崩溃 Bug。

第一步：让上限来自同一份执行配置 / Contract，并由 Host 显式传入；保留整批校验与零副作用拒绝。

验收：

- 批次边界 1 / 8 / 9 / 32 / 33 在协议层与 Core 上有一致结果
- 未知工具与合法同批工具的配对结果正确
- 重复 call ID、超限或取消时不会提前执行部分副作用

前置：无

源码：

- [shared/agent/turn.js:22](../shared/agent/turn.js#L22)
- [src/runtime/sharedAgentCore.js:4](../src/runtime/sharedAgentCore.js#L4)
- [src/services/chat/chatExecutionRunner.js:787](../src/services/chat/chatExecutionRunner.js#L787)
- [src/tools/functionCalling.js:7](../src/tools/functionCalling.js#L7)

本轮诊断：[melo-review-20261019-probes.json](evidence/melo-review-20261019-probes.json)

### A06 · P2 · 统一 Loop 决策与 Tool 执行接口，保留平台 Adapter

范围：Desktop / Android / iOS；类型：架构缺口；相对工作量：L。

同一策略需要分别修改主 Chat、Subagent、Skill Executor、Swift Loop 和 Kotlin Host，单改规则常量不能保证行为一致。

证据：主线 Node Chat Runner、subAgent、skillExecutor 均有工具循环；Swift 有独立 AgentLoop。mobile 分支 Node / Android 已消费共享 Reducer，但外围仍有自己的终止、预算与结果处理。主线尚无 Android 或 shared/agent。

第一步：先写输入事件、状态、Effect、终态和 Host 接口映射，选一个现有生产入口逐字抽取。随后迁移主 Chat 与子循环，再接 Kotlin / Swift；不把 Git merge 当成逻辑已统一。

验收：

- 每条通用策略只有一个生产实现，Host 负责 HTTP / 存储 / OS Effects
- 相同事件在各引擎得到相同的许可、预算及终态
- 保留主线的上下文、工具记录、审批与取消修复；未完成的平台显式列出

前置：A05

源码：

- [src/services/chat/chatExecutionRunner.js:849](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/services/chat/chatExecutionRunner.js#L849)
- [src/agents/subAgent.js:192](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/agents/subAgent.js#L192)
- [src/agents/skillExecutor.js:239](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/agents/skillExecutor.js#L239)
- [ios/Melo/AgentLoop.swift:190](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/ios/Melo/AgentLoop.swift#L190)
- [docs/specs/2026-10-17-shared-agent-search-design.md:1](../docs/specs/2026-10-17-shared-agent-search-design.md#L1)

### A07 · P2 · 把任务完成条件与工具调用成功分开表达

范围：普通 Agent Task；类型：完成证据边界；相对工作量：M。

调用了一个工具且返回 ok，不能证明用户请求的研究或操作目标已经完成。

证据：主线无 Tool Calls 即进入最终回答；Verification 还依赖模型输出不确定性标记。mobile Core 的 requiredTools 检查成功工具名称，不接收任务目标和源内容；无关查询只要工具 ok 也可满足这个检查。Android DeviceCompletion 已有屏幕终态校验，不应把它描述成完全没有验证。

第一步：围绕任务类型定义可观察的 Completion Receipt：查资料需要来源 / 已读状态，导航需要目标页面，缺证据用 partial / blocked。复用现有设备验证，不给每轮无差别增加一次 LLM Judge。

验收：

- 完成、部分完成、受阻、取消和预算耗尽区分清楚
- 确认目标已达到时及时结束；无进展和重复调用有界
- Tool ok 不自动等同 task achieved，未知证据保持未知

前置：A06

源码：

- [src/services/chat/chatExecutionRunner.js:965](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/services/chat/chatExecutionRunner.js#L965)
- [src/services/chat/chatExecutionRunner.js:1195](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/services/chat/chatExecutionRunner.js#L1195)
- [shared/agent/turn.js:100](../shared/agent/turn.js#L100)
- [android/app/src/main/java/com/melo/android/device/DeviceTaskLoop.kt:14](../android/app/src/main/java/com/melo/android/device/DeviceTaskLoop.kt#L14)

### A08 · P2 · 让 Android 使用统一的 Context Budget 与原文回读策略

范围：Android 长对话；类型：平台能力差距；相对工作量：L。

手机对话超过近窗后早期约束可能消失；字符上限与模型 Token 容量不等价。

证据：Android ChatPhoneUse.history 只取最后 60 条，正文总长上限 160000 字符；普通共享 Chat 只注册 web_search / fetch_url / phone_use。主线 Node 和最新 iOS 已有按模型容量裁剪、压缩卡与 read_history；不能把历史 iOS 截断缺陷继续算成未修。

第一步：统一 Context 计划、来源开关和预算结果，原文与摘要留在平台存储 Adapter。先保证被窗口排除的本对话原文可按权限回读，再接压缩。

验收：

- 长对话中的早期决定能由原文回读或有出处的摘要恢复
- 模型窗口、图片和工具返回共同纳入预算
- 重启保留压缩边界；关闭的项目 / 资料不从核实或成员路径旁路进入请求

前置：A06

源码：

- [android/app/src/main/java/com/melo/android/chat/ChatPhoneUse.kt:35](../android/app/src/main/java/com/melo/android/chat/ChatPhoneUse.kt#L35)
- [android/app/src/main/java/com/melo/android/chat/SharedChatAgent.kt:93](../android/app/src/main/java/com/melo/android/chat/SharedChatAgent.kt#L93)
- [ios/Melo/PhoneContext.swift:1](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/ios/Melo/PhoneContext.swift#L1)
- [src/services/chat/contextBudget.js:1](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/services/chat/contextBudget.js#L1)

### A09 · P2 · 统一 Session Events 及模型 Context、UI 的投影

范围：执行历史 / Replay；类型：状态与可观测性；相对工作量：L。

本轮 history、持久 Tool Chain、执行侧车和 UI 状态存在多条组织路径，增加重启、追问和跨 Provider 调试的成本。

证据：主线 functionSession.append 推进本轮 loopMessages，另保存 ToolInvocationRecord / Scene；toolChain 历史重放默认关闭，并且不是现有跨端同步协议的一部分。已有记录能力应复用，不能称 Melo 完全没有执行日志。

第一步：借鉴 DSH 的事件边界，先定义 turn / model / tool / terminal 的规范事件与稳定 ID；用投影生成执行卡和可回放模型历史。仅迁移相关记录，不重做整套存储。

验收：

- 取消、重启与 Provider 切换后，已执行的步骤有一致可解释记录
- UI 与模型输入可追溯到相同事件，敏感字段仍有白名单和脱敏
- 回看日志不触发真实动作；恢复不盲重放结果不明的副作用

前置：A06

源码：

- [src/services/chat/chatExecutionRunner.js:1073](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/services/chat/chatExecutionRunner.js#L1073)
- [src/services/chat/messageBuilder.js:535](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/services/chat/messageBuilder.js#L535)
- [src/services/chat/toolTraceReplay.js:1](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/services/chat/toolTraceReplay.js#L1)
- [src/tools/toolInvocationRecord.js:1](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/tools/toolInvocationRecord.js#L1)

### A10 · P2 · 建立可复现的跨平台测试入口和 CI

范围：Linux / macOS / Android；类型：验证与 CI；相对工作量：M。

仅靠某台开发机的绿色结果，无法发现 Linux 文件身份、SQLite 路径和手机独立运行中的差异。

证据：固定主线树没有提交 GitHub / GitLab CI 配置。部分 Browser Tests 硬编码 /Applications/Google Chrome.app；本机 Ruby 未安装也导致一个版本探针用例失败。restoreArtifact 的一项整组失败在单独运行时通过，表明 Fixture 顺序 / 常驻缓存隔离需要修。初轮缺 Native Addon 是本次快照准备问题，不作为产品缺陷。

第一步：先分清 Pure Unit / HTTP / Browser / Native / Device Gate，统一浏览器查找和 Fixture 初始化；Linux 构建 Addon 跑服务层，macOS 跑 Swift，Android 单独编译和 Emulator。

验收：

- 新 checkout 的依赖、构建和测试步骤可重现
- 环境缺失与业务失败有清楚分类，不用静默跳过关键失败换取绿色
- 主线 Native / DB RED 修复后成为稳定 Gate；不能把日常通过称完整发布通过

前置：无

源码：

- [scripts/run-unit-tests.js:1](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/scripts/run-unit-tests.js#L1)
- [desktop-ui/imagePreview.browser.test.js:29](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/desktop-ui/imagePreview.browser.test.js#L29)
- [scripts/verify-daily.js:1](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/scripts/verify-daily.js#L1)
- [src/services/workspace/workspaceMutations.test.js:297](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/services/workspace/workspaceMutations.test.js#L297)

### A11 · P2 · 为 Task Cache 增加布局与 App 版本的变体策略

范围：Android / Fold6；类型：Fold / Cache 改进；相对工作量：M。

同一目标在 Fold6 内外屏的页面结构不同，复用不适配的脚本会先失败，再进入后续处理，损失 Cache 收益。

证据：cacheScope 包含 Agent / Project / displayId / instructions，DeviceScript 不记录姿态、窗口布局或 App 版本。同 displayId 不等于同一布局。但现有 Replay 会重新定位 selector、拒绝陈旧屏幕并校验终态，因此本轮没有证明会跨姿态盲点旧坐标。

第一步：明确可共享脚本与布局变体的匹配策略，加入布局 / 版本变化后的失效和重新验证；保留跨布局仍有效的语义 selector。

验收：

- 同任务内外屏分别命中兼容脚本；切换姿态后不使用旧 screen_id
- App 更新或页面变化后安全停止 / 受控重新探索
- Exact Hit 仍为零 LLM；记录命中、失效与 fallback Latency

前置：无

源码：

- [android/app/src/main/java/com/melo/android/device/DeviceAgent.kt:78](../android/app/src/main/java/com/melo/android/device/DeviceAgent.kt#L78)
- [android/app/src/main/java/com/melo/android/device/DeviceScripts.kt:19](../android/app/src/main/java/com/melo/android/device/DeviceScripts.kt#L19)
- [android/app/src/main/java/com/melo/android/device/ScriptRunner.kt:1](../android/app/src/main/java/com/melo/android/device/ScriptRunner.kt#L1)

### A12 · P2 · 完成项目移动、删除和恢复的生命周期设计

范围：Project / Workspace / Sync；类型：生命周期功能；相对工作量：L。

项目归属、任务审批、长期记忆、原图与同步 Tombstone 相互关联，后续功能容易在不同模块各写一套处理。

证据：当前项目服务 / HTTP 路由提供 create / update，仓库仍把项目聚合和完整删除级联列为后续。已有 Chat 文件删除与 Artifact 回收能力，不应当作项目生命周期已完成。此项是待设计功能，不是已证明发生数据丢失。

第一步：先定义归档 / 解除归属 / 删除 / 恢复的可观察行为、操作日志与跨端兼容，再接 UI；默认保留聊天、图片和用户外部工作目录。

验收：

- 移动聊天不会改变已执行运行的目标快照；旧审批失效规则明确
- 中断的删除步骤可恢复，旧设备离线回来不复活项目
- 无外部目录递归级联删除，资产引用和记忆状态有可检查结果

前置：A02, A04

源码：

- [src/services/project/projectMutations.js:21](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/services/project/projectMutations.js#L21)
- [src/http/domainRoutes.js:81](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/http/domainRoutes.js#L81)
- [docs/project-architecture-plan-20261015.md:83](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/docs/project-architecture-plan-20261015.md#L83)

### A13 · P3 · 按职责拆分大入口，优先 Chat 和执行视图 Controller

范围：Desktop UI / Services；类型：定向 Refactor；相对工作量：M / 每个模块。

大量界面事件和状态集中在单一文件，修改一处交互需要理解过大的上下文。

证据：主线物理行数（含注释空行）：desktop-ui/app.js 13711，chatExecutionRunner 1341，memory/store 2805，webSearchTool 2786。行数只是定位信号，不能独立证明 Bug；已有领域模块和依赖边界测试应保留。

第一步：先选一条 Chat / Run UI 的职责边界，byte-for-byte 移植并保持公开接口，再独立简化。Memory / Search 的拆分另开 Issue，不在一个 PR 中整库改名搬家。

验收：

- 首个迁移提交仅改变组织与接线，行为保持
- 草稿、焦点、滚动、Streaming 与取消由实际行为测试覆盖
- 中央入口减少职责，不只是多一层转发文件

前置：A10

源码：

- [desktop-ui/app.js:1](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/desktop-ui/app.js#L1)
- [src/runtime/architectureBoundary.test.js:1](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/runtime/architectureBoundary.test.js#L1)
- [CLAUDE.md:1](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/CLAUDE.md#L1)

### A14 · P2 · 建立大历史容量与首字等待基线，再决定分页边界

范围：大历史 / Bootstrap；类型：待测量性能；相对工作量：M。

对话、工具记录、图片和索引持续增长，需要知道实际瓶颈在读取、投影、传输还是 UI 渲染。

证据：Bootstrap 仍加载状态、排序全部聊天并组装工作区 / 资料等投影；总览也说明冷启动读历史、正文未分页。bench:turn 使用模型和 Embedding Stub，只测 Melo 开销；本轮未压测，不能据文件大小宣称当前已经很慢。

第一步：用合成历史分别测冷 / 热 Bootstrap、TTFT 前本地开销、序列化字节与内存，记录样本规模，再针对实际热点分页或延迟加载。

验收：

- 不同历史规模有可重复的 p50 / p95、载荷字节和峰值内存
- 模型网络时间与本地开销分开
- 分页 / 缓存后仍保留当前聊天、草稿、检索和历史跳转语义

前置：A10

源码：

- [src/services/desktop/bootstrap.js:229](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/src/services/desktop/bootstrap.js#L229)
- [scripts/bench-turn.js:1](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/scripts/bench-turn.js#L1)
- [MELO_OVERVIEW.md:100](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/MELO_OVERVIEW.md#L100)

### A15 · P2 · 从已知失败建立最小 Task Replay / Eval 集

范围：Core 收敛之后；类型：后续质量验证；相对工作量：S 起步。

现有 Regression Tests 能保护实现，仍需要比较任务是否完成、工具是否合适以及成本是否退步。

证据：EVALUATION.md 是代码审查 Rubric；Memory Bench 有可执行脚本，但公开 Golden 只有两个示例，实际查询集忽略入库。bench:turn 是 Stub 性能基准。未找到统一的 Agent Task Dataset / Runner / Scorer。

第一步：尊重先收敛逻辑的顺序，在 A06 / A09 稳定后，从本次自然搜索、重试、调用批次、完成和取消 Case 形成少量可回放任务；各端共用一份协议和数据。

验收：

- 一个 Runner 能在不同 Host 上比较相同任务与事件
- 先检查可确定的工具、限制、来源、终态、重复次数和 Token / Latency
- Fixture 回归与真实 LLM 质量结果分开，不把一批 Stub 测试当真实成功率

前置：A06, A07, A09

源码：

- [EVALUATION.md:1](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/EVALUATION.md#L1)
- [bench/memory/golden.example.json:1](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/bench/memory/golden.example.json#L1)
- [bench/memory/README.md:1](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/bench/memory/README.md#L1)
- [scripts/bench-turn.js:1](https://github.com/MortredVigoss/Melo/blob/83654dd1d59e854c3d347924bf604258b44eaab1/scripts/bench-turn.js#L1)

## 验证边界

- master 初轮 JS 探针：3207 pass / 205 fail / 1 cancelled / 20 skipped。442 个测试文件；缺快照 Native Addon、macOS Chrome 路径及强制 Offline 模式等影响结果，不解释为 205 个产品 Bug。
- master 构建 Addon 后非 Browser 探针：3924 pass / 16 fail / 20 skipped。显式排除 .browser.test.js，仍强制 Offline；与正常完整 Gate 不等价。
- master 无强制 Offline、串行 8 文件专项：229 pass / 9 fail。压缩类原失败消失；剩余为文件身份校验、项目记忆 HTTP、Ruby 缺失和 Fixture 顺序问题。
- mobile Shared Agent Core：84 pass / 0 fail。npm run test:agent-core；包含现有 Conformance 等，不能证明所有边界已经覆盖。
- 独立诊断：inode 8/8 复用并漏拦截；memory-book HTTP 500；批次 9/32 拒绝。全部使用临时目录、空 home、合成数据或本地函数。
- 源码快照完整性：1329 / 1329。全部 Blob 与固定 master SHA 一致，测试未修改被审产品源码。

## 已排除与仍不确定的项目

- 主线上一轮七项 iOS 对齐问题已有修复，不重新当作当前未修 Bug。
- 当前 mobile 分支 5 个 shared/agent 测试文件均被默认 Test Discovery 发现。
- Android DeviceAgentClient 明确限制单次一个 Tool；single() 不能独立证明多调用崩溃。
- Task Cache 已重新定位 selector、检查旧屏幕和终态；未证明跨姿态盲点坐标。
- restoreArtifact 的整组失败单独运行通过，应先修 Fixture / 常驻缓存隔离，不直接声称恢复功能损坏。
- 本机没有 Ruby；版本探针失败不能据此断言 Bash 权限策略错误。
- 强制 Offline 导致的压缩测试失败已通过无该开关的专项排除。
- GitHub Actions workflows API 读取被 Connector 拒绝；仅报告源码没有 CI 配置，不声称所有外部 CI 都未运行。

原始日志在实际仓库 `.tmp/repo-review-20261019-*.log`。这轮没有合并、产品改动、真实模型请求、设备操作、GitHub Issue 创建或 Push。
