# Melo 审计台账

目的：让审计收敛。每条问题有编号、来源、状态；机器能探的由 `scripts/audit-inventory.mjs` 每次运行自动刷新（`inventory-*.json` 的 `ledger`），判断类由人工在本表更新。再审计时只报"新增 / 已关 / 复发"，不整份重写。

运行：`node scripts/audit-inventory.mjs`（全量，写 `docs/audit/inventory-<日期>.json` 与 `report-<日期>.md`）；`node scripts/audit-inventory.mjs --baseline docs/audit/inventory-<上次>.json` 只看增量。`--check --out .tmp/audit` 使新增命中返回非零（按出现次数比较，不能拿关闭项抵消新增项）；CI 同时检查当前基线与目标分支 / push 前一提交基线。规则清单在脚本顶部 `RULES`，机器探针在 `LEDGER`。

## 一、机器探针（来自 10-23 / 10-24 三份报告的具体结论）

| 编号 | 问题 | 位置 | 首见 | 2026-10-26 状态 |
| --- | --- | --- | --- | --- |
| L1 | 「额外快速」小模型猜标签留在 harness 层 | `src/judge/fastJudge.js` | 10-23 | ✅ closed（整体下线） |
| L2 | HTTP 搜索路由把 web_search 设为必需工具 | `shared/agent/search.js` | 10-23 | ✅ closed |
| L3 | 路由提示词硬写"先搜" | `shared/agent/search.js` | 10-23 | ✅ closed |
| L4 | Hosted 搜索缺回执时替换模型回答 | `invokeModelNode.js` | 10-23 | ✅ closed |
| L5 | 研究回执要求回复原样含来源 URL | `shared/agent/completion.js` | 10-23 | ✅ closed（2026-10-26，行为回归 + 双端契约） |
| L6 | 分类模型写死 gpt-4o-mini | `src/retrieval/intentRouter.js` | 10-23 | ✅ closed |
| L7 | 视觉能力按模型名正则 | `src/media/visionCapability.js` | 10-24 | ✅ closed（探针形态）；目录化见 H1 |
| L8 | 前端用 7860 端口正则判断自定义声音 | `desktop-ui/app.js` | 10-24 | ✅ closed |
| L9 | 任务 owner 固定四个内置 id | `src/domain/task/taskService.js` | 10-24 | ✅ closed |
| L10 | 渠道别名硬加 melo | `telegramAddressHelpers.js` | 10-24 | ✅ closed |
| L11 | 英文硬编码的 window.prompt | `features/chat/controller.js` | 10-24 | ✅ closed |
| L12 | 仓库里本机绝对路径 | `scripts/android-pet-assets.js` | 10-24 | ✅ closed |
| L13 | 同轮两份不同的问候词表 | `prepareNode.js` | 10-24 | ✅ closed |
| L14 | 空回复兜底只有英文 | `finalizeNode.js` | 10-24 | ✅ closed |
| L15 | 预算用完模板只有中文 | `agent-loop.json` | 10-24 | ✅ closed（2026-10-26，行为回归 + 双端契约） |
| L16 | 纠正事实主题只认三种 | `src/memory/factPolicy.js` | 10-23 | ✅ closed（2026-10-26，行为回归 + 双端契约） |
| L17 | 智能模式档位表未落地 | `desktop-ui/smartRouting.js` | 10-23 | ✅ closed（已落地） |

## 二、规则扫描基线（2026-10-26，批次 5 修复后 838 个正式文件 × 20 条规则）

| 规则 | 命中 | 和 10-24 手工报告的对应 | 解读 |
| --- | --- | --- | --- |
| H1 模型名正则 / 字面量 | 0 | 2026-10-26 批次 3 | 显示名 / 旧目录迁移 / 冒烟模型读取 providerDefaults，保留定制值 |
| H2 CJK 判断语言 | 0 | 2026-10-26 批次 2 | 唯一语言 detector；五个分词/昵称边界允许项有回归 |
| H3 本机地址 / 端口 | 0 | 2026-10-26 批次 3 | 共享本机服务目录；原生壳唯一数值回退；UI 地址参数化 |
| H4 机器绝对路径 | 0 | 2026-10-26 批次 3 | 示例改用户目录；素材导入必须显式来源 |
| H7 中文事件名无翻译行 | 0 | 2026-10-26 批次 2 | 提供方、自动连接和删除项目占位已翻译；用户命名不翻译 |
| H8 服务端中文回复 / 错误 | 0 | 2026-10-26 批次 2 | serverText 五语，请求上下文隔离 |
| H9 按脚本选回复语言 | 0 | 2026-10-26 批次 2 | 统一 replyLocale；Agent → 最近用户消息 → 渠道 / 界面 |
| H10 桌面 JS 原始色 | 0 | 2026-10-26 批次 4 | scene token 统一 Canvas / Three.js / SVG |
| H11 CSS 原始色（tokens 外） | 0 | 原 500+ → 0 | 全部进了 `tokens.css` |
| H12 原生对话框 | 0 | 原 4 → 0 | |
| H13 内联 style | 0 | 2026-10-26 批次 4 | 固定样式类化；连续几何通过 CSS 变量 |
| H14 !important | 5 | 2026-10-26 批次 4 | 仅 hidden / 系统 reduced-motion 有意覆盖 |
| H15 escapeHtml 副本 | 0 | 2026-10-26 批次 4 | 单一实现 i18n；旧 html 兼容导出 |
| H16 未文档化环境开关（出现处） | 0 | 原 3 个开关零文档 → 0 | 按出现处计，`docs/**/*.md` 或根说明文件里提到即豁免；"在设置页可见"仍是 J7 |
| H17 问候词表副本 | 2 | 5 → 2 | |
| H18 iOS 固定字号 / 原始色 / 绕过本地化 | 0 | 2026-10-26 批次 5 | 语义校准先 38→6；6 处真实字号改主题 token，动态状态与目录覆盖同步 |
| H19 写死 zh-CN 默认 | 0 | 2026-10-26 批次 2 | 桌面 / 原生默认跟随系统；已有语言偏好保留 |
| H20 TODO | 3 | 3 → 3 | |
| H5 外部服务地址（信息） | 73 | 原 40 个域名 | 集成端点，暂不处理 |
| H6 内置 Agent id 写进逻辑 | 2 | 47 处兜底 → 2 处真逻辑 | |

## 三、判断类（人工，10-24 报告 §2–§3 的条目）

| 编号 | 问题 | 10-24 | 10-26 | 状态 |
| --- | --- | --- | --- | --- |
| J1 | 两套搜索规划器并存 | `constrainSearchPlan` + `planRequest` | `prepareNode` 不再调用旧规划器 | ✅ closed（route 名仍 12 个，见 J2） |
| J2 | route 名 12 个、`unavailable` 7 种 reason | 12 | 12 | 🟡 open，列为下一阶段 |
| J3 | `searchTask.js` 适配层"无人被迫迁移" | 95 处 legacy | 未复核 | 🟡 open |
| J4 | 问候 / 确认词表多份 | 5 份 | 3 份（H17 计 2） | 🟡 收窄 |
| J5 | 核验模型永远用默认模型 | — | 2026-10-26 复核已有修复 | ✅ closed：真实 runner 测试断言核验请求使用 Agent 固定模型 |
| J6 | 只有第一轮流式输出 | — | 2026-10-26 复核已有修复 | ✅ closed：工具后最终回答有 onDelta，目标检查不流式；旧注释已于批次 5 修正，不改变运行逻辑 |
| J7 | 18 个 `=== '1'` 环境开关不在设置页 | 18 | H16 计 32 处 | ✅ closed（2026-10-26 复核：已有七项设置；新增目录守卫，真实浏览器保存/取消/覆盖通过） |
| J8 | `app.js` 6881 行等体量 | 6881 | 6869 | 🟡 open |
| U1 | 反馈通道 | 71 / 10 / 23 | notify 统一入口 | ✅ closed（2026-10-26，持久错误/成功提示；真实进度 role=status 保留） |
| U2 | 表单编辑 | 13 个 | 共享 EditSession | ✅ closed（2026-10-26，取消/失败重试/Enter 浏览器实测；composer 与自定义输入对话框保留提交语义） |
| U3 | 页头层级 | 9 / 27 | page-title / pane-title / subsection-title | ✅ closed（2026-10-26，消息正文标题保留） |
| U4 | 按钮视觉 | 13 | primary / secondary / ghost / icon | ✅ closed（2026-10-26，布局/动作类与可交互图形保留；Codex 原生读取被工具禁止，使用现行 Melo token） |
| U5 | 空状态 | 三种口吻 | 统一还没有 | ✅ closed（2026-10-26，空集合统一；错误含义不改） |
| U6 | 术语 | 资料/知识、聊天/对话 | 双端知识/对话 | ✅ closed（2026-10-26，个人资料/数据导入导出/会话令牌保留语义；共享概念门禁在 U10） |
| U7 | 时间格式 6 种写法 | 6 | 3（formatTime ×6 为主） | ✅ 基本统一 |
| U8 | CSS 原始色 500+、z-index 17 档、字号 50 种 | 500+ / 17 / 50 | 0 / 0 / 2 | ✅ closed |
| U9 | iOS 字号/颜色/动态本地化 | 26 / 26 / 33 | H18=0 | ✅ closed（2026-10-26，主题生成、五语 Bundle/目录、完整 App 未签名编译通过；真机另验） |
| U10 | 桌面 / 手机术语对表 | — | 共享四个 concept ID | ✅ closed（2026-10-26，interface-terms.json、JS/Swift 生成与实际界面消费；device 用电脑/手机对应名称） |

## 四、复审规则

- 每次审计先跑 `audit-inventory.mjs --baseline <上次>`，报告只写：机器规则的 新增 / 已关；台账里状态变化的条目；新发现的判断类条目（给新编号）。
- "看过没问题"也要记：判断类条目复核后写明日期与结论，避免下次重新发现。
- 规则表要改（加规则、改允许名单）必须在脚本里改并跑自测 `scripts/audit-inventory.test.js`，不在报告里口头改。

## 2026-10-26 批次 0 复核

H1 / H3 / H18 / H19 校准及正反例通过，所有规则新增为 0；数值下降属于误报修正，L5 / L15 / L16 仍开放。H5（73）与 H20（3）按用户要求保留。门禁检查基线缺项和基准历史缺失时失败；CI 运行中不改写基线。完整验收与后续批次见 [实施回执](remediation-2026-10-26.md)。
