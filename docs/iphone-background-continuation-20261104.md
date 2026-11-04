# iPhone 回复后台续行与中断恢复

基准 0771e46。使用独立检出保留主线正在修改的 ChatStore、AgentLoop 和共享策略。

修改前链路：MeloApp.scenePhase → ChatStore.send / enteredBackground → ReplyBackgroundLifetime.begin → IOSReplyBackground.requestContinued → 系统 BGContinuedProcessingTask。系统控制灵动岛尺寸；原实现每次前台发送都提交系统任务，并在流式更新中重复更新标题。短时授权或系统任务到期时 ChatStore 取消网络任务，loadExecutionRecords 将未终结记录标为 interrupted，ContentView 仅调用 send(retry: true)。

恢复链路覆盖普通回复和工具回合，从 AgentLoop.invokeModel 的工具准入、调用结果、核验到 ChatStore 的原问题、执行记录和本机原子存储。保留同一 run、已完成证据、补充、已消费轮数，并在恢复时重新核对绑定与权限。对结果不明的副作用和媒体生成保留现场并要求核对，用户停止优先。边界止于模型与系统 API，系统后台时长、灵动岛实际外形及实体手机长时锁屏另验。

验收分开检查前台请求数、短时和持续后台授权、过期/迟到回调、同一任务恢复、手动取消、结果不明的外部操作、真模拟器切换及冷启动读取。

## 已接入的行为

- 前台发送只取短时后台保护。将要离开应用时，用当次独立标识申请继续运行并允许系统排队。回到前台释放系统进度界面。迟到的授权与到期回调只属于原来的申请。系统显示短标题 Melo 和本地化阶段，工具完成时推进真实进度。灵动岛的物理尺寸和调度时长由 iOS 决定。
- ChatStore 通过 BackgroundReplyStorage 把检查点原子写入应用私有 ReplyCheckpoints。普通对话恢复原 runID 与 questionID，重新检查 Agent、项目、连接、权限。AgentLoop 继续使用保存的目标、候选答复、工具回执、来源、补充、已用轮数和预算。工具调用按名称及规范化参数识别，恢复时给重复请求返回已有结果。
- 短时保护到期后在返回前台时自动尝试续行。系统持续任务到期可能来自用户在灵动岛取消，此时由“继续任务”明确恢复。进程退出前未收到到期回调时，重新启动后同样可以继续。用户在对话内主动停止会移除检查点。
- 外部写操作派发前先保留执行中标志。已发出的写操作没有确定结果时，或图像生成、视频、团队任务缺少可重放状态时，保留原运行记录，可保存当前进度并结束。图片像素、供应商内部推理和授权不写入恢复上下文；曾经的屏幕内容不等于现在的画面。检查点随完成或删除清理，不进入同步格式。

## 验证与边界

iOS 26.4 iPhone 17 Pro 专用模拟器。运行 `ios/scripts/verify-background-simulator.py`，在无调试器状态切到设置，延迟 12 秒的夹具回答在后台写盘；注入后台时间到期后自动恢复原 runID、两次 active 只生成一次回答；应用内主动停止不会恢复。随后终止 Melo 进程并重新启动，从磁盘续行，同一任务仅一条提问与一条回答。原生 Debug 与未签名 iPhoneOS Release 构建均通过。

独立 Swift 套件验证前台零项持续任务申请，离开后提交一次，重复或迟到的回调不能终止新尝试。AgentLoopTests 使用模拟提醒写入，恢复时传输层再次要求相同的操作，底层计数仍为一次；未确定结果的写入阻止自动重放。系统批准的长时间后台运行、灵动岛在实体设备上的视觉效果及供应商网络中断后的实际计费另验。[Apple 后台任务说明](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask)
