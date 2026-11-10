# 回复延迟修复记录（2026-11-10，Claude）

用户看完[延迟复核](response-latency-audit-20261110.md)后要求"都去修一下"。基准是本机 master `88b128ef`。本轮按复核里的七项建议逐项处理，改了桌面端、共享核心和 iPhone 源码；没有推送，没有覆盖安装。过程中我造成了一次用户数据事故，单独记在[事故记录](incident-test-isolation-20261110.md)，恢复等用户决定。

## 结果

同一问题、同一连接（`claude-opus-5-5`，Anthropic API Key）、同一套 Agent 与工具配置。改动前是今天上午在正式安装版上测的；改动后是中午在隔离数据目录的服务上测的（原因见事故记录），两组相隔约四小时，不是同一轮。

| 问题 | 改动前 | 改动后 |
| --- | --- | --- |
| 明天墨尔本天气多少：总时长 | 105.5 s、68.7 s | 24.1 s、22.6 s、23.6 s |
| 同上：模型请求次数 | 17、15 | 5、5、5 |
| 同上：输入 token | 263k、255k | 58k |
| 同上：按参考价估算的单次费用 | 约 $0.80、$0.49 | 约 $0.20、$0.11、$0.19 |
| 用一句话解释什么是二分查找：总时长 | 5.4 s | 3.8 s |

改动后一次天气题的时间线（第三次）：主 Agent 派单 3.2 s → 检索成员 5.6 s（两轮，一次搜索直接取到预报）→ 主 Agent 写答案 4.5 s（约第 9 秒开始出字）→ 完成检查 10.1 s。完成检查现在是剩下最大的一段，见"没做的"。

答案质量没有评测集。三次改动后的回答都给出了明天的温度范围、天气和降雨概率并注明来源；有两次只用了 wttr.in 一个来源，没有再去对照气象局。

## 改动

| 复核项 | 改动 | 位置 |
| --- | --- | --- |
| L1 收尾请求走错协议 | 到上限后的收尾与其检查按连接自己的协议发出；文本协议连接不再带原生工具列表 | `src/runtime/limitDelivery.js` |
| L2 读页只能翻页 | 读页工具声明"结果就是一个窗口"，模型看到整个窗口和续读偏移（与 iPhone 一致）；窗口按 token 等价长度截（中文页约 7 000 字，英文页仍是 20 000 字） | `src/tools/functionCalling.js`、`src/tools/builtins/fetchUrlTool.js`、`src/services/search/pageWindow.js`、`src/tools/toolInvocationRecord.js` |
| L2 成员忘了刚读的来源 | 成员保留旧结果改为按体积（约 16 000 token 以内都留全文，最新一条永远保留），不再只留最近一条 | `src/tools/functionCalling.js`、`src/agents/subAgent.js` |
| L2 天气快路用不上 | 搜索工具的说明写明天气问题一次返回预报；快路结果登记为已读来源 | `src/tools/builtins/webSearchTool.js` |
| L2 派单扩写 | 派单说明要求按用户原话写任务，不加字段、不点名来源、不要求交叉核对；检索成员先搜索，只有任务给了网址才直接打开 | `shared/agent/internalRouting.js` |
| L3 成员自查 | 只读岗位（检索、社交检索、资料读取、计算）交回前不再自己做完成检查，与 iPhone 一致；回执改由"实际读到了什么"决定。执行岗位保留自查 | `src/agents/subAgent.js`、`src/services/chat/execution/internalMembers.js`、`src/runtime/sharedAgentCore.js` |
| L3 核验看不到依据 | 完成检查读每条证据时，按答案里的数字和词选取最相关的片段，不再只看开头 2 000 字；证据少时每条最多看 6 000 字 | `shared/agent/goal.js` |
| L3 核验串行两次 | 答案标了不确定内容时，由完成检查在同一次请求里一并核对，收尾节点直接用它的结论；检查没有核对到时才发原来的核验请求 | `shared/agent/goal.js`、`invokeModelNode.js`、`finalizeNode.js`、`ios/Melo/AgentLoop.swift`、`ios/Melo/SharedAgentCore.swift` |
| L3 检查输出 | 检查的 JSON 要求一句话原因、只列用户要的交付项 | `shared/agent/goal.js` |
| L4 主 Agent 请求过重 | MCP 工具默认只列名称和一句说明，模型要用时先调 `load_tools` 取定义，下一步再调用；内置工具、技能、派单不变。审批和权限照旧 | 新增 `src/services/chat/execution/deferredTools.js`，接入 `invokeModelNode.js` |
| L5 重复生成 | 成员报告限 120 词、只列事实与来源，由主 Agent 写给用户的答案 | `shared/agent/internalRouting.js` |
| L5 Jina 卡顿 | Jina 3 秒没回就并发直连；网页仍优先等 Jina 的渲染结果 5 秒，非网页资源（JSON / XML）直连一到就用；输的一方中止 | `src/tools/builtins/fetchUrlTool.js`、`src/services/search/searchLimits.js` |
| 手机：串行读页 | 一批全是读网页的调用最多三个同时加载，结果仍按原顺序交回；混有其它调用的批次保持严格顺序 | `ios/Melo/AgentLoop.swift` |
| 手机：20 秒整页超时 | 第 8 秒起，文档已解析且正文超过 400 字的页面直接读取，不再等所有资源；20 秒硬上限不变 | `ios/Melo/WebPageTools.swift`、`ios/Melo/WebPageText.swift` |
| 共享包 | `npm run build:agent-core` 重新生成（45 模块） | `shared/agent/dist/*`、`ios/Melo/AgentCore/*` |

没有照复核原样做的一项：复核第 5 项写的是"单成员、证据已核实时直接交付成员报告"。用户保留的决定是主 Agent 负责整合和审核，所以改成让成员报告变短，答案仍由主 Agent 写。

两个新开关登记在[环境开关目录](env-flags.md)：`MELO_DEFERRED_TOOLS=0` 关闭按需加载；`MELO_ALLOW_USER_HOME_IN_TESTS` 见事故记录。

## 修改前的链路与边界

- 链路：`chatRoutes` → `chatExecutionRunner` → `prepareNode` → `invokeModelNode`（派单、整合、完成检查、限额收尾）→ `internalMembers.runInternalMembers` → `subAgent.runSubAgentLoop`（成员循环、压缩、收尾）→ `functionCalling` 会话（结果封装）→ `executor` → `fetchUrlTool` / `webSearchTool` → `limitDelivery.runLimitDelivery` → `openai.requestOpenAICompatibleReply`（协议分发）→ `finalizeNode`。手机：`ChatStore` → `AgentLoop.run`（工具批次、候选、收尾）→ `DeviceTools.perform` → `WebPageToolRunner` / `WebPageLoader`。
- 共享状态：请求上下文里的预算与成员子预算（没改口径）；`coreTurn.observations`（成员观察并入主账本的方式没改）；目标状态新增只属于单个候选的 `uncertainClaim` / `claimReview`，不进持久化快照。
- 契约：`shared/agent/goal.js` 的检查请求与回复（新增可选的 `uncertainClaim` 输入和 `claim` 输出，旧宿主不传就没有变化）；`internalRouting` 的派单说明与成员系统提示；工具结果信封（读页结果可以超过 8 000 字的通用上限，其它工具不变）；`searchLimits` 新增两个数值。
- 异常：收尾请求失败仍然退回宿主证据文本；并发读页里输的一方被中止，不向外抛；`load_tools` 由宿主直接应答，不进执行器。
- 停止条件：到模型与网页的传输边界为止；不进 Jina、wttr.in、供应商内部；Android 宿主代码没改，只随共享包变化。

## 验证

- 新增与改写的测试：`limitDelivery.protocol.test.js`（本地假服务端走真实分发，Anthropic / Chat Completions 原生 / 文本协议三种连接，旧代码下三项全红）、`functionCalling.window.test.js`、`fetchUrlTool.hedge.test.js`、`goalEvidence.test.js`、`deferredTools.test.js`、`deferredTools.graph.test.js`（真实执行图）、`internalMembers.test.js` +4、`finalizeNode.test.js` +4、`promptPipeline.test.js` +1、`subAgent.test.js`（压缩用例按新口径重写）、`testIsolation.test.js`；Swift `AgentLoopTests`（并行读页、合并核验）、`WebPageToolsTests`（软超时判定）。并行读页用例做过反向验证：把并发数改回 1 时断言失败。
- 改了断言的旧测试：三处把收尾请求写死成"空的原生工具列表"，那正是 L1 的错误形状，改成断言 `tools: []` 且文本协议不带原生列表；两处路由用例原来期待成员各自检查一次再由主 Agent 检查，改成整轮只检查一次。
- 用上午实测的真实数据重放：成员当时读到的气象局文件（13 285 字，墨尔本段在第 5 249 字）和它的报告，旧的前 2 000 字看不到墨尔本段，新的片段选取在 4 000 字额度内包含墨尔本段、天气、风和日期。脚本与输出在证据目录。
- 真实模型：上表的五次天气和问答；另一次让它用 Markdown 转 PDF 工具，模型先调 `load_tools` 再调该工具，工具照常弹出审批（探针无人确认，120 秒后按拒绝处理）。
- 门禁：快速档 `run-xDpHtY` 全绿（公共边界扩大到 601 / 601 个文件：JS 5 111 / 5 111，Android 四项、设置浏览器验收、全部 Swift 组、文档链接；426 秒）；中间一轮 `run-erW8FY` 只红了一项（新开关没登记到开关目录），补登记后通过。iPhone 无签名构建通过（`.tmp/latency-fixes-20261110/ios-unsigned-build.log`）。

## 没做的

- 完成检查本身仍要 9–11 秒，其中约一半是模型思考。把检查请求的思考强度调低是下一步的候选，需要先有评测集，本轮没有动。
- iPhone 正文流式显示没有做：它要改传输、消息落盘和界面，并且需要在真机上验收。
- iPhone 的两处改动只有源码、离线测试和无签名构建，没有装到手机上验证；WebKit 的软超时逻辑离线测试覆盖不到加载过程本身。
- Android 宿主没有改；Android 的并行读取和核验合并都没有接。
- Codex 登录连接没有在桌面上实测。
- 实测时发现"请用图表工具生成一张柱状图…"被图片生成流程接走，没有进入 Agent 循环，这是既有行为，本轮没有处理。那次探针用用户的图片引擎生成了一张图。

## 证据

`.tmp/latency-fixes-20261110/`：五次探针的事件流、回复与时间线（`weather-1..3`、`explain-1`、`mcp-1`、`weather-0-first-cut` 是调整 Jina 规则前的一次 49 秒）、对应 Trace（`traces/`）、定向测试与门禁日志、iPhone 测试与构建日志。改动前的基线在 `.tmp/latency-audit-20261110/`。探针合计约 $1.1（参考价估算），用的是用户的 API Key。
