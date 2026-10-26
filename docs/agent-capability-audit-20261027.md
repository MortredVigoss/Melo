# Melo Agent 能力审计：工具覆盖与任务执行闭环（2026-10-27）

范围：源码基准 `72197e5`（master，2026-10-26），桌面安装 home `.tmp/melo-home-user`（Codex 连接，模型 `gpt-6.1-sol`），iPhone 0.7.12 (44)。只审计、不改代码。方法：工具注册表与能力策略实跑探针（不是读注释）、共享循环源码逐路径核对、真实运行记录统计（32 条执行场景、590 条审批记录、27 条搜索轨迹）、共享循环现有 184 项测试复跑（全绿）。真实记录只做计数，不引用对话内容。

## 0. 结论

1. **工具"全不全"**：桌面内建 34 个（主 Agent 普通任务可见 27 个，开 CDP 再加 6 个浏览器工具），加 4 个默认开启的免费 MCP（Playwright、AntV 图表、Markdown→PDF、Mermaid）和 4 个内建技能；手机 4 个共享工具 + 7 个设备工具（默认全关）。覆盖"读搜改文件、shell、网页读搜截图、浏览器操作、PDF/Excel、图片 OCR/处理、翻译、计算、历史/知识、提醒、委派"。**缺口集中在本机系统集成（日历 / 提醒事项 / 通讯录 / 邮件 / 备忘录 / 通知 / 系统截屏 / 打开 App）、结构化公共数据（地理编码、汇率、维基、辞典、学术）、文档生成（docx / pptx）和手机端免费搜索**。这些全部有不注册、不付费的做法（§1.4）。
2. **任务执行"做到一半停"**：10-23 之后的闭环（目标状态 + 候选检查 + 最多 2 次纠偏）在"用过工具"或"明确检索类"任务上是成立的，184 项测试覆盖了演唱会 / 导航 / 重试等场景。但有一条**未被覆盖的主路径：非检索类任务（修代码、整理文件、本地操作）里模型一次工具都没调就回"请告诉我 X"，检查器不会触发，回执直接记"已交付"**（§2.2 第 14 条，探针 A 实证）。这正是"明明有能力却自己停下来"的典型形态，而且界面上看不出异常。
3. 其余会停的路径里，三条值得排期：轮次上限 10 轮（含检查轮与纠偏轮，长任务实际只有 6–8 轮干活）到顶后用模板回复、不给进度总结；审批摩擦（真实记录 590 次里 240 次拒绝，拒绝后模型通常就停）；模型侧没有任何"先用工具、后问人"的操作指令，全靠事后检查兜底。
4. 上次（10-23）要求的两件事已落实：额外快速（extraFast / fastJudge）代码残留 0 处；"首轮必须搜"已取消，`requiredTools` 只剩"用户给了链接就必须读"和"导航必须用 phone_use"两种合理约束。

## 1. 工具调用能力

### 1.1 桌面内建工具（34 个注册，`src/tools/registry.js`）

| 类别 | 工具 | 需审批 | 能力键 | 备注 |
| --- | --- | --- | --- | --- |
| 系统 | `bash` | 每条命令过 FileSafetyGate（静默白名单只有 pwd / whoami / 版本探测 / which / type） | runCommands | 实际上什么都能做，但模型不知道本机有哪些可调用的系统能力 |
| 文件 | `file_read` `glob` `grep` | 否 | readFiles | |
| 文件 | `file_edit` `file_write` `file_delete` `file_move` `file_mkdir` | 是 | writeFiles | delete 为回收站两段式 |
| 网页 | `fetch_url` `web_search` `web_screenshot` | 否 | network | 搜索 = Playwright + Google，失败退 DuckDuckGo（经 Jina）；读页 = Jina Reader；天气走 wttr.in 快路径。全部免费无 key，但依赖本机 Chrome / 第三方免费服务的可用性 |
| 浏览器 | `browser_open` `browser_snapshot` `browser_close` `browser_wait_for` | 否 | network | 仅在用户开启 CDP（`MELO_CDP_ENABLED`）时可见 |
| 浏览器 | `browser_click` `browser_fill` | 是 | network | 同上 |
| 文档 | `pdf` `xlsx` | 是 | read/write | |
| 媒体 | `image`（OCR / 信息 / 处理 / 生成）`media_info`（yt-dlp）`media_api`（MusicBrainz / Last.fm / iTunes） | 否 | generateMedia / 读 | |
| 记忆 | `search_history` `read_history` `knowledge` | knowledge 是 | knowledgeMemory | |
| 实用 | `calculator` `translate`（Google 免费）`clipboard`（是）`device_location`（IP 定位）`reminder`（仅聊天内提醒） | 见前 | — | |
| Agent | `delegate`（`agent` 为旧别名） | 否 | delegate | 只有主 Agent 默认可委派 |
| 开发 | `development_job` | 是 | 三项 | 仅桌面来源（10-26 收紧） |

可见性探针（`filterToolsByCapabilities` → `selectStableTools` → `requestAllowsTool`，主 Agent 默认能力）：普通任务 27 个；开 CDP 33 个；用户说"不要联网" 23 个；用户说"不要用任何工具" 0 个；非主 Agent 32 个（无 delegate）。之外还会叠加 MCP 工具（按 Agent 白名单）和技能工具。

### 1.2 MCP、技能、连接器（本机实际状态）

- MCP 预设默认开启且已登记到主 Agent：`playwright`（完整浏览器）、`antv-chart`（25+ 图表）、`markdown2pdf`、`mermaid`。全部 npx 免费包、版本钉死；`browserless` 预设因 npm 无包保持禁用。用户自定义 `mcpServers` 为空。
- 技能：内建 4 个已启用（skill-creator / project-planner / connector-builder / artifact-curator）+ 1 个测试夹具技能。仓库旁的 `melo-skills-bundle`（docx、data-*、engineering-* 等）未接入本机。
- 连接器：只有旧式内置 id（openai-compatible / projects / artifacts / local-files / local-command），外部连接器 0 个。
- 能力策略（`src/domain/agent/capabilities.js`）：每个 Agent 默认七项能力全开（用户 10-22 决定），MCP / 技能 / 连接器按白名单；远端渠道（Telegram / Discord）审批类工具直接 `PERMISSION_NO_SURFACE`。

### 1.3 手机端

- 共享循环工具：`read_history`、`web_search`、`fetch_url`、`phone_use`（每轮最多 3 次，同任务不重复）。
- 设备工具 7 种（日历列 / 建、提醒事项列 / 建 / 完成、通讯录搜索、当前位置），**默认全关**（`DeviceToolPolicy`），用户在设置里逐项开。
- **手机没有免费搜索后端**：`web_search` 需要 Brave（要注册拿 key）或自建 HTTP 端点，否则路由直接 `SEARCH_UNAVAILABLE`；手机也没有桌面那套浏览器搜索回退。Codex 原生 Hosted Search 需要先跑验证探针，本机两条 Codex 连接都未验证通过。

### 1.4 缺口与免费补法（不注册、不付费）

下表按"补起来最划算"排序。"免费"指调用方不需要账号或 key；标 ★ 的是本机零成本、不经过任何第三方。

| 缺口 | 现状 | 免费补法 | 说明 |
| --- | --- | --- | --- |
| ★ 本机日历 / 提醒事项 / 通讯录 | 手机有、桌面没有；桌面只有聊天内 `reminder` | `osascript`（AppleScript / JXA）读写 Calendar / Reminders / Contacts，或 EventKit | 走 TCC 授权一次；手机端已有同名工具，可直接对齐工具 id |
| ★ 邮件 / 备忘录 / 信息 | 无 | `osascript` 操作 Mail / Notes / Messages（读、搜、起草） | 发送类必须审批 |
| ★ 系统通知 / 打开 App 或 URL / 系统截屏 | 无（`web_screenshot` 只截网页） | `osascript display notification`、`open`、`screencapture` | 低风险，建议只读类免审批 |
| ★ Spotlight 全盘检索 | `glob/grep` 限工作区 | `mdfind` | 用户显式要求时才越出工作区 |
| ★ 快捷指令 | 无 | `shortcuts run <名称>` | 让用户自己的自动化变成工具 |
| ★ 朗读 / 本地转写 | TTS 已有 Edge 免费音色；转写走 Whisper API（要 key） | `say`；whisper.cpp 本地模型 | 转写本地化后离线可用 |
| ★ docx / pptx 生成 | 只有 pdf / xlsx | `docx` / `pptxgenjs` 本地库，或接入旁边 skills-bundle 的 docx 技能 | 和现有 `xlsx` 同一形状 |
| ★ 结构化小工具 | `calculator` 覆盖数学 / 单位 / 日期 | 哈希、Base64、UUID、二维码（qrcode 库）、JSON/CSV 转换、正则测试 | 很小，可合并进 calculator 风格的"utility"工具 |
| ★ SQLite / CSV 查询 | 无 | Node 自带 `node:sqlite`（项目已在用） | 只读查询免审批 |
| ★ 定时 / 周期任务 | `reminder` 只能在聊天里提醒 | 本地调度（launchd 或进程内 cron），到点以任务形式触发 Agent | 真正的"到点自动做" |
| 天气 | wttr.in 快路径藏在 `web_search` 里 | Open-Meteo（无 key，逐小时 / 多日）、wttr.in | 建议独立成 `weather` 工具，手机也能用 |
| 地理编码 / 周边 / 路线 | 无 | Nominatim（OSM，无 key，1 次/秒需带 UA）、Overpass API（周边 POI）、OSRM 公共路线 | 导航类任务的"找场馆 / 找地址"就靠它 |
| 汇率 | 无 | Frankfurter（欧央行数据，无 key） | |
| 百科 / 结构化知识 | 只能靠搜索 | Wikipedia / Wikidata REST（无 key） | 稳定事实优先于网页搜索 |
| 辞典 / 国家信息 / 图书 | 无 | Free Dictionary API、REST Countries、Open Library | |
| 学术 / 技术社区 | 无 | arXiv API、Hacker News Algolia、GitHub 公共 REST（匿名 60 次/小时） | |
| 搜索引擎冗余 | Google（浏览器）→ DDG（Jina） | DuckDuckGo HTML / Lite 直连、SearXNG 公共实例、Wikipedia 搜索 | 减少对 Playwright + Google 的单点依赖 |
| 手机免费搜索 | 无后端即不可用 | 手机直连 DDG HTML + Jina Reader，或由桌面中继（桌面在线时） | 不需要 Brave key |
| 官方免费 MCP | 已有 4 个 | `@modelcontextprotocol/server-filesystem` / `-fetch` / `-time` / `-git` / `-sqlite` / `-memory`，DuckDuckGo MCP | 都是 npx 免费包，但与内建工具重叠，优先补上面的本机集成 |

明确不算"免费"、不建议默认依赖：Brave / Tavily / Serper 搜索 key（本机 config 里有空位）、Whisper API、MiniMax TTS、Browserless 云浏览器。

### 1.5 工具层的小问题（P2）

- `translate`、`media_api`、`media_info` 没有声明 `capability`，"不要联网"时仍可见（它们都会联网）；`device_location` 反而被当作联网工具隐藏。
- `development_job` 对模型默认可见；它只在用户已在面板创建作业时才有用，平时只是噪音。
- `web_search` 单点依赖本机 Chrome + Google 页面结构；Hosted Search 验证探针从未通过。
- 模型收到的工具描述是函数定义本身，**没有一份"本机还能做什么"的能力地图**（例如"可以用 osascript 读日历"）。bash 能做的事模型并不知道，所以不会去做。

## 2. 任务执行闭环

### 2.1 现在的链路

prepare（能力 / 请求策略筛工具、搜索路由计划）→ 模型轮（每轮 ≤ 32 个调用）→ 工具执行（审批、重复守卫、预算）→ … → 模型给出无工具调用的候选回复 → `goalCandidate` 决定要不要检查 → 检查轮（同一模型、无工具、只看观察 ID）→ `complete` / `continue`（最多 2 次纠偏，带原始目标与缺口反馈回主循环）/ `needs_user` / `partial` → finalize 写回执（`completion.outcome`）。委派成员、技能、iOS、Android 共用同一套判定（`shared/agent/goal.js`、`completion.js`、`turn.js`）。

硬限制（`shared/protocol/agent-loop.json`）：每轮 10 次模型请求（**检查轮和纠偏轮也计数**）；运行预算 20 分钟 / 120 次工具 / 40 万输入 token；同参数失败 2 次即本地拒绝；连续 3 轮全失败 `REPEATED_TOOL_FAILURE`；5 轮无进展 `NO_PROGRESS`；成员 8 轮 / 3.2 万 token / 委派深度 2；技能默认 6 轮；审批等待 120 秒。智能模式升档每轮最多 1 次，条件是模型主动请求、或轮数 > 4、或失败 ≥ 2。

### 2.2 会"停下来"的路径

| # | 触发 | 用户看到 | 评价 |
| --- | --- | --- | --- |
| 1 | 轮次上限 10（`turn.js` ROUND_LIMIT） | 固定模板"已达到工具执行上限"，没有进度总结 | **要改**：模型没机会汇报做了什么、剩什么；长任务实际干活轮只有 6–8 轮 |
| 2 | 剩余轮数 < 1 时不做检查（`goal.js` GOAL_CHECK_BUDGET） | 回答保留，回执"部分" | 与 1 同根 |
| 3 | 纠偏 2 次用完（GOAL_CORRECTION_LIMIT） | 回答保留，回执"部分" | 合理，但每次纠偏消耗 2 轮 |
| 4 | 检查结果不合规 / 不可用（GOAL_CHECK_INVALID / UNAVAILABLE / EVIDENCE_INVALID / COVERAGE_MISSING / NO_NEXT_STEP） | 回答保留，回执"未确认" | 合理的保守处理 |
| 5 | 检查判 `needs_user`（只允许歧义 / 偏好 / 权限 / 私有输入；`lookup_missing` 强制转 continue） | 明确问用户 | 正确 |
| 6 | 连续失败 / 无进展（REPEATED_TOOL_FAILURE / NO_PROGRESS） | 模板停止语 | 合理 |
| 7 | 同参数失败两次被本地拒绝（REPEATED_FAILURE） | 模型被告知换方法 | 正确 |
| 8 | 运行预算用完（BUDGET_EXHAUSTED） | "已达到运行预算，发送'继续'" | 合理；"继续 / 重试"能恢复原任务与当前能力 |
| 9 | 审批：每个写类工具和几乎每条 bash 都弹窗；120 秒超时或用户拒绝 → `PERMISSION_DENIED` 回给模型 | 模型多半回"需要你批准" | **要改**：真实记录 590 次审批里 240 次拒绝（bash 286、删除 80、覆盖写 55）；一次拒绝就断整条任务 |
| 10 | 能力拒绝（CAPABILITY_DENIED：能力关闭、子 Agent 无委派、MCP 未白名单） | 桌面有即时提升提示 | 合理 |
| 11 | 远端渠道无审批面（PERMISSION_NO_SURFACE） | 提示去桌面做 | 合理 |
| 12 | 用户说"不要用工具 / 不要联网" | 整轮隐藏工具 | 合理；重试轮会继承限制 |
| 13 | 搜索不可用（手机无后端；桌面 Chrome / Google / Jina 任一失败） | "搜索不可用"或退到 DDG | 手机端是硬缺口 |
| 14 | **非检索类任务，模型零工具就回"请告诉我 X"**（`goal.js` 第 38 行：未用工具且不是明确检索 → 直接 deliver） | 回执"回答已交付"，界面无异常 | **P0**：这是"有能力却停下"的主形态 |
| 15 | 模型在用了工具后放弃 | 进入检查，`lookup_missing` 会被推回去继续 | 正确（探针 C） |
| 16 | 成员 / 技能子循环到上限 | 成员返回 `GOAL_INCOMPLETE`，主 Agent 可能据此收尾 | 需要主 Agent 有"接着做"的指令 |
| 17 | 上下文预算超限 | 压缩一次后再超就报错 | 合理 |
| 18 | 模型侧 | `prompts.js` 的操作指令只有 5 条 ReAct 通则，没有"有工具先用工具、只在歧义时问人、结束前对照原始目标"的要求 | **P1**：全靠事后检查兜底 |

探针（`createCoreTurn` 实跑，工具集 glob/grep/file_read/bash/file_edit/web_search/fetch_url）：

| 场景 | 候选回复 | 结果 |
| --- | --- | --- |
| A 本地任务"把失败的测试修好"，零工具 | "需要你告诉我测试在哪个目录、用什么命令" | **不检查，回执 completed / ANSWER_DELIVERED** |
| B 检索任务"查明天墨尔本天气"，零工具 | "请告诉我你在哪个区" | 进入检查（会被判 continue） |
| C 同 A，但先调了一次 glob | 同 A | 进入检查 |
| D 闲聊"你好" | "你好！" | 不检查（正确） |

A 与 C 的差别只是"有没有碰过工具"。设计初衷是"普通自包含问答不加检查请求"（省一次模型调用），代价是把所有非检索任务的零工具回复都当成了普通问答。

### 2.3 真实记录

- 执行场景 32 条（10-14 → 10-24，14 天保留期）：完成 19 / 受阻 10 / 部分 3。13 条 `RELEVANT_READ_SOURCE_MISSING` 全部在 10-21 及之前，即 10-23 闭环上线前；其中 3 条实际读了 2/2 来源仍被判"部分"，是旧的 50% 词组相关度门槛误判。10-23 之后只有 3 条场景，全是零工具简单问答——**新闭环在本机还没有被真实多步任务检验过**。
- 工具使用：32 条里 11 条用过工具；bash 8、fetch_url 5、web_search 3、file_read 3、原生搜索 2、grep 2、file_edit 2、生图 1、file_write 1。
- 审批 590 条（10-07 → 10-19）：允许 350（几乎全是单次授权）/ 拒绝 240；bash 286、读 113、删除 80、覆盖写 55、移动 26。没有"本任务内始终允许"的使用痕迹。
- 搜索轨迹 27 条：23 成功 / 4 失败。
- 共享循环测试：goal / completion / continuation / research / conformance 184/184 通过。

### 2.4 问题清单与建议（供排期，不含代码）

| 级别 | 问题 | 建议 | 验收 |
| --- | --- | --- | --- |
| P0-1 | 零工具候选在非检索任务上不检查（§2.2 #14） | 把"是否检查"的条件从"用过工具 或 明确检索"改成"任务型请求 且 有可用工具"。任务型判定不要再加关键词表：可复用智能路由已有的判定输入（`needs.tools`）或一个与语言无关的信号——候选回复在向用户索要信息（问句 + 可用工具非空）。检查器本身已能判 `lookup_missing → continue` | 探针 A 必须进入检查并被判 continue；闲聊 D 仍不检查；新增夹具进 `shared/agent/continuation.test.js` |
| P0-2 | 轮次上限后模板回复、无进度（#1） | 到上限时保留 1 轮无工具"进度汇报"（已完成 / 未完成 / 下一步 / 需要用户什么），模板只作兜底；"继续"沿用现有恢复 | ROUND_LIMIT 场景回执含进度条目；夹具覆盖 |
| P0-3 | 10 轮含检查与纠偏，长任务不够 | 轮数按任务配置：主循环接入和成员一样的 `maxIterations`（8–20）用户设置，或智能模式按复杂度判定提升；检查轮不计入工具轮 | 合同字段不变形；双端一致性测试通过 |
| P1-4 | 审批摩擦（#9） | 任务开始时一次性征求"本次任务可执行：运行命令 / 改文件 / 删除"的范围授权（已有 session 级 always-allow 机制，默认改为按任务）；拒绝时把可替代方案回给模型而不是只回 denied；只读 bash（ls / cat / git status 等）进静默白名单 | 拒绝率可观测；拒绝后模型继续用其他方式 |
| P1-5 | 模型侧没有坚持完成的指令（#18） | `buildReActOperatingInstructions` 补三条，与检查器口径一致：公开可查 / 本地可读的信息先用工具取，不先问人；只在歧义 / 偏好 / 权限 / 私有输入时提问；回答前对照原始目标逐项核对 | 提示词测试 + 探针 A 在真实模型上的表现 |
| P1-6 | 成员到上限返回不完整，主 Agent 缺"接着做"的指令（#16） | 主 Agent 收到成员 `GOAL_INCOMPLETE` 时的默认动作是补做或换人，不是收尾 | 团队夹具 |
| P1-7 | 手机无免费搜索（§1.3） | DDG HTML + Jina 直连，或桌面中继 | 手机不配 key 也能 `web_search` |
| P2-8 | 能力地图缺失（§1.5） | 系统提示加一段"本机可用的系统集成"（随工具注册自动生成，不写死） | 提示词快照测试 |
| P2-9 | 工具标记不一致、`development_job` 噪音、搜索单点 | 给 translate / media_* 声明 network；development_job 仅有作业时可见；搜索加 DDG 直连第二路 | 审计规则 H 表追加 |
| P2-10 | 新闭环没有真实多步任务的运行证据（§2.3） | 用真实模型跑 5 个代表性任务（修测试、整理目录、查天气 + 导航、文档生成、委派调研）并留回执 | 执行场景里出现 `continue` / `complete` 决策 |

已确认不是问题：额外快速残留 0；首轮强制搜索已取消；`requiredTools` 只剩读链接 / 导航；检索类零工具候选会进检查；用过工具的候选一律进检查；取消与预算路径与"完成"分开。

## 3. 证据

- 工具 / 可见性探针与核心循环探针：本文 §1.1、§2.2 内联结果（`node --input-type=module` 实跑注册表与 `createCoreTurn`）。
- 真实记录：`.tmp/melo-home-user/desktop/execution-scenes/`、`permission-audit.sqlite`、`search-trail-log/`（只统计，不外传）。
- 测试：`node --test shared/agent/{goal,completion,continuation,research,conformance}.test.js` 184/184。
- 关联文档：[10-23 目标保持审计](agent-goal-completion-audit-20261023.md)、[10-23 实施方案](agent-harness-implementation-20261023.md)、[取消强制搜索方案](agent-loop-dehardcode-plan-20261023.md)。
