# B 方案实施与交付记录

2026-11-05：用户已选择推荐 B，授权实现、合并 master、推送和本地 Mac 覆盖安装。基准主线 cba47c9；隔离分支 codex/task-evaluation-b-20261105，包含此前 R1–R7 修复 5d1a514。保留账号、数据和其他线程工作，不运行 git pp。

## 修改前执行链路与边界

- 桌面：chatExecutionRunner → prepareNode → invokeModelNode → sharedAgentCore/createCoreTurn → shared/agent/goal 与 taskEvaluation → completion → executionScenes → shared/agent/execution → 任务空间。读取本轮原目标、补充、实际工具观察、预算；合同和实体账本仅写入本轮 goal/task 回执。task_progress 是协调控制调用，不执行外部工具；错误作为可纠正控制结果返回，取消和硬预算继续由宿主处理。
- 路由：internalRouting/startInternalJob → internalMembers/runInternalMembers → runSubAgent → executor → observations → internalHandoff → 主 Agent。沿用能力交集、审批、防重副作用和真实工具信封；改变的是份额及轮数分配，不授予权限。所有成员共用父资源池；不得因多派成员增加全局预算。
- iPhone：AgentLoop/invokeModel → PhoneGoalState/SharedAgentCore → 同一 taskEvaluation → completion/ExecutionScene；后台 cursor 保存 goal/core/observations。Android：SharedChatAgent/Run → SharedCoreTurn 与 goalState → 同一 JS Core → completion/scene。核对工具可见性、控制分支、独立成员轮数、取消/恢复，不能仅接声明。
- 持久化边界：现有 completion.task 增加可选 evaluation，不修改旧账户/同步 v1 结构；旧记录缺失此字段照常显示。共享 presentation 生成评价摘要和候选详情，三个 UI 消费同一结果。新偏好由合同明确给出并受用户目标约束。
- 异常：证据不存在、只有摘要、引用不匹配、硬条件/明确数量不足，不能标记 verified/completed；以可读缺口反馈主 Agent。工具、审批、网络错误维持原传播；合同处理不得吞掉取消。模型评分不是概率，不能覆盖硬门槛。

审计覆盖 shared/agent、Node 执行适配、Swift/Kotlin 宿主及 UI 桥接、共享预算与收尾、模型连接元数据、续行存档、生成器与回归发现。追踪停止于既有原子存储、平台工具执行器及供应商传输边界：内部实现不改，依靠现有契约/集成测试。账号、平台登录和第三方模型内部未改；真实网络/真实模型、Mac 安装和 UI 验收另列证据，不以夹具代替。此次不安装 iPhone。

## 验证计划与状态

共享策略的确定性场景覆盖实体去重、真实证据、硬条件、明确数量、低收益、软目标调整、补充修订、预算/取消。宿主集成计数器证明控制调用不执行外部副作用，三端跑同一契约。quick 与基准集成档按 test:plan 扩大全量，构建共享 bundle 后运行 Swift/Android/浏览器。通过后真实模型隔离探针、Mac 备份/覆盖安装/正常 UI 操作单独验收。当前：实施中，未宣称产品验收完成。

## 已接入（待组合门禁 / 发布验收）

共享 task_progress 控制工具连接 Node、Swift、Kotlin 主循环。版本化 TaskContract 冻结用户修订下的硬条件与明确数量；CandidateLedger 以事件身份/日期/地点或商品型号去重。字段引用必须落在真实成功读取观察，摘要、provider 自述、handoff、拒绝/登录墙不能计为字段证据；语义蕴含仍由独立最终核验负责，不用合法 ID 冒充事实正确。评分只作用于合格条目。单一事实/计算不强制实体配额。最终检查不可省略，20 项只找到 8 项不能 completed。

主界面任务摘要追加发现/核实/主推数；评估记录可展开看缺字段、排除原因、分数理由。Agent 设置三端都有快速/标准/深入偏好，标注“本机”，采用现有本机 replyLanguage 设置的保留规则，旧同步协议不增加字段；该偏好不修改硬数量或总预算。本文明确这是检索范围偏好，深度模式没有暗中启用 C 的多评审费用。

成员初次 4 工具轮，基于具体缺口续派 +2，累计最多 12；共享父预算不再自动加钱。Node 独立子循环，Swift/Kotlin 使用独立 turn 和窄预算，继承成功/不确定副作用防重。iOS cursor 保留主/成员计数与子预算，恢复不重置已花份额。触顶成员保留证据、交付阶段无工具，交回 partial/GOAL_INCOMPLETE；主 Agent 继续评估其余缺口。

首轮证据 `.tmp/task-evaluation-b-20261105/{policy-tests,focused,graph}.log`：36 共享确定性样例及补充宿主门槛测试；完整 Node 图实际执行一次目录读取，控制调用零外部执行，8/20 为 partial、20/20 为 completed。Swift/Android 单项首轮通过，后续 UI 与收尾补充仍待组合运行。模型评分并非概率；36 个真实模型校准计划不冒充已执行，真实探针单列。

## 运行中发现并修正

- 首轮真实模型目录探针暴露短引用误拒：`AUD` 等准确短字段被旧 8 字门槛排除。改为允许引用包含该字段值的短原文，并支持条目级共享引用，避免六个字段重复全文。回归同时锁定虚构引用拒绝和短币种有效，字段验证也拒绝空值。
- 覆盖范围只接受短类别标签；长句硬要求仍进入约束，不用不可满足的全文标签卡住任务。控制调用最多 64 次，连续 3 次无效更新转无工具收尾，防止不消耗工具轮的记账调用空转。
- 首轮组合 run-Dxy7fS：JS 4922/4923，唯一失败为旧“派成员自动扩预算”断言。已改为检验 B 的禁止自动扩预算，同时保留显式授权扩预算的原硬截止传播断言。修正定向回归 45/45。
- 新增 Swift 主循环验收：主轮数为 1 仍能顺序完成研究与计算两个成员；8/20 不能 completed、20/20 可完成，控制调用不执行外部工具，完整评估账本写入回执。
- 覆盖安装前已正常退出旧应用，完整克隆数据和旧应用；5,778 个数据文件、7,607,823,147 字节，源/备份 SHA-256 清单完全一致。备份入口 `.tmp/task-evaluation-b-20261105/backup.json`，未卸载或清空数据。

- 第二轮真实探针：8/20 正确 partial；20/20 虽已核实，最终核验仍只见每条观察前 2,000 字，误称 F13–F20 未读取。已修为核验优先保留从真实观察重新校验的引用及周边上下文，仍守总证据预算；普通核验和上限交付共用。新增后半页/伪造引用回归，原始失败回执保留在 before-reviewer-fix。

## 最终候选 201b9c9 的门禁

- 修正后快速档 run-WMPGwg：JS 4927/4927，零失败/取消/跳过；Android JVM、Lint、Debug、Release、设置浏览器、38 组 Swift 全通过（所有测试重跑，仅命中编译缓存）。
- 完整 iPhone Release 无签名构建成功：`.tmp/task-evaluation-b-20261105/ios-build.log`。不等于真机安装/使用验收。
- 基准集成 `npm test -- --base cba47c9` 运行中；覆盖 5d1a514 的 R1–R7 和本次 B，主线/远端在合并前重新核对，无其他 WIP。
- 真实模型探针使用用户既有模型连接，只传合成目录，不访问真实聊天。8 项目录取得 8/20 partial；20 项目录的后半页审核问题已修，短截止探针触顶记录保留，最终复验使用 10 分钟探针截止（不修改产品预算）。批量 36 轮真实质量校准尚未执行，不宣称已完成。

- 最终真实探针还发现审核返回格式与宿主要求不一致：模型三次明确“20/20 已达标”，但旧 JSON 格式未列 evaluationValid，宿主按缺字段拒绝。已在返回格式和规则中明确两个必填布尔字段（evaluationValid / needsEvaluation），仍由独立核验决定真假，不改为默认放行。修正后重新真实验收与门禁。

## 合并前结论

最终产品候选 **2cb936b**（B 主体 201b9c9，含 R1–R7 5d1a514）。两档均全绿：快速 `.tmp/test-runs/run-BdkSW7/summary.json`，基准 cba47c9 集成 `.tmp/test-runs/run-b9dLLp/summary.json`。每档 JS 4927/4927、零失败/取消/跳过/复测；Swift 38 组全部实际运行，Android JVM/Lint/Debug/Release、设置浏览器与共享渲染通过，无平台跳过。iPhone 完整 Release 无签名构建通过，产物内 agent-core.js 哈希与最终核心一致；未安装 iPhone。

真实连接 gpt-6.1-sol 在隔离数据上读取封闭合成目录：只有 8 项时返回实际清单与缺 12 项，partial；最终 20 项样例仅一次读取，142 秒，20/20、零缺口、completed，实际答复逐项列出了型号/地区/价格/可购状态。历史失败与修复见上，不能将这些受控样例外推为开放网络整体推荐质量。专项目录内 live-8.json / live-20.json 为回执。36 次真实任务人工校准另计。
