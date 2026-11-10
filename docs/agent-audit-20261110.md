# Android 回复延迟修复与 Agent 全链路审计（2026-11-10，Claude）

用户在看完[回复延迟修复记录](response-latency-fixes-20261110.md)后提出："安卓也改吧，然后整个 agent 这块再去看看有没有什么逻辑错误，还有和 ui 不统一的地方。"本文是这一轮的实施记录和审计报告。没有推送，没有安装。

## 0. 结论

1. Android 已接上桌面与 iPhone 的延迟修复：一批网页并行读取、网页按窗口读取并可续读、主 Agent 的回答边生成边显示、请求整形。Android 没有"不确定内容核验"这一步，所以没有可合并的核验。
2. 审计用六个只读子代理分片阅读（共享内核、桌面宿主、桌面界面、iPhone、Android、设置），共报告约 90 条。我逐条对照代码核实后修了 43 处，都带测试；其余列在第 4.2–4.4 节，没有当作已确认的结论。
3. 最严重的一条是在 Android 模拟器上追出来的：**内核的隔离环境还在加载内核包时被关闭，会把整个 App 共用的 JS 沙箱进程带崩**，随后任何对话的回复都以"共享 Runtime 执行中断"失败。停止回复会触发它，界面上被取消的后台解析（执行卡片、回复气泡）按代码看也走同一条路。改成"等当前求值结束再关闭"后，直接测试从 4 次红 2 次变为全绿，240 次停止 0 次崩溃。
4. 有 6 项需要用户决定，见第 4.4 节。

## 1. 范围、源码基准与方法

- 范围：共享内核 `shared/agent/`；桌面宿主 `src/services/chat/execution/`、`src/agents/`、`src/tools/`；桌面界面 `desktop-ui/features/chat/`；iPhone `ios/Melo/AgentLoop*.swift` 及相关；Android `android/app/src/main/java/com/melo/android/{chat,core,network,device,ui}`；三端 Agent 设置页。
- 源码基准：审计阅读基于 `bed3b43c`；本轮代码提交是 `099a1c3b`；本轮改动之前的提交是 `33a2c4a0`（把 `windowChars` 原样移入共享内核，单独验证过：JS 3142 / 3142）。
- 方法：
  - 六个只读子代理各读一片并给出带行号的报告，原文压缩件在证据目录的 `audit/`。子代理的结论是模型输出，不是事实；每一条在动手前都由我对照当前代码复核，能跑的用纯函数探针复现（临时 `MELO_HOME`）。
  - Android 在无窗口模拟器（`emulator-5554`，AVD `melo_pet_qa_20261022`）上跑整套设备测试：基线、每批改动之后各一轮，外加定向循环。
  - iPhone 的每条代码修复都做了反向验证：逐条撤回修复，确认对应测试变红，再恢复。Android 的沙箱修复同样在旧行为上跑过直接测试。
  - 供应商行为用公开文档核对了两条：OpenAI Chat Completions 拒绝 `tool_calls: []`；Anthropic 拒绝请求体里不成对的代理字符。

## 2. 执行链路

```
Android  ChatEngine.send → SharedChatAgent.reply → ReplySession.run → execute
           ├─ next → DeviceAgentClient.next → ToolStreamDecoder（三种协议）
           ├─ assign → SharedCoreTurn.open（成员回合，独立隔离环境）→ handoff
           ├─ 工具批次：PageReads（并行网络读取）→ SharedSearchAdapter.load / page
           ├─ checkCandidate（完成核对）/ deliverLimit（到上限的整理）
           └─ ChatJournal（场景事件）→ ChatEngine 落库 → ReplyContent / ExecutionCard / WarRoomPresentation
         共享内核调用：SharedCoreRuntime.evaluateJSON（JS 沙箱里的隔离环境，全 App 共用一个沙箱进程）

桌面     sendChatMessage → prepareNode → invokeModelNode
           ├─ traceProviderPayload → 模型供应商
           ├─ internalMembers → runSubAgent（成员）→ memberEvidence → 交回
           └─ goalCandidate / reviewGoal（完成核对）→ finalizeNode → SSE → desktop-ui/features/chat/controller.js → 视图

iPhone   ChatStore.send → AgentLoop.run → transport.round
           ├─ beginMember / finishJob（成员）
           ├─ DeviceToolContext.perform（手机数据、网页、历史）
           └─ PhoneGoalState / PhoneCoreTurn（JSContext）→ ExecutionRecord 阶段 → SwiftUI
```

## 3. Android 延迟改动

| 改动 | 位置 | 测试 |
| --- | --- | --- |
| 同一批网页读取并行，最多 3 个；预算按调用顺序准入，结果按调用顺序校验、记录、回报；批次结束或停止时取消未完成的读取 | `SharedChatAgent.kt` `PageReads`、`ReplySession.execute`；`SharedRunBudget.admitEffect`；`SharedSearchAdapter.load` | 设备 `aBatchOfPageReadsLoadsSideBySideAndIsReportedInCallOrder`、`stoppingDuringAPageBatchSendsNoFurtherModelRequest`；JVM `DeviceAgentClientTest` |
| 网页按窗口读取：`fetch_url` 接受 `offset`，结果带 `nextOffset`；中文页面的窗口按 token 折算；同一回复内缓存已下载的页面，续读不重新下载 | `shared/agent/tools.js` `normalizeFetchedPage`、`shared/agent/pageWindow.js`；`SharedSearchAdapter.page` | 契约夹具 5 条（共 152）；`shared/agent/tools.test.js`；设备 `aLongChinesePageIsReadInPartsAndDownloadedOnce` |
| 主 Agent 的回答边生成边显示，核对期间保持可见；成员的汇报不显示给用户 | `ToolStreamDecoder`（`onText`）、`DeviceAgentClient.next`、`ReplySession.next` / `checkCandidate` | 设备 `theAnswerIsVisibleWhileItIsCheckedAndAMemberReportNeverIs`；JVM `ToolStreamDecoderTest` |
| 请求整形：没有工具时不带 `tools` / `tool_calls` 字段；允许一次返回多个工具调用（手机操作类除外）；Responses 协议请求 `reasoning.encrypted_content`；Anthropic 输出上限提到 8192 | `DeviceAgentClient.next`、`ToolStreamDecoder` | JVM `DeviceAgentClientTest`、`ToolStreamDecoderTest` |
| 进度文案跟随实际动作：按工具名显示；"正在核对回答是否完成…"；到上限时"正在整理已确认的内容…" | `SharedChatAgent.kt` `toolPhase`、`checkCandidate`、`deliverLimit` | 设备流程测试里断言 |

没有做的：Android 没有真实模型下的耗时对比（本轮全部用夹具和本地假服务），所以没有"从多少秒降到多少秒"的数字。

## 4. 审计发现

严重级：A 会让回复失败或丢失工作；B 结果或显示错误但回复还在；C 文案与小问题。

### 4.1 已修复（均有测试）

**Android**

| 级 | 问题（修复前的表现） | 位置 | 测试 |
| --- | --- | --- | --- |
| A | 内核隔离环境还在加载内核包时被关闭（停止回复时正好在开新回合），沙箱进程崩溃；之后任一对话的回复以"共享 Runtime 执行中断"失败。求值途中的关闭一并改为等它结束 | `SharedCoreRuntime.evaluateJSON` / `settled` / `close` / `open` | 设备 `aRuntimeStoppedWhileItOpensNeverTakesTheOtherRuntimesDown`（旧行为 4 次红 2 次）、`anEvaluationStoppedMidwayNeverTakesTheOtherRuntimesDown`；停止循环 12 轮 240 次 0 崩溃 |
| A | 用户停止的回复被记成"受阻 / 失败"：收尾向已关闭的内核要回执；或拆除过程中冒出的其他错误决定了记录类型 | `ReplySession.run`、`replyFailure`、`ChatJournal.finish` | 设备 `aStopAtAnyMomentIsRecordedAsStoppedNeverAsFailed`；JVM `ReplyFailureTest` |
| A | 工具结果累积超过模型上下文时，整段回复以 `CONTEXT_BUDGET_EXCEEDED` 结束，没有答复 | `ReplySession.fit` | 设备 `aChainThatOutgrowsTheContextHandsBackInsteadOfFailingTheReply` |
| A | 只有图片的消息生成空文本块，Anthropic 拒绝，之后这段对话每次都失败 | `ChatPhoneUse.kt`、`ModelClient.kt` | JVM `DeviceAgentClientTest` |
| A | Anthropic 流式响应里没有参数的工具调用解析失败，请求作废 | `ToolStreamDecoder` | JVM `ToolStreamDecoderTest` |
| A | 整理阶段出错或被停止时，场景永远停在"进行中" | `ReplySession.run` | 设备停止与上限流程 |
| B | 搜索后端超时、搜索地址不可用、不允许读取的网址，会结束整轮；现在只算这一次调用失败 | `SharedSearchAdapter.search` / `load` | 设备 `aSlowSearchBackendIsOneFailedLookupNotTheEndOfTheRun`、`anAddressTheBuildMayNotOpenFailsOneReadAndTheReplyContinues` |
| B | `route_task` 被拒或一次回了两个时，主 Agent 只得到"UNKNOWN_TOOL；请先完成前置检索"，而它手里没有检索工具 | `ReplySession.assign` / `execute` | 设备 `twoAssignmentsInOneResponseAreToldTheOneCallRuleAndTheNextSingleOneRuns` |
| B | 一轮回复可读的网址上限是 32，第五次搜索之后的结果被当成"不是本轮搜到的"拒读 | `SharedChatAgent.kt` `MAX_READABLE_URLS` | 设备 `aResultOfALaterSearchCanStillBeRead` |
| B | 内核自己的 5 秒求值上限被当成"运行截止时间"，随后在已关闭的内核上做整理 | `SharedCoreRuntime.evaluateJSON` | 随上面两条运行时测试 |
| B | 托管搜索只有第一轮被记录（行号固定） | `ReplySession.execute` | 设备研究流程 |
| B | 观察记录每次核对都整份过桥，单次上限 200 万字符；现限制为 128 行、120 万字符 | `trimObservations` | 设备长页面流程 |
| B | 任务空间把"部分完成 / 受阻 / 等待补充 / 未核验 / 预算用完"的回复当作仍在运行，会自动弹出 | `WarRoomPresentation.finished` | JVM `WarRoomPresentationTest`；设备 `ChatPresentationFlowTest` |
| B | 失败后不显示"重试"，或显示了另一段对话的错误 | `MainActivity.kt` 重试行 | 设备 `AndroidFlowTest` |
| C | 已送达的回答下面显示红色原因码；成功的回复显示"停止原因：ANSWER_DELIVERED"；缺"等待补充""未核验"两个状态名 | `ExecutionCard.kt` `visibleRunError` | JVM `WarRoomPresentationTest` |

**共享内核（三端同时生效）**

| 级 | 问题 | 位置 | 测试 |
| --- | --- | --- | --- |
| B | 桌面上不需要工具的回答被记为"受阻 · 尚无目标完成证据"，只因为问题里有"操作""打开""删除"之类的词（例："操作系统是什么？"） | `completion.js` `completionReceipt` | `completion.test.js` |
| B | 完成核对读长页面时，只带上命中片段之后的文字；数据所属的标题或标签如果正好在片段边界之前（例：预报里的地区名），核对方看不到，无法判断数字属于谁。现在先带前一段，再带后一段 | `goal.js` `evidenceExcerpt` | `internalMembers.test.js`、`goalEvidence.test.js` |
| B | 回复语言误判：一个带重音的字母判成西班牙语（"Café"），一个假名判成日语 | `locale.js` `detectReplyLanguage` | `portability.test.js` |
| B | 用户给的网址后面紧跟中文时，整段被当成网址，成员回执变成"部分完成" | `completion.js` 网址提取 | `completion.test.js` |
| B | "好的""ok"这类确认被当成寒暄，跳过完成核对，也不开成员目录 | `goal.js` `goalCandidate` | `goal.test.js` |
| B | 核对结论只认裸 JSON 或一种围栏写法，前后有一句话就记成"核对不可用" | `goal.js` `reviewGoal`（`parseVerdict`） | `goal.test.js` |
| B | 来源行只留 16 000 字，桌面一个完整窗口的最后五分之一对核对不可见 | `completion.js` `SOURCE_TEXT_CHARS` | `completion.test.js`、`goalEvidence.test.js` |
| C | 含"İ"的网页抽取正文时偏移错位，脚本内容混进正文 | `tools.js` HTML 抽取 | `tools.test.js` |
| C | 计算器换算把很小的结果舍成 0.000001 | `arithmetic.js` `convertUnit` | `tools.test.js` |

**桌面**

| 级 | 问题 | 位置 | 测试 |
| --- | --- | --- | --- |
| B | 截断落在表情中间时文本里留下半个代理字符，校验 JSON 的供应商会拒绝整个请求（Anthropic 返回 400）。文本工具协议的工具结果和各处纯文本截断会走到这里；原生工具协议的工具结果因为是字符串里的 JSON，本来就不受影响 | `src/runtime/loopTrace.js` `traceProviderPayload` | `providerPayloadText.test.js` |
| B | 主 Agent 的完成核对只看到成员读过页面的前三四千字，却当成整页（这是我在 `bed3b43c` 里收窄成员报告时留下的缺口） | `src/agents/subAgent.js` `memberEvidence` | `internalMembers.test.js`（真实循环） |
| B | 服务器端已超时的权限询问留在屏幕上，并挡住后面的询问 | `permissionContext.js` `announcePromptClosed`；`permissions.js`；`fileSafetyGate.js`；`controller.js` | `permissions.closed.test.js`、`controller.test.js` |
| B | 对话 A 在回复时，对话 B 的输入区显示 A 的提示和停止按钮，并且点发送没有任何反应 | `controller.js` `handleSendMessage`、`replyRunsElsewhere`；`viewComposer.js` | `controller.test.js` |
| B | 核对给出"无法核实"时，不再去查回答所依据的记忆和知识上下文（合并核验时引入，桌面与 iPhone 同改） | `finalizeNode.js`；`ios/Melo/AgentLoop.swift` finalize | `finalizeNode.test.js` |
| B | 保存过搜索设置的用户（页面默认写入 8 条），内部成员的 5 条上限不再生效 | `internalMembers.js` `memberConfig` | `internalMembers.test.js` |
| B | 重新打开被停止的回复时，"[工具轨迹]"消息被当成这次回复的答案 | `src/http/executionRoutes.js` | 路由测试 |
| C | 服务器关闭询问（超时、取消）之后，横幅仍写"等待你的确认"，屏幕上却没有询问 | `turnPresentation.js` `receiveTurnPresentation` | `turnPresentation.test.js`、`controller.test.js` |
| C | 成功回合的工具轨迹标签写着"已取消" | `messageToolTrace.js` | `messageToolTrace.test.js` |
| C | 完成核对进行时界面一直写"正在回复" | `invokeModelNode.js` `checkStage`；`turnPresentation.js` | `promptPipeline.test.js`、`turnPresentation.test.js` |
| C | Melo 自己放弃的慢读取显示成红色失败 | `fetchUrlTool.js` `hedgedRead` | `fetchUrlTool.hedge.test.js` |
| C | 计算步骤显示内部名 `calculator` | `runSteps.js` | 界面测试 |

**iPhone**（除最后一条文案外，每条都做过"撤回修复 → 测试变红"的反向验证）

| 级 | 问题 | 位置 | 测试 |
| --- | --- | --- | --- |
| A | 成员的工具连续失败三轮，整段回复以"本轮已停止"结束，主 Agent 没有机会接手 | `AgentLoop.run`（工具批次之后的停止判断） | `AgentLoopTests` |
| A | 写操作的参数被工具拒绝（例如新建提醒缺标题）时，回复以"请先核对上一步操作的结果"结束，并且无法续跑 | `AgentLoop.run`、`refusedBeforeStart` | `AgentLoopTests` |
| A | 一次回复读了很多长页面后，观察记录超过 2 MB 的过桥上限，回复在最后核对时失败 | `AgentLoop.observationOverflow` | `AgentLoopTests` |
| B | 团队成员的最终回答如果正好在超出工作额度的那一轮给出，会被丢弃，换成"本轮已停止" | `AgentLoop.run` | `AgentLoopTests` |
| B | `route_task` 被拒或重复时只回"此功能在当前角色和回合不可用" | `AgentLoop.run` | `AgentLoopTests` |
| B | 在 8 秒软超时读到的页面被记成完整读取 | `WebPageText.openResult` | `WebPageToolsTests` |
| C | 团队面板写"每位成员单独调用一次模型，只处理文字"，实际成员会多轮调用模型并使用手机数据和网页工具 | `TeamSheet.swift`、`ios/native-translations.js`（五种语言） | 字符串目录生成 |

### 4.2 已核实，本轮没有改

| 级 | 问题 | 位置 | 没改的原因 |
| --- | --- | --- | --- |
| B | 预算在"回答已写出、等待核对"时用完，三端都改走上限整理，而整理请求不带这份回答，等于重写一遍；成员没用工具时整理出来的是空的三段式 | `shared/agent/limitDelivery.js` `deliveryRequest`；`AgentLoop.run`；`invokeModelNode.js` | 改的是共享的交付规则，见 4.4 第 1 项 |
| B | 成员 token 上限写的是总额，其中约 38% 留给收尾：默认 32 000 实际可用于工作约 19 760；填 11 000 以下成员一步不做，界面允许填 1 | `shared/agent/runBudget.js`；`desktop-ui/features/agents/view.js` | 含义和默认值是产品决定，见 4.4 第 2 项 |
| C | 桌面"搜索超时"可填到 120 000 毫秒，工具执行器 60 秒就终止搜索 | `desktop-ui/searchSettings.js`；`src/tools/executor.js` | 只核对了两端数值，没有复现 |
| C | 有手机操作工具的一端，含"操作""打开"的提问仍按"需要执行证据"处理，靠核对方标明"这是一次回答"才算送达；核对方没标时记为受阻 | `shared/agent/goal.js` `goalCandidate`、`reviewGoal` | 用探针确认；改的是按词判断任务类型的规则，影响面大，没有在本轮动 |

### 4.3 子代理报告了、我没有逐条核实的

下面这些只读过报告，没有对照代码确认，也没有复现。行号见证据目录 `audit/` 下对应报告。

- 桌面宿主：重复或非字符串的工具调用编号让主回合以 `DUPLICATE_CALL_ID` 结束；核对要求继续之后，已成功的相同读取被 `ALREADY_EXECUTED` 拒绝；补充消息关闭了 `task_progress`；并行成员各按"只有自己"分预算，主 Agent 的保留额没有扣；团队运行后主 Agent 可能重复成员已完成的写操作；成员固定保留 16 000 token 结果，小上下文模型会溢出；成员交回内容从末尾截到 8 000 字；核对反馈作为普通用户消息加入；`resume` 实际是新开一个成员；Anthropic 与 Chat Completions 把"输出被截断"当作错误。
- 桌面界面：成员的模型请求不计入界面上的 token 与请求数；没被打断的成员也显示"已中断"，"N 次调用 · 上限 M 轮"把调用和轮数混在一起；被拒绝、过期、被跳过的调用显示成普通失败；阶段显示原始原因码；工具名显示内部标识（`[agent:d1] web_search`、`load_tools`）；中英文混排；成员的工具结果刷新后不在历史里；断言核验的结论不显示；供应商报错只有英文并且一律写 OpenAI；`tool_output` 事件没有消费者。
- 共享内核：账本的实体键去掉所有符号（"Galaxy S24"等于"Galaxy S24+"）；上限整理时核对方拿到的证据是撰写方的一半；整份评估账本进了核对提示和保存的回执；截止时间之后到达的工具结果被丢弃；证据锚点不支持西里尔、阿拉伯、希腊、泰文；iPhone 上截断落在表情中间会让内核回复无法解析。
- iPhone：暂停后超过截止时间再续跑会丢掉已保存的工作；"模型请求"阶段在第一次请求后不再更新，模型用时与 token 只统计了一次；续跑后暂停时关闭的阶段一直显示"已中断"；批次校验写了但没接；截图工具告诉模型"已附上"但回复里不一定有；成员自己超时被报成团队预算用完。
- Android：输出被截断与模型拒答按协议错误处理，`max_tokens` 与 `max_completion_tokens` 的区别；读页不跟随重定向；删除对话不会停止它正在跑的回复；成员行在"未核验"时显示"已中断"；每个失败调用都写"结果未知"；路由关闭时仍把整段对话过桥；被裁掉的观察行仍可能被引用。
- 设置：成员轮数 / token / 超时只约束"被委派时"，内部成员不读；项目范围保存把整页写成项目快照；委派深度按整条链取最小值；"上下文来源 · 记忆"在 iPhone 上还会关掉压缩摘要和历史回读；能力说明与即时授权不符；定位说明漏了"还需要联网"；白名单不标"全局未启用"；哪些设置只在本机，三端标注不一致；未迁移旧权限的 Agent 不勾确认时改动被静默丢弃；Android 残留"智能模式"文案；"搜索条数上限"未保存时界面显示 8、运行用的是另一个默认值。

### 4.4 需要用户决定

1. 预算用完时已经写出、还没核对的回答：直接送达并标"未核验"，还是像现在这样重写一份上限整理。
2. 成员 token 上限与超时：界面数字指总额还是可用于工作的部分，默认 32 000 是否上调，最小值是否限制。
3. "已送达但核对服务不可用"的回答现在归在"受阻"，是否单列一个状态。
4. 成员的模型请求要不要计入界面上的 token 与请求数。
5. 团队和委派里，Agent 自己的模型覆盖是否应该压过对话所选模型（普通回合是对话所选模型优先）。
6. 之前留下的三件事仍在等：真实数据目录的恢复（`.tmp/incident-20261110/restore.py --apply`，执行前保持桌面 Melo 关闭）、记忆库是否从 11-05 备份合并（1 351 条对 44 条）、今天测试留在真实目录里的记录是否清掉。

## 5. 覆盖与未覆盖

已覆盖：第 1 节列出的源码范围；Android 整套设备测试（模拟器）与 JVM 测试；iPhone 两组离线测试与反向验证；桌面与共享内核的 JS 门禁。

未覆盖及原因：

- 真机：Android 真机与 iPhone 真机都没有装，本轮没有安装授权。
- 真实模型：全部用夹具与本地假服务，没有花用户的额度。因此没有 Android 的真实耗时对比，也没有验证真实供应商对新请求形状的响应。
- 桌面端到端点击验收：只有门禁里的浏览器阶段，没有在正式安装的桌面应用里操作（数据目录仍是受损状态，应用保持关闭）。
- Telegram、MCP 连接器、手机控制（`phone_use`）的真实流程不在本轮范围。
- 第 4.3 节约 50 条没有核实。
- 设备测试里与 Agent 循环无关、没有处理的项：`PetOverlayFlowTest` 1 项与 `AndroidFlowTest.importedExecutionEvidenceReachesTheSharedRenderer`（无窗口模拟器没有 WebGL 帧）每轮都失败，基线即如此；`TaskCacheFlowTest` 1 项与 `DeviceAgentTest.treeFirstSupportsOrdinaryCoordinateTapsWithoutApprovalAndExplicitVisualFallback` 时过时不过（后者单独重跑两次一败一过），都是无障碍点击类测试，本轮没有改它们依赖的代码，原因没有查。

## 6. 审计边界与停止条件

- 不改用户保留的产品决定：主 Agent 只负责派单、审核与整合，检索交给成员；用户选的模型不自动切换。
- 需要产品决定的问题只记录，不动代码（第 4.4 节）。
- 不触碰用户数据目录；测试只在门禁或临时 `MELO_HOME` 下运行。
- 门禁或设备测试变红时先查清原因再继续，不重试掩盖。停止测试偶发失败就是这样追到沙箱崩溃的。
- 不推送、不安装。

## 7. 验证

- **JS 门禁**：第一次真正跑到 JS 阶段的一轮（`run-ofMify`）5 141 项里红了 4 项，都是本轮早先写的新测试。其中 3 项是夹具写错：自包含回答的测试用了带手机操作的工具集；半个代理字符的夹具走了本来就安全的原生工具协议；核对摘录的断言正好落在片段边界上，同时暴露出摘录不带前文。另 1 项如实指出横幅在询问关闭后仍写"等待你的确认"。改正后的 JS 信号档 `run-HPFuDI`：5 142 / 5 142，设置浏览器验收通过。在那之前我把这 4 项算作"已有测试"是不对的。
- **完整快速档**：`run-bKiCRk` 全绿，551 秒：公共边界扩大到 603 / 603 个文件，JS 5 142 / 5 142，Android JVM / Lint / Debug / Release 四项，设置浏览器验收，全部 38 组 Swift，文档链接；没有跳过的平台阶段。门禁之后只改了 `SharedCoreRuntime.kt` 里的一段注释，另跑 JVM 224 项确认可编译。集成档按计划选到的测试与这一轮相同，本轮没有再跑一遍，推送前要跑。
- **Android 设备测试**（无窗口模拟器，整套五轮）：

| 轮次 | 用例 | 未过 | 说明 |
| --- | ---: | ---: | --- |
| 基线（`33a2c4a0`） | 116 | 20 | 16 项是旧测试没有跟上 11-07"主 Agent 不持有检索工具"和 10-27"有工具就做完成核对"，以及任务空间自动弹出的缺陷；4 项见表下 |
| 第一批改动后 | 122 | 8 | 12 项转绿，新增 6 项通过 |
| 第二批改动后 | 126 | 7 | 又 4 项转绿；2 项新测试红：一项是测试自己超出了成员 6 轮上限，一项暴露沙箱崩溃 |
| 运行时修复后 | 128 | 5 | |
| 重建内核包后（最终） | 128 | 5 | |

每轮都未过的 4 项：两项真实模型测试需要显式开启（按假设跳过），`AndroidFlowTest.importedExecutionEvidenceReachesTheSharedRenderer` 要 WebGL 帧，`PetOverlayFlowTest.clipsDecodeAndTouchesDriveTheOverlay`。最后三轮各有一项不同的偶发失败，每项只出现一次、其余四轮都通过：`TaskCacheFlowTest.openedAppIsPublishedBeforeNextModelRequestAndSurvivesTaskFailure`、`DeviceAgentTest.treeFirstSupportsOrdinaryCoordinateTapsWithoutApprovalAndExplicitVisualFallback`（单独重跑两次，一败一过）、`AndroidFlowTest.foregroundReplyContinuesWhileActivityIsStopped`（单独重跑两次都过）。模拟器连续跑了几个小时，原因没有查。
- **沙箱崩溃**：`diag2-logcat.txt` 里是崩溃时的调用栈。直接测试 `aRuntimeStoppedWhileItOpensNeverTakesTheOtherRuntimesDown` 在旧的"立即关闭"上跑 4 次红 2 次（`sandbox found dead during call to createIsolate`），在修复后通过；停止测试循环 12 轮、240 次停止没有一次崩溃，修复前大约每 60 次停止一次。针对"求值途中关闭"的另一项直接测试在旧行为上 3 次都没有红，说明触发点是加载内核包的那一段，这项测试只作为不变量保留。
- **Android JVM**：224 项通过。
- **iPhone**：`AgentLoopTests`、`WebPageToolsTests` 通过；七条修复逐条撤回后对应测试都变红（`ios-red-check.txt`）。没有装机。
- **没有执行**：集成档 `npm test -- --base bed3b43c`（推送前要跑）、`npm run release:verify`、任何真机与真实模型验收。

可重复的命令（先导出本机 Android 工具链，见 `MELO_OVERVIEW.md`）：

```bash
npm run test:plan -- --files $(tr '\n' ' ' < .tmp/android-agent-20261110/changed-nonkt.txt)
npm test -- --files $(tr '\n' ' ' < .tmp/android-agent-20261110/changed-nonkt.txt)
npm test -- --base bed3b43c
npm run test:android:connected
python3 ios/scripts/test.py --suite AgentLoopTests --suite WebPageToolsTests --skip-renderer --skip-js
```

## 8. 证据

`.tmp/android-agent-20261110/`：

- `audit/`：六份子代理报告的压缩件。
- `baseline/results.xml`、`after-1.xml`、`after-2.xml`、`after-3.xml`：四轮整套设备测试结果。
- `diag2-logcat.txt`：沙箱崩溃的调用栈（`SandboxDeadException`）。
- `stop-loop-after.txt`：修复后 12 轮停止循环；`core-red-check-2.txt`：旧关闭方式下直接测试 4 次的结果。
- `ios-red-check.txt`：iPhone 七条修复的反向验证。
- `port-verify-summary.json`：`33a2c4a0` 的单独验证。
- `*.py`：本轮每一批修改用的脚本。
