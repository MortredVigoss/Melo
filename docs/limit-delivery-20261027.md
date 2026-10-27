# 循环轮数与上限交付实施记录 · 2026-10-27

## 授权、源码与索引

用户已指定五步方案，每步独立提交；本次不推送、不安装、不修改真实账号和数据。实际起点为 `ca3fca0`（含 `99b8ba7` 的闭环修复），集成验收仍按用户指定的 `7ae6bf5` 计算范围。使用独立工作树 `/private/tmp/melo-limit-delivery-20261027`。已读 AGENTS、CLAUDE、完整 MELO_DEVELOPMENT_STANDARD 与总览；`npm run scope` 识别 chat/agents/runtime 及原生、同步、生成契约消费者。

## 修改前执行链路与边界

| 链路 | 状态、异常与契约 |
| --- | --- |
| 桌面聊天入口 → `execution/prepareNode.js` → `invokeModelNode.js:invokeModelNode` → `runtime/sharedAgentCore.js:createCoreTurn` → `shared/agent/turn.js:startTurn/advanceTurn` | 请求所属 Agent、目标/补充、权限、预算与上下文均属于本轮；共享 reducer 维护 rounds、pending、审批后执行许可、失败与无进展计数。非法事件抛错由图节点记录；停止回执经 finalize 持久化。 |
| `invokeModelNode` → `openai.js:createReply` → 提供方适配 → 工具执行器 → `coreTurn.results/candidate/review` | 模型请求和工具均消费 runBudget；超时、取消、上下文过大在宿主捕获；工具结果必须配对。候选回答经 `goalCandidate/goalReviewRequest/reviewGoal`，`completionResult` 生成回执，`finalizeNode`/executionScenes/桌面执行面板显示结果。 |
| `delegate.js` / `team.js` → `subAgent.js`；技能入口 → `skillExecutor.js` | 子预算受父预算约束，权限交集保持；每个成员拥有独立 turn/goal/observations。异常与 partial 交接必须沿调用方保留已执行结果，不能误报完整交付。 |
| iPhone `AgentLoop.run/invokeModel` → `PhoneCoreTurn.event` / `PhoneGoalState` / `PhoneRunBudget` → `SharedLoopPolicy` | 同一 JS 契约经 JavaScriptCore 执行；Swift 宿主保留取消、审批、provider/工具调度与持久化。`withDeadline`、成员限制、transport round 的 catch 路径必须一起审计，避免丢失收尾。 |
| Android `SharedChatAgent` → `SharedCoreTurn.request/event` / `SharedRunBudget.model/effect` → `SharedCoreRuntime` | JSON 桥使用同一 reducer/goal/budget；Kotlin cancellation、预算异常与工具回执进入同一结束语义。 |
| Agent 设置 → collaboration 归一化/同步 → 各宿主轮数；smart routing → 分类与运行预算 | 保留已保存配置，明确旧字段兼容；UI 输入范围与运行时范围同源。桌面/iPhone/Android、生成 JS/Swift/Android assets 都是契约消费方。 |

共享读写边界：运行内预算（含祖先）、goal、工具观察与 requestContext；配置只走现有保存入口；最终回答、completion、continuedRequest 只走现有聊天持久化。不得修改 MELO_HOME、模型连接或真实历史数据。执行许可、审批拒绝、取消和重复副作用守卫保持现有规则。

审计停止点：追踪到现有原子持久化与 UI 回执消费，不进入第三方 provider SDK/SQLite 内部；使用既有集成回归验证边界。真机覆盖安装、同步服务器部署、长时间后台运行不在授权范围；原生编译与契约测试不能冒充真机验收。真实模型验收单独保留脱敏场景回执，不能由 fixture 替代。

## 顺序、覆盖与验收

1. request 明确 tools/check/delivery；仅合法工具批次计入 rounds；检查、纠偏候选和收尾不占轮数。保留事件兼容及停止守卫。
2. 统一默认 40/20/12，工具 200、30 分钟，主循环设置 10–64；深度智能任务 64/300/45 分钟；生成契约和三端 UI 对齐。
3. 工作额度与收尾保留分离；一次无工具交付，再目标检查；保持证据/缺口，LIMIT_DELIVERED 回执；取消和硬截止仅宿主证据清单。
4. 成员/技能同语义，partial 交接 GOAL_INCOMPLETE，上级继续补做。
5. 三跳场景 6/40 轮、预算/取消边界、共享 conformance、Swift/Kotlin、同范围快速档、基准集成档与真实模型。

已阅读覆盖：共享 turn/goal/budget/completion/JSON bridge、Node core host、桌面主循环、子循环入口、Swift loop/core、Kotlin core/budget/聊天入口及 scope 索引。逐步补读 provider 预算入口、配置和所有回执消费者并记录差异。开工时未完成：代码、回归、真实模型与最终集成。当前进度以本文最后的验收记录为准。

专项证据：`.tmp/limit-delivery-20261027/`；阶段完成后追加实际命令、结果和提交。功能级源代码索引尚未落地，本表来自直接阅读实际函数，不以模块地图代替调用证据。

## 第一步验收

仅实际工具批次增加 rounds；三端 Host 发送 request.kind；兼容旧 mode=review。新增四份跨引擎计数 fixture 与非法 kind/批次、收尾工具零执行断言。Swift 旧夹具改为一轮工具额度，仍断言候选+检查+工具+收尾共四次模型请求与实际执行一次。

快速档 `run-h7krwC/summary.json` 全绿：JS 4732/4732、Swift 37 组、Android JVM/Lint/Debug/Release、设置浏览器与生成资源；无跳过、无隔离复测。Swift 夹具在该组编译前更新，重新生成全文件 test:plan，选组保持全部 Swift/JS/Android；日志保留。证据 `.tmp/limit-delivery-20261027/step1-plan.log`。剩余四步尚未实施。

## 第二步实现与过程记录

新 `shared/agent/loopLimits.js:resolveLoopLimits` 由 Node 和原生 JSON 桥共同调用；模型路由保存深度分类标志，普通升档不偷偷重置预算。主任务已有字段 `collaboration.maxTaskIterations` 保留，成员仍为 `maxIterations`，避免混用两个独立设置；新 UI 为 10–64，旧记录小于10的显式值保持可读且不重写。成员默认20、技能默认12只作用于未填写的配置。

Agent 扩展协议的可选 maxTaskIterations 最大值放宽到64，workspace v1其他字段不变；旧端的该可选设置通道可能不能接收大于20的新值，原数据保留；本次三端消费者与生成物一起更新，未部署同步服务器。新 Android UI 常量由契约生成，运行策略从同一 JS core 读取。

`chatExecutionRunner → runDeadline` 保持原始硬截止，只有本轮预算实际延长才在旧截止点重排剩余时间，显式短截止仍优先；Swift root 在路由准备后取动态预算，成员不放大；Android 移除15分钟旧常量、保留45分钟外层硬顶和每请求共享预算。执行记录边界从160提升至契约512，以容纳300次工具调用，包含 sessionEvents 与桌面记录投影。

第二步首轮快速档 `run-jZMSSo` 在浏览器加载阶段失败：前端增加共享契约 import 后，服务端白名单未增加该模块。不是机器负载问题。修正 `server.js` 明确只读路由与 iOS 面板打包依赖后，Agent 设置浏览器保存64/取消/原配置保留通过。旧运行器将错误判为超时并开始自动复测，已停止该旧运行及其4个子进程，失败日志和 `step2-first-run-interrupted.json` 保留；随后在稳定树重新生成全部改动文件计划并完整重跑，不把旧树自动重试当验收。

第二步补漏：技能磁盘导入、新建/编辑表单也从同一契约读取默认12，显式保存6仍保留。Swift 新超时传入暴露出 `DEADLINE_EXCEEDED` 被误归 `.toolLimit`，已按原因归 `.budget`；独立 JSCore 桥不依赖完整 App 的 `AgentLoopContract` 类型，未传超时时由共享 reducer 取默认。旧夹具分别改为30分钟、契约轮数足量响应、超过当前契约截止时间，仍保留“不得发生晚到副作用/不得再核验”的断言。

过程证据：`run-6iDtDd` 与 `run-aTMkfB` 的 JS4742、Android四项和设置浏览器均绿，Swift 分别暴露旧响应夹具不足和超时夹具未同步；失败原样保留，未跳过。`step2-swift-all.log` 同时记录独立桥的编译边界修复；`step2-swift-final-loop.log` 关键循环套件通过。最终同范围快速门禁重跑中，以上不是最终完成声明。

第二步最终验收：`run-9yDTRs/summary.json` 同范围快速档全绿：JS4742/4742、Swift37套、Android JVM/Lint/Debug/Release、设置浏览器和生成资源；零跳过、零隔离复测。最终测试前完成上述修正，测试期间未再改产品代码。第二步独立本地提交；第三步及后续、真实模型和最终基准集成仍未完成。


## 第三步实现与过程记录：统一收尾与跨端边界

`reserveDelivery → admitModel/settleModel` 在各宿主的请求入口预留60秒、8k输出额度和有界输入余量；父子账本与并发待结算请求共用额度，工作工具的超时改为扣除预留后的期限。Node `chatExecutionRunner/createReply → runtime/limitDelivery`、Swift `AgentLoop.deliverLimit → APIChatTransport/CodexResponsesTransport`、Kotlin `SharedChatAgent.deliverLimit → SharedRunBudget.model` 全部调用同一 delivery/goal/completion 规则。正常轮数/时间/调用/token 上限进入一次无工具交付与检查，只有硬截止/取消/不可用额度走宿主清单；检查不可用保留回答为 unverified。公开原生搜索也计一次实际工具轮，同一回复的原生与本地工具不重复计轮。

新增审计边界：预算 JSON 桥须克隆预留对象（跨引擎测试暴露原先浅复制会修改入参，已修）；Swift 真 transport 按实际请求体准入并结算，循环不再重复计费，智能路由判断也走同一预算。检查/交付关闭普通及托管工具；继续沿既有取消持久化路径保存工具记录，不在取消后再请求模型。completion 新增 LIMIT_DELIVERED、可选 limitReason/检查结果；JSCore Codable 与 Android JSON/共享场景同时读取，旧数据缺字段仍可解码。

当前证据：桌面6/40工具轮演出→异地→当天活动夹具通过，分别 partial/LIMIT_DELIVERED 与 completed，已有活动与缺口不丢；共享预算并发/三上限/硬截止计数器通过。iPhone相同6/40场景、Network与SharedContract三个套件通过（后续桥克隆修正会再核对）；Android编译/JVM通过。`step3-*` 留失败与修正记录；最终完整快速档、成员/技能统一收尾、真模型及基准集成尚未完成。

### 第三步验证完成

第三步完整快速档 run-xapdiU 通过：JS4757/4757、Swift37、Android JVM/Lint/Debug/Release、设置浏览器，零跳过/复测。修复旧报告变量残留、独立入口取消信号、策略资源缺失的零调用兜底；保留完整失败与修复日志。见 `.tmp/limit-delivery-20261027/step3-quick-verified.log` 与 `.tmp/test-runs/run-xapdiU/summary.json`。尚未完成成员/技能、真实模型和基准集成。

## 第四步修改前补充边界

`runConfiguredMember → runSubAgent → budgetedMemberReply → shared runBudget` 与 `buildSkillTool → runSkill` 分别保留权限、工作区写锁、取消传播及交接。子预算为成员保留总输入/输出 token，未配置总量的主预算仍只计输入；并发准入把未结算输出也算入父池。iPhone `PhoneMemberLimits → AgentLoop → PhoneModelMeter → policyBridge` 使用相同策略，达到上限返回 completion 和文字而非抛错丢交接。Codex OAuth 不接受 API 的输出上限字段，保留原协议；用量按回执/估计结算，原生服务内部调用不可由本机逐个抢占（需在最终证据写明此物理边界）。

子任务 partial/GOAL_INCOMPLETE 通过交接保留缺口，主循环指令要求补做/换人。团队固定编排的主 Agent 汇总路径也须检查：不能把 partial 成员直接归为整体成功，余量不足时保留交接。Android 当前没有本机委派/技能执行入口，公共预算与完成契约由同源 JS/跨引擎测试覆盖，不声明新增 Android 协作功能。停止边界仍是既有持久化、工具权限和提供方传输；本步不部署/安装或改用户配置。

## 第四步验收

成员与技能在上限时复用统一交付/检查，partial 保持 GOAL_INCOMPLETE 和证据交接；团队成员 partial 后由主 Agent 继续正常工具循环。输入/输出总预算只施加于成员与团队池，主任务原有输入预算不变；并发请求先占额度，成功/失败均结算，父池预留不可被子任务吃掉。小成员预算按比例预留输入，避免默认 builder 尚未发出能力授权就耗尽；不能满足交付额度时保留宿主清单。

最终累计快速档 `run-4D3pby/summary.json` 全绿：JS4771/4771、Swift37套、Android JVM/Lint/Debug/Release、设置浏览器，零跳过/复测。`step4-ios-build.log` 记录完整未签名 iPhoneOS 构建通过。成员/技能各轮数、调用、时间、token、取消计数器通过；HTTP 团队恢复夹具6次模型请求，成员读A后部分交接，主 Agent 接着读C并得到 completed。能力授权浏览器实际弹窗、放行、结果回传、列出和撤销通过。首轮失败 `run-GbcOvA` 保留，修正预留比例、父预算夹具与耗尽 metadata 后完整重跑。

真实模型演唱会链路已在隔离日历夹具与真实联网工具上完成：8次模型请求、5次工具调用，最终 completed；不读取或修改用户日历。第五步将保存脱敏回执、补执行面板断言并跑基准集成。所有验证只在隔离环境，不推送或安装。

## 第五步验收范围与当前证据

- 跨端6/40轮场景分别交付 partial/LIMIT_DELIVERED 与 completed；目标检查和纠偏候选不计轮。时间/工具次数/输入token与成员总token的预留、硬截止、取消、并发父子额度均有真实调用计数器断言。相关入口：shared 的 conformance/deliveryBudget/limitDelivery，Node chatExecutionRunner 与 childDelivery，Swift AgentLoopTests，Android共享核心/JVM。
- 执行面板新增生产 completion → scene → DOM 的断言，文字为“部分完成 · 已达轮数上限”，旧“受阻 · 尚无目标完成证据”不出现。专项2/2通过。
- [真实模型回执](evidence/limit-delivery-20261027/live-model-receipt.json)：2026-10-27，8次模型请求/5次工具调用，日历→场馆城市→当地活动→正文读取→核验纠偏→completed；没有“达到工具执行上限”。首个日历回执正文不足被检查器发现并重新读日历，未凭空标记完成。日历为明确标注的测试占位条目，联网检索/网页与模型为真实调用，未使用个人日历。
- [执行场景回执](evidence/limit-delivery-20261027/execution-scene.json)由当时捕获的真实事件通过生产投影器重建，来源/操作/最终completion可回看。场景中的重建时间不作性能证据；耗时以模型回执为准。执行时未冻结源码hash，此项仅证明当时主循环真实链路，不冒充最终提交哈希的运行证明；最终集成门禁另验。

未覆盖与限制：没有安装应用、真机相机/账号同步、长期后台验收。Codex OAuth不支持本地API的输出上限参数；8k为预留/准入额度，实际输出依提供方用量结算，不能宣称服务端硬截断为8k。提供方托管搜索的内部多次调用也不能被宿主逐个抢占；本地工具仍逐个计数和截止。用户显式给成员极小token或短于预留的时间时可能无法进行模型收尾，保留宿主结果清单且不伪造完成。

步骤提交：d0bcf3e（计数）、cceb4f1（配置）、006797b（主循环交付）、57bc404（成员/技能）。第五步累计快速档与基准7ae6bf5集成档开始前，产品代码已固定；待记录最终结果。

## 最终验收与覆盖清单

最终累计快速档 `run-ca7apo` 与基于 **7ae6bf5** 的集成档 `run-RRWwcg` 均通过：**JS4771/4771、Swift37套、Android JVM/Lint/Debug/Release、设置浏览器、语法/文档/生成器/资源预检**；零失败、零取消、零跳过、零隔离复测。Swift复用编译产物但37个测试程序全部实际重跑，不是跳过测试。最终完整未签名 iPhoneOS 构建 `step5-ios-build.log` 成功，未安装。

[门禁摘要、源码与日志指纹](evidence/limit-delivery-20261027/verification.json)记录每个成功阶段，代码在最终两档门禁期间未修改。临时完整日志位于实施工作树 `.tmp/test-runs/` 与 `.tmp/limit-delivery-20261027/`；失败过程保留，不能把早期失败轮当最终绿灯。

| 验收边界 | 实际回归入口与结论 |
| --- | --- |
| 工具轮、免费检查/纠偏/交付、共享生成契约 | `shared/agent/conformance.test.js`，147份跨引擎fixture及额外直接断言；Swift SharedAgentCore/SharedContract、Android JVM。 |
| 6轮部分交付、40轮完整交付 | Node `chatExecutionRunner.test.js` 与 Swift `AgentLoopTests.swift` 的同主题夹具；结果/缺口保留，前者LIMIT_DELIVERED。 |
| 时间/调用/input token、成员total token、并发预留 | `deliveryBudget.test.js`、`runBudget.test.js`、`childDelivery.test.js`；一次交付+无工具核验，父预留不可借用。 |
| 审批拒绝/超时/无界面、权限继承 | `executor.capabilityElevation.test.js`、`executor.capabilityScope.test.js`、capabilityElevation浏览器；拒绝零操作，允许/撤销实际生效。 |
| 取消、硬超时与迟到副作用 | `executor.cancellation.test.js`、chatExecutionRunner及Swift AgentLoop；取消零后续模型，真实bash延迟写被阻止。 |
| 压缩、网络/读页失败与无进展 | chatExecutionRunner上下文压缩、`fetchUrlTool.evidenceTrail.test.js`、`webSearchTool.jinaAbort/swrAbort.test.js`、`agents/repeatGuard.test.js`及共享reducer；保留已有护栏，不把上限放大变成无限循环。 |
| 团队部分交接后继续 | `functionCalling.integration.test.js`真实HTTP夹具；6请求/2实际读取，主Agent补做后completed。 |
| UI、配置与旧数据兼容 | agentSettings/capabilityElevation真实浏览器、executionPanel DOM；三端共用字段和默认，显式旧值保留。真实账号/同步服务器未写入。 |
| 真实模型 | 隔离日历+真实模型/联网：8请求、5工具、检查纠偏后completed，完整边界见上节。 |

五步实施及本地验收完成。最后一步仅新增回归/脱敏证据和交接文档；合回原本地开发分支时须再次确认原树干净且仍为ca3fca0，使用fast-forward保留历史。未运行git pp/push/安装；没有将构建或夹具结果称为真机验收。

## master 合并与推送授权

2026-10-27用户明确授权合并master并推送。fetch后origin/master无独有提交，本地master为7ae6bf5；以fast-forward合入77b2879，保留全部前序提交，不产生合并冲突或产品代码变化。再次核对verification.json中的94份代码SHA一致，复用刚完成的7ae6bf5基准集成结果；只对新增的本节及总览/进度记录执行文档范围检查。`push-master.log`和`push-master-receipt.json`位于产品仓库`.tmp/limit-delivery-20261027/`，保存实际推送结果与local/remote SHA。未授权安装，不运行git pp。
