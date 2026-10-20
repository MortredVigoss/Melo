# 通用循环实施约定（GitHub #5，2026-10-20）

用户已授权依次完成 GitHub 工作项。此文先明确迁移边界，接现有架构计划，不另换整个 Agent 框架。开始代码迁移前完成 #9/#2；每条只在实际验收后关闭。

## 当前事实

主线 Node 主聊天、subAgent、skillExecutor 与 Swift AgentLoop 分别控制模型/工具轮次；同用 JSON 契约、预算和工具信封，但实现尚未同源。手机分支已有 `shared/agent/turn.js` 生产 reducer、Node wrapper、Kotlin SharedCoreTurn 与 JS 沙盒；Swift SharedAgentCore 仅桥和一致性测试，尚未接生产 AgentLoop。不能用已有 bundle 或 Git 合并当作 iPhone 已完成。

## 状态和接口

| 输入 / 状态 | 同源 Core 决策 | Host 效果与现有保障 |
| --- | --- | --- |
| start：runId、turnId、允许工具、上级约束、限额、单调时钟 | 建立轮次身份、能力交集、预算与空待办 | 从已解析 Agent 和执行上下文提供，模型不能填写授权 |
| request / usage | 判断是否能发下一次请求，累计用量与终止条件 | HTTP 协议、父预算记账、上下文压缩、补充消息、超时/取消真正传至调用 |
| calls：稳定调用 ID、名称和参数 | 批次数量、重复 ID、能力许可、重复失败/无进展边界 | 实际工具解析、schema/动作级能力、审批、OS 和并行调度；Core 不能授予执行器拒绝的能力 |
| result：调用 ID、明确 ok、错误、进展凭证 | 配对待办、记录失败和进展，完成整批后决定是否继续 | 保存工具记录并回传原 provider 格式；不丢已有结果 |
| complete / feedback | 判断待执行项是否清空和证据状态 | 原有来源、最终回答、核实流程保留；目标完成证据在 #6 收口 |
| cancel / deadline / exhausted | 终态不可再许可新动作，迟到结果不再推进 | Host 取消在途 I/O；已执行副作用记录保留，绝不自动重放 |

内部状态包含 running、终止原因、已请求轮数、已配对调用、进展和用量。UI 的 completed/partial/blocked/cancelled 与旧协议兼容映射；不把工具 ok 直接定义成目标 achieved（#6）。

## 分步实现与回滚

1. 从手机分支逐字引入便携 Core、bundle 生成器、Node/Swift 桥及现有 conformance fixtures；独立 `byte-for-byte port` 提交。不覆盖主线新版上下文、模型协议、图片、能力或 UI；不整体合并旧手机分支。
2. 同源化剩余通用预算/重复与终止决策，迁移 Node 主聊天、子 Agent、skill 的生产路径，保留现有 executor 最终授权。Host 仅负责真实副作用、记录投影和协议适配。
3. Swift 生产 AgentLoop 调用同一个已校验 JS bundle；Kotlin 使用同一事件、许可和预算规则。Swift 团队成员本来走同一 AgentLoop，继续继承父预算与能力。
4. 同一确定性事件集在 Node、JSCore、Android JS 引擎核对许可、用量、终态；再分别跑真实 Host 的受控模型 HTTP 与工具计数器。生产 bundle 散列/源文件一致性成为门禁。

## 必须保留的回归

- 单轮 32 个合法调用边界（Mobile A05 已修复），33 个拒绝；未知调用仍得到配对错误，不能丢弃合法兄弟。
- 权限被禁止时实际工具计数为零，委派/skill 不能扩大权限，审批等待和取消行为保留。
- 重复失败、重复成功但无新证据、轮次、输入预算、成员预算、deadline 有界；失败后更换合法策略仍可推进。
- 补充消息、上下文超限一次压缩、provider 原始工具回执、图片/网页证据、MCP 名称映射与脱敏不丢失。
- 终态之后迟到事件不再请求模型/工具；重启回看不会执行副作用。
- 真实模型效果、真机长后台另列，确定性夹具不冒充这些证据。

第一阶段进展：从手机分支 `9522cb9` 逐字引入 25 个 Core/桥/bundle 文件；`replyDocument.js` 仅追加该分支既有展示函数，原主线前缀逐字保留。打包资源、测试发现和代码地图接线单列。生产主循环尚未接入，#5 仍打开。

验证：`core-port-js.log` 84/84；`core-port-swift.log` 49 个相同 conformance fixtures 在真实 JSCore 通过，另含资源散列、隔离和 JSON 数据注入边界。`core-port-wiring-final.log` 测试发现/代码地图与 gate 夹具 11/11。完整日常正在运行；逐文件原样比对记录在 `.tmp/github-issues-fix-20261020/core-port-files.json`。

第一阶段最终：`core-port-daily-final.log` 日常 **4185/4185 JS**、零跳过，语法、文档、两项浏览器、共享渲染及 **33 组 Swift** 全通过（151.8 秒）。首轮三项 gate 失败已按新增目录补齐源码读取登记及隔离仓库夹具，不跳过测试。25 个引入文件再次与 `9522cb9` 的 blob 逐字比对全等。准备独立移植提交，生产迁移仍待实施。


第二阶段 A：`src/runtime/runBudget.js` 的实现逐字移到 `shared/agent/runBudget.js`（唯一代码差异是契约 import 路径）；原入口只重导出原公共符号。`generate-agent-loop-contract.js` 同时从现有 JSON 生成便携、深冻结的 `loopContract.js`，不另维护默认值。Node 现有调用已使用这份实现；Swift/Kotlin 生产仍待桥接。`core-budget-port-targeted.log` 21/21，包含祖先记账、限额收紧、deadline、计划扩容及契约；完整日常进行中。

后续接线注意：桌面 web_search/fetch_url 与便携 Core 的最小工具 schema 不同，迁移必须保留现行字段/NULL/32 调用边界，不能因为碰巧同名被旧便携 schema 拒绝。Swift 的 JS bundle 初始化失败必须明确停止，测试资源通过专门测试入口注入，不能在产品里从工作目录加载脚本。Host 保留真实取消、并行调度、父级记账和审批；决策改从同源代码取结果。

第二阶段 A 最终：`core-budget-port-daily.log` 日常 JS 4185/4185、33 组 Swift、浏览器/语法/文档全通过（174.5 秒）；未改变用户数据或应用安装。此预算实现移植独立提交，随后再改 Host 接口。

第二阶段 B：已新增预算 JSON 操作，Swift PhoneRunBudget 生产调用同源创建/截止/父子收紧/记账/停止逻辑，Native 仍拥有锁与父预算。bundle 只从签名应用资源加载，测试目录回退受 MELO_TEST 编译标志限制；缺失/损坏使当前及祖先预算停止。预算桥与 Core 57/57；Swift 3 组（契约 130 fixture、AgentLoop、资源缺失零调用）通过。证据 `core-budget-bridge.log`、`core-swift-budget-final.log`，完整日常进行中。

第二阶段 B 最终：`core-budget-swift-daily.log` 日常 JS 4187/4187、34 组 Swift、浏览器/语法/文档全通过，431.8 秒；未安装或访问用户数据。

重复守卫移植：原 repeatGuard 整段逐字移入 shared/agent，仅改契约 import，原 Node 入口重导出。暂不加入 bundle（原 SHA1 仍为 Node crypto）；下一提交才拆开 Host 指纹与便携状态。逐字校验、契约/守卫 12/12、真实子 Agent/技能 32/32 通过；没有混入行为修改。

生产接线 WIP：Node 主聊天/子 Agent/技能与 Swift AgentLoop 已接 turn reducer；旧 Host 只保留协议、schema、真实执行/审批/取消、上下文和记录。重复守卫可在便携运行时执行；Core 同时约束连续整批失败与重复成功无进展。统一默认 10 轮 / 32 调用 / 20 分钟；成员/技能/设备可收紧各自限额。Host 提供实际 schema 边界，保留桌面 NULL 参数与工具扩展字段。

验证：共享 JS 98/98，JSCore 61 相同 fixture；生产主聊天真实 HTTP 与子 Agent/技能 45/45；Swift 3 组包含有效 32 / 无副作用 33、重复失败两次实际执行、无进展六轮、缺失资源零请求、原取消/压缩/补充/预算/核实。首轮全 JS 4202/4203 唯一旧无进展夹具仍期待 10 轮，按新策略改断言为 6 轮且保留不得返回原工具块；完整日常重跑中。

手机分支 1af5377 已推送 CI：与主线相同 Core/bundle/61 fixture，Kotlin Native 持有共享预算父对象及 mutex，工具额度原子预留，模型使用实际 usage 或请求文本估计；Chat→Phone 预算传递；通用聊天 32 调用与配对错误、屏幕操作单步/终态验证保留。Android 需实际 JVM/Lint/APK/Emulator 结果，不以 JS 专项代替。主线 iOS simulator 编译进行中，不安装、不读取真实账号数据。

生产接线主线最终：`core-loop-daily-final.log` 完整日常 JS 4203/4203、零跳过，34 组 Swift、浏览器/语法/文档全部通过（471.4 秒）。Network/Codex OAuth 的十轮夹具改为每轮带新结果，继续锁定十轮上限；另有真实 Host 无进展六轮回归。`core-loop-ios-build.log` simulator Debug 双架构编译成功，app 中实际含与主线相同 Core/manifest；未签名安装。Android 1af5377 的 JVM/Lint/Debug/R8 已过，Emulator 运行中。最终验收继续核对设备进展策略及并发预算额度预留，不提前关闭。

收尾第二轮：共享预算新增原子 admission；Swift 同一锁内检查并预留祖先额度，32 个并发子预算争最后一个名额仅一个获准。设备进展也收进 Core，Kotlin 只散列屏幕内容/像素，观察成功不能清除失败动作。新增 7 个跨引擎 fixture（共 68），共享 JS 106/106；Swift AgentLoop/契约两组通过。完整日常再次执行中。

Android 首轮 60/61：导航无证据实际零动作，但接线把具体拒绝码改成笼统 PHONE_TASK_FAILED；已保留具体原因和原断言。截图输入估计不再把 base64 字节当成文本 token。第二轮提交 795f2fc，CI 39356581051 运行中；DeviceProgress 的三项策略测试已移至真实 Android Core 引擎，JVM 仍验证屏幕指纹。用户账号、安装、数据均未改。

第二轮日常 JS 4210/4211：失败为 #2 原真实 HTTP 并发/重启夹具抓到冷启动 journal_mode 先于 busy_timeout 的窗口，与 Core 逻辑无关但不可跳过。已重新打开 #2，确定性双路径启动锁回归红转绿；主线全日常重跑。

第二轮主线最终：`core-loop-and-cold-lock-daily.log` 日常 JS 4213/4213、零跳过，34 组 Swift（实际 JSCore 68 fixture）、浏览器/语法/文档全部通过，433.7 秒。`core-loop-admission-ios-build.log` 再次 simulator Debug 编译成功。#2 启动锁补充在 Mac/Linux 各 5/5（Linux 8.2 秒）通过。Android 795f2fc 已过 JVM/Lint/Debug/R8，模拟器尚待结束；正式推送关闭仍等实际结果。
