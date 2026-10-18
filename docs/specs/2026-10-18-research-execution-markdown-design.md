# Research、Chat 执行记录与 Markdown

状态：用户于 2026-10-18 选择“按推荐方案实现”，开始实施。沿用已认可的同源本机 JS Core；开发只用 Fixture，App 内凭证保留，不新增付费服务或默认占用手机屏幕。

## 已核对的缺口

1. `shared/agent/search.js` 用关键词选择工具；brunch / 导航漏匹配，关于历史执行的问句又会因“打开”触发 Phone Use。当前 plan 只选一条 route，无法正确表达“检索后导航”。Search 给出 snippets，不自动构成页面核对或完整 Research。
2. Android `SharedChatAgent` 的 onPhase 覆盖一段 partial；没有保存 plan、Tool start/result 或完整 Scene。ChatEngine 将返回文字统一记 completed；Chat 没有可展开的通用执行卡。桌面已有 ExecutionScene / ToolInvocationRecord，不应另造一套长期分叉的事件语义。
3. Android `ReplyText` 只是裸 URL 的 AnnotatedString。仓库已有共享 ReplyDocument 的段落 / 标题 / 列表 / 引用 / 代码 / 表格解析，Android 未接入。

## 方案选择

- 推荐：共享任务计划与执行契约 + 原生折叠卡，修复 Markdown 并复用共同解析。保留 Compose Chat / 草稿 / 图片 / Phone Use 原生保护，逐模块迁移；需补数据、状态与 UI 的集成验证。
- 最小改动：只加关键词与阶段文字。改动少，但复合任务、历史可审计和重启恢复缺口仍在，不推荐作为最终交付。
- 全量改为共享 Web Chat：渲染更集中，但会牵涉输入、图片、滚动、Accessibility 和 Fold 姿态，不在本轮范围。

## 推荐行为

### Research

`推荐 brunch 并导航 → Search → 按需读取候选来源 → 比较 / 选择 → Phone Use 打开对应 Maps 路线 → 回报实际结果`

普通推荐优先公开来源；只读取支持推荐理由所需的页面，不人为凑固定次数或来源数量。用户明确要求深入 Research / 多来源比较时才加深查询和交叉核对。来源不足、矛盾、过期或不可读要保留说明，不用模型已有知识伪装实时检索。营业状态仅在用户要求时核对。

Search 缺少 Backend 时明确报告不可用，保留已授权且确实可执行的步骤；不把 Search 失败当作接管屏幕的授权，不新增 Key。单纯询问上次做了什么读取本次已有记录，不重做搜索 / 导航。“打开 / 导航”类复合动作保留原生确认和可见证据，未知终点先澄清。

### Chat 内执行卡

默认折叠，放在本轮答案之前。摘要如“检索 3 个来源 · 导航未执行”，实际执行中显示当前阶段；数字、进度与成功声明均来自实际事件。

展开后按时间顺序显示 Tool 名称、输入摘要、开始 / 完成时间、结果摘要、来源、错误或取消原因。每步完整输出可继续展开，保留有界内容；屏幕 pixels / tree、凭证和敏感字段不进入卡片。Phone Use 子任务引用原步骤卡，避免重复统计。重启 / Activity recreation 后可查看已持久化记录。旧记录标“未记录工具明细”，不反向编造轨迹。

显示执行记录与模型公开摘要；不展示原始内部思维、encrypted reasoning 或供应商隐藏字段。只有服务真实返回公开 Reasoning Summary 时才显示，明确标记来源；没有就省略，不额外请求模型生成伪造思考。不因不支持 Summary 而阻止正常回复。

请求传输结束与任务结果分开：完成、部分完成、受阻、取消可区分；Guard 停止不显示任务成功。执行失败后的已完成步骤仍可审阅。上轮解释需要这份有界实际轨迹进入上下文，工具输出仍是不可信资料。

### Markdown

复用共享 ReplyDocument 解析与格式契约，Android 只做 Compose 呈现。支持段落、标题、列表、引用、粗体 / 斜体 / 行内代码、安全链接、代码块和表格；小屏表格可横向滚动，不挤压文字。用户消息 / 草稿保留原文，复制或分享不丢原始内容。原始 HTML 不执行，未知或未闭合语法有可读回退；链接仅显式点击打开。

## 数据与平台边界

通用规则留在同源 Core；Node 与 Android 共用新计划 / 证据要求，借用现有 ExecutionScene 的 operations / pipeline / sources 与阶段状态。Android Host 负责实际网络 / Service / 本机持久化及 UI。新增字段保持可选并向后兼容，不能丢弃现有聊天、Key、Task Cache 或其他 Accessibility 服务。

本轮先交付 Android 的真实入口；Node 对新共享契约同步回归。iOS 可打包共享源码 / Fixtures，生产 UI 与 Swift 的接入必须有 macOS 验证后单列交付，不冒称三端全部完成。

## 实施与验收

1. 给 brunch + 导航、只问推荐、历史解释、显式 App、否定 / 引用 / 澄清与权限不足补离线反例，先复现后修。
2. 接 Research 与复合任务的 Tool / 证据要求；成功、来源不足、部分完成、失败、Guard、取消与重启有真实记录。
3. 接默认折叠卡、展开 / 再折叠、当前阶段及历史恢复；共用 Markdown 解析并检查恶意链接、代码字面量和未闭合语法。
4. JVM / Node 定向回归、三协议本地 HTTP Fixture、Android JS engine / Compose Emulator Cover 与展开尺寸、Lint / Debug / R8、最终 APK 签名与 16 KiB 检查。
5. 用户现有真实手机只作授权范围内验证；不得在私人手机运行会替换资料的测试夹具，不自动发送真实模型请求或改变 Search 账号配置。

## Summary 依据

[OpenAI Reasoning models](https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries)：公开 Summary 需服务支持与显式请求；不是原始 reasoning tokens。本轮会保留不同协议 / Proxy 不支持的路径，不按模型名称推断能力。
