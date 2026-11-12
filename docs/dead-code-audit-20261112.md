# 死代码清理与测试成本审计（2026-11-12）

基准 fab843a0，隔离树 /tmp/melo-dead-code-20261112，分支 codex/dead-code-audit-20261112。用户授权扫描、删除有证据的无效代码，并要求测试优化方案；本轮不改测试选择策略，不推送/安装，不操作正式应用数据。

## 扫描方法与边界（修改前）

枚举 Git 跟踪源码/配置，逐文件完整读取、逐行规则扫描并记 SHA256；JS 使用固定版本 Acorn AST + eslint-scope 作用域引用，静态/动态 import、require、re-export 均记录。Swift/Kotlin 做私有名称单引用和占位扫描；生成、第三方、测试单独分类。扫描不是逐行人工语义证明；不能证明未使用的部分不删除。

停止于仓库入口和第三方/生成边界；不删插件/Worker/HTTP/原生桥入口，不因只被测试引用就断言某功能无用，不删除历史数据字段和同步兼容。具备副作用的变量初始化、协议空实现、抽象方法、对象 rest 排除字段均须保留。无静态 importer 只是候选，需要核对所有代码/配置/HTML/脚本中的字符串引用及入口。

## 清理执行链与审计范围

- 桌面 app.js → 当前 feature renderers / 主渲染函数：清除没有任何引用的旧 sidebar、问候与 composer/TTS 渲染 helper；不改当前 UI 入口和样式。
- openai.js、PDF/knowledge/bash helper、文件安全辅助函数：仅删除未导出、无读取引用的函数；现行工具注册 → executor → 权限/预算/真实实现路径保持，副作用表达式不删除。
- /api/tasks/prepare → prepareTaskExecution → updateStateAtomically → createChatRecord → 后续真实 chat runner：移除空 assertCanCreateChat 调用和旧空导出，保留 recents 展示上限；补任务创建在多聊天下不丢数据的回归。
- 旧 runTaskAgentExecutionGraph 与无入口的 re-export 文件：核对源码引用、服务映射、命令/构建入口后删除；现行任务由 sendChatMessage 共用 chat runner，原审批/取消/恢复测试保留。
- 未使用 import 只删绑定；若该 import 整体无读取则保留 side-effect import，避免改变模块初始化行为。
- 删除后重新构建功能地图并核对依赖/路由；现有桌面浏览器、工具安全、任务持久化、Swift/Android 消费方由门禁验证。原生声明无法证明死亡的保留，未做真机或真实模型验收。

原始清单、全行覆盖、候选及复核结论位于 .tmp/dead-code-20261112/；最终统计、删除明细、门禁回执与优化提案在收尾时补齐。

完成收尾日期：2026-11-13（Melbourne）；文档与证据目录按开工日期 2026-11-12 命名。

## 结果与覆盖清单

本次基准按之前约定的口径（src / desktop-ui / desktop-app / scripts 的 JS、Swift、JSON、HTML、CSS 等，含空行、注释和测试）为 **1,292 文件、227,202 行**。扩展覆盖 Android、iOS、shared、mobile-sync、native、构建入口及本地化后，完整读取并记录哈希的是 **2,005 文件、497,627 行**：

| 分类 | 文件 | 行 |
| --- | ---: | ---: |
| 产品、脚本和配置（包含 JSON 数据，不等同于纯业务代码） | 1,108 | 231,150 |
| 测试与测试目录 | 710 | 108,567 |
| 生成资源 | 15 | 24,701 |
| 第三方、Gradle wrapper | 171 | 49,203 |
| iOS 本地化词典 | 1 | 84,006 |

其中 1,429 个 JS / MJS / CJS 文件解析了完整 AST 与作用域，解析错误 0。Swift、Kotlin、C++、Python、Shell、构建配置是完整文本和规则扫描，不能声称做了这些语言的完整静态语义分析。二进制图片、视频、字体、JAR 不作为“可执行源码行”统计；历史 Markdown 只在调用与设计决策需要时读，不混入源码覆盖率。

具体覆盖和 SHA256：专项目录 baseline-complete.json；删除后清单 current-complete.json；规则/剩余候选与空回调 review-decisions.json。这些是本地可复查证据，不含用户数据。

### 已清理

- **17 个模块**：15 个已无调用方的旧位置转发文件，以及被现行聊天执行链替代的 services/chat/taskExecutionRunner.js、services/task/taskPrompt.js。删除模块表见下。
- **24 个无引用、未导出的局部函数**：旧侧栏、旧命令建议面板、旧 MiniMax 参数渲染 helper；未使用的 Codex 音频输入构造/转码链；PDF、知识搜索、文件哈希及命令辅助函数。现行音频提取、TTS、知识检索和权限检查仍有入口，未下线这些功能。
- state/chatPruning.js 两个空函数与未使用的旧排序函数；任务准备处移除空检查。保留 MAX_RECENT_CHATS，它只控制最近列表展示，不能作为数据保留上限。
- 无读取的 import 绑定、未消费的定时器返回值、已经不被使用的 ffmpeg 状态和 APP_ROOT 局部常量；模块可能有初始化副作用时保留裸 import。定时器仍然实际执行。
- 重新生成模块地图和 iOS 共享渲染来源清单；生成后的 renderer 实际内容未改变，删除的是 tree-shaking 已消掉的函数。

删除模块：

~~~text
src/media/{audioExtractor,documentExtractor,enrich,imageExtractor,linkExtractor,videoExtractor}.js
src/retrieval/publicLookupIntent.js
src/services/activity/activityLog.js
src/services/agent/agentLibrary.js
src/services/artifact/artifactService.js
src/services/chat/{contextFilters,modeDefs,taskExecutionRunner}.js
src/services/message/messageSearch.js
src/services/task/{taskPrompt,taskService}.js
src/state/chatThreadContext.js
~~~

函数逐项名称和原位置：专项目录 deletions.json。没有删除测试文件，没有降低断言，没有清理任何用户内容或历史兼容字段。

### 有空函数或静态引用少，但不能删除的部分

- 167 个空回调/方法包括取消清理接口、可选回调、流消费监听、Promise rejection handler、抽象基类默认方法。它们会影响接口形状、异常处理或流读取，不能把空函数等同于无作用代码。部分静默异常处理可另立可诊断性任务，本轮不改变其行为。
- server.js、CLI、HTML 里的 app.js / launchScreen.js / galaxyBackdrop.js，以及 socialSupervisor、builtinWorker、derivedIndexWorker 由启动入口、子进程或 Worker 使用，静态 import 图不能单独证明它们死亡。
- 服务层兼容转发、测试支持模块及某些只看到测试引用的模块：测试引用本身是用途，另有 HTTP 静态映射与动态加载；未证明整个入口链失效的保留，不靠删除测试制造“无引用”。
- 对象解构中用来排除敏感字段的未读变量、仍有副作用的初始化、类内部名称绑定保留。
- 第三方包和生成文件不手工裁剪；运行时路由、原生桥和协议方法不按字符串引用数量删除。

## 执行链与验证边界补充

任务准备新增回归：15 段历史对话 → prepareTaskExecution → 原子提交 → 再次 prepare → 原对话逐条深比较一致、只新增一个执行对话、requestId/chatId 不变、runCount 仍为 0。此处不需要模型调用。

文件/权限相关清理止于无读取的私有 helper 和 import 绑定，不改 gatedRead、dirfd 原子操作、审批判定或工具执行结果。现有拒绝/取消、目录穿越、符号链接、恢复回归应全部执行。聊天工具预算、网络故障、上下文压缩、停止与双端契约由原有选定回归覆盖，不用空函数测试替代。

机器规则复核按仓库现有 scripts/audit-inventory.mjs 的 H1–H20 执行；使用同一 fab843a0 源快照、同一文档集作基线，20 条规则新增命中均为 0。10-27 旧基线与当前主线不同，不能把旧基线已有增长算作本次引入，也不能把缺少规则说明文档的归档扫描当成下降。新旧 inventory 位于专项证据的 baseline-rule-audit/、rule-audit/。

未覆盖：正式桌面数据与真实账号、真实模型/网络服务、iPhone/Android 真机安装及使用。本轮是死代码清理，未授权发布；正式桌面数据待恢复的既有事故记录保持不变，未启动正式应用。机械扫描不能证明“所有潜在无效功能都已找到”。

## 检测成本审计与建议（仅方案，未更改门禁）

### 当前事实

当前自动发现 **612 个 JS 测试文件**；最近完整成功回归 run-ACh0QE 是 **5,217 个测试用例**。文件数与用例数不能混用。

plan-matrix.json 是在本次代码上实际调用选择器得到的结果：

| 单次改动 | 快速档 JS 文件 | 集成档 JS 文件 | 当前扩大原因 |
| --- | ---: | ---: | --- |
| desktop-ui/features/chat/controller.js | 46 | 46 | 所属 UI 组与反向依赖 |
| src/services/search/pageWindow.js | 185 | 185 | 整个 tools 功能组 |
| shared/agent/goal.js | 227 | 612 | 公共运行边界，集成档全量 |
| ios/Melo/Network.swift | 1 | 1 | 同时选 22 个 Swift 编译组 |
| ios/Melo/AgentCore/agent-core.js | 612 | 612 | 生成文件未显式登记，作为未知边界 |
| ios/scripts/test.py | 612 | 612 | 门禁本身的安全校准 |
| 删除 src/media/audioExtractor.js 转发文件 | 612 | 612 | 所有删除都无条件全量 |
| 只改 Android 导入脚本 | 3 | 3 | Android 专用分支 |
| 同时改该 Android 脚本和聊天控制器 | 612 | 612 | 混合改动落回未知边界 |
| src/services/task/prepareTaskExecution.js | 77 | 77 | approvals 功能组 |

现有日志摘要、失败才读日志、生成检查去重、Swift 编译缓存已经实现，不把它们包装成新方案。本次删代码跨越公共边界且修改构建脚本，按现行规则扩大到全量是预期行为，不能为本次绿灯临时收窄。

最近几次实际成功记录（读取历史 summary，非本轮复跑）：

| 运行 | 总耗时 | JS | 浏览器 | Swift |
| --- | ---: | ---: | ---: | ---: |
| run-ACh0QE，完整集成 | 815.7 s | 175.46 s | 39.66 s | 551.49 s |
| run-er6A1K，完整集成 | 284.6 s | 178.49 s | 39.86 s | 27.63 s |
| run-bCN18h，扩大全量快速档 | 254.4 s | 175.04 s | 39.73 s | 27.39 s |

两次集成均执行了 Android；成本差异主要在 Swift 缓存命中情况。不能只盯着“5,000 项 JS”或按用例数量推算模型 token。普通自动化测试本身主要耗 CPU/时间；把长 TAP 反复读入模型才明显消耗上下文。数据来自 recent-gates.json，不同源码批次仅用于定位阶段，不能当本次优化前后对比。

### 方案 A：补齐选测映射，推荐先做

预计 1–2 个工作日，风险低，收益最直接。

1. 生成文件登记“源文件 → 生成器 → 产物 → 三端消费者”；iOS AgentCore 变更显式选 shared conformance、宿主契约与对应原生组。若生成来源校验失败仍阻断，不降为零测试。
2. 删除/重命名同时读取 **基准图 + 当前图**：旧调用方、动态读源者、构建入口与跨端消费方的并集必须覆盖。找不到旧图、动态引用无法解析、删的是启动/安全/存储/协议入口时仍全量。
3. 混合 Android + JS 按子计划求并集；共享契约继续联动三端，不能简单排除 Android 路径。
4. 普通开发执行一次快速档；一批合并/推送前按批次基准执行一次集成档。保留门禁自身改动的完整校准要求。

验收：用生成产物、旧路径删除、纯 Android、混合变更、动态读取、未知新目录、安全边界构造至少 20 类选择器夹具；每个场景证明需要的测试没有漏掉。对历史至少 10 组实际 diff 比较旧/新计划，并注入已知故障验证新计划能检出。目标是已登记的局部改动不再因路径分类缺失跑满 612；不承诺把公共契约改动收窄。

### 方案 B：拆测试依赖与过宽功能组

建立在 A 之上，预计 2–4 个工作日，风险中。

- 把 tools 的 185 文件大组拆成搜索读取、文件安全、文档/媒体、外部连接等明确子域；选择规则使用反向依赖 + 子域边界 + 契约必测。
- 控制 stateStore、bootstrap、server 等入口在纯函数测试中的引入；真正 HTTP/持久化/取消/审批场景保留服务集成测试。
- Swift 当前 Network.swift 被 22 个编译组共同引用。分离纯策略、协议值对象与网络宿主，减少无关组重复编译；现有缓存只省编译，不省测试执行。
- 不按文本相似删除测试；只有能证明相同前置条件、同一路径、同一不变量，才讨论合并 fixture，保留全部边界断言。

验收：同一机器、同一基准、相同并发，分别测冷/热缓存，各至少 3 次；报告中位数和慢项，保留失败数、跳过数、平台覆盖。目标局部快速档中位耗时降低至少 30%，但这只是验收目标，不是已实现收益。

### 方案 C：分平台调度与安全缓存

可与 A 独立实施，预计 1–2 个工作日，风险中。

- 用测得的慢项与内存占用安排 JS、Swift、Android 阶段；不要直接把并发 4 改成 CPU 核数，避免模型索引/浏览器/Gradle 争抢内存造成超时。
- CI 分平台任务，仅聚合全部必需平台成功的同一提交回执；本机没跑的平台明确未执行。
- 跨 worktree 的编译缓存仅在输入、编译器/SDK、架构、flags 与资源哈希相同，且产物无绝对路径绑定时复用；校验二进制完整性。测试本身每次执行，不复用“上次通过”的结果。
- 保留现有 summary.json，添加机器可读 slowest-tests、选组理由、缓存命中率；模型默认只读摘要与失败片段。原始日志留本地，不整份回读。

验收：修改任意源码、SDK/编译 flags 或生成资源应失效；破坏缓存产物应重新编译；故意制造失败必须阻止绿灯。快速档每轮默认终端摘要控制在约 2 KB（失败诊断另计），不裁剪磁盘证据。

**建议顺序：A → 量化复测 → 按实际瓶颈选择 B / C。** 安全、持久化、协议、门禁自身、未知动态依赖仍保持宽范围回归。删除这批死代码本身不会让 5,000 项测试大幅减少；主要收益来自明确依赖，而不是删除保护用例。

## 重复验证入口

- 扫描：专项目录的 scan.cjs → extended-scan.cjs → review-decisions.cjs；临时解析器版本 acorn 8.15.0 / acorn-walk 8.3.4 / eslint-scope 8.4.0，安装在 /tmp/melo-audit-tools-20261112，未写进产品依赖。
- 机器规则：node scripts/audit-inventory.mjs --out .tmp/dead-code-20261112/rule-audit --baseline .tmp/dead-code-20261112/baseline-rule-audit/inventory-2026-11-12.json --json-only --check。
- 范围：npm run test:plan -- --files 加 task-files.json 中全部路径，实际输出 test-plan.log。
- 回归：同范围 npm test -- --files；记录见下。合并之前仍要按 fab843a0 或真实批次基准跑集成档。

补充依赖核对：package.json 的 24 个直接依赖均有代码、构建或间接加载用途，未移除包。tweetnacl 在 Melo 源码里没有静态 import，但当前 @discordjs/voice 的加密适配器会动态加载它；ffmpeg-static、opusscript 也有依赖探测/音频用途。只按“grep 不到 import”删除会损坏音频路径。证据：package-usage.json 及安装版本 @discordjs/voice/dist/index.js 的 methods 表。

本轮产品源码（不含测试、生成地图/清单、文档）统计：76 个改动路径，新增 82 行、删除 827 行，净减少 745 行；其中包含 84 个无读取 import 绑定。新增的 29 行任务保留回归不计入上述减量。

最终局部变量复核：纯 UI 查找、未用的计数/索引及普通对象字段绑定已清理；文件安全 fstatSync 调用、桌面冒烟中的创建任务请求仍执行，仅去掉未用的返回值变量。剩余产品未读变量候选都属于导出解构或对象 rest 排除字段（隐私、权限、回执、生成契约），已逐项保留。

Swift 编译输入量化：当前 38 个测试组共声明 602 次源码输入，去重为 86 个文件，Models / SyncWorkspace / MemoryFacts 各进入 26 组。这里只证明重复编译输入存在，不能推出 602/86 倍的耗时收益；缓存和编译器工作须实测。证据 swift-input-summary.json。

本轮日志量实测：首轮完整 JS TAP 为 1,194,683 字节，显式完整选测计划为 47,386 字节。当前已将这些输出写入文件；进一步的摘要输出改进应保留磁盘全文，只减少默认送入模型的内容。这里没有把字节数换算成不可靠的 token 账单。

### 本轮验证过程

- run-bCAGEI：首次快速档在共享 renderer 来源校验处阻断；随后按现有构建流程重新生成清单，未跳过校验。
- run-hSoIRv：首批清理的快速档扩大全量通过，612 / 612 文件、JS 5,218 / 5,218、失败/取消/跳过均 0，Android 四项、设置浏览器、Swift 全部 38 组通过；1068.3 秒，其中 JS 227.10 秒、Swift 冷编译与执行 669.30 秒。此后最后的未读局部变量清理以最终回执为准。
- 最终范围包含全部代码、生成资源和文档；final-code-snapshot.json 固定这批非文档文件哈希。最终快速档回执见收尾段落。
- 浏览器使用隔离服务和 fixture 数据，验证保存、失败保留草稿、取消、多个连接切换，以及 1440 / 900 / 390 / 320 宽度；不代表正式桌面数据或 iPhone 真机验收。

### 最终回执（2026-11-13）

代码提交 **11e8939e**，保存在 codex/dead-code-audit-20261112；master 仍是 fab843a0，未合并、未推送、未安装。当前分支不是已安装应用。

最终快速档 **run-yKKiOm**：612 / 612 个 JS 文件，**5,218 / 5,218 用例通过，失败 0、取消 0、跳过 0**；语法、文档链接、生成器依赖、共享资源、Android JVM / Lint / Debug / Release、设置浏览器、Swift 38 组全部通过。最终非文档代码哈希与 final-code-snapshot.json 一致。

| 阶段 | 秒 |
| --- | ---: |
| 语法 | 11.90 |
| 文档与生成/共享预检 | 0.96 |
| Android | 29.97 |
| JS | 215.25 |
| 设置浏览器 | 40.83 |
| Swift（复用编译，测试重新执行） | 30.08 |
| 总计 | 329.00 |

完整回执：.tmp/test-runs/run-yKKiOm/summary.json。没有平台阶段跳过；没有真机、真实模型、正式用户数据验收。该回执是显式任务的快速档，即使扩大到全量，也不改称主线合并验收。用户批准合并时仍按批次基准执行集成档。

这次两轮计时展示的是冷/热构建环境差异和最终复验，**没有实施测试优化方案，不能把 1068.3 → 329 秒称为新优化带来的收益**。
