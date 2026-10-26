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

## 二、规则扫描基线（2026-10-26，批次 0 校准后 835 个正式文件 × 20 条规则）

| 规则 | 命中 | 和 10-24 手工报告的对应 | 解读 |
| --- | --- | --- | --- |
| H1 模型名正则 / 字面量 | 8 | 原报告 ~60 处散落 → 目录模块 `providerDefaults.js` / `modelCatalog.js` 已集中（不计） | 剩余：显示名 3、配置迁移快照 3、冒烟用例 2。转写状态 / 后端 / 二进制名称和 iOS 自检已校准；没有 5 个真实转写模型默认值 |
| H2 CJK 判断语言 | 8 | 原 6 种写法 → 共享 `shared/agent/locale.js`（不计） | 剩余 8 处未改走共享 helper |
| H3 本机地址 / 端口 | 13 | 原散落 → `src/shared/localServices.js` 集中（不计） | 剩余：`desktop-app/main.swift`、`verify-red-green.js`、mobile-sync relay |
| H4 机器绝对路径 | 3 | 原 1 → 3 | 见报告样例，需逐个看 |
| H7 中文事件名无翻译行 | 7 | 原 21 → 7 | 剩余多为提供方 / 连接显示名 |
| H8 服务端中文回复 / 错误 | 27 | 原 42 → 27 | 仍按"有没有汉字"选语言的落点 |
| H9 按脚本选回复语言 | 1 | 原 4 落点 → 1 | |
| H10 桌面 JS 原始色 | 18 | 原 35 → 18（3D / 卫星场景例外） | |
| H11 CSS 原始色（tokens 外） | 0 | 原 500+ → 0 | 全部进了 `tokens.css` |
| H12 原生对话框 | 0 | 原 4 → 0 | |
| H13 内联 style | 14 | 14 → 14 | |
| H14 !important | 24 | 37 → 24 | |
| H15 escapeHtml 副本 | 14 | 16 → 14 | |
| H16 未文档化环境开关（出现处） | 0 | 原 3 个开关零文档 → 0 | 按出现处计，`docs/**/*.md` 或根说明文件里提到即豁免；"在设置页可见"仍是 J7 |
| H17 问候词表副本 | 2 | 5 → 2 | |
| H18 iOS 固定字号 / 原始色 / 绕过本地化 | 38 | 26 + 26 + 33 → 56 | |
| H19 写死 zh-CN 默认 | 18 | 新规则 | 多在 iOS 设置页与 `desktop-app/main.swift` |
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
| J6 | 只有第一轮流式输出 | — | 2026-10-26 复核已有修复 | ✅ closed：工具后最终回答有 onDelta，目标检查不流式；旧注释在架构方案登记 |
| J7 | 18 个 `=== '1'` 环境开关不在设置页 | 18 | H16 计 32 处 | 🟡 open |
| J8 | `app.js` 6881 行等体量 | 6881 | 6869 | 🟡 open |
| U1 | 反馈通道 3 套并用 | 71 / 10 / 23 | 72 / 13 / 24 | 🟡 open |
| U2 | 表单未接共享编辑条 | 13 个 | 工具条用户 8（+1），裸 submit 13 | 🟡 open |
| U3 | 页头 h1 / h2 两套 | 9 / 27 | 9 / 28 | 🟡 open |
| U4 | 按钮类名 13 种 | 13 | 26 | 🔴 变差（需核对是否是新设计体系） |
| U5 | 空状态三种口吻 | 5 / 8 / 1 | 11 / 10 / 6 | 🔴 变差 |
| U6 | 术语 资料 / 知识、对话 / 聊天 / 会话 | 27/11、78/10/2 | 27/11、79/11/2 | 🟡 open |
| U7 | 时间格式 6 种写法 | 6 | 3（formatTime ×6 为主） | ✅ 基本统一 |
| U8 | CSS 原始色 500+、z-index 17 档、字号 50 种 | 500+ / 17 / 50 | 0 / 0 / 2 | ✅ closed |
| U9 | iOS 固定字号 / 原始色 / 绕过本地化 | 26 / 26 / 33 | H18 56 | 🟡 open |
| U10 | 桌面 / 手机术语对表 | — | 未做 | 🟡 open |

## 四、复审规则

- 每次审计先跑 `audit-inventory.mjs --baseline <上次>`，报告只写：机器规则的 新增 / 已关；台账里状态变化的条目；新发现的判断类条目（给新编号）。
- "看过没问题"也要记：判断类条目复核后写明日期与结论，避免下次重新发现。
- 规则表要改（加规则、改允许名单）必须在脚本里改并跑自测 `scripts/audit-inventory.test.js`，不在报告里口头改。

## 2026-10-26 批次 0 复核

H1 / H3 / H18 / H19 校准及正反例通过，所有规则新增为 0；数值下降属于误报修正，L5 / L15 / L16 仍开放。H5（73）与 H20（3）按用户要求保留。门禁检查基线缺项和基准历史缺失时失败；CI 运行中不改写基线。完整验收与后续批次见 [实施回执](remediation-2026-10-26.md)。
