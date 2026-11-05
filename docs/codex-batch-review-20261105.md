# Codex 批次复核（2026-11-05，Claude，只报告）

> 2026-11-05 晚更新：C1–C3 已按用户决定修复并推送，见[修复记录](codex-batch-fixes-20261105.md)；下文保留发现时的状态。

用户要求复核 Codex 在 `afdcce1` 之后做的东西。范围是 `afdcce1..a3817f5` 共 9 个提交、70 个文件（+4 370 / −297）：审计 `431912b`、R1–R7 修复 `5d1a514`、方案文档 `cba47c9`（合并 `2b2a0ab`）、任务评估 B `201b9c9` + 审核字段修复 `2cb936b`、门禁与真实模型记录 `4ec8333`、Mac 覆盖安装回执 `e325b62` / `a4ae796`（以上已推送），以及 iPhone 安装回执 `a3817f5`（仍在本机 master，未推送）。本轮只读源码、diff、门禁 summary 与回执，另跑了三组隔离探针和一次桌面真实探针；没有改产品代码，没有推送、安装或 `git pp`。

## 结论

Codex 对方案 A 的七项审计全部属实，修复方向正确、测试与门禁证据齐全，B 方案把散落的策略数字收进一份共享契约并在三端接上了同一个控制工具。本轮确认 **2 项需要修的缺陷（P2）、1 项待真实数据校准的策略风险（P2）** 和 4 项文档 / 覆盖 / 卫生问题（P3）。全部不影响已装应用的数据安全；都不在本轮修。

## 1. 对 Codex 审计（`431912b`）的核对

R1–R7 逐条对照我自己的实现，全部成立：成员新建 coreTurn 没有跨成员防重（R1）；我把成员报告行写成 `ok:true, executed:true` 是为了让限额收尾保留报告正文，副作用是目标检查把成员自述当成执行凭证（R2）；`jobModels` 进了 v1 线协议而已装手机的契约 `additionalProperties:false`（R3）；执行成员绕过智能模式强档门槛（R4，我没考虑到）；`runBudget` 扩了但共享 reducer 的截止时间在创建时固化（R5；宿主 `runDeadline` 会重查预算，reducer 不会）；同 URL 去重丢分页窗口（R6）；岗位换连接只复制五个字段（R7）。两项"遗漏"（策略写死、手机内联）我在交接里已写明，Codex 也如实注明。审计证据 `.tmp/recent-change-review-20261105/` 的三组探针可重跑。

## 2. R1–R7 修复（`5d1a514`）逐项

| 项 | 实现 | 复核结果 |
| --- | --- | --- |
| R1 | `src/runtime/turnEffects.js` 整轮账本，`chatExecutionRunner` 创建、`executor.js:114` 原子保留 / 结算；`subAgent` 异常与取消都返回已收集观察 | 对写操作正确；对 `unknown` 效果过宽，见 C1 |
| R2 | 报告行改为 `executed:false`，`goal.validEvidence` 排除 `handoff` | 正确。报告正文在限额收尾里只剩 160 字，但成员的真实观察已并入主账本（`invokeModelNode.js:436`），事实不丢 |
| R3 | `portableCollaboration` 把 `jobModels` 从 v1 载荷剥掉，Node / Swift 应用与确认时保留本机值，旧包做带因果时钟的兼容投影，新增 `882eba7` 契约夹具 | 正确。卫生问题：`shared/protocol/sync.schema.json:1321` 仍声明 `jobModels`，线上却永远不发；后续线程容易再把它放回线协议 |
| R4 | 智能模式下 execute 派单先要求强档（`ROUTING_REQUIRES_STRONG`），执行成员固定用主连接 | 正确。设计取舍：智能模式下用户给执行岗选的更强连接也被忽略，设置页没有说明（P3） |
| R5 | `hardDeadlineAt`、`extendBudget` 封顶、reducer 新事件 `extend-deadline` 由 `createCoreTurn` 同步 | 正确（预算用 `Date.now`，core 用 `performance.timeOrigin + now`，同为 epoch 毫秒）。B 取消自动扩容后只剩显式扩容路径在用 |
| R6 | 同 URL 只对相同正文去重，保留原 `truncated` | 正确 |
| R7 | 岗位连接带完整能力 / 元数据 / 上下文窗口；选中连接不存在时明确失败 | 功能正确。卫生问题：`{ ...config, ...profile }` 把 `id` / `name` / `models` / `providerId` / `revision` / `test` 等整份档案字段铺进运行配置，今天只有 apiKey / authMode / baseUrl / model 四个字段重名（本意），是个潜在撞名点（P3） |

### C1 · P2：整轮副作用账本把成功过的只读命令也拦下

`turnEffects.js:12`：账本在第一个内部成员启动后置为 active（`internalMembers.js:104`），之后同一工作区内任何效果为 `write` **或 `unknown`** 的工具，只要参数相同，第二次调用一律返回 `TURN_EFFECT_ALREADY_ATTEMPTED`，不区分上一次是否已成功结束、不区分主 Agent 与成员。`bash` 没有效果声明（`toolEffects.js` 只按名字表判定），MCP 工具只有带 `readOnlyHint` 的才算 `read`（`src/mcp/manager.js:416`）。隔离探针（`scratchpad/turn-effects-probe.mjs`，账本 active、首次成功后再调一次）：

| 工具 / 参数 | 效果 | 第二次相同调用 |
| --- | --- | --- |
| `bash` `cat notes.txt` / `ls -la` | unknown | 拒绝 |
| `mcp:playwright:browser_click`（同 ref / element） | unknown | 拒绝 |
| `mcp:playwright:browser_navigate`（同 URL） | unknown | 拒绝 |
| `mcp:playwright:browser_snapshot`（readOnlyHint） | read | 允许 |
| `file_write` 同路径同内容 | write | 拒绝（本意） |

现实场景：执行成员翻页——快照 → 点"下一页"（ref e12）→ 快照 → 再点同一个 ref 就被拒，模型还被告知"不要重复该效果"；主 Agent 在成员跑完后再执行一次 `ls` 核对也被拒。Codex 的主图反例只用写计数工具，没有覆盖这类重复。建议：只对 `write` 效果和仍在 `pending` 的并发重复拦截；`unknown` 在上一次已结束后放行（最多提示），`bash` 可借用自己已有的只读命令判定（`bashTool.js:243`）给账本一个 `read` 结论。

## 3. 任务评估 B（`201b9c9` + `2cb936b`）

已核对的部分：策略数字全部收进 `shared/agent/taskEvaluation.js`（版本化，解决了我交接里的"策略写死"）；`task_progress` 在桌面（`invokeModelNode.js:150` / 399）、iPhone（`AgentLoop.swift`）、Android（`SharedChatAgent.kt`）三端走同一个共享 `goalOperation`；`evaluationMode` 三端都有本机设置且不进同步协议；成员改为按 4 轮 / 8 次调用 / 90 s 切片从根池领份额，`resume` 续派 +2 轮、累计 12 轮（`internalRouting.js:64`）；`shared/agent/dist` 与 iOS / Android 构建副本哈希一致（`npm run check:agent-core` 44 模块通过）；`architecture/modules.json` 与源码一致（`npm run scope`）；新测试文件由 `scripts/test-discovery.js` 自动纳入门禁。我在 master 上用隔离 home 跑了 14 个相关测试文件：291 / 291 通过。

### C2 · P2：审核器被要求索取一个宿主没有提供的工具

`goal.js:117`：审核器只要回 `needsEvaluation:true` 且本轮没有账本，宿主就把 `complete` 改成 `continue`，nextStep 写死为"初始化 task_progress"。审核提示词对所有"多项发现 / 推荐"任务都要求账本。但 `task_progress` 只在内部岗位目录存在时才提供：桌面排除团队任务 / 团队计划 / 禁工具请求（`invokeModelNode.js:147–150`），iPhone 在团队计划、视频、出图回合关闭内部路由（`ChatStore.swift:650`），Android 只在禁工具请求时没有目录。这些回合里的推荐类任务永远到不了 `complete`，只能烧完轮数走限额收尾、以 partial 结束。隔离探针（`scratchpad/review-goal-probe.mjs`，有一条真实已核实读取、需求全部 met）：审核器回 `needsEvaluation:false` → complete；回 `needsEvaluation:true` → continue、`GOAL_INCOMPLETE`。审核器本身的行为没有用真实模型复现，但提示词是明确指令，我判定大概率发生。建议：把"本轮是否提供了 task_progress"传进 `goalReviewRequest` / `reviewGoal`，没提供就不要求也不强制；或者在团队流程里也提供该工具。

### C3 · P2：成员 90 秒切片与 4 轮额度在真实延迟下对不上

`taskEvaluation.js:8`：成员每次切片 90 s（加 60 s 收尾保留），初始 4 个工具轮；桌面 `internalMembers.js:134` 按此收窄子预算，iPhone `beginMember`、Android `memberAllocation` 同样。用户现用连接 `gpt-6.1-sol` 的单次模型调用约 20–30 s（10-27 BIGBANG 实测 14 次调用 313 s），4 轮至少要 120–180 s，所以成员多半在 1–2 轮后就 `DEADLINE_EXCEEDED`，再花一次收尾调用，主 Agent 必须反复 `resume`。Codex 的真实探针都是主 Agent 自己读目录（`final-live-probes.json`：actualReads 1–2），没有成员在真实延迟下跑过。

### 桌面真实探针：成员时间片

设置：桌面 Melo（已推送代码的服务进程），主 Agent `main`、连接 `gpt-6.1-sol`，用本机接口新建对话发送"读取 6 个 txt 的 amount 并求和"。说明：项目外新对话的工作区是每对话独立目录（`.tmp/melo-home-user/workspaces/chats/<id>`），我给的相对路径在那里不存在，所以读取全部失败；这不影响时间片的观察，但也意味着这次没有验证成员读到文件后的评估流程。

| 时间 | 事件 |
| --- | --- |
| 6.3 s | 主 Agent 第一轮就派出"资料读取成员" |
| 13.5 s | 成员第一轮并行 6 次 `file_read`，全部 File not found（模型往返 7.2 s） |
| 18.7 s | 成员第二轮改用 `glob`（往返 5.2 s） |
| 78.7 s | `glob` 60 s 超时失败 |
| 129.0 s | 成员被切片截止打断（interrupted），交回 partial 报告："没有任何文件读取成功" |
| 132.7 s 起 | 主 Agent 自己改用绝对路径读取 → 文件安全卡（无人点击）→ 60 s 工具超时 → 改 `bash` → 又一张卡；约 200 s 时我终止探针 |

读数：小上下文下模型往返只有 5–7 s，比我按 BIGBANG 估的 22 s 快，纯读文件任务 4 轮能装进 90 s；但一次 60 s 的工具超时就吃掉了整个切片，成员两轮后被截止、只交回失败记录，主 Agent 得从头再来。网页读取单页 10–20 s、上下文变大后同样容易发生。切片机制本身按设计工作（截止 → 收尾 → partial 交接 → 主 Agent 续跑）。C3 的结论因此修正为：不是必然对不上，而是切片对单次慢工具没有余量；建议 90 s 至少覆盖"工具超时 + 两次模型往返"，或者让子预算截止跟随剩余轮数而不是固定值。顺带两条非本批引入的观察：工具级 60 s 超时会在文件安全卡（120 s）还挂着时先触发，卡片随后作废；项目外对话的工作区是隔离目录，模型看不出相对路径落在哪里。

## 4. 门禁、安装与真实探针证据

- 两档门禁在工作树 `/private/tmp/melo-orchestration-fixes-20261105/.tmp/test-runs/`：快速档 `run-BdkSW7`（588 个文件，JS 4 927 / 4 927，185 s）、基准集成 `run-b9dLLp`（`--base cba47c9`，4 927 / 4 927，180 s），都零失败 / 零取消 / 零跳过；中间红档 `run-Dxy7fS` 等 Codex 已自行留档。master 快进自同一提交，树相同，之后的三次文档提交各跑了纯文档档。
- Mac：`.tmp/task-evaluation-b-20261105/mac-release.json`，代码 `2cb936b`、安装自 `4ec8333`、17 项 GREEN、运行目录是主仓库；桌面壳自 14:40 起运行，服务进程从主仓库启动，当前代码即已推送代码。
- iPhone：`.tmp/iphone-task-evaluation-20261105-cf8_8gxy/complete.json`，源 `a4ae796`，121 个文件两次回读一致，18 聊天 / 197 消息 / 6 Agent / 26 原图保留。版本仍是 0.7.13（45）——固定流程里应改 pbxproj 版本号，Codex 改用哈希区分，已写明（P3）。
- 真实模型：`final-live-probes.json`，8/20 两次读取 190 s partial；20/20 一次读取 142 s completed。

## 5. 文档与流程

- MELO_OVERVIEW §2 "聊天与 agent loop" 仍写"成员独立运行（份额 / 并行 / 预算扩展）"，而 B 已取消自动扩容（`extendForMember` 现在返回 null，`ROUTING_EXTENSION_CAP = 0` 等变成死出口）；`docs/agent-orchestration-implementation-20261104.md` 也没有"已被 B 取代"的注记（P3）。这是用户选 B 时方案文档已写明的取舍，但后果要知道：根池 400k、主 Agent 保留 60k、成员份额 ≤120k，一轮大约只能起三个成员，长任务会比昨天的设计更早 partial。
- Android 是 iOS 之外改动最大的宿主（`SharedChatAgent.kt` +69：成员子回合、子预算、task_progress），但没有新增 Android 单元测试；门禁的 Android 阶段是编译 / Lint / 既有 JVM 测试，`SharedAgentCoreTest.kt` 是仪器测试不进门禁。iOS 补了 `AgentLoopTests`（+33）。按"声明 ≠ 接入"，Android 的成员预算与控制调用路径只由编译证明（P3）。
- Codex 的两条总览条目追加在文件末尾（第 620 / 625 行，H2 / H3）而不是 §4 最新交接，沿用了 10-26 / 10-27 的旧先例；PROGRESS 条目都在 12 行内；`codex.md` 已同步（21:11）；提交署名与规范一致；`2b2a0ab` 在 master 留下一个合并气泡，无害。
- `a3817f5`（iPhone 回执）仍只在本机 master，没有推送。

## 6. 建议顺序

1. C1：收窄整轮账本（只拦 `write` 与并发 `pending`，`unknown` 已结束即放行）。
2. C2：审核规则按"本轮是否提供 task_progress"门控。
3. C3：按真实延迟校准成员切片（或让主 Agent 的 `resume` 自动化），再跑一次带成员的真实探针。
4. 文档：更新 §2 事实行、给昨天的实施记录加取代注记、删掉死出口；补 Android 成员路径的 JVM 测试；推送 `a3817f5`。

## 7. 证据

- 本轮探针与脚本：`/private/tmp/claude-501/-Users-mortred-Desktop-melo/e02f4818-201a-4300-b680-ef89814fc875/scratchpad/`（`turn-effects-probe.mjs`、`review-goal-probe.mjs`），桌面真实探针 `.tmp/codex-review-20261105/probe-b-run/`（`events.jsonl`、`console.log`、`reply.md`），夹具 `.tmp/codex-review-20261105/probe-b/`。
- Codex 自己的证据：`.tmp/recent-change-review-20261105/`、工作树 `.tmp/orchestration-review-fixes-20261105/`、`.tmp/task-evaluation-b-20261105/`、`.tmp/iphone-task-evaluation-20261105-cf8_8gxy/`。
