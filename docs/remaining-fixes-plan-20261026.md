# 剩余问题修复方案 · 2026-10-26

依据：`docs/audit/report-2026-10-26.md`（规则扫描基线）与 `docs/audit/ledger.md`（台账）。原则：每一批都有机器可验的验收（规则计数或探针状态），做完跑 `node scripts/audit-inventory.mjs --baseline docs/audit/inventory-2026-10-26.json` 看增量；代码改动按两档节奏测，合并前集成档一次。批次按"先纠正行为、再统一语言、再统一界面、最后动架构"排序；每批可独立交付，不互相阻塞。

## 批次 0 ─ 规则校准（半天，先做，否则后面的数字不准）

| 项 | 改法 | 验收 |
| --- | --- | --- |
| H1 误报 | 排除状态字符串（`-unavailable` / `-cpp` 这类后缀）与 `ios/Melo/*Verification.swift` 自检文件 | H1 从 22 降到只剩真默认值 |
| H3 单一定义 | `desktop-app/main.swift` 里 `MELO_DESKTOP_PORT` 的唯一回退、`scripts/verify-red-green.js` 的测试端口进允许名单 | H3 只剩散落引用 |
| H18 主题文件 | `ios/Melo/MeloTheme.swift` 是色板 / 字号定义本身，进允许名单 | H18 56 → ~38 |
| H19 收窄 | 只匹配默认 / 回退语境（`?? "zh-Hans"`、`\|\| 'zh-CN'`、`locale: ... ?? "zh-CN"`），不匹配语言选项列表 | H19 34 → 真默认值 |
| CI 门禁 | `verification.yml` 跑 `--baseline` 对比上一基线，任一规则新增 > 0 即红；基线文件随修复更新 | 以后只会减不会增 |

## 批次 1 ─ 行为纠正（1 天）

| 编号 | 问题 | 改法 | 验收 |
| --- | --- | --- | --- |
| L5 | `shared/agent/completion.js:38-41` 研究回执要求回复原样含来源 URL，否则 `RELEVANT_READ_SOURCE_MISSING` | 相关性 = 词组命中 ≥ 0.5 **或** 来源被引用（URL 在回复 / `citations` 里）；删掉 `includes(row.url)` 硬条件；对应 `completion.test.js` 加"读了来源但没贴 URL 仍为 completed"用例；`npm run build:agent-core` 同步 dist | 探针 L5 closed；conformance 绿 |
| L15 | `agent-loop.json budget.replyTemplate` 只有中文 | 改成 `{zh, en, ja, ko, es}` 结构，`budgetExhaustedReply` 按对话语言取（见批次 2 的 `replyLocale`）；iOS `AgentLoopContract.swift` 同步读新结构，fixtures 更新 | 探针 L15 closed；两端 contract 测试绿 |
| L16 | `src/memory/factPolicy.js:13-16` 纠正事实主题只认 ES20xx / 部署端口 / 回复语言 | 主题改由抽取阶段带出的 `subjectKey`（模型输出结构里已有 `subjectKey` 字段，`factSubject` 优先读它）；去掉三条正则，保留为空字符串回退；补测试：新主题的纠正能覆盖旧事实 | 探针 L16 closed |
| J5 | 核验模型永远用默认模型（`chatExecutionRunner.js:119-124` `verifier = config.model`） | `verifier` 先取 Agent 模型，再取智能模式选中的模型，再回落默认 | 单测：Agent 钉死模型时核验请求的 model 字段等于该模型 |

## 批次 2 ─ 语言与文案（2 天）

目标：服务端不再用"有没有汉字"选语言；界面不再出现未翻译的服务端中文。

方案对比：

| 方案 | 做法 | 优 | 劣 | 评分 |
| --- | --- | --- | --- | --- |
| A 事件 id 化 + UI 翻译 | 服务端 `execution_event` 只发 `id` + 参数，桌面 / 手机按 id 查翻译表；远程渠道（Telegram / Discord）由服务端按频道语言渲染 | 一处翻译表，门禁已有 | 要改 32 个事件发送点和 UI 渲染 | ★★★★ |
| B 服务端小目录 | 新建 `src/shared/serverText.js`（id → 五语），服务端按 `replyLocale` 渲染后再发 | 改动集中、UI 不动 | 翻译表两份（桌面 + 服务端） | ★★★ |
| **C 混合（推荐）** | 事件走 A（UI 已有翻译行的 7 个先补行，其余改 id）；回复 / 错误文案走 B（27 处，远程渠道必须服务端渲染） | 各取所长 | 两处规则 | ★★★★★ |

- `replyLocale(chat, userMessage)`：Agent 语言设置 → 对话最近用户消息语言（`shared/agent/locale.js detectReplyLanguage`，唯一允许的脚本判断）→ 界面语言（把 `interfaceLanguage` 随请求头传给服务端，`src/` 第一次真正消费它）。
- H2 剩余 8 处：`voiceRewrite.js:169,214`、`app.js:2409`（TTS 选声）、`completion.js:16`、`dynamicContext.js:29`、`telegramAddressHelpers.js:81`、`conversationTopics.js:23`、`executionScene.js:239` —— 判语言的改走 `locale.js`，分词的进允许名单。
- H7 剩余 7 处：提供方显示名（豆包 · 火山方舟 / 通义千问 · 百炼 / 本地模型 / 自定义兼容服务）补翻译行或改用 id + 翻译；`原有连接`、`已删除的项目` 同理。
- H19：iOS 默认语言用 `Locale.current`；桌面 `voiceInput.start` 回退到界面语言；`main.swift` 两处同理。
- 验收：H7 = 0、H8 = 0、H9 = 0、H2 = 0（分词例外在允许名单）、H19 = 0；英文界面跑一遍 `language.browser.test.js` 扩展用例：执行面板无中文。

## 批次 3 ─ 配置化（1 天）

| 规则 | 剩余 | 改法 | 验收 |
| --- | --- | --- | --- |
| H1 | `audioExtractor.js` whisper 名 5、`modelPresentation.js` 显示名表 3、`config.js` 3 | 转写模型名进 `providerDefaults.js`（`transcription` 段）；显示名由目录元数据（`providerDefaults` 加 `labels`）提供，`modelPresentation` 只读；`config.js` 改读目录 | H1 = 0（校准后） |
| H3 | `desktop-relay.js`、`customize/view.js` 文案里的 Ollama 地址、`main.swift` 回退 | 读 `localServices.js` / 配置；文案用 `{url}` 占位 | H3 = 0（校准后） |
| H4 | `pdfTool.js` 示例路径 `/Users/me/…`、`desktop-pet-assets.js` 回退路径 | 示例改 `~/Documents/…`；桌宠资产来源无默认（必须 `MELO_PET_SOURCE_DIR`，README 说明） | H4 = 0 |
| J7 | 18 个 `=== '1'` 环境开关 | 行为类（CDP、工具链历史、上下文位置、离线、禁媒体、外部读取器、工具追踪）进 `config.advanced` + 设置页"高级"；debug 类集中到 `docs/env-flags.md` | 设置页能看到并改；文档列全 |

## 批次 4 ─ 桌面 UI 统一（2 天）

| 编号 | 现状 | 改法 | 验收 |
| --- | --- | --- | --- |
| U1 反馈通道 | `showError` 72 / `showFlashToast` 13 / 页内 `role=status` 24 | 一个 `notify({ level, text, scope })`：错误 = 页内状态条 + 可选 toast；成功 = toast；统一样式与存活时间 | 三者调用点归一，浏览器验收检查无原生对话框 |
| U2 表单 | 13 个裸 `type="submit"` 表单 | 全部接 `EditSession / renderEditActions`（编辑 → 保存 / 取消），和设置页一致 | `grep type="submit"` 只剩 composer |
| U3 页头 | h1.page-title 9 / h2.pane-title 28 | 定规则：页级 h1.page-title，卡片级 h2.pane-title，小节 h3.subsection-title；清掉 card-title 的 h2 / h3 混用 | 标题类名 ≤ 3 种 |
| U4 按钮 | 26 种类名 | 先核对 Codex 新设计体系；定三类（primary / secondary / ghost）+ 图标按钮，其余映射 | 类名 ≤ 5 种 |
| U5 空状态 | 还没有 11 / 没有 10 / 暂无 6 | 统一"还没有 X，…" 口吻；翻译行同步 | 一种口吻 |
| U6 术语 | 资料 27 / 知识 11；对话 79 / 聊天 11 / 会话 2 | 桌面 10-22 已定「知识库 / 成果库」，统一用 知识；统一用 对话；手机对表（U10） | 翻译表里不再混用 |
| H13 / H14 / H15 / H10 | 内联 style 14、!important 24、escapeHtml 14 份、3D 场景色 18 | 内联进类；!important 逐个查层叠；`escapeHtml` 统一从 `i18n.js` 导出；3D 场景色进 `tokens.css` 的 `--scene-*` | H13 = 0、H15 = 0、H14 ≤ 5、H10 = 0 |

## 批次 5 ─ iOS（1.5 天）

- H18：`MeloTheme.swift` 做语义字号 / 色板（校准后它本身不计），其余 ~38 处改引用主题；`Text(verbatim:)` / 插值文本改 `LocalizedStringKey` + 格式参数（`AgentEditor.swift:102`、`CapabilityElevationViews.swift:73-100` 为主）。
- U10：桌面 / 手机术语对表（知识 / 成果 / 对话 / 这台电脑上 ↔ 这台手机上），放进 `ios/native-translations.js` 注释与 `desktop-ui/translations.js` 头注释，并加一条检测：同一概念两端键名一致。
- 验收：H18 ≤ 10；SharedContractTests 绿。

## 批次 6 ─ 架构（后排，各 1–2 天，需单独方案）

| 编号 | 问题 | 方向 |
| --- | --- | --- |
| J2 | route 名 12 个、`unavailable` 7 种 reason | 收敛为 5 个 route（none / fetch / search / phone / unavailable）+ reason 枚举进 contract |
| J3 | `searchTask.js` 适配层"无人被迫迁移" | 要么三个工具真正迁移到结构化 evidence 并删 legacy 输出，要么删适配层 |
| J6 | 只首轮流式 | 工具调用后的最终回答也流式（`onDelta` 在最后一轮打开，中间轮缓冲） |
| J8 | `app.js` 6869 行 | 继续按功能目录抽（settings / tts / composer 三块最大） |

## 执行方式

1. 批次 0 先做，更新基线文件；之后每批结束跑 `--baseline` 并把 `inventory-<日期>.json` 作为新基线提交。
2. 每批一个分支、按文件名提交；快速档随改随跑，合并前集成档一次。
3. 台账 `docs/audit/ledger.md` 每批更新状态；判断类条目"复核无问题"也要记日期。
4. 不做的也写明：H5 外部服务地址 73 处（集成端点）本轮不动；H20 3 条 TODO 留原位。
