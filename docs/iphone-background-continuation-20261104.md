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

## 与本地主线的任务分工集成

原修复提交 `cc20f89` 的快速档 `run-6L1pvk` 通过 4,837 项 JS、设置浏览器及 38 套 Swift。首次检出缺少测试私有资产与同平台的原生依赖，另修复了保留旧记录所需的翻译行。随后一次 Swift 编译期间源码发生变化，固定上述提交后重新完成快速档。

集成基准 `b80ade3` 引入了 iPhone 内部成员。任务暂停时也保存成员分工、剩余轮数和交接报告。恢复成员时通过当下的工具目录重新获得权限，只带入该成员的观察。已完成工具可以用原回执作答。测试先由主 Agent 读网页，再由执行成员创建提醒，在写成后模拟断网并读取磁盘格式的检查点。恢复成员取得同一条提醒的回执，未能读取主 Agent 的网页回执，最后将结果交回主 Agent。底层调用计数为一次读网页、一次创建提醒。真实供应商与真机锁屏待验。

## 最终验收

组合源码 `d8c51b2`。从 `b80ade3` 运行 `npm test -- --base b80ade3`，集成档 `run-sjrWAq` 用时 433 秒。4,842 项 JS 全部通过，零跳过、零失败。设置浏览器及 38 套 Swift 通过，未触发隔离复测。合并版重新完成模拟器 Debug、未签名 iPhoneOS Release 构建，以及切到设置、到期、手动停止和结束进程后恢复验收。冷启动探针调用“继续任务”按钮绑定的同一个方法，运行编号相同，提问与回答各一条。专项使用延迟网络夹具。真机外形、长时间锁屏与实际模型连接尚待验收。

本地回执在产品根目录的 `.tmp/iphone-continuity-20261104/combined-evidence/`，含快速档及集成档摘要、`simulator-verification.json` 和 `process-verification.json`。复跑专项目标使用 `python3 ios/scripts/test.py --suite AgentLoopTests --suite ReplyBackgroundTests --skip-js --skip-renderer`。在专用模拟器安装 Debug 构建后，运行 `python3 ios/scripts/verify-background-simulator.py <模拟器 UUID>`。
