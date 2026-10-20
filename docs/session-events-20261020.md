# Session Events 实施约定（GitHub #8）

复用已经保存的 ExecutionScene、ToolInvocationRecord 与手机 ExecutionRecord，定义同源的 turn / model / tool / terminal 投影。事件 ID 由 run、操作 ID 与阶段决定，不依赖供应商、数组位置或当前时间；回看和恢复只读记录，不重新调用工具。

规范事件只包含白名单身份、状态、时间、工具名、参数摘要哈希、错误码和目标回执。原始参数、正文、提示词、密钥与 opaque reasoning 不进入事件；详细内容仍由已有脱敏记录持有。运行中断且没有结果的工具明确为 unknown，取消不能证明副作用没有发生。旧记录缺信息保持缺失，不补造开始时间或成功回执。

桌面和手机共用事件与模型历史投影。执行详情显示相同事件 ID；下一轮的有限历史携带同一 ID 和结果状态。按现有上下文开关和预算取最近记录，保持冻结的 v1 同步协议，不迁移全部存储。

验收覆盖同一调用 ID 跨轮、供应商切换、取消/重启、未知副作用、重复回看、脱敏白名单、落盘恢复及三个运行引擎。工具计数器证明回看/构建历史零执行；真实设备和真实模型不作为夹具证据。

已完成 Node 三协议真实 localhost 请求、落盘后 UI/模型同 ID、未知副作用、跨 run/iteration/member 去重、白名单与无动作回看专项 160/160。首轮跨引擎检查捕获 undefined 字段的 JSON 差异，已在投影入口省略未定义字段；Responses 夹具改为该 API 所需的 completed SSE，保留断言。最终整批日常（基准 4c3ebb5）4314/4314 JS、5 项生成预检、35 Swift 全过，551.2 秒；86 个同源 fixture 在 JSCore 通过，iPhone simulator BUILD SUCCEEDED。Android 5f3d834 的独立验证 run 39366995591 全过（JVM/Lint/Debug/R8/模拟器），已推正式手机分支；主线 a2551cf 已推，#8 已关闭。Android 原有有界脱敏执行详情保留，额外引用规范事件 ID，不以此重发工具调用。

完整日常首次检出旧 trace 测试禁止在所有请求文本出现调用 ID；规范事件需要该身份。保留 legacy trace 不携带调用 ID 的原断言，补充规范 ID 出现且递归检查无 function_call/tool_use 等协议对象，证明不重发动作。修正后专项 17/17 与完整日常全部通过。证据：`.tmp/github-issues-fix-20261020/events-{targeted-final,daily-final,ios-build,swift}.log`。

### Android / Mobile 分支补充（整合时保留）

已完成 Node 三协议真实 localhost 请求、落盘后 UI/模型同 ID、未知副作用、跨 run/iteration/member 去重、白名单与无动作回看专项 160/160。首轮跨引擎检查捕获 undefined 字段的 JSON 差异，已在投影入口省略未定义字段；Responses 夹具改为该 API 所需的 completed SSE，保留断言。Swift/Android/整批日常仍待验。Android 原有有界脱敏执行详情保留，额外引用规范事件 ID，不以此重发工具调用。
