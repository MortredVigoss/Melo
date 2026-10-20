# 最小任务回放与评测（GitHub #14）

## 约定

`shared/agent/fixtures/tasks.json` 是公开合成任务集；`taskReplay.js` 是三端同一 Runner，直接调用生产 Core 的路由、循环许可、预算、完成证据与 SessionEvent 投影；`taskScore.js` 是显式预期评分器。通过 JSON `taskReplay` 操作进入 Node、JavaScriptCore 和 Android JavaScriptSandbox，无 Host IO、凭证或真实模型。

11 项覆盖自然餐厅搜索、重试且禁止手机、有效/未知工具混合批次、重复 ID 原子拒绝、重复错误停止、搜索摘要不冒充原文、tool ok 不冒充终态、取消后迟到调用、输入 token/时间/工具预算。工具只有 Core 许可且预算允许才记作 fixture 执行。每个任务逐项检查工具名单、拒绝码、来源、终态、最大重复次数、模型轮数、输入/输出 token 与时间。

`tasks.expected.json` 保存完整规范化事件，所有端与其比较；它不能替代 tasks.json 中手写的语义预期。评分失败时 CLI 不写新 golden，测试覆盖篡改来源、成本、工具、重复事件与缺失终态；失败 CLI 非零退出。`--write-golden` 仅显式更新，正常验证不会重写预期。

## 使用

- `npm run eval:tasks -- --out /tmp/tasks-node.json`
- `npm run eval:tasks -- --compare .tmp/agent-task-eval-jscore.json`
- Android 隔离 emulator 在测试存活期间通过 ADB reverse 向独立 localhost 收集端提交实际报告；保存为 `.tmp/agent-task-eval-android.json` 后用同一命令比较。收集端核对本轮 UUID、大小与成功状态，拒绝重复报告，测试结束即关闭。
- 报告包含 dataset 与 Core bundle SHA256；不同任务/版本不能混比。原生测试逐项断言 golden，再导出报告；CI 再与 Node 逐字段比较事件、回执及成本。

`fixtureInputTokens` / `fixtureOutputTokens` 是脚本声明值；`simulatedElapsedMs` 是显式虚拟时间（当前工具夹具即时返回，模型耗时由 tape 指定）。`replayElapsedMs` 仅诊断各 Host 的 Runner 实际运行时间，不当模型延迟，也不参与跨端相等比较。这 11 项通过率不是 LLM 任务成功率，不证明真实搜索服务、设备工具或人类偏好质量；真实 LLM 评测必须另外标记数据/模型/供应商/真实 usage，并单独报告，当前 Runner 拒绝 real-llm 类型。

## 回放发现的修正

混合批次里被明确拒绝、未执行的未知工具，曾使研究被推断成“研究+操作”，继而误报缺少操作终态。完成类型现在排除 `executed === false` 的操作推断；实际执行失败或执行情况未知仍保守要求终态。新增独立回归及混合任务覆盖，三端共用修正。

## 验证状态

Node 专项 25/25；11 项任务在 Node/独立 VM/JavaScriptCore 的事件与指标一致；89 个原有 Core conformance 和 Swift 数据桥通过。Android、完整日常及跨平台 CI 待最终回执。未触碰真实账号、用户状态或安装应用；不运行 git pp。

集成中间结果：首次预检指出新测试读取 fixture/bundle 未登记，已补隐式依赖；第二次全 JS 有一项旧图片预览断言竞态（naturalWidth 已有但 load 缩放尚未完成），单跑通过。将等待条件改为实际完成 load/fit 初始化，原尺寸、下载、缩放断言全部保留；随后重跑完整集成。

主线最终日常：基于 6a5a171，4356/4356 JS、35/35 Swift，零跳过，151.5 秒。Node/JavaScriptCore 11 项报告完全一致。Android 首轮 39382785730 构建通过，emulator 失败待定位；不是最终跨端通过。

主线远端回执：`aa83db2` 的 [CI 39391968956](https://github.com/MortredVigoss/Melo/actions/runs/39391968956) Linux Node/HTTP/browser 与 macOS Swift 全绿；下载后复核 Linux Node、macOS Node、JavaScriptCore 三份报告，与本机 Node 的 11 项事件、回执及 fixture 成本完全一致。Core SHA256：`0824f40c28ec965d1de450a14763709d31e96320b47b20ef69ada3894792ff68`。Android 第二轮 39392779228 待验。

Android 最终待验修正：`a11183b` / CI 39394944470 使用运行期 localhost 上报。前两轮各 73/73 用例通过，分别因卸载后缓存不可读、AGP 未复制附加文件而 gate 失败；两次失败均保留，未用旧报告替代。新的收集器真实 HTTP 回归 2/2 通过，最终原生 CI 等待中。

## 最终验收

- 主线代码 `aa83db2`：本地完整日常 4356/4356 JS、35/35 Swift；[Linux/macOS CI 39391968956](https://github.com/MortredVigoss/Melo/actions/runs/39391968956) 全绿。
- 手机代码 `a11183b`：[Android CI 39394944470](https://github.com/MortredVigoss/Melo/actions/runs/39394944470) Core、真实 HTTP 收集测试、JVM、Lint、Debug/R8、73/73 emulator 与报告比较全部通过，零 emulator 跳过。已下载核对 XML 和带本轮 UUID 的实际报告。
- 本机再次将 Android JavaScriptSandbox、CI JavaScriptCore、Linux Node 的报告与本机 Node 逐字段比较：11 项任务的事件、证据、终态和 fixture 成本全部一致，bundle/data SHA256 相同。
- 前两轮报告导出失败、图片测试时序失败均保留记录；未删用例、降低断言或用旧报告替代。没有真实 LLM 成功率、实体设备、安装升级或完整安装型发布 gate 声明。

用户已授权每条测试通过后推送并关闭。本项验证完成，正式分支按该授权发布。
