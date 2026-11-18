# Melo 总览：当前事实、功能索引与接手入口

更新时间：2026-11-16（Australia/Melbourne）。这是所有 Melo 工作线程共用的人工维护入口：顶部依次是当前事实、功能索引和最新交接；按日期的阶段过程（含日期、提交与当次验证数字）在 [总览历史交接](docs/handoffs/overview-history-20261019.md)。

## 1. 先看这里

- Mac 工作仓库：`/Users/mortred/Desktop/melo/Melo Desktop Project`；Android Integration 的 WSL 工作仓库：`/home/zhouy/workplace/Melo`。Codex 的独立任务目录不一定是实际 Git checkout，接手必须核对 `git rev-parse --show-toplevel`。
- 本文保存当前事实、功能索引、架构边界、跨线程登记和最新交接；`PROGRESS.md` 保存意图时间线；专项文档保存详细证据；Git 保存代码历史；`architecture/modules.json` 是生成的功能地图。`codex.md` 是自动生成快照，不手改。
- 接手顺序：`MELO_DEVELOPMENT_STANDARD.md` → 本文 → `git status --short` → `npm run scope -- <改动文件>`（只报告受影响功能、另一端与选组）→ 本次模块的实际 diff / 源码与证据。正常工作不用完整回读线程。
- 记录缺失、线程更新时间晚于交接、源码与文档冲突时，只定向读该线程近期相关轮次，再补本文；不要靠旧总结覆盖新代码。
- 2026-10-15 已确认通知的 8 条线程全部完成补录回复；当前主线复核总览、源码/Git 与关键证据，集中归档详细回执。完成补录不等于产品任务全部验收；详见[历史交接](docs/handoffs/overview-history-20261019.md)的补录登记与[核对报告](docs/handoffs/melo-doc-reconciliation-20261015.md)。
- 本文不是自动监控：各线程必须在实际改动后主动更新。未更新的线程或未记录的 diff 应标为“待归属/待核对”。

## 2. 当前事实

11-16：新增实时语音对话（方案 A 级联全双工；用户在 A/B/C 三方案中选定，平台"桌面 + iPhone 一起"）。聊天输入区点通话按钮后一直听，说完自动作为语音轮发出，回复按句读出，朗读时开口即打断，回复进行中说的话作为补充，说"停 / 算了"取消；审批只在屏幕上点。语音轮提示、读出规则、停止词与时长在 agent-loop.json 的 `voiceTurn` 节，桌面与 iPhone 跑同一份夹具；Mac 与 iPhone 共用 Swift 通话引擎。只有离线测试、编译与门禁（快速档扩为全量 `run-AosjeK` 全绿，追加修正 `run-pUhuXa`），没有真机麦克风和真实模型验收；当晚已装到两端：iPhone 0.7.20 (52) 覆盖并首启；桌面 `release:verify` 17 项全绿并覆盖，但数据目录待用户恢复，装后没有正常启动（[安装回执](docs/realtime-voice-plan-20261116.md)（第 11 节））。见[方案与实施记录](docs/realtime-voice-plan-20261116.md)。

11-14 第四轮：本机 12 个没有并入 master 的分支全部并入，`git branch --no-merged master` 为空。11 个的内容 master 早已有，只记录、不改文件。`codex/reply-latency-20261109` 带进来 7 项并按 master 现在的代码改写：iPhone 回答草稿（API 密钥连接改为流式）、相同的被拒答案不重复核对（三端）、同一网页后续分页不重新加载、运行与暂停时间等；master 已有自己做法的 8 项保留 master 的；并入时修掉分支流式解码器的 4 处问题和"不重复核对在 iPhone 上从不生效"。**iPhone 两个只读成员同时运行没有启用**，要在 master 现在的成员机制上重新设计，等用户决定。只有离线测试、模拟器和门禁（`run-NIhf3d`、`run-eZv89f`），没有真实模型验收；手机要重装才有这些变化。见[合并记录](docs/unmerged-branches-merge-20261114.md)。

11-14 第三轮：用户对上一轮留下的清单作了决定（"全按你推荐的来"）。智能选模的代码三端全部删除（产品早已固定使用所选模型），连同记忆提供方栈、外部向量后端、旧搜索规划器、Browserless 预设、后台命令任务等 14 项；核实过的 37 个问题修掉，其中两个是核实时才发现的：macOS 上浏览器会话每个进程只能打开一次、PDF 工具走浏览器的路径一直生成不了 PDF。新增 `file_restore` 工具；29 个聚焦测试命令改为在临时数据目录里走测试池。4 条待用户决定，桌面壳未重编、手机未重装。见[清理记录](docs/dead-code-cleanup-20261114.md)第 11 节。

11-10 Agent 全链路审计分两轮：第一轮接上 Android 的回复延迟修复、修掉"停止回复会带崩内核沙箱"、修 43 处（[记录与审计](docs/agent-audit-20261110.md)）；第二轮把留下的约 50 条未核实报告、4 条未改问题和 6 项待决定逐条处理，再修 97 处，8 条不成立，16 条没改并写明原因（[第二轮记录](docs/agent-fixall-20261110.md)）。两轮都只有模拟器、离线测试与门禁，没有真实模型验收。**第二轮没有推送**：`git pp` 的推送前评级是 C，三条发现已修复并验证，推送等用户再说一次。**桌面真实数据目录11-16 23:56 已恢复（用户说"你来恢复"后由 Claude 在终端面板执行 `restore-keep.py --apply`：33 段对话、6 个 Agent、33 个对话文件与 11-05 备份清单逐一一致；受损的两份改名为 `state.json.damaged-20261110`、`threads.damaged-20261110` 留在原地；23:57 正常启动读的是恢复后的数据）。**

10-28 用户反馈0.10.7首个模型请求76秒失败，截图证明13工具已注册而非Tool缺失。确认Android Tool Transport强制stream=false、错误步骤/Chat卡不显示实际原因；现修复连接Stream配置与三协议SSE完整回执、分片/断流安全、HTTP/Timeout诊断和折叠错误展示。201项JVM、Native29（含折叠错误展示/重启与SSE主Loop）已过；视觉截图已核对。用此前授权Proxy Key做单次公开合成GPT/Modal请求，13Tools+Streaming返回200/15.692秒/web_search参数校验过，未执行工具、未发送私人Trace；不等于手机全任务验收。快速/集成档均仅2素材失败；完整test:full的Android/Browser/Runtime Smoke过，素材/macOS环境仍红、Swift跳过；[0.10.8（32）Pre-release](https://github.com/MortredVigoss/Melo/releases/tag/android-v0.10.8-organizer-preview.1)已发布并匿名下载200，Tag固定8d76036，不合主线。此次用户GPT/Modal实际失败原因尚无原始记录，不能声称已证明是504或已实机修复。私人Trace仅本地、未操作手机，实际请求仅上述公开合成检查。[Transport专项](docs/android-model-transport-fix-20261028.md)。

10-28 用户现授权对当前Branch单独Release，已推送codex/android-organizer-20261026并发布[Android 0.10.7 Pre-release](https://github.com/MortredVigoss/Melo/releases/tag/android-v0.10.7-organizer-preview.1)，Tag固定fd3bd0d，不合并master。APK+SHA256SUMS匿名下载200、GitHub digest一致，与0.10.6同签名。已补集成档run-dkvzlN与完整test:full：Android/Browser/Runtime Smoke通过；全量JS仍仅两项私有桌宠素材失败，macOS打包/安装/启动在Linux失败、Swift跳过，不能称完整发布Gate GREEN。私人Trace仅本地。[发布回执](docs/android-0.10.7-branch-prerelease-20261028.md)。

10-28 已落实共享任务/证据契约与生产Android单决策Loop：phone_action/phone_workflow回到同一Chat Loop，原生Session无Model；Routing仅建议、明确Workflow依赖保留。修复反馈误派任务、完成证据截断/误分类、每轮丢历史、跨页已生效状态丢失、动作后观察失败与残留输入Cache；成功子流程独立发布并参数重放。0.10.7（31）：Core240/JVM190/Native50通过，最终APK再跑生产Chat6项通过；真实Bedrock五个样本独立UI校验，导航27.137→19.563秒，浏览器59.661→28.295秒/12→3请求，换词30.084秒命中同Cache。run-PyqRFL JS4636过/2缺私有素材失败/15跳过；Lint/Debug/Release、独立Settings浏览器、SceneBridge4通过。Swift/JSC待macOS、Fold6 OneUI待实机；不能称全仓GREEN。APK已导出Windows artifacts，Trace仅本地、未操作手机、未推送。[实现与完整验收边界](docs/android-unified-loop-20261028.md)。

10-28 用户要求手机拿走后完整分析最近会话，避免逐句补丁。已只读保存两份一致快照，完整读取最新4会话/34消息/18主执行/9设备执行；其中15次主执行确属0.10.6。确认共性问题：Android餐厅Skill与共享Web指导在实际请求中冲突；反馈/澄清被requiredTools和工具证据规则误判，108.91秒纯反馈出现6次模型请求；子循环每轮压缩导致已选目的地在Start后的下一轮丢失，随后继续操作并尝试关闭导航（被freshness拦住）；导航仅学到open_app、0次checkpoint，另有搜索Cache遗漏原输入前置条件；操作/观察错误状态混合。3个共用层故障已无模型/无手机本地复现。[审计、分阶段改进与验收](docs/android-session-harness-audit-20261028.md)已记录；该审计阶段仅改文档与本地诊断、未改运行时、未请求新模型、未推送；其后的实现与验证见上一条。原始私人Trace仅本地，不能沿用浏览器验收声称真实Maps导航已修。

10-27/28 用户要求改用 Emulator 自主验证真实任务、重复耗时及 Cache。0.10.6（30）空白页+冷进程基线下，Google搜索27.551→9.071秒（Model6→0）、网页跳转34.518→10.112秒（9→0）；ChatEngine真实注册入口49.209→26.255秒，自动phone_use→phone_workflow，同一Cache、子Model7→0（UI主请求2次，不含独立Completion Checker）。已修共享Core的URL强制fetch误判、串行工具请求、Focus、孤立参数和Manifest签名前缀；IME Search/Send、Hint/Label已验证，表单搜索37.773→10.392秒、实际请求9→0、独立终态校验通过。JVM182、Native19+4+2及Lint/Debug/Release过；run-feZKBk JS4625过/2缺私有素材失败/15跳过，未称全仓GREEN。换Google关键词固定结果标题失配仍有；自建QEMU内存问题已加仅针对其进程的监控，失败日志保留。[专项证据与限制](docs/android-browser-cache-evaluation-20261027.md)。用户随后明确要求安装手机：Fold6已备份覆盖0.10.6、启动及Accessibility绑定核对，保留旧连接，未跑手机任务；Trace保留策略/隔离与跨端仍WIP，仅本地，不推送。

10-27 共享 Loop 本地 Trace 设计已获用户认可，Core / Node / iOS / Android 录制实现为 WIP；用户要求 Trace 留在本地、不自动发送。当前 0.10.4（28）试用 APK 已覆盖安装 Fold6 并得到启动成功回执，保留现有数据；JVM170、Trace/HTTP12、Emulator Trace2通过，完整同范围快速档已结束（run-85yqsn，仅两项缺私有素材），不能称 Trace 已完成验收。继续本地隔离、保留策略及跨端验证；[设计](docs/specs/2026-10-27-loop-local-traces-design.md)、[试装回执](docs/android-local-trace-trial-install-20261027.md)。

10-27 0.10.3（27）按用户澄清改为独立成功动作即时持久化：原生 open_app 验证后立刻发布 action；checkpoint 验证后发布子流程，整项任务失败也保留。Chat 通过共享 Core 的 phone_workflow / 当前 Skill Manifest 原生重放，编辑/删除仍由本机缓存库管理。Core222/JVM170/Emulator69通过，Android构建与R8通过；快速档仅两项缺私有桌宠素材，不能称全仓 GREEN。已导出0.10.3 APK，Fold6未连接、未安装；不能用已保存子目标替代整项任务成功；[专项回执](docs/android-verified-action-cache-20261027.md)。

10-27 0.10.2（26）执行阶段已验证：能力目录不随措辞隐藏 phone_use、UI Tree 优先/按需图像、普通点击沿用任务授权、低对比关闭控件和旧缓存重校验；Core215/JVM164/Native63通过，快速档两项缺私有素材。见[执行回执](docs/android-phone-reliability-20261027.md)。用户最新明确动作/子流程成功应立即缓存，发布粒度后续由0.10.3继续，不把0.10.2阶段当成该功能完成。

10-27 补丁 0.10.1（25）已覆盖安装 Fold6：修复短句“重试”丢失原任务及 phone_use，并区分路由建议/实际注册目录；Core 213、Native 专项 11 通过，最新 APK 六种协议/执行组合通过。手机锁屏，真实汽水播放尚待解锁复测；见[补丁回执](docs/android-short-retry-fix-20261027.md)。

10-26 Android 接手：已将本地 master fast-forward 到 `248364b`，从最新主线建立 `codex/android-organizer-20261026`；原 Android 未推送工作保留在原分支 `1be64ad`，未混合合并。Goal Check 的 Calendar→Weather 受控回归通过，旧手机循环问题尚未全部解决；见 [主线复核](docs/master-loop-recheck-20261026.md)。用户已认可并实施 Todo / Calendar 独立页面、系统日历/ICS、通知与可选强提醒、同一 Repository 的 Chat Tools；[实施回执](docs/android-organizer-implementation-20261026.md)。补充修复动态广告引起的坐标 stale_screen 误拒绝，见[专项](docs/android-dynamic-ad-freshness-20261026.md)。当前 0.10.0 已完成：Core 212、JVM 160、Native 专项 26 全通过；完整 Native 87/88，宠物拖动仍失败；快速档两项缺失私有宠物素材，不能称全仓 GREEN。10-26 使用 Emulator；10-27 用户重新授权后，0.10.0（24）已覆盖安装到 Fold6 并确认启动，见[安装回执](docs/android-organizer-install-20261027.md)。真实汽水和强提醒交回用户试用，未推送。

每个功能只保留一个现行状态和证据入口。测试数字只属于当次源码，见所链带日期的回执；当前树需重新运行 `npm test`（日常）或 `npm run test:full`（发布）。过程与旧状态见[历史交接](docs/handoffs/overview-history-20261019.md)。

| 功能 | 现行状态 | 证据 / 待验 |
| --- | --- | --- |
| 项目与工作区 | 创建显式归属、执行器绑定能力、无项目聊天按需独立目录（A `33660c6` / B `b02438a`）；文件面板、每次删除询问文件去留与遗留文件管理 `7ae2292` | [架构加固](docs/arch-hardening-20261015.md)、[UI 功能对齐](docs/ui-function-alignment-20261016.md)；项目聚合模型与完整删除级联见[项目专项](docs/project-architecture-plan-20261015.md)；P1 提交回执已交付，桌面项目页已拆到 `desktop-ui/features/projects/`（P2a，[架构方案](docs/architecture-maintainability-plan-20261019.md)） |
| Agent、技能与团队 | Agent 演进 P0–P4 已实现，6 Agent / 26 成果已迁移；审查修正 `4680530`；统一设置页 `dc67fa0`；团队与委派同一规则，手机本机可运行团队；10-20 能力临时提升 / 即时开启与新 Agent 只读起步、「基于已有 Agent」（桌面 + 手机，手机以本机权限为上限） | [实施与迁移](docs/agent-evolution-20261015.md)、[审查修正](docs/agent-review-fixes-20261015.md)、[设置](docs/agent-settings-20261016.md)、[协作](docs/agent-team-20261016.md)、[能力临时提升](docs/capability-elevation-20261020.md)；真实模型协作与真机单列；[隐藏编排层审计 11-04](docs/agent-orchestration-audit-20261104.md) |
| 聊天与 agent loop | 手机与桌面同一循环（prepare → invoke-model → finalize），公共循环/预算策略现由 `shared/agent/` 同源执行，配置契约为 `shared/protocol/agent-loop.json`；10-23 已接入共享 `goal.js`：原始目标/补充、无工具交付检查、最多两次有预算纠偏；取消普通首步必搜，成员回执贯通团队，见[综合实施与验收](docs/agent-harness-implementation-20261023.md)（任务与基准集成验收均通过）；10-24 已覆盖安装桌面与 iPhone 0.7.10（42），数据保留及实际使用检查见[安装回执](docs/dual-update-20261024.md)；七项双端对齐修复 `ee8eb3f` / `3ad091c` 已推送并装入双端；桌面聊天页 / 输入区 / 发送管线已拆到 `desktop-ui/features/chat/`（P2c）；10-27 `99b8ba7`补齐零工具任务核验；后续[上限交付改造](docs/limit-delivery-20261027.md)已实现只计工具轮、默认40轮、预留收尾、成员部分交接后主 Agent 补做（三端契约同源，最终快速/7ae6bf5集成已通过）；10-27 `d0bcf3e`–`77b2879` 只计工具轮、默认 40 轮 / 硬顶 64、预留额度收尾交付（LIMIT_DELIVERED）、成员 / 技能部分交接后主 Agent 续跑，已推送；11-04 / 05 Claude 方案 A：内部岗位成员独立运行（份额 / 并行）、限额收尾保留已核实事实、执行成员启动前“本次任务”审批卡、Agent 设置页岗位模型（`afc9992`–`4e56677`，已推送），见[编排实施记录](docs/agent-orchestration-implementation-20261104.md)；11-05 Codex 修复审计 R1–R7（`5d1a514`：整轮副作用账本、报告不作执行凭证、`jobModels` 不进 v1 线协议、执行岗强档、硬截止、同 URL 分页保留、完整岗位连接）并落地任务评估 B（`201b9c9` / `2cb936b`：共享 `taskEvaluation.js` 策略、`task_progress` 合同与实体账本、三端本机"任务检索深度"、成员按 4 轮 / 8 次调用领份额、不再自动扩展顶层预算），Claude 复核见[Codex 批次复核](docs/codex-batch-review-20261105.md)；11-05 晚 Claude 修复复核 C1–C3（整轮账本只拦 `write` 与进行中 / 跨执行者的 `unknown` 重复、审核器只在提供 `task_progress` 时要求账本、成员截止 = 轮数 × 90 s + 60 s 三端同公式），见[修复记录](docs/codex-batch-fixes-20261105.md) | [上限交付](docs/limit-delivery-20261027.md)；[10-27闭环修复与验收](docs/task-continuation-20261027.md)；[修复与 10-19 日常回执](docs/mobile-desktop-alignment.md)；10-20 完成状态误分类修正与 Claude B1/B2 复核见[专项](docs/completion-status-fix-20261020.md)；真实供应商与长后台另验 |
| 记忆 | #2 并发写事务预约修复已通过 Mac/Linux 回归与完整日常；项目记忆本与个人档案已接入；项目来源手写记忆经独立可选通道（`/api/project-memory-sync` ↔ `/v1/project-memory`）同步；桌面记忆页 / 记忆本 / 回复页脚已拆到 `desktop-ui/features/memory/`（P2a） | [记忆架构](docs/memory-architecture.md)（以顶部现行约定为准）、[A7 回执](docs/mobile-desktop-alignment.md)；私人同步服务未部署新版 |
| 知识资料与成果 | 本机分段索引（SQLite FTS + 本地 embedding），按对话/项目开关过滤；两端按问题切段检索，旧 8 份 / 24000 字前置限制已移除 | [Agent 演进 P2/P4](docs/agent-evolution-20261015.md)、[A3/A5 回执](docs/mobile-desktop-alignment.md) |
| 设置、模型连接与账号 | 11-07 桌面与 iPhone 按 ChatGPT 登录 / API Key 展开实际表单，保存与设为默认分离；用户决定整体关闭智能选模，三端产品入口固定所选模型。11-14 起三端的选模引擎、设置接口与共享策略模块已删除，旧配置读取后忽略。已覆盖 Mac / iPhone 0.7.16 (48)，原凭证可读取 | [设置结构](docs/model-settings-structure-20261107.md)、[发布及数据验收](docs/model-settings-release-20261107.md)；本次未重做 OAuth 授权或真实模型请求；[五语](docs/interface-languages-20261015.md)、[连接架构](docs/llm-connections.md) |
| 双端同步 | v1 线协议冻结；Agent 能力与项目记忆走可选通道，旧服务只让扩展待同步，聊天同步照常 | [双端修复](docs/mobile-desktop-alignment.md)；私人同步服务需部署本版代码后启用新通道 |
| 工具、MCP 与网页 | 桌面支持 stdio / 标准 HTTP；12 类社交与视频链接的只读检索默认对现有与新 Agent 开放，可逐个撤销；手机设备数据仍为独立权限 | [Instagram、YouTube 等 10 类平台](docs/public-media-readers-20261104.md)、[站内检索、登录与验收](docs/mcp-retrieval-audit-20261104.md)、[既有 MCP](docs/mcp-startup-20261015.md)、[手机系统数据](docs/ios-device-data-20261016.md) |
| 搜索路由 | 自然餐饮/住宿/产品推荐与相关追问进入搜索；禁止联网、引用、闲聊、本地/App 边界保留，按当前能力说明不可用 | [#3 实施](docs/github-issues-implementation-20261020.md)；受控 HTTP 测试，真实供应商另验 |
| 图片、视频与附件 | 10-21 双端已接应用内拍照、确认进入草稿、原件与传输副本分开；[实现与验收](docs/test-cost-camera-plan-20261021.md)，实时会话暂缓；iPhone 后置拍照四流程已由用户真机确认，见[装机回执](docs/phone-camera-install-20261021.md)。桌面/手机请求 `quality: high`，10-15 单次实测 Codex 服务回报 low；手机图片链与保存防重复已接生产入口；多图逐张、2K/4K、视频抽帧已合入主线 | 10-20 #4 二次修复旧工作区归属与回看图片引用；原生预览/原尺寸/保存/冷启动重开均通过，原件 SHA 不变；[修复回执](docs/issue-4-legacy-preview-20261020.md)、[实施证据](docs/github-issues-implementation-20261020.md)；见[图片承载计划](docs/image-capacity-plan-20261015.md)；[图片体验](docs/image-ux-20261016.md)、[多图与视频](docs/image-video-plan-20261016.md)；真实账号画质待验 |
| 语音 | TTS 路由与停止修复（10-17 审计）；手机朗读要点化并按回复语种选声（10-18）；桌面朗读按 Agent 卡片模式 / 音色 / 风格，已知 Agent 默认概要（10-22）；11-16 实时语音通话（方案 A）：桌面与 iPhone 输入区的通话按钮，语音轮提示 / 读出规则三端同源（agent-loop.json `voiceTurn`），Mac 与 iPhone 共用 `VoiceCall.swift` / `SystemVoiceCallAudio.swift`；桌面编排 `desktop-ui/voiceCall.js`，iPhone `VoiceCallController.swift` | [审计与实施状态](docs/architecture-agent-context-audit-20261017.md)；真机朗读待验；[实时语音方案与实施](docs/realtime-voice-plan-20261116.md)：真机麦克风、回声消除、识别准确率待验，需重编桌面壳与重装手机 |
| 授权、审批与任务 | #1 审批期间持有文件身份，阻止 inode 复用（`47da231` 已推送，[实施](docs/github-issues-implementation-20261020.md)）； 模型 / 工具 / 授权共用截止与取消，超时后迟到批准零写入（A2）；手机权限首次迁移与撤销修正 `85c51f7`；桌面审批界面样式在 `desktop-ui/features/approvals/approvals.css`（工具/文件审批 JS 仍在 app.js，P2c）；能力请求卡片与「临时授权」列表在 `desktop-ui/features/approvals/`（10-20）；手机卡片进 `ChatStore` 审批队列，账本与判定在 `ios/Melo/CapabilityElevation{,Runtime,Views}.swift`（10-20） | [A2 回执](docs/mobile-desktop-alignment.md)、[手机权限](docs/phone-permission-fix-20261016.md) |
| 桌面壳与界面 | 11-16 主检出 `2fff53bd`（未推送，含实时语音通话）已重建并原位覆盖，`release:verify` 17 项全 GREEN（JS 5,208 / 5,208），真实数据目录前后无变化；数据目录 11-16 23:56 恢复后已正常启动（[安装回执](docs/realtime-voice-plan-20261116.md)（第 11 节））。此前：11-11 主检出 `9b070cf2`（未推送）已重建并原位覆盖，`release:verify` 17 项全 GREEN；因数据目录未恢复，装后没有正常启动，首次正常启动要用户点一次"桌面"文件夹权限（[回执](docs/agent-fixall-20261110.md)）。此前：11-07 产品主检出 `701e43f5` 已重建并原位覆盖，17 项发布检查及正常工作区 / 模型设置 / 数据回读通过，见[本次回执](docs/model-settings-release-20261107.md)。历史：10-27 安装源码 `554ce96`（10-27 壳重建覆盖，第二次 `release:verify` 17 项全绿，[回执](docs/overwrite-install-20261027.md)；10-27 晚真实多工具测试[评估](docs/live-test-bigbang-20261027.md)：壳给服务的 PATH 没有 node 使 Playwright 搜索腿不可用，当晚已修（node 目录置于服务 PATH 首位，原生启动断言 14 项），第三次 `release:verify` 17 项全绿覆盖安装；装后实测 Google 对无头浏览器出验证页、Jina 匿名 DDG 403，无 key 时搜索仍无结果，需配 key；10-26 [回执](docs/overwrite-install-20261026.md)；壳从源码目录运行，桌面即主检出代码；壳重编译后首次正常启动需用户点一次"桌面"文件夹权限）；神经总览 `22bcd1b`；双端低饱和黑金 M 图标；10-15 记录的阅读 / 预览 / 文件 WIP 已于 10-17 收入 `8cd3eff`；10-20 桌面工作面统一（`surfaceUnify.css` 最后载入：间距、13px 基准字号、控件、工作面不透明度、去旧绿色），手机未动、知识青灰身份色待用户决定 | [10-20 统一](docs/ui-unify-20261020.md)、[双端安装](docs/dual-reinstall-20261019.md)、[银河与留白](docs/galaxy-clarity-20261016.md)、[图标](docs/design/logo-muted-20261016/README.md)；`desktop-ui/app.js` 仍是中央入口（导航、组合、render() 保护、设置 / 资料 / 审批 / TTS 等页面）；记忆 / 项目页（P2a）、Agent 设置（P2b）、聊天（P2c）已拆到 `desktop-ui/features/` |
| 桌面宠物 | 10-22 并入 `Melo.app`（方案 C）：`desktop-pet/` 独立包、仓库外媒体钉哈希、`DesktopPet.swift` 启停、系统设置「桌面宠物」开关与真实状态；真包冷启动 / 对话 / 开关 / 退出联动已验 | [并入文档](docs/desktop-pet-integration-20261022.md)、[桌宠说明](desktop-pet/README.md)；素材生产线仍在 `/Users/mortred/Documents/New project/desktop-pet` |
| iPhone | 实体机 11-16 原位覆盖到 0.7.20 (52)（代码 `2fff53bd`，未推送，含实时语音通话）并首启，18 对话 / 209 消息 / 6 Agent / 27 图五次回读一致（[安装回执](docs/realtime-voice-plan-20261116.md)（第 11 节））；新个人签名描述文件 11-23 22:30（Melbourne）到期，换描述文件后要用户在手机上点一次"信任"才能打开。此前：11-11 原位覆盖到 0.7.19 (51)（代码 `9b070cf2`），18 对话 / 205 消息 / 6 Agent / 27 图五次回读一致（[回执](docs/agent-fixall-20261110.md)），签名 11-14 到期；11-08 覆盖到 0.7.18 (50)；10-27 原位覆盖到 0.7.13 (45)，17 对话 / 174 消息 / 6 Agent / 26 图两次回读一致（[回执](docs/overwrite-install-20261027.md)）；10-26 曾覆盖到 0.7.12 (44)，16 对话 / 169 消息 / 6 Agent / 26 图两次回读一致（[回执](docs/overwrite-install-20261026.md)）；10-24 曾覆盖到 0.7.11 (43)，16 对话 / 163 消息 / 6 Agent / 25 图两次回读一致（[回执](docs/phone-overwrite-install-20261024.md)）；10-22 曾覆盖到 0.7.9 (41)，15 对话 / 151 消息 / 6 Agent / 24 图两次回读一致（[回执](docs/phone-overwrite-install-20261022.md)）；此前 0.7.8 (40) 已覆盖并启动，原 12 对话 / 137 消息 / 6 Agent、账号偏好和 21 张原图经两次回读保留；用户确认拍照四流程与实际回复正常 | [10-21 拍照版安装](docs/phone-camera-install-20261021.md)；个人签名到期 10-28 20:52（Melbourne；10-26 构建复用同一描述文件，未续期，到期前需再装一次）；镜头切换和后台恢复另验 |
| Android 桌宠 | 10-22 分支 `feature/android-desktop-pet`（0.8.0 (17)）：「系统 → 桌宠」开关后金冬天 / 大肥鱼以自有前台服务常驻其他 App 之上，窗口只按当前动作的不透明包围盒布局；拖动贴边、单击换动作、双击系统语音识别 → 专用「桌宠」对话 → 朗读与气泡、长按菜单；自动动作沿用桌面「优先待机、动作后休息 30–60 秒」；素材不进 Git，`assets/pet/catalog.json` 记录 hash 与 Release `android-pet-assets-1`，Gradle `preparePetAssets` 构建时校验 / 下载 | [android/README.md → 桌宠](android/README.md)、[verification.md](android/verification.md)；JVM 144、Lint 零 Error、Debug / R8、Emulator `PetOverlayFlowTest` 2/2 通过；Fold6 真机（朋友测试）、三星省电、真实语音未验，PR 待用户决定合入 |
| 远程渠道 | Telegram（10-16）、Discord（10-17）按用户决定归档，配置与历史保留 | [Telegram 归档](docs/telegram-archive-20261016.md)、[Discord 归档](docs/discord-archive-20261017.md) |
| 架构维护 | B2 执行节点、B3 自定义页与桌面 token 已合入；当前拆分质量与剩余 B4/B5 见[10-21 核对](docs/architecture-split-review-20261021.md)。方案已获批执行 P0–P2；P0 已交付：生成的功能地图、`npm run scope`、`npm run boundaries`、纯文档选组纠正与本总览重整；P1 项目 / Agent 提交回执已交付；P2 完成：P2a 记忆页、项目页拆入 `desktop-ui/features/` 并补齐 `bootstrapError` 重新拉取；P2b Agent 设置；P2c 聊天状态 / 事件与其余 CSS，`render()` 只调功能钩子，共享请求层为 `sharedApi.js` | [方案与第 8 节执行修订](docs/architecture-maintainability-plan-20261019.md)；P1 / P2 状态以最新交接为准；[独立审计](docs/claude-architecture-review-20261019.md)确认的提交后刷新失败回归已在 `46554b2` 修复，日常选定范围通过 |
| 发布 gate | 11-14 检测提速已本地提交（`c5ee2c6b` 起）：快速档不再因生成产物、Android 混改、功能地图没登记的文件、验收脚本扩大到全量；Android 与 Swift 并行、Swift 并行编译并清理缓存、JS 测试池按机器余量取 4–8 个位置且重文件最多 3 个，见[记录第 6 节](docs/dead-code-cleanup-20261114.md)。10-21 降本已本地提交 `8304aab`：[实现与校准](docs/test-cost-camera-plan-20261021.md)；纯文档 CI 先计划并省去重型任务，局部 UI 按整组和实际依赖选取，Swift 复用编译但每次执行测试；日常按功能、反向依赖、隐式边与平台选组；任务 `--files` / 集成 `--base` / 强制 `--all`；先预检、JS / 资源 / Swift 去重；公共 / 未知边界保留扩大，发布完整 gate 保留 | [统一检测规则](docs/testing-workflow.md)（AGENTS / CLAUDE 共用）、[实施验证](docs/test-selection-implementation-20261020.md)：最终工具 29/29，隔离完整日常、两项浏览器与 32 Swift 通过；本地模型资源项补测 3/3 |

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
| `voice` | `src/services/tts/`、`src/http/ttsRoutes.js`（含 `/api/voice-call/*`）、`src/services/media/voiceRewrite.js`；`desktop-ui/voiceCall.js`、`desktop-app/VoiceCallBridge.swift` | `VoiceInput.swift`、`SpeechText.swift`、`VoiceCall.swift`、`SystemVoiceCallAudio.swift`、`VoiceTurnRules.swift`、`VoiceCallController.swift` | agent-loop（`voiceTurn`）· `test:tts` |
| `approvals` | `src/services/approval/`、`src/services/task/`、`src/safety/`；`desktop-ui/features/approvals/approvals.css` | `ChatStore.swift`（审批队列） | `test:audit-fixes` |
| `desktop-shell` | `desktop-ui/app.js`、`neural*.js`、`src/services/desktop/bootstrap.js`、`desktop-app/main.swift` | 场景经 `ios/scripts/build-scene.py` 打包 | `test:ui` |
| `iphone` | — | `ChatStore.swift`、`ContentView.swift`、`MeloApp.swift` | `test:ios` |

基础设施另列 `platform`（`src/state/`、`src/runtime/`、`src/http/` 传输）、`channels`（已归档渠道）、`tooling`（脚本与 gate）。

## 4. 最新交接

### 2026-11-18 — 实时语音通话修复（Codex）

桌面和 iPhone 的播报绑定通话与回复轮次，挂断后的迟到结果仍留在聊天。排队句子不参与回声匹配，按播放进度预取；系统音色在本地分句。手机模拟器用真实聊天存储验证了同聊天重拨和下一轮正常读出。软件耗时与实体设备出声分开记录。桌面布局与遮挡由现有 melo ui 线程在独立工作树处理。[实施、回归与耗时](docs/voice-call-audit-20261118.md)。


### 2026-11-16 — Melo 主线（Claude）— 实时语音对话（方案 A，桌面 + iPhone）

用户要"增加实时语音对话系统"；按规范先出三方案并评分（A 级联全双工 8.2 / B GPT-Live 6.5 / C 双引擎 7.7），用户选 A、平台"桌面 + iPhone 一起"。基准 `f75f139a`，已提交 `adbb6145`；当晚用户说"装到两端"，已装到电脑和 iPhone（版本号提交 `2fff53bd`，[安装回执](docs/realtime-voice-plan-20261116.md)（第 11 节））。没有推送、没有读写正式数据目录。
行为：输入区新增通话按钮。开始后一直听，说完（默认 0.8 秒，可选较快 / 标准 / 较慢）自动作为语音轮发出；这一轮带上口语化回答的要求（桌面还带 Agent 卡片的说话风格）；核对后的回答按句读出（桌面 Agent 服务端音色，没有可用音色时系统声音；iPhone 系统声音）；用工具时说"我查一下"，等确认时说"请在屏幕上确认"；朗读中开口即打断；回复进行中说的话作为补充；整句是停止词时取消回复。听写与通话互斥；通话期间平时的自动朗读不触发。
文件 / 接口：`shared/protocol/agent-loop.json`（`voiceTurn` 节与夹具，已重生成三端副本与核心包）、`shared/agent/voiceTurn.js`、`ios/Melo/{VoiceCall,SystemVoiceCallAudio,VoiceTurnRules,VoiceCallController}.swift`、`desktop-app/VoiceCallBridge.swift`、`desktop-ui/voiceCall.js`；`/api/chat/send/stream` 新增可选布尔 `voiceTurn`，新路由 `POST /api/voice-call/speech-plan`、`POST /api/voice-call/speech`；`ChatStore.send(…, voiceTurn:)`。不改同步 v1 线协议、不新增消息字段；Android 只多一段契约数据。
验证：快速档因改到共享契约与公共边界扩为全量，`run-AosjeK` 全绿（JS 5,201 项 0 失败 0 跳过、Android 四项、Swift 编译与全部 41 组、渲染预检、设置浏览器验收，239 秒）；面板提示的追加修正 `run-pUhuXa`（347 项）；Swift `VoiceCallTests`（含 30 条与桌面相同的夹具）、iPhone 模拟器整包编译、桌面壳编译；修复类测试都在去掉修复后确认会红。
接手要知道的：(1) 两端已装：iPhone 0.7.20 (52) 已首启，签名 11-23 到期；电脑已覆盖，数据目录 11-16 23:56 恢复后已正常启动。本机 Docker 是 colima，虚拟机会悄悄死掉、让 `docker` 命令全部挂起，`release:verify` 前先在后台探一次 `docker info`。(2) 改了 `desktop-ui/translations.js` 一定要 `npm run build:ios-scene`，本次第一次快速档就因此停在预检。(3) 真机验收要看：Mac 外放时开口能打断、Melo 不会被自己的声音打断；中文端上识别；MiniMax / Edge 音色读回答；工具与确认的占位句；挂断后麦克风指示灯熄灭；iPhone 来电时挂断。(4) 11-16 晚用户找不到桌面通话入口，按方案 A 改成总览、新对话页、对话页输入区都有带文字的「通话」按钮；没有对话时第一句话新建对话、通话跟着移进去（方案第 12 节）。iPhone 入口没改。
仍然挂着：两端还没真正打过一次语音通话（麦克风、回声消除、识别、真实模型，要用户在场）；SpeechAnalyzer 未接（见方案第 10.2 节）；桌面正式数据目录已于 11-16 23:56 恢复（用户先以为已恢复，核对后没有生效；用户说"你来恢复"后由 Claude 在终端面板执行）；本次提交都只在本地，未推送（开工时 master 与 `origin/master` 同为 `f75f139a`）。

### 2026-11-14 — Melo 主线（Claude）— 死代码清理第二轮与检测提速

用户要求逐行扫描、清掉废的空的没用的，并看检测为什么久。基准 `cc9a982e`（已含 Codex 11-12 的清理）。没有推送、没有安装、没有读写正式数据目录。
清理：手写代码净减 3,579 行、删 23 个文件，三端都有；只删产品和测试都没有引用的。清理前后 38 张界面截图逐像素一致。没有动的 30 多项（已停用功能的整套代码、只有测试在用的代码、未引用素材）列在[记录](docs/dead-code-cleanup-20261114.md)第 5 节，等用户决定。
检测：快速档的选择规则改了四处，过去 62% 的快速档会跑全量，回放后剩 12%；Android 与 Swift 并行，Swift 冷编译 551 → 150 秒，全量集成档 285 → 238 秒。规则写在 [docs/testing-workflow.md](docs/testing-workflow.md)。
**接手要知道的：** (1) 第一遍曾误删仍在使用的 `probe`（`06791f79` 已恢复）。删 JS 里的名字必须整词搜索并逐条看命中，只搜调用形式不够；核对脚本在本机 `.tmp/dead-code-claude-20261114/vanished-check.cjs`。(2) 改了场景包的任何输入（包括 `desktop-ui/translations.js`）都要 `npm run build:ios-scene`，否则完整门禁的预检会红。(3) 补读确证但没有落实的小项留在本机 `.tmp/dead-code-claude-20261114/reader2-*.md` 第 2 节。
**没有修、等安排的问题**（记录第 7 节，12 个已核实）：社交链接读取的"关闭弹层"会在已登录页面里点击几乎任意按钮；`file_edit` 单处替换会展开 `$&`；已删除的对话仍能被 `search_history` 搜到；`git pp` 脚本推送的是 `HEAD` 而不是评审过的提交；剪贴板写入必失败；超过 200 KB 的文件读不了；英文事实提取要求句末有句号；等等。
验证：集成档 `run-11UkeT`、最终完整校准 `run-33QqEn` 全绿；Android 设备测试 144 项中 140 通过（4 项失败与 11-10 相同）。没有真机、真实模型、桌面应用启动验收。
仍然挂着：桌面正式数据目录待用户执行恢复命令（恢复前不要启动桌面 Melo）；master 领先 `origin/master` 未推送，上次 `git pp` 评级 C 后没有重新评审；iPhone 签名已到期。

### 2026-11-12 — Codex：死代码清理与测试成本审计（隔离分支，11-13 验收完成）

用户授权读取全部代码、删除有证据的无效代码，并提出测试优化方案；本轮未授权推送、合并、安装或改门禁策略。
基准 fab843a0，独立分支 codex/dead-code-audit-20261112，工作树 /tmp/melo-dead-code-20261112；主线和正式数据未动。按既有源码口径读取 227,202 行；扩展三端、测试、第三方、生成与本地化到 2,005 文件 / 497,627 行，JS AST 1,429 文件、解析错误 0。该覆盖不等于逐行人工语义证明。
已清理 17 个旧模块、24 个未导出 helper、两个空检查及旧聊天排序函数、84 个未读 import 绑定；保留运行入口、Worker、兼容层、协议空方法及有副作用初始化。任务准备补 >10 聊天保留回归；iOS 共享渲染清单与模块地图已生成。
最终快速档 run-yKKiOm 按现行删除/公共边界扩大到 612 文件，JS 5,218 / 5,218、失败/取消/跳过 0；Android 四项、设置浏览器、全部 38 组 Swift 通过，329 秒。代码提交 11e8939e。首轮共享 renderer 清单过期已补生成；机器扫描 H1–H20 对 fab843a0 的新增命中 0。
方案推荐先补生成产物/删除基准图/混合 Android 选测映射，再按实测拆过宽组与处理原生编译缓存；不删测试、不复用旧绿灯。详情与可复查清单见 [审计和方案](docs/dead-code-audit-20261112.md)。
边界：未运行真实模型、真机或正式桌面验收；正式桌面数据待恢复的既有事故未处理。清理代码已本地提交，合并前仍需集成档，本轮不合并/推送。

### 2026-11-10（晚）— Melo 主线（Claude）— 审计遗留项核实与修复（第二轮）

- **先看这条**：`.tmp/melo-home-user` 11-16 23:56 已恢复（用户说"你来恢复"后由 Claude 在终端面板执行 `restore-keep.py --apply`：33 段对话、6 个 Agent、33 个对话文件与 11-05 备份清单逐一一致；受损的两份改名为 `state.json.damaged-20261110`、`threads.damaged-20261110` 留在原地；23:57 正常启动读的是恢复后的数据）。恢复后第一次启动会自动重建记忆库，不需要合并。下面两条交接里关于"待恢复"的说法已过时。
- [记录](docs/agent-fixall-20261110.md)：上一轮留下的约 50 条未核实报告、4 条未改问题、6 项待决定全部逐条处理。修 97 处，8 条不成立，16 条没改（记录第 5 节的表）。
- 接手要知道的行为变化：
  - 共享内核 `turn.js`：修正或分派之后，已成功的写入和效果未知的调用都不重放，与推送版本相同；只有工具自己声明只读的调用可以重复（桌面 `effectFor`：`ls`、`cat 文件`）。本轮一度放宽成“其后有别的操作成功过就可以重跑”，推送前评级指出这等于放开整轮重放，已撤回，不要再这样放开。停止说明写成一句话（`stopReasonText`），原因码只留在回执里。
  - 已送达、核对没有结论的回复记为 `unverified`（原来是 `blocked` 或 `partial`）。预算用完时已写好的回答直接送达，不再重写（桌面 `runLimitDelivery({ candidate })`，两个手机端 `deliverLimit`）。这样送达的回答如果带着不确定标记，由处理普通回答的同一段代码按核对结论更正或标注（桌面 `verifyWithoutRequest` / `replyNotes`，iPhone 在 `deliverLimit` 里），到上限时不另发核验请求。
  - 一轮回复里的所有函数调用会话共用一组调用编号：新建会话要传 `{ callIds }`。三端都接受不带编号或重复编号的服务。
  - “用户点名要读的页面读了没有”改为看读到的地址是否写在目标里（`completion.js`），不再把目标切成网址；中文路径、结尾标点、片段都按同一页处理。
  - 桌面：并行成员按“在跑的成员还可能用掉多少”分份额；续派带上前一次交回的内容；连续三次分派全被拒就关闭分派；成员的用量和工具记录计入本轮；搜索和读页按各自设置的时限执行（`toolTimeoutCeiling`）；团队总结和看图判断用对话所选模型（`turnModel`）。
  - 桌面界面：执行相关的文字集中在 `desktop-ui/executionText.js`（工具名、原因码、被拒的调用、成员交回状态）。新注册的工具必须先在这里有名字，有测试守着；这个模块也进手机场景包。
  - iPhone：暂停的时间不算运行时间（`PhoneRunBudget`）；对话摘要不再跟随“记忆”开关，`read_history` 仍跟随。Android：对话请求不带固定输出上限，官方接口的推理模型用另一个字段；读页会跟跳转并逐跳检查地址，拒绝私有 IP 字面量。
  - 成员 token 上限与超时有下限（20 000 / 120 000 毫秒，`MEMBER_LIMIT_FLOORS`），默认值没变。
- 没做、需要用户决定的：修正之后是否允许重跑测试、检查类命令（需要一份明确的“可重复命令”声明）；回复被输出上限截断时是否保留已生成的文字；成员 token 默认值；项目范围下 Agent 设置的保存方式；是否显示命令的实时输出；输出上限很小的模型；成员汇报的语言。都在记录第 5 节。
- 推送：**没有推送**。`git pp` 的推送前评级是 C（记录第 8 节）：三条发现都属实，已修复并各自反向验证。按评估标准没有重跑，要推送需要用户再说一次 `git pp`；推送前不必再跑集成档，除非树又变了。
- 验证：跟进修复后的集成档 `run-ACh0QE`（基准 `84437476`）全绿（612 / 612 个文件，JS 5 217 / 5 217，Android 四项，设置浏览器验收，全部 38 组 Swift，文档链接）。Android 设备测试 144 项里 140 通过，未过的 4 项与上一轮相同。真实模型、Android 真机、桌面端到端没有验证。提交 `5ec0f5cd`、`9b070cf2`。
- 安装（11-11 凌晨，装的是未推送的 `9b070cf2`）：iPhone 0.7.19 (51) 已原位覆盖并首启，数据五次读取一致；电脑 `release:verify` 17 项全 GREEN 并覆盖安装，真实数据目录前后无变化，**没有正常启动**。用户要做的顺序：执行上面的恢复命令 → 正常启动桌面 Melo → 在系统弹窗里点"允许"。Android 没有真机，没有安装。

### 2026-11-10 — Melo 主线（Claude）— Android 延迟修复与 Agent 全链路审计

- 数据目录的现状与恢复命令以上一条（第二轮）交接为准。写这一条时：`.tmp/melo-home-user` 还是被夹具覆盖的状态，桌面 Melo 保持关闭，恢复、记忆库合并、测试记录清理三件事都等用户决定。
- [记录与审计](docs/agent-audit-20261110.md)。Android 现已接上延迟修复：一批网页并行读取、窗口续读、回答边生成边显示、请求整形。
- 接手要知道的行为变化：
  - Android `SharedCoreRuntime`：求值不会被取消，`close()` 等当前求值结束后才关闭隔离环境（最多再等 5 秒）；内核自己的 5 秒上限抛"执行超时"，不再冒充运行截止时间。不要改回"取消即关闭"，那会带崩全 App 共用的沙箱进程，`SharedAgentCoreTest` 里有两项直接测试守着。
  - Android 停止的回复一律记为 `cancelled`（`replyFailure`）；工具链超出上下文按"到达上限"收尾；`route_task` 被拒时带原因，三端都用 `ROUTE_DENIED`。
  - 手机内核的 `fetch_url` 按窗口返回并接受 `offset`；来源行保留一个整窗（`SOURCE_TEXT_CHARS`）。
  - iPhone：成员自己的回合停止只结束该成员；写操作在开始前被工具拒绝（`refusedBeforeStart`）不再卡住回复；观察记录有 128 行、1.2 MB 的上限。
  - 桌面：成员读到的页面整行交给主 Agent（`memberEvidence`，总量 40 万字）；完成核对的摘录先带命中片段的前一段；权限询问被服务器关闭时发 `tool_permission_closed`；`memberConfig` 同时限制已保存的搜索条数。
- 没做（写这一条时）：要用户决定的 6 项在记录第 4.4 节；子代理报告里约 50 条没有核实，在第 4.3 节，带行号的原文在 `.tmp/android-agent-20261110/audit/`。这些已在第二轮逐条处理，见上一条。
- 验证：门禁：完整快速档 `run-bKiCRk` 全绿（603 / 603 个文件，JS 5 142 / 5 142，Android 四项，设置浏览器验收，全部 38 组 Swift，文档链接；551 秒）；集成档没有跑，推送前要跑。 设备测试（无窗口模拟器）最后一轮 128 项：本轮新增与改动的全部通过；未过的 5 项是 2 项固定的环境失败、2 项需显式开启的真实模型测试和 1 项偶发失败（单独重跑两次都通过），基线是 116 项里 20 项失败。 提交 `099a1c3b`，本机 master 领先远端 6 个提交，未推送、未安装。

### 2026-11-10 — Melo 主线（Claude）— 回复延迟修复；桌面真实数据目录待恢复

- **先看这条**：`.tmp/melo-home-user` 的 `state.json` 和对话文件在 11-10 12:05 左右被测试夹具覆盖（我直接运行 `node --test` 造成，根因同 11-07）。桌面 Melo 已退出。恢复脚本 `.tmp/incident-20261110/restore.py --apply` 会从 11-05 完整备份恢复 33 段对话和状态，不动 `config.json`；它改用户数据，要用户决定后再执行。恢复前不要启动正式版做验收。经过见[事故记录](docs/incident-test-isolation-20261110.md)。
- 防护已在代码里：测试进程没有 `MELO_HOME` 或它指向用户目录时，`resolveRuntimePaths` 给一次性临时目录（`source: 'test-isolated'`）；`src/runtime/testIsolation.test.js` 拒绝"根级 `after()` + 顶层 `await test()` + 改 `MELO_HOME`"的测试写法。新写走真实执行图的测试，用一个父用例加 `t.after`。
- 延迟修复（[记录](docs/response-latency-fixes-20261110.md)）：天气题 69–106 秒降到约 23 秒，模型请求 15–17 次降到 5 次。接手要知道的行为变化：
  - 只读内部成员不再自查，回执看它实际读到的来源；执行成员保留自查。
  - 完成检查读证据时按候选答案选片段；候选带不确定标记时检查会一并给出 `claimReview`，宿主拿到就不再单独核验。桌面与 iPhone 已接，Android 未接。
  - 主 Agent 的 MCP 工具定义按需加载（`load_tools`），`MELO_DEFERRED_TOOLS=0` 或 `config.deferredTools: false` 关闭。成员不受影响。
  - `fetch_url` 的结果是一个按 token 等价长度截的窗口，模型能看到整窗和续读偏移；Jina 3 秒不回并发直连，网页再等 Jina 5 秒。
  - iPhone：一批全是 `open_url` 时最多三个并行；页面可读即在 8 秒软超时读取。只有源码、离线测试和无签名构建，没有装机。
- 未做：完成检查的思考强度（需要评测）、iPhone 正文流式、Android 宿主、Codex 连接的桌面实测。记忆库自 11-07 事故后只剩 44 条（备份里 1 351 条），是否补回等用户决定。
- 验证：快速档 `run-xDpHtY` 全绿（公共边界扩大到 601 / 601 个文件：JS 5 111 / 5 111，Android 四项、设置浏览器验收、全部 Swift 组、文档链接；426 秒）；中间一轮 `run-erW8FY` 只红了一项（新开关没登记到开关目录），补登记后通过。本机 master 领先远端，未推送、未安装。

### 2026-11-10 — Melo 主线（Claude）— 回复延迟复核与当前版本实测（只报告）
- 线程 ID：e02f4818。桌面当前版实测：天气单事实题 68.7–105.5 秒、15–17 次模型请求，纯问答 5.4 秒。确认缺陷 L1：非 Codex 连接上成员 / 主 Agent 到上限后的收尾请求按错协议发出必失败（`src/runtime/limitDelivery.js:16` + `src/openai.js:1427`，10-27 引入）。放大项：成员读页只留最近一次正文导致翻页循环、答案后两到三道核验、主 Agent 带 82 个工具定义、Jina 优先读页。[审计记录](docs/response-latency-audit-20261110.md)，证据 `.tmp/latency-audit-20261110/`。
- 未做：任何修复、手机当前版真机实测、Codex 登录连接的桌面实测、质量评测集。建议顺序见记录第 7 节（先修 L1，再治翻页循环和多道核验）。

### 2026-11-09 — Codex：提问到回复延迟审计（电脑与 iPhone）

用户确认两端都慢。基准 `84437476`，沿发送/上下文/路由成员/工具/核验/落盘与 UI 检查，仅读已有本地记录。iPhone 11-07 天气样本 85.506 秒、9 次模型请求，模型 60.754 秒、读页 23.877 秒；活动攻略 766.044 秒中活跃执行 337.168 秒，段间恢复等待 428.876 秒。记录属于 0.7.16/17，非当前新测速。当前源码仍有手机正文等整轮完成/API 非流式、成员与读页串行、重复核验和缺证据时空改写、手机模型阶段 ID 复用漏计后续请求。桌面成员另有独立完成检查；保留主 Agent 分派审核与固定选模决定。详见[审计、优先序与验收指标](docs/response-latency-audit-20261109.md)。28 项目标/路由回归通过；脱敏复算在 `.tmp/response-latency-audit-20261109/`。本轮仅文档，无产品改动、新模型请求、设备操作或推送；后续按方案实施并跑同模型双端对照。


### 2026-11-07（晚）— Melo 主线（Claude）— Agent 列表、任务空间改名、静止背景、无合同任务的核验展示

- 记录在 [war-room-routing-review-20261107](docs/war-room-routing-review-20261107.md) 的「用户复看后续」。分支 `claude/task-space-c-20261105`，已合并 Codex 的模型设置（`701e43f5`）。
- **Agent 列表**（用户决定）：
  - 列表只显示一个默认 Agent 和用户自己创建的 Agent；
  - 内部岗位不是 Agent：桌面 research / builder / reviewer，手机自带的 writer / analyst，以及同步到手机的桌面岗位；
  - 判断入口在桌面 `src/shared/userAgents.js`（`RETIRED_AGENT_IDS`）和手机 `AgentProfile.retiredBuiltInIDs`，两边必须一致；
  - 已在用的不会消失：`keepId` / `keep` 保留对话、项目或新对话正在用的那个；
  - 服务端拒绝委派给这些岗位、拒绝把它们编进团队；Agent 的委派对象里只剩它们时，不再给「委派」工具。
- **改名**：界面上「作战大屏」改为「任务空间」，「作战台」改为「任务面板」；文件名和内部标识不变。
- **背景**：工作面板里的银河不转动、统一调淡（`galaxyBackdrop.css`）；首页星图仍由「◈ 星空流动 / 静态模式」控制。
- **无合同任务的核验展示**：
  - 共享 `shared/agent/goalReview.js` 生成每次核验的有限视图（结论、原因代码、最多 12 条要求的类型、状态和引用证据），由 goal 的只读动作 `reviewSnapshot` 取出；
  - 三端在 `goal-check:N` 阶段附带 `goalReview`，两个场景 reducer 都会规范化；它不进入 v1 同步；
  - 投影是 `sceneGoalReview` / `goalGate`，以及 `traceList` 的 `review:*`；
  - 证据编号沿用核心的上限（16 个，每个最长 256 字符），打开证据时优先精确匹配；没有分派的任务在任务空间里用 `checked` 布局；
  - 没有任务合同时，交付闸门、证据热力、合同覆盖、任务合同四块显示核验。
  - 新增浏览器可加载的共享模块时，要同时登记三处：
    - `src/server.js` 白名单；
    - `ios/scripts/build-scene.py` 的 `paths`；
    - 读源文件的测试要登记到 `architecture/module-annotations.json`。
- **回复保存不再改界面**：`sendChatMessage` 只在发送开始时选中对话；回复保存时（成功或失败）不再把 `activeView` 和 `selectedChatId` 拉回这段对话（`6d3732c7`）。
- **未做**：
  - Android 核验视图只有编译、JVM、Lint，没有在模拟器上跑过；
  - 真实模型探针未跑。
- 验证：集成 `run-pXcx6I` 全绿（JS 5059/5059、38 组 Swift、Android 四阶段、设置浏览器）；iPhone 0.7.17 (49) 已原位覆盖，三次备份一致、首启关键数据不变。

### 2026-11-07 — Melo 主线（Claude）— 作战大屏复看修复：主 Agent 只路由、快速档停止规则、社交检索成员

- 审查与落地记录：[war-room-routing-review-20261107](docs/war-room-routing-review-20261107.md)。分支 `claude/task-space-c-20261105`：第一步 `d98e7642`，第二到五步 ``bfc382b9``。
- **停止规则**：默认快速档在 `TASK_EVALUATION_POLICY.defaultMode`。
  - 桌面一次性迁移由 `settings.evaluationDefaultVersion` 标记；
  - 只冻结用户原话里的数量；
  - 同轮修订合同只能增加要求，类别不变；
  - 账本按「规范化网址 + 正文」记录读过的页面（`seenPages`），同一页面换个调用或成员重读不算新读取；
  - 桌面迁移由用户 2026-11-07 确认保留（`git pp` 第一次评级 C 的第 3 条）。
- **主 Agent 只路由**：
  - 三端都按共享的 `leadWithheldTools`（检索与社交检索成员的全部工具）收走主 Agent 的检索工具和原生搜索；
  - 桌面在用户补充关闭路由时由 `restoreLeadRetrieval` 归还；
  - 改动主 Agent 工具时，要同时看桌面 `invokeModelNode.js`、iOS `AgentLoopRequest.scopedBody`、Android `SharedChatAgent` 的 `roundSpecs`；
  - 桌面成员默认用 Melo 自己的搜索。只有共享计划的 `availableTools` 里没有 `web_search`、且原生搜索已验证时，成员才接管原生搜索（`memberHostedSearch`）；
  - 社交检索成员在只读并行队列里（`READ_ONLY_JOBS`）；
  - 成员用原生搜索时，`runSubAgent` 把回执写进证据（`hosted:N`，服务商来源），并把原生事件转发给调用方；原生搜索任务一律在已验证的完整对话配置上执行（连接、模型、端点、凭证，`internalMembers.js` 的 `hostedJob`），岗位另配了连接时在大屏注明；
  - 共享核心 `completionObservation` 把来源类型和截断分开：截断只加 `truncated`，只有读过的网页（`extracted`）才会变成 `partial`；`provider` 等类型无论多长都保持不变。
- iPhone 0.7.15（47）已覆盖安装：两份安装前备份一致，安装后与首次启动后的数据核对都通过（证据在主项目 `.tmp/iphone-overwrite-20261107-review-*`）。Mac 等最后一轮 `git pp` 通过后再装（用户要求）。
- **社交检索成员**：
  - 新岗位 `social` 已加到 `INTERNAL_JOB_ROLES`、`MEMBER_ROLES`、`MEMBER_ROLE_MODULE`（归网页检索区域）、岗位模型选择和 iOS 记录；
  - 小红书 MCP 已升级到 v2.7.3，登录要用户在设置里扫码。
- **未做**：
  - 手机把需要桌面 MCP 的检索交给 Mac：用户手机没有到 Mac 的通道，另立任务；
  - Android 的路由行为只有编译、JVM 与 Lint 检查，没有在模拟器上跑过；
  - 真实模型探针未跑。
- 集成档 `run-C2AmLJ`（`--base cc115e8e`）：JS 5 023 / 5 023，Swift 38 组、Android 四项、设置浏览器验收全绿；iOS 无签名构建通过。

### 2026-11-06 — Melo 主线（Claude）— 作战大屏（布局 A）移入产品 — 已合并到 master
- 分支 `claude/task-space-c-20261105`（worktree `.tmp/task-space-c-20261105`，已变基到 `d5c596e`）：C1–C5（评估快照与成员岗位三端发出、`src/shared/executionBoard.js` 投影）之上，嵌入式任务空间换成全屏作战大屏：`desktop-ui/warRoom*.js`、`src/shared/warRoom.js`；聊天里收成一行；自动弹出与「为确认提示让开」三端同规则（桌面 `executionPanel.js`、iPhone `WarRoomPresentation` + `ContentView`、Android `WarRoomPresentation.kt` + `MainActivity`）。区域只算自己的调用，每个数字点开即其记录；修复 token 被推理摘要重复计数。C7：全局取景改由 `desktop-ui/warRoomLayout.js` 按每个区域真实外沿计算并留出标签边距，打开时相机直接就位，五个区域不再出屏；手机底部卡片可横向滑动。[专项记录](docs/task-space-c-20261105.md)，证据 `.tmp/war-room-20261106/`。
- 用户 2026-11-06 要求合并并推送。集成档 `run-CjTZuy`（`--base d5c596e`）结果：
  - JS 591 / 591 个文件，4 992 / 4 992 项，0 失败 0 跳过；
  - Swift 38 组、Android 四项、设置浏览器验收、文档链接、生成器与共享渲染预检全部通过。
  - 随后 master 快进到本分支。
- `git pp` 推送前评估评级 C（完成状态与评估计数失真），推送被阻止，GitHub master 仍为 `d5c596e`。
  - C8 已修复：交付与核验状态由完成回执决定（`deliveryStatus`）；计数用评估器总数（快照新增 `excluded` / `gapCount`，旧记录兼容）；画布点选算作用户操作。
  - 快速档 `run-jsRQQE`：全量 JS 4 996 / 4 996，Swift 38 组、Android 四项全绿。
- 用户确认修完后用 `git pp` 推送并合并到 master。第二次 `git pp` 评级 C（跨端终态与候选追踪）。
  - C9 已修：三端结束状态统一解读（映射表见专项记录）；快照候选 key 唯一；首次打开时恢复区域与相机。
  - 集成档 `run-pHTRku`：JS 4 998 / 4 998，Swift 38 组、Android 四项全绿。
- 第三次 `git pp` 评级 C（数据展示与跨任务隔离）。
  - C10 已修：覆盖率按未排除候选计算（`fieldCoverage`）；候选飞入随任务切换、关闭与释放取消；iPhone 成员任务改记 `input`，旧记录兼容。
  - 集成档 `run-GagU9S`：JS 5 001 / 5 001，Swift 38 组、Android 四项全绿，iOS 无签名构建通过。
- 第四次 `git pp` 评级 C（降级入口缺失、记录可能长期隐藏）。
  - C11 已修：三维不可用时舞台列出五区域入口（同一套详情）；关闭、减弱动态、静止、渲染失败时动画一律收尾，并立即显示等待中的行。
  - 集成档 `run-T16EyM`：JS 5 002 / 5 002，Swift 38 组、Android 四项全绿。
- 本地 master 停在 `b8c89341`：主工作区有另一线程（Codex「Melo 对话归组」）未提交的 `MELO_OVERVIEW.md` 交接，快进被 git 拒绝，本线程未动它。推送改由本分支执行（上游设为 `origin/master`）。
- 第五次 `git pp` 评级 B，已推送 `03f9db4d`。C12 按评审建议修复：WebGL 上下文丢失后释放渲染器；减弱动态关闭后恢复绘制；iPhone / Android 延迟关闭绑定展示代次。集成档 `run-BOKN5A` 全绿。
- 未做：真机手势与帧率、Android 仪器测试、真实模型探针；覆盖安装未授权。
### 2026-11-05 — Melo 主线（Claude）— 复核 C1–C3 修复并推送
- 线程 ID：e02f4818。C1 整轮副作用账本只对 `write` 与进行中 / 跨执行者的 `unknown` 重复拦截，`bash` 只读形式不进账本；C2 审核器只在本轮提供 `task_progress` 或已有账本时才要求账本；C3 成员子预算截止 = 轮数 × 90 s + 60 s（三端同公式）。真实主图计数测试覆盖同成员翻页 / 主→成员；快速档 `run-alGeuV`（339 / 589 文件，JS 3 327 / 3 327，Android、22 组 Swift，892 s）、集成档 `run-RtVrtf`（`--base a4ae796`，589 / 589，JS 4 934 / 4 934，Android、设置浏览器、Swift 全绿，294 s）。[修复记录](docs/codex-batch-fixes-20261105.md)。
- 未做：Android 成员路径单元测试、schema 的 `jobModels`、`jobConnectionConfig` 白名单（P3）；真实模型 / 真机未验收。

### 2026-11-05 — Melo 主线（Claude）— 复核 Codex 批次（R1–R7 修复、任务评估 B）— 只报告
- 线程 ID：e02f4818。范围 `afdcce1..a3817f5`。Codex 审计 R1–R7 全部属实、修复正确；B 方案三端同源、门禁 / 安装回执核对无误；master 隔离跑 14 个测试文件 291 / 291。[复核记录](docs/codex-batch-review-20261105.md)。
- 待修（未动产品）：C1 整轮副作用账本误拦 `unknown` 效果的重复只读调用（`bash`、Playwright 点击 / 导航），C2 审核器在不提供 `task_progress` 的团队 / 视频 / 出图回合强制 continue，C3 成员 90 s 切片在真实延迟下偏短（桌面探针里成员一次 60 s 的 glob 超时就耗尽整个切片，两轮后被截止只交回失败记录（模型往返仅 5–7 s））；P3：§2 事实行已改、Android 成员路径补 JVM 测试、`jobConnectionConfig` 改为白名单、schema 的 `jobModels` 注记或删除；`a3817f5` 待推送。

### 2026-11-05 — melo主线（Codex）— 最近组合改动复核
- 源码基准 `afdcce1`；本轮只审计与记录。确认 7 项缺陷：跨成员副作用防重 / 异常回执、未核实报告冒充完成证据、旧手机岗位模型同步不兼容、智能强档旁路、预算与循环截止不一致、同 URL 分页证据丢失、岗位连接能力快照不完整；另有策略写死和手机执行/UI未对齐。[完整报告与修复顺序](docs/recent-change-review-20261105.md)。
- 当前相关 16 文件 / 324 项定向回归全过；新增隔离主图反例仍复现重复写 2 次、零执行 completed、低档写入等。旧端契约用昨晚安装源码 `882eba7` 回放，未操作手机。证据 `.tmp/recent-change-review-20261105/`；未修产品、未跑全量发布、未推送/安装/git pp。需后续授权修复并补组合回归，不能沿用原 GREEN 宣称这些边界通过。

### 2026-11-04 — iPhone 已覆盖安装连接修复
实体 iPhone 已从主线 `882eba7` 原位安装并进入前台，原图、聊天、草稿与设置比对通过。Mac 桌面目录已获准，真实工作区也已验证。[验收记录](docs/model-connection-entry-20261104.md)

### 2026-11-04 — 模型连接修复随主线安装到 Mac
GitHub master 已回读至产品提交 `3379718`。集成检查 `run-2njTtf` 及 17 项 Mac 发布检查通过，安装后账号与聊天核对一致。[安装与发布记录](docs/model-connection-entry-20261104.md)

### 2026-11-04 — 先保存 API Key、再补模型
已复现并修复桌面第二次保存报错。桌面与 iPhone 显示密钥保存状态，重新打开连接管理会回到保存的账号。快速档 `run-EjySBh` 通过；原生按钮、冷启动与出站凭证的检查见[连接验收](docs/model-connection-entry-20261104.md)。

### 2026-11-04 — 模型连接管理（Codex）
桌面和 iPhone 的系统设置首屏提供 API Key 入口，同一服务可添加多个具名账号。全局和单段对话可各自切换。Android 同地址绑定按连接 ID 解析。快速档 `run-t78jZl` 通过。五账号浏览器实点、模拟器冷启动及 HTTP 密钥核对见[入口和验收](docs/model-connection-entry-20261104.md)。

### 2026-11-05 — Melo 主线（Claude）— 方案 A 全部落地并推送（岗位目录、成员独立运行、限额证据、任务级审批卡、岗位模型）
- 线程 ID：e02f4818。用户选方案 A 并拍板全部最高分项。已推送 master：A1 岗位目录动态生成（`afc9992`）；A2 / A3 成员走 `runSubAgent`（份额、只读并行 / 执行串行、取消贯通，`a1b56f8` + 三处修正 `35f5fd1` / `42e992d` / `dbf5dff`）；P2-10 + B3 限额收尾保留已核实事实、成员压缩、派成员时扩展顶层预算（`f6de67a`）；A4-1 执行成员启动前一张“本次任务”审批卡 + A5-1 Agent 设置页按岗位选模型连接（`4e56677`）。真实探针：卡片 8 s 弹出、任务级批准后 file_move 不再二次弹卡、文件安全门仍逐项确认；BIGBANG 长题机制全部按设计工作但仍 LIMIT_DELIVERED（天气需分页读 BOM）。快速档 `run-pCcNjZ` 全绿；集成档 `run-9TzcQe` 全绿（583 / 583，JS 4 868 / 4 868，Android、设置浏览器、Swift 全部通过，197 s）。[实施记录](docs/agent-orchestration-implementation-20261104.md)、[审计](docs/agent-orchestration-audit-20261104.md)。
- 未做 / 下一步：手机端成员仍内联（无卡片、不读岗位模型，宿主差异已记录）；审批卡列出岗位全部受审批工具（执行岗 24 个，17 个是 Playwright 动作），可按子任务或 MCP 服务分组收窄；BIGBANG 的天气要 BOM 分页读取或接 BOM 公开接口；门禁前先 keep-awake，`--files` 不要带 `.kt` 路径（会扩成全量 JS）。
### 2026-11-04 — Melo 主线（Claude）— 隐藏子 Agent 编排层审计（只报告）
- 线程 ID：e02f4818。用户所问的"主 Agent 路由 / 分派 / 审批 / 整合、子 Agent 做网页查询与工具调用"这层已由当日内部岗位路由实现；审计对照出五项差距（岗位白名单写死只覆盖 11 / 33 工具、成员轮次与 token 不分层、不能并行分派、审批无主 Agent 预筛与任务级范围授权、同模型且成员无背景），三次真实探针印证预算不分层导致 LIMIT_DELIVERED（326 148 / 400 000 token，检索成员 6 轮 28 次调用触顶），另有 wttr.in 快路定位错误与收尾丢失成员已核实事实两处缺陷。[审计与方案评分](docs/agent-orchestration-audit-20261104.md)。未改代码。
- 下一步：用户选方案（推荐 A：动态岗位目录 → 预算分层 → 并行分派 → 审批预筛 → 岗位模型与背景，分阶段各自验收）；P2-9 wttr.in 定位与 P2-10 收尾丢证据可单独修；搜索无 key 仍是检索岗位的前提问题。

### 2026-11-04 — 设计 Melo（Codex）— iPhone 后台保护与恢复
本地主线组合源码 `d8c51b2` 包含后台恢复及任务分工。集成档 `run-sjrWAq` 通过 4,842 项 JS、38 套 Swift 和设置浏览器。短回复不再在前台提交持续任务，离开时排队申请系统后台时间。普通回复的工具回执与执行预算保存在设备，可以沿原任务继续；未知副作用需先核对。模拟器实切设置、系统时间到期注入、杀进程后恢复与主动取消分开验证。[实施与验收](docs/iphone-background-continuation-20261104.md)
选测复核（2026-11-04）：`run-6L1pvk` 快速档实际也扩大到全 JS。对固定组合源码重放计划，单独传入 `ios/scripts/verify-background-simulator.py` 即选 578/578 个 JS 文件，其余 17 个改动合计选 170/578。该专项脚本走了“未知运行时 / 构建边界”兜底。此次仅重放计划，尚未变更选测规则。

### 2026-11-04 — 内部岗位按需分工（Codex）
桌面、iPhone 和 Android 的主 Agent 可以按需分配检索、资料读取、计算和执行，按宿主工具权限隔离成员上下文。手动团队与自定义 Agent 的委派白名单独立。真实模型用隔离合成预报交付 26°C → 78.8°F；最终回归 run-OeYShm 通过 4,842 项 JS、38 套 Swift、Android 四项和设置浏览器。三端入口、回放与边界见[实施及回执](docs/internal-routing-and-scene-20261104.md)。

### 2026-11-04 — 自定义 Agent 分工审计与任务空间分类
金冬天、懂王当前均关闭委派。桌面及 iPhone 已有显式团队与主 Agent 汇总，此前未有自动岗位路由；现按用户选定的按需分工接入普通聊天。iPhone 网页、手机工具和历史读取现写入实际调用，记录来源与读取状态；旧手机回放也按工具归类。详见[方案与执行回执](docs/internal-routing-and-scene-20261104.md)。393 × 852 浏览器实点、iOS 模拟器目标构建与影响范围回归 run-lQI4u4 通过（JS 2,241，Swift 38 套，Android 四项）。未装真机。

### 2026-11-04 — 设计 Melo（Codex）— Android Organizer 本地集成与缺陷审计
本地 master 已合入 yrlf 的 12 个原始提交，合并节点 `7a828ec`，最终源码 `7a55331`。修复系统日历撤权后的信息披露、短日程延期失效、目标完成误报、长对话压缩后误超限、跨端 Trace 留存及归档断链。最终集成 `run-hdesSa` 通过 JS 4,837、Swift 38 套、Android JVM 204 与 Lint/Debug/Release、设置浏览器。另验模拟器 16 项、iOS 未签名完整构建。增量审计 H1–H20 零新增，10-27 固定基线原有 H5 +29。实体手机及真实模型服务另验。[合并审计](docs/android-organizer-merge-audit-20261104.md)
用户已授权将含贡献分支和审计修复的本地 master 推送至 GitHub master。推送前远端为 `d58554c`，已验收的源码为 `7a55331`。[GitHub 主线提交记录](https://github.com/MortredVigoss/Melo/commits/master/)

### 2026-11-04 — GitHub 分支归属核对（设计 Melo）
GitHub 仓库事件显示 `yrlf` 创建并推送 `codex/android-organizer-20261026`。12 个独有提交的 Git 作者均为 Yang。远端 `master@54a9cac` 与分支 `fed7c13` 各有 32 和 12 个独有提交，共同祖先以来分支改动 143 个文件。Organizer 增加本机待办、日历和提醒，手机操作支持验证后重放，共享核心调整完成证据并记录本机执行轨迹，Android 新增流式工具调用和错误详情。已核对 GitHub 提交、文件差异、PR 清单与预发布，本分支未开 PR。源码与发布状态以[固定版本比较](https://github.com/MortredVigoss/Melo/compare/54a9cac100998d17b105dd4816821ecc41236a01...fed7c1343240f0f622843d9c1438a5f78019f121)和[0.10.8 预览版](https://github.com/MortredVigoss/Melo/releases/tag/android-v0.10.8-organizer-preview.1)为据。

公开媒体 MCP 的首次预审为 C。联网权限、字幕续读和文章路由已修复，基准集成 `run-wjw2jf` 通过。按用户指令直接快进推送后，已回读核对 GitHub `master` 为 [d58554c](https://github.com/MortredVigoss/Melo/commit/d58554cf9a5bc669d472af58b38066285314846e)。[整改回执](docs/public-media-readers-20261104.md)。

### 2026-11-04 — 桌面公开媒体 MCP

新增 10 类作品的公开检索与读页。现有 6 个 Agent 均已启用，数据备份核对通过。Instagram 指定账号、YouTube 关键词各实获 6 个候选并读到作品。Instagram 作者文字、YouTube 实际字幕、其他平台详情与受限样本见[逐平台验收](docs/public-media-readers-20261104.md)。

### 2026-11-04 — 站内检索与 MCP 读取
- 桌面新增小红书搜索/笔记详情、抖音搜索/作品详情/评论。固定版本、校验和、回环令牌、独立登录；现有和新建 Agent 默认获两项只读服务，用户撤销后不再补回，手机不共享电脑会话。
- 标准 HTTP/stdio、目录变化/取消、结构化内容、读页等级与长文分页已接到真实执行链。入口：自定义 → 高级 → MCP 服务；第三方发布、私信等不出现在默认工具列表。
- [审计、授权与实施回执](docs/mcp-retrieval-audit-20261104.md)。当前桌面实连 2+3 个工具，六个 Agent 均通过权限核验；浏览器实际显示两套登录入口。访客实测：两平台各找到 4 个候选；小红书 546 字笔记正文、抖音 288 字作者文案。真实模型自行搜索并打开小红书笔记，回执 completed；受限页不算已读，视频文案不算观看记录。日常门禁 `run-qe79QA` 全绿（JS 4784、Swift 37、Android 与设置浏览器）。

### 2026-11-04 — 本线程：MCP 与网页检索审计（仅报告）

- 基准 `2ca7fa3`，未改产品代码/账号/配置，未安装、提交或推送。[审计与分阶段方案](docs/mcp-retrieval-audit-20261104.md)覆盖 MCP 发现→可见性→执行→结果→证据/回执及相关桌面/移动入口。
- 审计时服务登记四个 MCP；六个全局 Agent 均允许 network 与四个预设。缺口已复现：标准 HTTP MCP 缺失、自定义 HTTP 连接器被称作 MCP、分页漏工具、退出后假连接、结果正文/图片丢失、取消不下传、社交预览与截断读取状态丢失。旧搜索故障使用 10-27 日志，未冒充今天实测。
- 定向 11 文件 116/116、零失败/跳过；9 个边界探针 + 1 个真实子进程退出探针；证据 `.tmp/mcp-audit-20261104/`。已有循环/浏览器/核验确实存在；未注册的 sharedFetchAdapter 不算生产缺陷。
- 已核对小红书社区 MCP、Playwright、Browserless、Tavily、Firecrawl 维护者资料；推荐先修协议/结果/证据，再补只读来源并对齐手机。当时未验真实对照任务、平台登录或 UI；用户随后授权实施，最新回执见上条。


### 2026-10-27 — Melo 主线（Claude）— 桌面覆盖安装到 `554ce96`，发布脚本 `open --env` 修复
- 线程 ID：e02f4818。桌面壳 17:07 覆盖到 `~/Applications/Melo.app`，第二次 `release:verify` 17 项全绿（本机 Android 四项实际执行，两个安装路径 page-loaded）；`scripts/verify-red-green.js` 原生启动改为直接拉起可执行文件，因 macOS 26.6 的 `open --env` 把值在第一个空格处截断（项目路径含空格），快速档扩大到全部 `run-StBxI4` 全绿；[回执](docs/overwrite-install-20261027.md)。用户点权限后 18:58–19:09 用主 Agent 真跑 BIGBANG 10-31 长任务两段（[评估](docs/live-test-bigbang-20261027.md)）：场馆 / 交通 / 两天路线准确，天气缺，活动靠"继续"补到一半，两段都 LIMIT_DELIVERED；根因在壳 PATH 无 node（Playwright 搜索腿不可用）、Jina 匿名 DDG 限流、授权无人点 120 s 超时、40 万输入 token 回合预算、6 000 字页面截断。iPhone 19:14–19:20 覆盖到 0.7.13 (45)，17 对话 / 174 消息 / 6 Agent / 26 图两次回读一致。壳 PATH 当晚修复并第三次 `release:verify` 覆盖安装，集成档 `run-1epM2L` 全绿后已推送。
- 下一步：壳 PATH 已修并覆盖安装（第三次 `release:verify` 17 项全绿，用户需再点一次权限）；无 key 时搜索仍无结果（Google 对无头浏览器出验证页、Jina 匿名 DDG 403），需配 Tavily / SerpAPI / Jina key 或换引擎；集成档 `run-1epM2L` 全绿，已推送。

### 2026-10-27 — Melo 主线（Claude）— 循环上限八条复核与收尾
- 线程 ID：e02f4818。Codex 的五步提交 `d0bcf3e`…`77b2879` 已对照八条清单逐项核实落地，本机复跑新增测试与三跳夹具通过；收尾提交删除三端不再调用的进度汇报路径并重建 agent-core，快速 / 集成（基准 36c40b3）结果见[实施记录](docs/limit-delivery-20261027.md)复核节。已按用户授权推送。
- 下一步：iPhone 已于当日 19:20 覆盖到 0.7.13 (45)，真实模型的 LIMIT_DELIVERED 路径已在当日真跑中出现两次（均见上一条）；Kotlin `SharedCoreTurn.reporting` 无调用方，待 Android 改动时清理。

### 2026-10-27 — 设计 Melo（Codex）— 有能力却提前结束的四项修复
- 基准 `7ae6bf5`，分支 `codex/task-continuation-20261027`，本地实现提交 `99b8ba7`；[实施与验收](docs/task-continuation-20261027.md)。`shared/agent/{goal,turn}.js` 与 Node / iOS / Android Host 已接入零工具任务核验、独立检查轮、1–20执行轮设置与到顶无工具汇报；`fileSafetyGate` / executor / 审批UI接入本任务范围授权，合并文件双重确认，有限ls/cat静默读取。三端共用先取证再问人的操作指令。
- 最终快速 `run-oTS2EM` 与基于7ae6bf5的集成 `run-fK71Jc` 全绿：均JS4726/4726、37套Swift、Android四项、设置浏览器通过，无跳过/隔离复测；iPhoneOS完整未签名构建通过。真模型四项（文件翻译、计算报告读写回读、轮数到顶汇报、拒绝替代）及独立文件断言符合预期，[脱敏回执](docs/task-continuation-real-model-20261027.md)已入库；审计所有H规则零新增，未提高基线。
- 授权边界：首次实际需确认时由用户选择本次任务范围；拒绝后仅走仍被允许的替代路径。保留取消、整体预算、已有检索检查与成功效果去重。Android轮数为本机设置；桌面任务授权不替代手机系统权限。四项开发与本机验收完成；实体手机/真实账号跨端同步、安装发布仍待单独授权和验收，未推送/安装。保留另一线程规范提交 `dfc9269`，函数级链路及未覆盖清单已补入实施文档。

### 2026-10-27 — Melo 主线（Claude）— 统一开发规范落地
- 线程 ID：e02f4818；状态：本地提交，未推送。根目录 [MELO_DEVELOPMENT_STANDARD.md](MELO_DEVELOPMENT_STANDARD.md) 取代 CLAUDE.md / AGENTS.md 的流程部分，两者改为入口指针；所有线程开工先读规范。
- 要点：任何授权 AI 同一标准；修改前基于索引写执行链路与审计边界（停止条件、覆盖 / 未覆盖）；改后两档回归并覆盖上限 / 超时 / 压缩 / 审批 / 取消 / 契约场景；审计记录分级保留；审计输出固定格式。缺口：函数级调用索引待建。
- 未完 / 下一步：函数级 `call-index` 生成器与过期检测；Codex 由用户另行告知。

### 2026-10-27 — Melo 主线（Claude）— Agent 工具覆盖与任务闭环审计（只报告）
- 线程 ID：e02f4818；状态：报告已交付并本地提交，未推送；没有改产品代码。
- 结论：内建 34 工具 + 4 免费 MCP + 4 技能 + 手机 4 共享 / 7 设备工具；缺口与免费补法见[报告](docs/agent-capability-audit-20261027.md) §1.4。执行闭环的 P0：非检索任务零工具候选不进目标检查（`shared/agent/goal.js` 第 38 行），探针实证回执记"已交付"；P0 另两项：10 轮上限含检查轮且无进度汇报、审批拒绝即断（真实 590 次中 240 次拒绝）。
- 验证：注册表 / 能力 / 核心循环探针实跑；真实 32 条场景、590 条审批、27 条搜索轨迹只做计数；共享循环 184/184。
- 未完 / 下一步：报告 §2.4 的 P0-1 ~ P2-10 待用户排期交 Codex；新闭环尚无真实多步任务运行证据。

### 2026-10-26 — Melo 主线（Claude）— 双端覆盖安装到 `752a086`，回执推送
- 线程 ID：e02f4818；状态：iPhone 0.7.12 (44) 与桌面壳均已覆盖安装；版本号 `752a086` 已推送，本回执随后提交推送。master 已含全部完成线程，无新合并。
- 验证：`test:full` 14 步 13 GREEN，唯一 RED 为 Android（本机无 JDK / SDK，环境原因）；因此未走 `release:verify` 的安装步骤，改为手动 `install:desktop` 加与发布脚本相同的原生启动断言（两路径 13 项全过）。手机解锁备份 55 文件 / 187.8 MB，安装后与启动后 16 对话 / 169 消息 / 6 Agent / 26 图一致。
- 环境注意：`ios/scripts/sync-theme.py` 需 Python ≥ 3.9，anaconda 3.8 下 `build-scene.py` 直接失败，用 `/usr/bin/python3` 通过；Android 本机不可跑，由 CI 覆盖。详见[回执](docs/overwrite-install-20261026.md)。
- 未完 / 下一步：真机功能由用户在实体屏幕确认；Android 四项交 CI；带 lock 标签的开发镜像仍待重建。

### 2026-10-26 — Melo 主线（Claude）— 隔离自开发审计后三处收紧
- 线程 ID：e02f4818；状态：已提交 `16ad6dd`，随文档回执一起推送 master；未安装。
- 行为：`development_job` 在工具入口拒绝非桌面聊天来源（Telegram / Discord 的"始终允许"不再能启动作业）；`npm run build:development-image` 把 `package-lock.json` 哈希写进镜像标签 `melo.lock-sha256`，创建作业时不一致阻断、无标签记警告，候选改依赖文件在验证前阻断；`npm test --platform linux`（容器内自动选）把 Swift / Android 记为"本平台未执行"写入 `summary.json`，不计通过。
- 验证：门禁改动完整日常 `run-bZBKkK`（JS 4709/4709、设置浏览器、Swift 全过，无跳过/复测；Android 不在计划内）；Docker 隔离与旅程验收通过、无残留；真实镜像标签读取验证通过。现有 `melo-development:local` 无标签，重建后才绑定。
- 未完 / 下一步：重建带标签镜像并用真实作业走一遍阻断路径；Mac 原生隔离运行器、真模型与真机验收仍属后续阶段。

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
### 2026-10-26 — Android 主线复核与 Organizer 设计
- 当前新分支基于主线 `248364b`，旧 Android checkpoint `1be64ad` 保留；Goal/Completion/HTTP 53 项通过，Android JVM 147 项通过。Fold6 ADB 已授权、仍为 0.9.0/code22，仅查元数据，没有安装。
- 已确认源代码仍有 phoneFailure 直接返回、四调用压缩/JPEG Progress、Workflow Tool 未合入；不宣称主线已解决所有旧故障。
- Todo/Calendar 用户已选择原生提醒和系统+ICS Provider；[设计稿](docs/specs/2026-10-26-android-organizer-design.md)待整体审阅；[复核回执](docs/master-loop-recheck-20261026.md)保存本轮证据与边界。

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
| 神经导航 / 场景 | `desktop-ui/neuralLayout.js`、`neuralMotion.js`、`neuralShell.js`、`neuralSatellite.js`、`neuralScene3D.js` / `neuralScene.js` | 同一空间模型驱动 DOM、GPU/Canvas 与拾取；10-27 修复首页透明入口的级联和顶部项目避让，保留五组拓扑与持续动画，见 UI 交接 |
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
| 神经任务空间详情 | `desktop-ui/executionPanel.js` / `.css`、`executionDetails.js`；2026-11-06 起全屏作战大屏 `warRoom.js` / `warRoomScene3D.js` / `warRoomLayout.js`（原 `executionViewport.js` 已删除）；`ios/Melo/Scene/` 共享资源 | 最新回执、分轮可滚动摘要、完整详情；摘要滚轮不误触相机；历史仅读已存 sidecar，失败/取消保留已有回执；手机独立采集须另核对 |
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
| melo ui | `01a10bf3-d7b9-7832-a351-8b0f78e9c552` | 11-07 设置 `81ae41a5` 与主线 `6bb8da28` 合并为 `701e43f5` 并正常推送；Mac / iPhone 0.7.16 (48) 均已原位覆盖和实界面核对。连接方式切换对应表单，整体停用智能选模，原凭证保留 | Mac 发布前发现既有测试污染，已修复隔离；按用户确认恢复 33 聊天 / 752 消息 / 6 Agent / 1 项目，3 段较新执行记录另存。安装前后 6,047 文件完全一致，启动后原聊天及当前配置一致；手机 18 聊天 / 199 消息 / 6 Agent / 27 原图保留，原 API Key 和 Codex 登录实机可读。追加 unit 可选串行调度及即时阶段日志；快速 run-6LCJs3 全绿，集成 run-mHbkO2 通过（1 项超时单次隔离复测通过）；最终 release:verify 17/17 GREEN、JS 5048/5048，无跳过/复测。最终门禁修正与回执随本次收尾提交。[发布回执](docs/model-settings-release-20261107.md)、[设置记录](docs/model-settings-structure-20261107.md) |
| 读取 melo ui 方案 | `01a1103d-0c3b-77d4-96dc-ea499d455020` | 2026-10-06 读取、单次成功派发、按指定 turn 只读跟进与 Library 截图交付；2026-10-15 补历史证据 | 辅助线程无产品代码/提交；288/291 项为旧轮次结果，详细边界见[辅助线程回执](docs/handoffs/melo-thread-backfill-20261015.md#ui-helper) |
| melo iphone | `01a11116-8469-74a2-9815-8ce59b702afa` | 10-16 三线程功能/UI 对齐，Agent 首屏新建/移除旧语气、项目校验及新黑金 M，已覆盖 0.5.19 (25) | 本地 `5c975aa`；3575 JS/23 Swift/90 专项及模拟器通过；实体安装/启动/数据保留已验，实体 UI/真实模型未复验；`docs/ios-align-install-20261016.md` |
| melo副线 | `019d5db3-d2cd-70c2-bc8f-955d36099219` | 固定源码统计口径、早期 pre-push evaluation 协议；OpenClaw/桌宠历史工作独立 | 2026-10-21 再统计 205,993 行（含空行/注释，不含 ios）；既定四目录及扩展名 `find` / `wc -l` 退出码 0；仅文档 WIP 与快照更新，无产品验收或提交；桌宠入口见[副线回执](docs/handoffs/melo-thread-backfill-20261015.md#secondary) |
| melo全量代码统计（Claude Code） | `46a2bdcb-e8d9-4826-bf92-2fde11eff56a` | 2026-10-22 用户要求统计全部 Melo 代码含桌宠；新增全量口径，与副线四目录口径并列，不替代；2026-11-07 统计 Claude 累计 token 并按 Fable 5.1 定价折算 | 11-07 Claude 用量：本机 `~/.claude/projects` 与 Cowork `local-agent-mode-sessions` 全部 Melo 会话（cwd 或用户消息含 Melo/桌宠，含子代理；按消息 id + requestId 去重；2026-04-17 → 11-06，23,266 次调用）合计 7,796,865,222 token：缓存读 7,688,352,384、缓存写 92,829,925（1h 76,663,895 / 5m 16,166,030）、输出 15,511,286（含思考）、未缓存输入 171,627。按 Fable 5.1 牌价（$10 / $50 / 写 5m $12.5、1h $20 / 读 $0.25 每 MTok）约 $4,435（Claude Code $3,005、Cowork $1,430）；牌价折算，不是账单。未含 claude.ai 网页对话、其他机器、应用索引里 3 个无记录文件的 5 月会话、Codex 用量。 10-22 代码行数：HEAD `7750d8f` + 未忽略 WIP：自写代码 258,612 行（非空 240,931，1,528 文件；测试 91,581），其中产品仓库 249,790、外部 8,822（旧站 site 4,691、桌宠素材线去重 1,861、melo-universe 1,158、跑分自写脚本 1,112）。口径：`git ls-files --cached --others --exclude-standard` 下 js/mjs/cjs/jsx/ts/tsx/swift/kt/kts/py/sh/command/applescript/cc/gyp/html/css；排除 dsh-pet 上游 37,957、生成 bundle（`ios/Melo/Scene/`、两份 `agent-core.js`、`upstream/lib/melo-host.mjs`、`shared-core.js`）、JSON/xcstrings/YAML、外部 venv/SWE-bench/requests 副本与桌宠旧工作目录。同时副线四目录口径为 208,937。只读统计，无产品验收或提交 | HEAD `7750d8f` + 未忽略 WIP：自写代码 258,612 行（非空 240,931，1,528 文件；测试 91,581），其中产品仓库 249,790、外部 8,822（旧站 site 4,691、桌宠素材线去重 1,861、melo-universe 1,158、跑分自写脚本 1,112）。口径：`git ls-files --cached --others --exclude-standard` 下 js/mjs/cjs/jsx/ts/tsx/swift/kt/kts/py/sh/command/applescript/cc/gyp/html/css；排除 dsh-pet 上游 37,957、生成 bundle（`ios/Melo/Scene/`、两份 `agent-core.js`、`upstream/lib/melo-host.mjs`、`shared-core.js`）、JSON/xcstrings/YAML、外部 venv/SWE-bench/requests 副本与桌宠旧工作目录。同时副线四目录口径为 208,937。只读统计，无产品验收或提交 |
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
- 2026-11-06 用户拍板布局 A：
  - 任务空间展开为全屏作战大屏，聊天里收成一行。
  - 星核是主 Agent；五个区域按 Melo 主界面配色细化。
  - 执行由固定的低饱和紫色线框蜘蛛完成：出去就离开星核，必须碰到区域并在上面小幅移动转身，爪子扒下词条落到底部记录。
  - 回复中有真实执行时自动弹出，遇到等待用户确认的提示让开；电脑和手机都能手动旋转、缩放。
  - 工具调用区域只算本区域的调用，网页搜索归网页检索；屏上每个数字都能点开查看其记录。
  - 默认画面完整显示五个区域；手机底部卡片左右滑动。
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

- **2026-11-07 后续决定**：用户明确要求关闭整个智能选模，始终使用自己选择的模型，并移除这组设置。三端产品源码已停用自动判型、跨连接切换与升档；旧策略和通用引擎仅保留兼容/历史回执。此处 10 月记录保留为实施历史；当前设置结构与验证见[11 月记录](docs/model-settings-structure-20261107.md)，正式安装状态单列。
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

- 用户在自开发审计后授权实施；按推荐第一版交付候选代码、版本绑定证据和只读审查，停在待合并。分支 `codex/self-development-20261026`，基准 `346e175`；实现 `0f6cbff`、修正 `833e991`，最后文档回执单独提交。未推送或安装。
- `src/development/` 管理独立源码/Git、Docker 临时卷、断网执行、长命令日志/停止和启动恢复；`/api/development/*`、`development_job` 工具与桌面「工具与任务 → 隔离开发」提供实际入口。测试/审查绑定源码树，原仓库推进或证据变动使旧批准失效；敏感文件变更另需人工核对。审查必须实际读过证据和改动文件。
- 手机使用同一个作业 ID 投影到 v1 任务检查点；iPhone/Android 展示状态与验收摘要，禁止把检查点当作桌面执行/批准。纯 `test:full` 不安装；安装独立为 `release:verify` 且位于所有纯验证之后。
- 验证：专项 35/35；最终完整快速档 `run-PaMYDz` / 集成档 `run-b5NI8f`（基准 `346e175`）：JS 4704/4704、设置浏览器、Swift 37 组、Android JVM/Lint/Debug/Release 全过，无跳过/超时复测；iPhone 完整未签名构建成功。容器隔离、Git/原生依赖、恶意符号链接回传拒绝、取消清理和浏览器/HTTP/执行器闭环均实测；模型为确定性夹具。长命令约608秒正常退出；首次脚本计时断言错误已记录修正。
- 测试环境在独立工作树准备：依赖、离线模型、素材链接及哈希校验；未改真实账号或共享素材。Melo 最终实现提交 `833e991` 的模块在真实容器20/20，源码树不变。证据 `.tmp/self-development-implementation-20261026/`；完整说明见[实施文档](docs/self-development-implementation-20261026.md)。
- 状态：整批实现与组合验收已完成，本地合入主线；不推送、不安装。自动合并/发布/回滚、Mac/iPhone隔离运行器、真模型与真机验收属于后续阶段；本版不声称已实现完整自更新闭环。

## 2026-10-27 — 本线程：循环计数与上限交付

- 用户指定五步方案；独立工作树/分支 `codex/limit-delivery-20261027`，起点 ca3fca0，保留上一轮闭环修复；最终集成基准7ae6bf5。已读入口与开发规范，调用链/状态/异常/契约消费者与停止边界见[实施记录](docs/limit-delivery-20261027.md)。
- 已本地独立提交：d0bcf3e仅实际工具批次计rounds；cceb4f1默认40/20/12、工具200/30分钟、深度64/300/45分钟及三端设置；006797b预留时间/token后的无工具交付/核验；57bc404成员/技能统一交付及主 Agent继续补做。显式旧配置、取消/副作用/权限守卫保留。
- 最新累计快速run-4D3pby：JS4771、Swift37、Android JVM/Lint/Debug/Release、设置浏览器全绿，零跳过/复测；iPhone完整未签名构建成功。6/40轮两端夹具分别partial/LIMIT_DELIVERED与completed；浏览器授权、结果回传、撤销及DOM部分完成状态已验证。
- 第五步验收完成：真实模型隔离日历→真实搜索/读页→检查纠偏，8请求/5工具，completed；[脱敏回执](docs/evidence/limit-delivery-20261027/live-model-receipt.json)与[重建执行场景](docs/evidence/limit-delivery-20261027/execution-scene.json)。最终累计快速run-ca7apo/7ae6bf5集成run-RRWwcg全绿（JS4771、Swift37、Android四项、设置浏览器，零跳过/复测）；最终未签名iPhoneOS完整构建成功。本地验收完成，产品源码交付目标为原开发分支codex/task-continuation-20261027，整合方式为fast-forward；保留五步独立提交。
- 无推送、git pp、安装或用户数据变更。Codex OAuth输出8k仅为本机预留而非服务端硬截断；Android没有新增原生成员入口；真机、账号同步、长期后台本次未验。

### 2026-10-27 — 本线程 master 合并与推送交接

用户随后明确授权“去推送吧 合并master”。远端读取后无分叉，master从7ae6bf5快进至77b2879，包含此前任务闭环修复及本次五步提交。94份本次代码指纹与最终集成run-RRWwcg一致，合并未产生产品改动；复用其JS4771、Swift37、Android四项与浏览器全绿证据。本次只补发布记录并按文档范围检查；正式推送目标origin/master，命令输出及远端SHA核对保存在`.tmp/limit-delivery-20261027/push-master.log`与`push-master-receipt.json`。不运行git pp，不覆盖安装，不改账号和数据。

### 2026-10-27 — melo ui — 首页样式级联与空间回归
- 基准 `54a9cac`，本地提交 `a74a90d`：恢复透明神经入口，去除旧版 overview 内边距；`workspaceLayout` 为顶部项目入口、中枢及输入 dock 预留空间。五组颜色/粒子拓扑/功能不变，未触及账户、模型或同步协议。
- 定向回归 11/11；原生应用已加载修复、浏览器五个模块入口与持续动画已核对；截图、真实尺寸和根因见[专项记录](docs/home-ui-regression-20261027.md)。
- 快速 `run-pGEfj5` GREEN（1 项负载超时按运行器隔离复测通过）；基准集成 `run-necJZi` JS 778/778，Android、共享渲染、设置浏览器全绿，无复测；iOS 仅共享样式生成，无手机安装/真机验收；不推送、不重装。

## 2026-11-05 — Codex：内部编排缺陷修复与任务评估三方案

用户语音授权修审计R1–R7，新任务范围/评分策略先给三方案再选择。基准431912b，独立分支codex/orchestration-review-fixes-20261105。完成整轮副作用防重、异常回执保留、交接文字不作完成凭证、旧端设置同步兼容、智能执行强档、截止时间一致、分页证据和完整岗位连接；未知岗位连接明确失败。新策略尚未启用，推荐B（需求合同+分批评估）。[方案](docs/task-completion-policy-options-20261105.md)、[修复和证据](docs/orchestration-review-fixes-20261105.md)。最终累计快速run-xPfXLt全绿：JS4882/4882、Swift38组、Android四项和设置浏览器，零跳过/复测；中间失败和修正均留档，真实模型/真机与合并前基准集成未做；不合并/推送/安装，无用户数据修改。


### 2026-11-05 本线程：B 需求合同、自适应范围与最终审核

- 实现 201b9c9、审核协议修复 2cb936b，含内部路由 R1–R7 的 5d1a514。共享策略驱动三端任务目标、实体计数/证据、部分交付和独立成员份额；Agent 设置可选本机快速/标准/深入。
- 基准 cba47c9，最终快速 run-BdkSW7、集成 run-b9dLLp 两档 JS 各 4927/4927、Swift 各 38 组、Android 四项、设置浏览器全绿。最终真实模型目录：8/20 partial（读 2 次）、20/20 completed（读 1 次）；短引用、后半页证据与审核字段三处真实问题及修复见[专项记录](docs/task-evaluation-b-implementation-20261105.md)。
- 旧 Mac 完整备份 5778 文件哈希一致，另保留外部原图；用户已授权 master 合并、推送和本地 Mac 覆盖安装，发布验收回执另列。不安装 iPhone，已验证最终 iPhone 无签名构建。

Mac 覆盖安装和正式首启验收均已完成。17 项发布检查通过，安装后 5,778 个原文件哈希一致。用户确认桌面文件夹授权后，已用原账号在正式应用收发测试消息，并确认回复已保存。原有 33 个聊天、752 条消息和原图均保留，新增 1 个验收对话。Agent 管理页可见本机检索深度。验收证据见[安装回执](docs/task-evaluation-b-implementation-20261105.md)。

2026-11-05 用户随后授权 iPhone 覆盖安装。已将同一主线构建装入原实体 iPhone，验证 Melo 启动并进入前台。安装前完整容器两次读取一致，安装后和首启后均保留 18 个聊天、197 条消息、6 个 Agent、26 张原图及账号配置。见[手机安装回执](docs/iphone-task-evaluation-install-20261105.md)。


### 2026-11-06 — Codex：Melo 对话归组

- 本线程 `01a1b0c5-782c-7aa1-8310-3e8dffa52147` 按用户要求整理 Codex 侧栏；目标为已有本机项目 melo（`local-0e505ea558257b09e9f39cf3ad0304a1`），项目目录仍为混合工作区，不改变产品仓库。
- 通过 Codex App 的 `list_projects`、`list_threads`、`move_thread_to_project`、`move_thread_to_sidebar_section` 操作；6 条 Melo 对话取消单独置顶，项目置顶保留。两条历史对话「melo主线（历史）」「Melo AI」恢复显示后归入项目，回读确认归属。
- 验证层级：App 接口回执及侧栏/历史列表回读；非产品代码或运行态验收。当前活动对话移动接口成功但回读仍无归属；远端「读取 melo ui 方案」因无法安全确定来源项目未能移动，后续需用户在侧栏手动拖入。未逐条审阅无标题远端临时任务。
- 仅本条交接为文档 WIP，不提交、不推送、不安装；无产品功能改动。


### 2026-11-09 — Codex：双端回复延迟修复（已完成本地验证）

- 用户授权按审计顺序修复、保持功能与核验、保留账号数据、实测并更新文档。基准 a3d6859b，隔离工作树 `/tmp/melo-reply-latency-20261109`，分支 `codex/reply-latency-20261109`；原主工作树与安装应用未改。
- 已接通手机正文草稿、逐请求/活跃暂停计时、精确审核复用；两路只读成员/工具、HTTP 优先读取、权限/版本/时效约束的分页缓存；无效派单纳入原失败守卫。桌面/手机/Android 共享核验同步，保留主 Agent、证据和副作用检查。
- 真实同模型各 3 次：手机原生解释首草稿 1.16 s；最终交付未普遍改善、检索稍慢。35 份正式配置/状态/聊天哈希未变。原生 UI 草稿/保存/取消迟到回复、模拟器公开 HTTP 正文另验通过；不冒充实体手机测速。
- 快速 `run-upnw3o`、基准集成 `run-plxiQ5`：5070 JS、40 Swift 组、Android 四项及浏览器/预检全部通过，零失败/跳过。早期失败和中止记录保留；实现已本地提交 `4b46fa9e`，最后仅补文档交接。
- [执行链、实施与全部证据](docs/reply-latency-implementation-20261109.md)。下一步仅在用户另行要求时合并/推送/覆盖安装并补真机验收；本轮无 git pp、推送或正式安装。
- 2026-11-14 补记：这一条写在分支上，是分支当时的状态。分支当天并入 master 时只取了一部分（两路只读成员和 HTTP 优先读取没有带进来），见下一条和 [合并记录](docs/unmerged-branches-merge-20261114.md)。

### 2026-11-14 — Claude：12 个未并入的本地分支并入 master

- 用户要求检查没有并入的分支、全部合并、调试并让 GitHub 成为最新最全的版本。逐个文件核对后，11 个分支的内容已在 master，用只记录、不改文件的方式并入；`codex/reply-latency-20261109` 是唯一带着新功能的。
- 该分支与 master 11-10 的延迟修复重叠：master 已有自己做法的保留 master 的，其余 7 项按 master 现在的代码带进来（iPhone 回答草稿流式显示、相同的被拒答案不重复核对、网页分页缓存、运行与暂停时间、首段正文时间、"查找"判断收窄、桌面准备并行）。
- 并入时修掉分支的流式解码器 4 处问题（现与桌面端规则一致）和"相同答案不重复核对在 iPhone 上从不生效"。没有带进来：网页先用普通 HTTP 读；iPhone 两个只读成员同时运行（需重新设计，等用户决定）。
- 验证：完整校准 `run-NIhf3d`、集成档 `run-eZv89f`，iPhone 40 组与模拟器真实界面测试，Android 设备测试 12/12。没有真实模型、真实供应商和实体手机的验证；桌面壳未重编，手机未重装。
- [逐分支核对与逐项取舍](docs/unmerged-branches-merge-20261114.md)。
