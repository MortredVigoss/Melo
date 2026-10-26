# 剩余审计修复实施 · 2026-10-26

按用户给定的 0 → 1 → 2 → 3 → 4 → 5 顺序执行；每批独立本地分支，快速档按全部改动路径，合并前集成档一次。架构批次 6 先独立设计。语言使用 C 混合方案。H5 集成端点与 H20 TODO 本轮保留。

## 批次 0：规则与 CI 门禁

基准 `cce1e64`，分支 `codex/audit-0-20261026`。无产品运行时修改。

| 规则 | 校准前 | 校准后 | 原因 |
| --- | --- | --- | --- |
| H1 | 22 | 8 | 状态 / CLI / 后端名称逐 token 排除；只对 H1 排除 iOS 自检 |
| H3 | 17 | 13 | 排除发布测试端口；原生壳仅允许唯一数值回退定义，重复初始化仍报 |
| H18 | 56 | 38 | 主题定义文件排除，使用处仍扫描 |
| H19 | 34 | 18 | 扫描回退、参数默认、变量初始化；不扫描选项和语言映射 |

`--baseline` 仍输出可读增量；加 `--check --out .tmp/audit` 作为门禁，任何新增出现都失败。同一违规行复制一次也会失败，关闭旧命中不能抵消新增。CI 独立 audit job 无需安装依赖，先比本分支基线，再比 PR merge-base / push 前版本；防止同 PR 抬高基线放行。手动 CI 比仓库当前基线；PR / push 缺有效基准失败。生成物和差异保留为 CI artifact。

自测 6/6：允许名单边界、同一行状态与真实模型共存、默认与选项区分、同数换项、重复行、PR 基线抬高及缺历史均覆盖。扫描全部规则 +0，L5/L15/L16 仍 open。规则计数减少不等于行为问题已修复。

快速档（完整校准）与集成档 `npm test -- --base cce1e64` 均通过：JS 4629/4629、两组设置浏览器、37 Swift 套件，均无跳过 / 隔离复测。快速档约 150 秒，集成档约 151 秒。CI 最后补充了跨日期选择基线：本分支和目标版本分别选最新 inventory，夹具及集成档通过。仅更新审计 JSON 选脚本测试组（选测 17/17），未将基线变更当文档忽略。证据 `.tmp/audit-batch-0/`；快速档 `.tmp/test-runs/run-JWqJlz/summary.json`，集成档 `.tmp/test-runs/run-Mj6VhH/summary.json`。

## 批次 1：完成判断、记忆纠正与预算提示

基准 `bf828fa`，分支 `codex/audit-1-20261026`。L5/L15/L16 探针均 closed、规则新增 0。

- L5：词命中比例至少 0.5，或来源在正文 / citations 中出现；仍要求真实执行成功、可读取正文至少 40 字符、非 snippet。指定 URL 必须匹配，不可用其他网页代替。Node / iOS Host 均传递引用。回执仍为 supported，不声称独立核实事实。
- L16：保留抽取 subjectKey；任意主题同说话者新值覆盖旧值。不同主题 / 不同说话者保持，缺主题不凭关键词猜覆盖。旧 ES 例子显式提供主题键，新增保修期主题及无键共存反例。
- L15：budget.replyTemplate 与原因格式共用五语契约；共享 Core、Node 和 iOS 同步，iOS 通过同一 budget operation 渲染。20 个语言 × 限额夹具跨 Node VM / JavaScriptCore，未知语言英文回退。业务请求使用现有 config.replyLanguage；界面语言传输在批次 2 完成。
- J5 / J6：当前源码已经修复，`src/services/chat/promptPipeline.test.js` 的真实 runner 同时断言 Agent 固定模型用于核验、工具后最终回答流式、目标检查不流式。重新运行通过，避免重复改逻辑或重复测试。

新增回归先红（L5 无 URL、L16 未知主题），修复后最终专项 245/245；四组 Swift 专项通过，132 个共享 conformance 夹具。真实回归补出了共享策略加载失败被误报为 token 预算的边界，现使用独立五语提示；五语实际 AgentLoop 均断言零模型调用。旧“读过且已引用仍失败”夹具按新约定调整，保留无关未引用、无正文与未执行的失败反例。

最终快速档 `.tmp/test-runs/run-5yhv0C/summary.json`、集成档 `.tmp/test-runs/run-6Kx5nu/summary.json` 均 GREEN：JS 4660/4660、两组浏览器、37 Swift、Android JVM/Lint/Debug/Release，0 跳过、0 隔离复测。首次缺 Java 环境、旧夹具失败及共享策略错误均保留日志；使用本机已有 Java 21 / Android SDK，无新增安装。Android instrumentation 新夹具仅编译，未跑模拟器。证据 `.tmp/audit-batch-1/`。

## 后续批次

2. 语言：replyLocale、事件 id、服务端文案和英文执行面板。
3. 配置：真实默认值、地址 / 路径与高级开关。以校准后的真实命中为准，不将状态标识迁入模型目录。
4. 桌面 UI：反馈、表单、标题 / 按钮 / 空状态 / 术语及样式 helper。
5. iOS：主题 token、本地化及双端术语检测。
6. 架构：J2 / J3 / J6 / J8 独立方案，随后按依赖验收。
