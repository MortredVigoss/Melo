# Shared Core 单 Loop 与本地 Workflow Cache：2026-10-28

用户在[真实会话审计](android-session-harness-audit-20261028.md)后明确要求实施。实体手机未参与本轮；原始私人会话、Trace 和录制只保存在本机，不提交、不自动上传。

## 实现后的结构

`Chat -> Shared Core Goal/Turn -> Web / Organizer / phone_action / phone_workflow -> Observation -> 同一 LLM Loop`

- 生产 Android Chat 注册 `phone_action` 与 `phone_workflow`；`DeviceActionSession` 只执行原生操作，不调用模型。Root Chat Job 持有设备 Lease、权限作用域、确认、取消和持久化；旧独立/兼容入口仍保留，生产 Chat 不注册嵌套 `phone_use` Agent。
- Routing 只建议策略，不再用关键词猜出的 requiredTools / dependencies 强制执行。显式编写的 Workflow 前置约束仍由共享 Turn Reducer 校验。Research 按信息缺口决定深度、顺序和来源数量。禁止某个动作，例如“不要关闭导航”，不会隐藏整类手机/网络工具；明确的整类禁令仍有效。
- Core 区分 task / answer / feedback / clarification，以及 response / context / constraint / external_fact / external_effect。回应、引用对话、遵守禁令不需要额外操作；正向外部任务必须有成功执行证据，不能用“未做某事”替代。失败观察可以解释 unavailable，但不能证明完成了外部操作。Checker 获得有界的对话、能力和 Skill 信息；完成后的反馈按 answer 持久化。
- 原生 Receipt 保留跨页面的 applied effects；动作已经执行、后续观察失败，与动作未执行分开。预算内不再每轮删除旧事实。Checker 读取压缩后的可见文本与原生校验结果，避免详细 UI JSON 的开头截断掉真正目标。`finish` 后拒绝继续写操作，必要的只读观察仍可补充证据；已验证 Workflow 不需要重复 finish。
- 原生终态验证后，从真实动作、稳定 Selector 和输入生成 Canonical Workflow，而非缓存被改写的委托段落或 Research 结论。按钮和 IME 提交都能记录；终态实际可见的输入值形成附加参数断言。Open App、显式 Checkpoint 和支持的提交搜索片段还可独立于父任务结果保存。纯坐标或缺少稳定目标的流程仍可能不能缓存。
- 重放前与逐步执行时校验 Scope、权限、脚本 Revision、Fold 姿态、窗口尺寸、App Version 和目标 Freshness。拒绝依赖残留文字的孤立 submit；检查本次已填输入在后续提交/依赖点击前未改变；部分操作已生效的失败 Workflow 不允许从头盲重放。
- 详细录制在本机 Trace；可进入 History / Sync 的 Execution Scene 已去除原生 Screen Tree、输入明细与临时屏幕 ID。当前授权任务仍正常把必要反馈交给模型，这不等于读取或上传 Trace 文件。没有新增 Trace 读取 Tool。

## 真实模型与独立 UI 验证

五个样本均通过生产 ChatEngine 调用已授权的 Bedrock 连接，没有向测试入口指定 Script ID。导航使用 Debug Fixture，不是 Google Maps 或私人地址；浏览器使用真实 Chrome 和受控本机 HTTP 站点。每轮重置并验证初始状态，独立读取实际结束页面；导航还校验保存的 Home、active 状态和额外详情/关闭次数为零。新 runTag 排除陈旧报告。

- 导航：首次 **27.137 秒 / 6 次实际模型请求**；重复 **19.563 秒 / 4 次请求**，本机 Workflow 重放 **2.137 秒**。两次均完成；目的地标签在 Start 后刻意消失，实际效果仍只有选择 Home 和 Start。
- 搜索、提交、打开第一条结果：首次 **59.661 秒 / 12 次实际请求**；重复 **28.295 秒 / 3 次请求**，本机重放 **9.814 秒**。两轮都从已核对的空白页和冷 Chrome 进程开始。
- 把 `shared core` 换成 `agent cache`：**30.084 秒 / 3 次请求**，本机重放 **11.209 秒**；命中同一 Workflow ID，详情页独立校验新查询词。
- 设备执行均无子模型请求。上述总数包含主循环的决策、回答与 Completion Check；Cache Hit 不代表整段对话零 Token，也不是通用 Latency 保证。

样本、失败日志和原生原始 Trace 归档只在 `.tmp/harness-unification-20261028/`、`.tmp/benchmark-unified-v8-*`。保留了失败样本：过宽禁令隐藏工具、UI 截断漏掉查询词、错误地要求失败/禁止事项/回应行提供成功操作证据，以及测试初始页面未重置。失败未被算成有效重放；原始私人手机数据仍在原 Windows 审计目录。完整 Gate 的 `run-7f1Qez` 另发现缩小 Network 禁令时遗漏了直接 URL 的明确拒绝，两项已有 HTTP / URL 测试失败；已修复并增加同一共享策略的成对回归（禁止打开 Maps 不隐藏 Web，禁止访问 URL 不读取链接），专项 16 项通过，再运行最终 Gate。

## 本地 Trace 与后续 Eval

使用 `node scripts/eval-loop-traces.js --trace-dir /绝对路径/单个Trace目录` 检查本机事件完整性和指标；需要机器判断 pass/fail 时，用 `--labels /绝对路径/labels.json` 显式提供期望，不能把模型自报 completed 当作正确 Label。无 Label 的报告为 `unlabeled`，不宣称模型质量通过。

`node scripts/eval-loop-traces.js --write-fixtures .tmp/local-trace-fixtures` 只生成受控本地 Fixture，检查事件/继续执行/目录契约。真实质量证据仍是上面的真实模型任务加独立 UI 校验。命令不调用模型、不上传 Trace，不应将私人 Trace 复制进 Fixture、Git 或 Sync。

## 验证与限制

- Shared Core **240/240**、Android JVM **190/190**；Native 专项 **50/50**。最终 APK 又执行生产 Chat 入口 **6/6**（属于这 50 项，不累计成 56 项），验证工具目录、单 Loop 原生回执、受阻后继续解释、反馈不重开设备、取消和删除对话的生命周期。
- Native 专项覆盖 Accessibility、生产 Chat、Workflow、三种 Provider 协议、Research 交付、重复操作 Guard、Trace 和任务生命周期。
- 用户已拿走 Fold6；本轮未验收 Samsung One UI 8.5 实机布局。API 36 Emulator 通过不等于 Samsung 实机通过。
- Swift / JavaScriptCore 原生测试需要 macOS，当前环境明确跳过；生成的跨引擎 JS 与 Scene Bridge 检查是另一层证据。
- 全仓既有的私有冬季桌宠素材缺失仍保留，未跳过或削弱断言。
- 不自动 Push、开 PR、外部 Review 或上传 Trace。

## 最终本地检查与交付

- 本任务全范围先 plan 后 test；快速档因公共 / 构建边界扩大到全部 552 个 JS 测试文件。结果 `.tmp/test-runs/run-PyqRFL/summary.json`：JS **4653 项 / 4636 通过 / 2 失败 / 15 跳过 / 0 取消**，仅剩私有冬季桌宠素材的两项失败，未绕过。这是本地检测，不宣称全仓 GREEN 或完整发布 Gate 通过。
- 同轮语法、文档链接、生成器 / 依赖、共享渲染与 Android JVM / Lint / Debug / Release 通过。JS 阶段失败使后续阶段未自动执行，因此另跑 `verify-settings-design.mjs` 通过，iOS 脚本的 Renderer / Scene Bridge **4/4** 通过；Swift 明确因 Linux 跳过。
- 修复后 URL/HTTP 专项 **16/16**，失败记录 `run-7f1Qez` 保留。最终 Native 日志 `chat-native-final.log` 为实际 `OK (6 tests)`，不是 Gradle 的零项成功。没有超时隔离重试。
- APK：`Melo-0.10.7-unified-loop-debug.apk`，versionName **0.10.7** / versionCode **31**，**227355895 bytes**。已复制至 Windows 任务目录 `artifacts/`，源文件与复制件 SHA256 一致：`ac2490028265132569827ffe514c94d6ec81c8dff717fd226896b096877d3bf8`。这是本地 Debug 试用包，不含本轮实机验收。
- 结束时停止仅本轮拥有的 Emulator 与两台受控 HTTP Server；原始 Trace、失败记录保留本机。代码、生成资产、测试与文档做本地 Checkpoint，未 Push / 开 PR / 运行外部 Review。
