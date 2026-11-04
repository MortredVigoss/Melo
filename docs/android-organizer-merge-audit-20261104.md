# Android Organizer 合并与缺陷审计（2026-11-04）

目标为本机 master。合并前 master 为 601aed1，贡献分支为 fed7c134，公共祖先为 248364b9。先在独立检出组合两端，再验证相同提交并快进 master。

## 修改前的执行链路与边界

- Android 聊天从 ChatEngine.send 进入 SharedChatAgent.reply，再经 SharedCoreTurn 和共享 turn.advanceTurn 判定工作、核验、到顶汇报与工具准入。phone_action / phone_workflow 进入 DeviceActionSession 与 PhoneWorkflowHost.invoke。工具结果回到同一对话和 goal.reviewGoal。核对模型错误、取消、工作区权限、成功效果和失效脚本，跟到 Android journal 与最终回复。
- 日程从 Organizer 页面或共享 organizer 命令进入 OrganizerRepository.command/update 和本机 Room。系统日历与 ICS 经过 CalendarProvider.read、refresh 和来源权限。ReminderEngine.reconcile 调度，ReminderReceiver.onReceive 经 claim/deliverIfCurrent/acknowledge 更新送达状态。范围止于 OS 闹钟、通知与存储接口，系统调度和真机厂商行为需单列。
- Node 的 chatExecutionRunner.runChatAgentExecutionGraph 经 invokeModelNode、sharedAgentCore、goal/turn，连到桌面工具执行器、审批和工作区预算。iOS 的 ChatStore.send 经 AgentLoop.run、SharedAgentCore 与同一份共享策略。检查用于同步状态的生成物、模型重试、检查与汇报无工具、成功与失败证据、跨端 Trace 对异常与隐私边界的影响。
- 依据 architecture/modules.json、scope 和两支源码/差异选组。优先审计语义冲突、日程输入与网络边界、设备动作证据、日志与模型传输。真实个人数据、物理设备、系统通知投递和第三方模型服务不在本次本地合并门禁内。

## 发现与修正

| 级别 | 可触发的问题 | 实现与验证入口 |
| --- | --- | --- |
| 高 | 系统日历授权撤回后，已排程提醒仍可从缓存显示标题，聊天日程查询仍返回已撤权来源的名称 | Android 的 Calendar 列表、ReminderEngine.desired、OrganizerRepository.claim/deliverIfCurrent 和锁屏显示在使用数据时复查权限。通知投递失败或计划失效时不再标为 posted。OrganizerTest 覆盖撤权后隐藏系统来源和提醒、保留获准的 ICS 来源 |
| 高 | 声称已经完成本机操作的回答，可能用 self_contained 绕过检查器自己标出的 external_effect 要求 | 修正 shared/agent/goal.js 的 reviewGoal。测试修复前返回 deliver，修复后为 partial，保留兼容旧核验格式的纯文字交付 |
| 高 | 小上下文模型在长对话压缩后，加入分支的新工具说明会误报 CONTEXT_BUDGET_EXCEEDED 或丢失一条已选历史 | fitRequestContext 按实际传输布局计入用户消息包裹文本和标记，prepareNode 在本轮完成压缩时优先保留能放入窗口的尾部。原 master 对照 2/2，合并首轮两例失败，修复后相同断言及上下文/模型专项 47/47 |
| 中 | 诊断目录达到容量上限时，桌面先删最新记录；Android 与 iOS 只限制单次记录，完成记录一直累积 | 三端按同一纯函数从旧到新清理完成记录，固定与活动记录保留。Node 目录级回归修复前保留 old 却删除 new，Swift 本地目录验证过期与固定记录。Swift 夹具隔离到临时目录 |
| 中 | 已响铃的短日程被推迟 10 分钟时，原日程已结束，重新调度会把延期提醒丢掉 | ReminderEngine.desired 按已送达的具体发生时间、当前日程与版本重建延期提醒。已编辑和删除的日程不会复活。新增 JVM 测试先复现空计划，再验证推迟和接收后的计划、版本失效 |
| 低 | 从根目录搬到 docs/handoffs 的进度归档仍用原来的相对路径，导致文档门禁失败 | 修复四处引用并实际运行文档链接检查 |

21 个冲突文件涉及三端主循环、生成物、公开媒体检索及文档。逐段保留主线可设的执行预算与单独的无工具检查/收尾、分支的原生动作回执与 Workflow 目录。桌面原生搜索的计数改由带 Trace 的共享状态转移入口处理。两边的测试和历史文档都在。保留原 Brave 默认端点配置，对解析后的端点统一做合法性检查。
