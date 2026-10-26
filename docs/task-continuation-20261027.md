# 有能力却提前结束：实施与验收（2026-10-27）

基准 `7ae6bf5`，分支 `codex/task-continuation-20261027`。用户指定的四项修复已落地；最终快速档、集成档结果见下方。仅本地开发，不推送、不安装。

## 已实现的行为

| 项目 | 实现 | 边界 |
| --- | --- | --- |
| 零工具候选漏检 | 有可用工具时，任务型/不明确请求的无工具回答进入现有目标检查；“请告诉我目录”不能直接变成已交付 | 问候、明确禁工具、只用上下文直接回答保留；文件翻译也必须检查；纯文字足够的回答由检查器标为 self_contained；原检索及已调用工具检查保留 |
| 轮数与到顶回复 | 检查轮单独计数，最多3次；执行轮默认10、可设1–20，与成员轮数分开；到顶额外一次无工具进度汇报 | 检查及汇报仍消耗真实时间/token预算；关闭函数工具、原生搜索/图像；回执保持ROUND_LIMIT，不能宣称任务完成；取消/运行预算路径不变 |
| 审批与替代路线 | 首次实际需确认时增加“本次任务允许”；文件具体审批承接确认，取消通用工具审批的重复弹窗；拒绝后继续独立合法工作或已接受的文字建议 | 不扩大能力；保留原有显式工具拒绝；拒绝文件记录优先于后来对其他文件的任务授权；不得换工具重做被拒绝效果 |
| 模型操作指令 | 先用授权工具取得可发现的公共/本地信息；仅在歧义、偏好、权限、不可访问私有输入时询问；回答前逐项核对原目标 | 工具结果是证据，不是扩权指令；保留成功副作用去重，不强制首搜 |

任务授权绑定本次运行预算、run/chat、Agent、项目和工作区真实身份；不持久化、不同步，任务结束或取消失效。两类可选范围：工作区普通文件修改；已有固定 npm test/build/lint/check 模板（命令、目录身份和 package.json 哈希一致）。删除、敏感路径、符号链接、外部工作区、新建目录的逐项确认保留。界面同时保留单次、拒绝、始终允许；五语文案齐全。

静默只读命令只接受有限 ls/cat 语法：目录列表通过目录句柄读取，含空目录、不跟随链接；文件读取复用文件安全门。输出说明为路径列表，非 ls 元数据列。管道、重定向、扩展参数、外部/敏感读取仍需原有判断。Git可能执行仓库配置中的程序，保持命令授权。

## 三端设置与接口

- 桌面：Agent设置里的“任务执行轮数”，沿用编辑/保存/取消；默认值不强行写入旧配置。`collaboration.maxTaskIterations` 是已有Agent扩展的可选字段，不改冻结的workspace-v1形状。
- iOS：Agent编辑器Stepper、只读摘要与主循环Hook共用此字段；扩展编解码和同步schema生成物已更新，系统权限继续由原生机制管理。
- Android：Agent编辑页可调整本机任务轮数，进入运行配置；保存/重新投影保留。本机设置沿用当前Android策略，不宣称此项已经跨端同步。
- 主循环、成员与技能循环共享检查/进度策略；成员不完整时主Agent的默认动作没有改。本轮不扩日历/通讯录等工具、不动取消与整体预算、不重新引入强制搜索。

主要入口：`shared/agent/{goal,turn}.js`、`shared/protocol/agent-loop.json`、`src/services/chat/execution/invokeModelNode.js`、`src/safety/fileSafetyGate.js`、`src/tools/executor.js`；三端Host与Agent设置同步接入。具体文件以本分支diff及功能地图为准。

## 验证证据

| 层级 | 结果 |
| --- | --- |
| 专项 | 初始执行/检查/取消/预算/权限150/150；轮数保存/取消与补充/主题浏览器修正7/7；生产执行器+英文审批浏览器+只读命令10/10；无审批表面修复专项11/11 |
| iOS循环与共用边界 | 全部37套Swift通过（`swift-all-3.log`），包括检查/汇报、传输、取消/预算、同步、权限、设置；随后纯文字状态标签小修另跑定向与最终门禁 |
| iOS完整界面 | `xcodebuild` Release / iphoneos / CODE_SIGNING_ALLOWED=NO：BUILD SUCCEEDED；日志 `.tmp/task-continuation-20261027/ios-app-build-final.log` |
| 真模型 | `gpt-6.1-sol`四场景符合预期，见[脱敏回执](task-continuation-real-model-20261027.md)：文件翻译读写回读、多文件计算报告完成；2轮后追加零工具报告；拒绝写入后原文件保留且给出准确建议 |
| 审计 | `node scripts/audit-inventory.mjs --baseline docs/audit/inventory-2026-10-26.json`：所有H规则无新增，未提高基线 |
| 最终快速档 | `run-oTS2EM` GREEN：JS4726/4726、37套Swift、Android四项、设置浏览器通过；456.9秒；无跳过、无隔离复测 |
| 基于7ae6bf5的集成档 | 运行中 |

真实模型使用隔离home/workspace，只传测试数据，审批由测试脚本在该目录中批准/拒绝；英文审批按钮另由真实HTTP服务与浏览器夹具操作。不是实体手机/生产账号数据验收，也没有安装应用。

## 发现的问题与修正记录

- 首轮快速 `run-3OrhNV` Android四项通过，JS未过：旧状态缺requestMode不能因此拒绝合法调用，已修正；旧单请求/检查占轮数夹具按新语义更新，保留原行为断言。
- 真模型首轮暴露文件操作的两层弹窗，主动结束，未计通过；合并确认后，一次范围批准可覆盖多个文件。第二轮拒绝回答正确但检查器引用失败记录导致partial，已明确失败/拒绝只作限制背景，交付证据必须来自成功执行观察，未放宽证据校验。
- 新审批浏览器/执行器夹具两次失败分别源于macOS `/var` 路径别名和测试回调误消耗普通执行事件；改用真实路径并按事件类型接收决定，不改变产品权限边界。
- 快速 `run-ckimmK`：Android四项通过、JS4724/4725通过。无审批表面被具体文件门的错误包装成GATE_ERROR；现保留PERMISSION_NO_SURFACE，原“即时拒绝且零写入”断言继续成立。该轮未发生隔离复测。

方案取舍：仅提示词6/10；共享检查、独立轮数、一次进度汇报、明确范围授权9/10（采用）；无限续跑或拒绝后自动扩大权限2/10（不采用）。

全量Swift补出Network传输夹具的旧10次请求断言：现在保持10次工具执行、增加第11次无工具汇报，并断言最后请求没有tools。另补本地文件翻译零工具漏检用例，避免把“翻译”一概当成无需工具的文本请求。

Codex OAuth传输夹具同步增加“汇报轮无tools/tool_choice”的断言，并在纯文字核验中验证原始用户目标未被参考资料中的搜索要求污染。纯文字完成回执仍须成立，没有删除或改弱该断言。最后真模型运行四场景共18次模型请求，均符合各自预期，范围与运行时源文件哈希保存在脱敏回执。

最后修正三端纯文字核验状态：共享检查器返回deliver代表文本已交付，执行面板应为completed而非failed；Node/iOS增加状态断言。四个真模型场景均走有证据的complete或ROUND_LIMIT路径，不受该显示修正影响，未为此重复付费模型请求。

## 执行链路与审计边界（统一规范补录）

开发中途另一线程提交 `dfc9269`，将共用流程统一到 `MELO_DEVELOPMENT_STANDARD.md`；本线程已完整读取并保留该提交及其交接。本节依据当前功能地图、`.tmp/task-continuation-20261027/scope-final.log` 和实际源码调用补录于本地提交前，不将模块地图当函数级证明，也不声称本节在开发前已写好。该提交仅改规范/交接文档，没有改本次运行时代码；集成基准仍是 `7ae6bf5`，覆盖两者。

| 路径 | 文件:函数调用链 | 共享状态、契约与异常边界 |
| --- | --- | --- |
| 桌面入口到交付 | `src/http/chatRoutes.js:handleChatRoutes` → `src/services/chat/sendChatMessage.js:sendChatMessage` → `src/services/chat/chatExecutionRunner.js:runChatAgentExecutionGraph` → `src/services/chat/execution/invokeModelNode.js:createInvokeModelNode/invokeModel` → `src/runtime/sharedAgentCore.js:createCoreTurn` → `shared/agent/turn.js:advanceTurn`、`goal.js:goalCandidate/reviewGoal/goalProgressRequest` → `src/services/chat/execution/finalizeNode.js:createFinalizeNode/finalize` → sendChatMessage的回复保存与SSE |
| | | 请求入口捕获home、run/chat、预算、signal、Agent/项目绑定；`agent-loop.json`、工具信封与completion回执由共享核心判定。检查/汇报请求无工具；deadline/cancel仍优先。provider错误由invokeModel的检查/汇报/预算分支处理，外层保留中断/失败回执，finally清掉任务授权。最终正文/回执进入对话与执行记录，不将请求工具等同成功执行 |
| 工具与审批闭环 | invokeModel → `src/tools/executor.js:executeTool/executeScopedTool/runObservedTool` → `permissions.js:checkPermissionRule` → `fileWriteTool.js:run` / `fileEditTool.js:run` / `bashTool.js:run` → `fileSafetyGate.js:requestWrite/requestEdit/requestBashOp/_prompt` → SSE → `desktop-ui/app.js:renderFileSafetyDialog/_fileSafetyButtons/handleFileSafetyResponse/submitPermission` → `src/server.js:/api/tools/permission-response` → `fileSafetyGate.js:resolveFileSafety/commitOperation` → 目录句柄文件写入/命令执行 |
| | | executor首先判Agent能力、请求禁用策略与工作区；显式工具deny优先，文件门负责具体内容确认。`taskGrants/taskDenials`是以预算为弱键的进程内状态，键还含home、run/chat、Agent/项目、真实目录身份；只本任务使用，结束清除。批准后仍校验token、inode、hash、符号链接与取消。拒绝/无审批面错误传到工具信封（PERMISSION_DENIED/PERMISSION_NO_SURFACE），模型与checker可继续允许的工作；没有批准不能提交副作用 |
| 静默只读 | `bashTool.js:run` → `readOnlyCommand.js:readOnlyCommand` → `fileSafetyGate.js:requestRead` + `dirfdOps.js:openParentDirFd/_raw.readdirAt`（列表），或 `fileReadTool.js:run`（文件） |
| | | 仅固定语法且工作区内；读能力/路径门继续生效，目录fd在finally关闭，链接不跟随，输出有限。不匹配的命令回原bash风险/审批路径；本轮不改变任意shell授权 |
| 轮数设置与保存 | `desktop-ui/features/agents/view.js`表单 → `agentProfilePatch.js:buildAgentProfilePatch` → `src/services/agent/agentMutations.js:updateAgentProfile` → `src/domain/agent/capabilities.js:normalizeCollaboration` → `stateStore.js:updateStateAtomically` → 下一轮activeAgentProfile；iOS `AgentEditor.swift`编辑会话 → `AgentProfile.maxTaskIterations` → 原有Agent扩展保存/同步 |
| | | 旧Agent默认不强写新字段；保存/取消及其他配置保留。`shared/protocol/sync.schema.json`中agentCollaboration可选字段，更新JS/Swift生成器输出；冻结v1记录形状不变。Agent扩展同步由既有同步/编解码测试覆盖；不向Android宣称尚无的扩展同步 |
| iOS入口到结果 | `ios/Melo/ChatStore.swift:send` → `AgentLoopHooks.maxTaskIterations` → `AgentLoop.swift:run` → `SharedAgentCore.swift:PhoneCoreTurn/PhoneGoalState` → 同一agent-core JS → AgentModelTransport.round → AgentLoopOutcome → ChatStore的回复、执行图与completion记录 |
| | | 主/成员共用PhoneRunBudget；检查另计轮、汇报不能调用设备工具，原生授权与目录scope保留。工具/网络/上下文错误沿AgentLoop捕获或抛至ChatStore；Swift37套覆盖超时、压缩、停止、契约、模型传输、配置保存和同步。实体系统授权/后台系统行为未由编译证明 |
| Android入口到结果 | `Editors.kt:AgentsScreen`保存 → `Repository.kt:saveAgent/project` → `ChatEngine.kt:send` → `SharedChatAgent.kt:reply/ReplySession.run/next/checkCandidate/finish` → `SharedCoreTurn.kt` + JS核心 → DeviceAgentClient → journal/Repository记录 |
| | | 轮数存在Agent本机设置，投影时保留；取消、SharedRunBudget和错误仍由原协程路径控制。汇报无工具/原生搜索；失败汇报回退限制文案，取消/预算异常继续传播。JVM/Lint/Debug/Release通过，不等同真机后台/系统权限验收 |
| 成员与技能 | `src/agents/subAgent.js:runSubAgent`、`skillExecutor.js:runSkill` → 同一createCoreTurn/goal/check/report与父级预算 → 返回现有结果信封 |
| | | 检查与汇报也计真实预算，meta.iterations记执行轮。父级与成员能力交集、成功副作用去重保留；主Agent如何处理成员不完整结果按用户要求本轮不改 |

覆盖以状态共享、异常传播和契约消费三条线确定。已读与纳入的关键边界：上述入口与Host、请求上下文/预算、工具执行器、文件安全门/操作token、权限HTTP/UI、Agent配置保存与同步扩展；机械扫描只覆盖H规则，不能证明任务语义。回归关联见生成的功能地图和最终两档summary。

| 覆盖类别 | 可重复证据 |
| --- | --- |
| 零工具任务、文件翻译、纯文字已交付、原始目标不受参考资料污染 | `shared/agent/goal.test.js`、`promptPipeline.test.js`、iOS AgentLoopTests/CodexOAuthTests；真模型文件翻译与计算报告 |
| 轮数、调用次数、预算、取消、无进展、重复副作用、压缩、传输失败 | 共享conformance、Node runner/subAgent/skillExecutor、Swift AgentLoopTests/NetworkTests/CodexOAuthTests/ParityRegressionTests；最终门禁无跳过 |
| 允许一次/本任务/拒绝/长期、双重审批、无审批面、跨任务/Agent/工作区、拒绝后换工具 | `taskPermissions.test.js`、`headlessApproval.test.js`、既有fileSafety/phase2a/phase2d；`taskPermissions.browser.test.js`走真实服务及英文按钮；真模型拒绝后只给建议 |
| 只读命令与副作用 | `readOnlyCommand.test.js`：目录/空目录/隐藏文件/链接、文件读取、复合命令和外部读取仍受门禁、Git配置不能静默执行；原有安全回归 |
| 设置与多端契约 | agentSettings浏览器保存/取消、Swift AgentEdit/Sync/SharedContract、生成物一致性、Android四项；双端实际账号同步另验 |

停止条件：桌面对话/配置写入追到既有原子状态层与回执保存接口，文件副作用追到目录句柄提交和取消守卫；不改SQLite/原子rename/系统调用内部实现，既有并发与竞态测试负责这些不变量。共享契约追到Node、JSCore、Android消费方和生成物，第三方HTTP/模型SDK内部不重审，用传输夹具与真实模型回执验证接口。服务端审批以本机来源验证、实际resolve/拒绝、文件内容为终点。

未覆盖：实体iPhone/Android权限弹窗、系统后台长期存活、真实用户账号跨端同步、生产对话/个人文件（本轮不安装、不使用这些数据）；任意第三方模型稳定性（真模型只验证当前Codex/gpt-6.1-sol）；远程渠道新授权UI、通用任务权限DSL、新增设备工具与成员不完整默认策略（用户暂缓，保持原路径）。桌面任务授权不代替手机系统权限。没有因本轮通过而宣称这些未覆盖项完成。
