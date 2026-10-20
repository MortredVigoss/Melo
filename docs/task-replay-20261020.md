# 最小任务回放与评测（GitHub #14）

## 约定

`shared/agent/fixtures/tasks.json` 是公开合成任务集；`taskReplay.js` 是三端同一 Runner，直接调用生产 Core 的路由、循环许可、预算、完成证据与 SessionEvent 投影；`taskScore.js` 是显式预期评分器。通过 JSON `taskReplay` 操作进入 Node、JavaScriptCore 和 Android JavaScriptSandbox，无 Host IO、凭证或真实模型。

11 项覆盖自然餐厅搜索、重试且禁止手机、有效/未知工具混合批次、重复 ID 原子拒绝、重复错误停止、搜索摘要不冒充原文、tool ok 不冒充终态、取消后迟到调用、输入 token/时间/工具预算。工具只有 Core 许可且预算允许才记作 fixture 执行。每个任务逐项检查工具名单、拒绝码、来源、终态、最大重复次数、模型轮数、输入/输出 token 与时间。

`tasks.expected.json` 保存完整规范化事件，所有端与其比较；它不能替代 tasks.json 中手写的语义预期。评分失败时 CLI 不写新 golden，测试覆盖篡改来源、成本、工具、重复事件与缺失终态；失败 CLI 非零退出。`--write-golden` 仅显式更新，正常验证不会重写预期。

## 使用

- `npm run eval:tasks -- --out /tmp/tasks-node.json`
- `npm run eval:tasks -- --compare .tmp/agent-task-eval-jscore.json`
- Android CI 从隔离 emulator 拉取 `.tmp/agent-task-eval-android.json`，同一命令比较。
- 报告包含 dataset 与 Core bundle SHA256；不同任务/版本不能混比。原生测试逐项断言 golden，再导出报告；CI 再与 Node 逐字段比较事件、回执及成本。

`fixtureInputTokens` / `fixtureOutputTokens` 是脚本声明值；`simulatedElapsedMs` 是显式虚拟时间（当前工具夹具即时返回，模型耗时由 tape 指定）。`replayElapsedMs` 仅诊断各 Host 的 Runner 实际运行时间，不当模型延迟，也不参与跨端相等比较。这 11 项通过率不是 LLM 任务成功率，不证明真实搜索服务、设备工具或人类偏好质量；真实 LLM 评测必须另外标记数据/模型/供应商/真实 usage，并单独报告，当前 Runner 拒绝 real-llm 类型。

## 回放发现的修正

混合批次里被明确拒绝、未执行的未知工具，曾使研究被推断成“研究+操作”，继而误报缺少操作终态。完成类型现在排除 `executed === false` 的操作推断；实际执行失败或执行情况未知仍保守要求终态。新增独立回归及混合任务覆盖，三端共用修正。

## 验证状态

Node 专项 25/25；11 项任务在 Node/独立 VM/JavaScriptCore 的事件与指标一致；89 个原有 Core conformance 和 Swift 数据桥通过。Android、完整日常及跨平台 CI 待最终回执。未触碰真实账号、用户状态或安装应用；不运行 git pp。

Android 首轮 39382785730：JVM/Lint/Debug/R8 与 73/73 emulator 全过，失败在测试完成后导出报告，APK 已被 Gradle 卸载。改用 AndroidX 所用的 [additionalTestOutputFile 协议](https://android.googlesource.com/platform/frameworks/support/+/207170cd913e67b742f91814b84fd680bfd35c39/benchmark/benchmark-common/src/main/java/androidx/benchmark/InstrumentationResults.kt)，由 AGP 卸载前复制；每轮 UUID 避免误取旧报告。收集器拒绝缺失/重复/失败报告，第二轮 CI 待验。
