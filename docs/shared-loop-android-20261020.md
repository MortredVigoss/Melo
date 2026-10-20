# 共享循环 Android 接入（GitHub #5）

同源 Core 来自主线隔离工作树，预算移植 `153f1d9` / Swift 接入 `fa4afb9` / 守卫移植 `5e977b5` 后的策略接线。本分支不覆盖主线新版 Node/iOS。

- Android `SharedCoreTurn` 消费同一 turn reducer；通用聊天允许 32 个兄弟调用并配对回执，手机操作保持每步一个调用。
- `SharedRunBudget` 将创建、父子收紧、用量、deadline、停止全部交给同一预算实现；Native mutex 持有父对象、原子工具额度预留。资源故障隔离并停止上级预算，模型使用已回报 input usage 或明确的保守请求文本估计。
- 普通聊天、Hosted Search、工具续轮都走预算。Chat→Phone 子任务捕获父预算，真实模型/设备执行前检查；原取消、Accessibility 确认和屏幕终态验证保留。
- JS Core/JSON fixtures 共 98 项通过；61 个相同 conformance fixture 已在主线 JSCore 验过。Android 的预算并发/缺失资源/时间上限、32/33 边界补了回归，等待实际远端 JVM/Lint/Debug/R8/Emulator。
- 主线由 generator 从 `shared/protocol/agent-loop.json` 生成 `shared/agent/loopContract.js`；本分支复制同源文件，构建时核对 JSON 与便携策略一致，禁止手改副本。bundle 源散列和 Android 资源打包仍逐项校验。

这是 CI 验证节点；#5 仍未完成，不关闭、不宣称真机或真实供应商验收。后续结果追加本页。

第二轮：1af5377 的构建/JVM/Lint 已过，模拟器 60/61；唯一失败为导航无证据已正确拒绝但原因变成 PHONE_TASK_FAILED。保留原始拒绝码和实际零动作断言。设备进展计数改由同源 Core 判定，三项回归移到真实 Android JS 引擎；Kotlin 仅提供屏幕内容/像素指纹。预算采用共享原子 admission，图像 base64 不计作文本 token，新增大图回归。106 项共享 JS 与 bundle 一致性通过后推送重跑完整 Android CI；尚未关闭 #5。
