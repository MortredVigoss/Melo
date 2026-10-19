# 手机与电脑逻辑对齐审计 — 2026-10-19

结论：**部分对齐，不能称为同一套完整执行逻辑。** 最新提交共享了 Agent 循环的规则、文案和部分纯函数；上下文、资料、记忆、团队与工具生命周期仍各有实现。本次发现 3 项 P1、4 项 P2，均未修复。

## 范围与基线

- 用户要求“先审计”。仅阅读源码、运行离线测试与隔离探针，新增审计/交接文档；不改产品实现、不安装、不推送、不运行 git pp。
- 起点为 `a43836a`（手机统一 Agent 循环）；审计期间另一线程提交 `b5d889f`，只有 iPhone 0.7.3 (35) 版本号变化。证据基线固定为 `b5d889f9b448397c91c692cffc31b892f679a4ca`。
- 已读总览中 melo主线、设计 Melo、melo ui 的交接、手机对齐协议与近期实际 diff；三线程以总览登记和对应源码为依据，未完整回读历史对话。
- 覆盖普通对话、三种模型连接、工具循环、上下文/资料/记忆、团队、同步及共享场景资源。未逐行审计全部文件，也未用真实账号、实体手机或长后台验证。本报告判断的是仓库源码，不代表当前安装包的实际版本或效果。

## 对齐矩阵

| 模块 | 当前共同部分 | 手机仍有的差异 | 判断 |
| --- | --- | --- | --- |
| Agent 循环 | 三段执行、10 次模型调用、每轮最多 32 个工具调用、重复失败拦截、结果信封、补充消息、取消轨迹 | Swift 与 JS 是两套执行器；工具中途超时与参数边界存在缺口 | 部分对齐 |
| 模型连接 | Codex Responses、Anthropic、Chat Completions 都接入手机循环 | 手机 API 使用非流式请求；OpenAI API 走 Chat Completions，桌面可走 Responses；本地/自定义端点配置要求也不同 | 协议与体验不完全相同 |
| 长对话 | 手机能接收桌面摘要与话题卡 | 固定 48,000 字节/60 条近窗，没有手机本地产生话题摘要的路径；无桌面摘要时不提供历史读取工具 | 明显简化 |
| 知识资料 | 两端都区分知识与成果、保留全文 | 手机最多 8 份、均分 12,000 字符取开头；桌面按问题检索片段 | 明显简化 |
| 记忆 | 范围、冲突、停用及部分项目记忆字段同步；共用规则提取器 | 手机使用系统 NLEmbedding/词项召回，最多 12 条/6,000 字节；未实现桌面的稳定项目记忆本与个人档案注入，手写项目记忆还漏同步 | 部分对齐 |
| 团队 | 顺序、并行后复核、复核循环及交接摘要 | 文字团队；上下文、项目覆盖、成员模型优先级和成员配置上限存在差异 | 明显简化 |
| 权限和工具 | 主 Agent 的工具受本机授权控制 | 电脑能力配置与手机设备授权有意分开；手机没有桌面的 bash、完整 MCP/技能执行环境，网页工具串行 | 平台边界，不能称工具集合相同 |
| 图片、计时、神经场景 | 共享意图/协议夹具、计时数据与场景资源；26 个生成资源散列一致 | 保存和权限是原生平台实现；本轮未验真实生成、预览、照片权限或实际视觉 | 共享层已核对，端到端待验 |

## A1 · P1 · 历史读取的数字参数可让手机进程崩溃

**触发：** 手机已提供 `read_history` 时，模型返回 `{"limit":1e100}`，或 `{"fromMessageId":"m1","fromChar":1e100}`。

手机在限制范围之前调用 `Int(Double)`，只判断 finite；有限浮点数仍可能超过 Int 范围。Swift 直接 trap，无法被普通错误处理接住。before/after 同样先转换再处理，附近还有整数加减溢出的风险。

- 手机：[AgentLoopRuntime.swift](../ios/Melo/AgentLoopRuntime.swift#L592) 的 limit、before/after，以及 run 中的 fromChar。
- 电脑：[readHistoryTool.js](../src/tools/builtins/readHistoryTool.js#L79) 先在 Number 上夹紧范围。
- **验证：** 同一组生产 Swift 文件编译成独立探针，两种输入均以信号 5 退出，报 `Double value cannot be converted to Int … greater than Int.max`；桌面同样巨大 limit 正常返回一条消息。未触碰真实 App。
- **建议：** 统一参数校验，在浮点范围内先夹紧/拒绝，再安全转换；覆盖巨大正负值、边界及整数加减。

## A2 · P1 · 手机运行预算不能中断正在执行的工具

手机在每个工具开始前检查预算，随后直接 `await tools.perform(call)`。模型请求有 deadline 包装，工具没有；等待用户授权的 continuation 也没有随预算自动结束。

- 手机：[AgentLoop.swift:264](../ios/Melo/AgentLoop.swift#L264)、[ChatStore.swift](../ios/Melo/ChatStore.swift#L735) 的授权队列。
- 电脑：[executor.js:202](../src/tools/executor.js#L202) 将工具超时取为工具自身上限与剩余预算的较小值，并发送取消信号。
- **验证：** 设 40ms 预算、工具等待 250ms 后增加执行计数，手机约 271ms 才返回；执行计数为 1，工具记为 ok，之后循环才记预算耗尽。
- **影响：** 临近截止时间的工具仍会继续；未处理的写入确认可以一直等待，之后确认还可能继续执行。
- **建议：** 工具和审批等待共同绑定本轮取消/截止时间，执行写入前再次核对，禁止接受迟到成功。不能只给外层增加一个计时文字。

## A3 · P1 · 关闭知识/项目上下文后，核实请求仍会携带它们

普通回答的指令尊重 contextSources，但 ChatStore 单独组装核实证据时，无条件读取所选资料、项目名字和目标。出现不确定性标记并进入核实流程时，这些内容又发送到模型。

- 入口：[ChatStore.swift:424](../ios/Melo/ChatStore.swift#L424)；实际发送：[AgentLoop.swift](../ios/Melo/AgentLoop.swift#L347)、[AgentLoopRuntime.swift](../ios/Melo/AgentLoopRuntime.swift#L457)。
- 主请求正确过滤：[AgentProfile.swift:201](../ios/Melo/AgentProfile.swift#L201)。
- **验证：** 使用合成资料 `AUDIT_SECRET_DISABLED_KNOWLEDGE`，关闭知识开关后主指令不含资料；按 ChatStore 的实际组装方式接入生产 AgentLoop，核实适配器收到 1 次请求，仍含该资料。是离线请求捕获，没有把资料发送给真实服务。
- **建议：** 主请求和核实共用一份已过滤的上下文，包含开关、权限与预算结果；核实阶段不得重新读取被排除的来源。

## A4 · P2 · 纯手机长对话裁掉早期内容后，缺少恢复入口

手机保留近期完整轮次，但只有桌面同步来的摘要能替代更早部分。没有同步摘要的手机对话，超出近窗后既没有本地摘要，又因为 compactSummary 为空而不提供 read_history。

- [ConversationHistory.swift:6](../ios/Melo/ConversationHistory.swift#L6)、[recentTurns](../ios/Melo/ConversationHistory.swift#L50)；
- [ChatStore.swift:457](../ios/Melo/ChatStore.swift#L457) 用“已有桌面摘要”作为工具出现条件。
- 电脑：`src/services/chat/chatExecutionRunner.js`、`compactScheduler.js` 和 `src/memory/compactLedger.js` 包含窗口/背景压缩/话题卡及原文回读。
- **验证：** 81 条合成消息的手机请求仅保留 29 条，从 m52 开始，摘要为空；生产工具开关因此不会提供原文读取。原始消息仍在磁盘，不是数据删除。
- **建议：** 先让被窗口排除的本对话原文始终可按权限读取，再补手机摘要与按模型容量裁剪，明确显示哪些内容已压缩。

## A5 · P2 · 手机资料使用是“截开头”，没有桌面的按问题检索

手机先限制最多 8 份资料，再将总共约 12,000 字符按份数均分，只取每份开头。问题的答案在后半篇时，无论怎样提问都进不了主请求；超过 8 份会阻止发送，甚至知识开关已关闭也先做数量校验。

- 手机：[AgentProfile.swift:196–215](../ios/Melo/AgentProfile.swift#L196)。
- 电脑：[knowledgeContext.js](../src/services/chat/knowledgeContext.js)、[knowledgeIndex.js](../src/memory/knowledgeIndex.js#L103) 使用问题词项和向量选择片段。
- **验证：** 14,018 字符的合成资料，答案标记放在末尾；手机组装出的主指令完全不含答案标记。
- **建议：** 用文档切段和相关性选择取代固定前缀，数量限制变为上下文预算；关闭知识时不应让知识数量阻断普通聊天。

## A6 · P2 · 手机团队绕开了普通对话已经准备好的上下文与部分 Agent 设置

这是源码接线差异，不是 Swift/JS 语言差异：

1. ChatStore 已准备历史、项目、资料与记忆，但调用 runTeam 只传当前 clean 文本。成员收到的主要内容是本条任务与前序交接；“按刚才方案执行”缺少原方案。桌面给成员传 `buildMemberBackground` 的项目、摘要和最近 6 条消息。
2. 手机成员从 `preferences.agents` 取全局记录，忽略项目级 Agent 覆盖；普通聊天的 `agent(for:)` 则会读取覆盖。
3. 对话显式选过模型后，手机成员自己的模型被忽略；桌面成员优先用自身 model。
4. 手机团队未使用成员 collaboration 中的 maxIterations/maxTokens/timeoutMs；新代码只是共享团队的父预算。API 密钥团队也不传 phoneTools，传入 ask 的 web 布尔值只在 Codex 分支使用。

证据：[ChatStore.swift:415](../ios/Melo/ChatStore.swift#L415)、[runTeam:616](../ios/Melo/ChatStore.swift#L616)、[桌面 memberBackground.js](../src/agents/memberBackground.js)、[delegate.js:24](../src/agents/delegate.js#L24)、[chatExecutionRunner.js:746](../src/services/chat/chatExecutionRunner.js#L746)。

**验证层级：** 生产调用路径与参数静态核对，未用真实团队请求。手机文字团队不执行电脑命令属于既有范围；遗漏背景、项目覆盖和已配置模型/上限不应被笼统称为“完全一样”。

**建议：** 统一成员配置解析、受限背景和预算继承；明确区分手机可用工具与不可用工具，不能将联网选项静默丢弃。

## A7 · P2 · 电脑上手写的项目记忆不会同步到手机

手写项目记忆的来源是项目页，chatId 为 null。同步导出却要求每条记忆的 chatId 属于现存聊天，因而直接跳过；手机模型和召回入口也仍要求来源聊天存在。

- 创建：[projectBook.js:304](../src/memory/projectBook.js#L304)；
- 导出：[portableMemory.js:30](../src/services/chat/portableMemory.js#L30)；
- 手机：[MemoryFacts.swift](../ios/Melo/MemoryFacts.swift#L54) 的 eligible/validated。
- **验证：** 隔离 MELO_HOME，用生产 createUserBookRow 写入一条项目约定，电脑 listProjectBook 返回 1；生产 refreshPortableMemory 导出 0 条，expected 中也没有这条记忆。
- **建议：** 同步协议支持项目来源记忆，并按项目存在性校验，保留旧聊天来源规则；手机应能消费与管理这些约定。

## 验证结果和边界

| 验证 | 结果 |
| --- | --- |
| Swift 离线套件 | 31 组通过，31 组复用按源码签名缓存的编译产物并实际运行 |
| 共享场景 JS 校验 | 4 项通过；26 个桌面来源资源散列匹配 |
| JS 契约、生成器、预算、话题卡定向回归 | 27 项通过 |
| 新增隔离探针 | 复现上述崩溃、工具超时、关闭上下文仍进入核实、历史裁剪、资料前缀缺失、手写记忆漏同步 |
| 源码保护 | 与 b5d889f 基线比较，产品源码无本次改动；没有真实账号/模型请求、用户数据变更或安装 |

测试通过说明已有断言成立，不证明尚未覆盖的生产入口一致。证据目录：`.tmp/mobile-desktop-audit-20261019/`；`baseline.json` 是源码散列，`ios-tests.log` / `desktop-tests.log` 是现有回归，`AuditProbe.swift` / `probe-results.json` / `desktop-probes.json` 是合成数据复现。

建议修复顺序：A1 参数崩溃 → A2 工具/审批截止时间 → A3 上下文开关 → A4/A5 长对话与资料 → A6 团队 → A7 项目记忆同步。修复时补真实发送路径的跨端契约测试，继续分别记录离线测试、模拟器、实体机和真实服务验收。
