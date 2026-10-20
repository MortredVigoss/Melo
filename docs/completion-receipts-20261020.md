# 完成回执实施约定（GitHub #6，2026-10-20）

承接 #5 共享 Core。修复范围是可观察的完成语义，不增加每轮 LLM Judge，也不把词语匹配声称为事实核实。#5 全平台验证完成后实施本项。

## 合同

- 执行状态（是否还在运行）与任务回执分开。回执明确 completed / partial / blocked / cancelled / budget_exhausted，记录原因、任务类型、证据引用及目标是否得到实际验证。
- 普通问答/创作可以直接交付。涉及外部操作时，工具 ok 只说明那一步执行成功；没有 Host 核验的终态收据，目标保持 unverified。
- 公开研究须有本轮实际返回、与请求相关的来源及已读状态；空搜索、无关结果、仅摘要、模型虚构引用不能证明研究完成。匹配不充分时保留 partial/blocked，不追加无限核实轮次。
- 手机导航继续使用 DeviceCompletion 的最近画面、目标包名/文本与再次观察核验。仅接受 Host 核验的回执，不相信模型自行填入的 achieved。
- 终止后保留已经执行的动作、来源和未完成原因；不自动重放副作用。

## 接线与验收

1. 同源 Core 定义回执计算和边界 fixtures：无工具回答、空/无关/未读/已读来源、未知操作结果、受验证目标、取消与各类预算。
2. Node 主聊天、成员和技能把真实工具/Provider 观察传入；消息元数据及执行面板保留回执。Swift AgentLoop/ModelReply/ExecutionRecord、Kotlin SharedChatAgent/设备流程消费同一策略，保持旧记录可读取。
3. 本地真实 HTTP 与工具计数器证明拒绝不执行、最终无调用时诚实停止；三引擎执行相同 fixtures。UI 展示完成依据和缺口，不把响应结束显示成已验证达成目标。
4. 保留已有能力、审批、取消、上下文、来源、图片与账号数据回归；真机/真实模型的外部效果另列，不以受控测试代替。

## 实施检查点

- Node 主聊天、成员、技能已接 `shared/agent/completion.js`；Swift AgentLoop/ModelReply/ExecutionRecord 和 Android SharedChatAgent 使用同一策略。执行结束与任务结果分别存储，旧记录没有回执时不补造证据。
- 研究判断只检查本轮实际读取的正文和最终引用：不使用工具回显的 query、标题或摘要充当正文。词语覆盖是保守的来源匹配，不能验证事实真伪、资料时效或全部论点；跨语言、同义改写无法充分匹配时保持未知。正文只在本轮内存中保留，回执保存证据 ID 与有限标签。
- Android 保留 DeviceCompletion 的实际画面核验，仅接受 Host 返回的 visible_facts、run ID 和原始目标。成功完成较小子任务不能证明更宽泛的用户任务完成；不追加无限核查。
- UI 共用回执摘要；成员原有执行/交接状态仍表示成员是否返回，另展示目标回执。Swift 成员通过已有执行阶段保留回执，桌面成员通过交接记录保留。
- 目前通过：Node/Core/真实 localhost 模型 HTTP 115/115；JSCore 同一组 84 fixture；Swift AgentLoop、Execution 三组通过；另已验证执行记录落盘回读与共享桌面/iPhone DOM 展示。完整日常、iOS 编译、Android JVM/模拟器正在验证；#6 尚未关闭。
- 分支边界：主线负责当前 Node/iPhone；手机分支负责 Android 和同源 Core/共享展示资源，不整体合并手机分支内旧 Node/iPhone 源码。没有改用户配置、账号、真实数据库或安装应用。
