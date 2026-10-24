# Melo 全仓审计：写死、逻辑不清、UI 不统一 · 2026-10-24

范围：`src/`、`shared/`、`desktop-ui/`、`ios/Melo/`、`desktop-app/`、`scripts/`（排除测试与 `dist`），基于 2026-10-24 主检出工作树（Codex 的智能模式 / 目标检查改动正在进行中，`desktop-ui/smartRouting.js`、`shared/agent/goal.js` 已出现，本报告不评价这些在途文件）。只读审计，未改代码。合并了 10-23 的三轮结果（agent loop / memory、全局写死、额外快速）并新增"逻辑不清"与"UI 不统一"两部分。

## 0. 执行摘要（按伤害排序）

| # | 问题 | 影响 | 位置（代表） |
|---|---|---|---|
| 1 | 模型能力 / 行为按模型名正则猜 | 换提供方即错：非名单内模型一律"不支持图片"，推理强度按名字判 | `src/media/visionCapability.js:1-13`、`src/shared/modelCatalog.js:17-22`、`src/openai.js:475` |
| 2 | 关键词权重表 + 必需工具 + 回执门槛三道机关强制"先搜" | 模型凭稳定知识直答被判阻塞；Codex 在途改动已保留回答，但 `research` 仍来自关键词表 | `shared/agent/retrieval/searchRouter.js:10-26`、`shared/agent/search.js:84-102`、`shared/agent/goal.js:34` |
| 3 | 服务端文案语言靠"有没有汉字"决定，服务端不知道界面语言 | 英文界面显示中文事件名（21 个无翻译行）、远程渠道英文用户收到中文回复（42 处） | `shared/agent/turn.js:144`、`src/services/chat/execution/*.js`、`src/services/remote/discordVoiceRuntime.js:157-177` |
| 4 | 完成状态分类粒度错 | 调用计算 / PDF / MCP 的轮次永远"部分完成"；research 要求回复原样含 URL | `shared/agent/completion.js:38-41,60-86`（Codex 在途已改副作用判定） |
| 5 | 工具可见性与意图五分类靠正则 + 字数 | >80 字一律 factual；算术 / 翻译整轮不给工具；pdf / 图片工具靠关键词露出 | `src/retrieval/intentRouter.js:77-123`、`shared/agent/retrieval/requestPolicy.js:82-95`、`src/tools/toolGroups.js:29-31` |
| 6 | 本机服务端口 / 地址写死，前端用端口正则判状态 | 改端口即错；`app.js:612` 用 `/127.0.0.1:7860/` 判断自定义声音是否激活 | `src/server.js:1046`、`src/http/ttsRoutes.js:141`、`desktop-ui/app.js:612`、Ollama 11434 ×5 |
| 7 | 身份 / 角色 / 别名写死 | 删改内置 Agent 后不能当任务 owner；团队预设 id 写死；别名硬加 `melo` | `src/domain/task/taskService.js:25`、`src/agents/team.js:15-19`、`src/services/remote/telegramAddressHelpers.js:62` |
| 8 | 两套搜索规划器并存，12 个 route 名，搜索适配层"无人被迫迁移" | 路由决策分散、难解释；`legacy-reader` / `browser-search` 等分支长期并存 | `src/services/chat/execution/prepareNode.js:152,400`、`src/services/search/searchTask.js:1-16` |
| 9 | 18 个只认 `=== '1'` 的环境开关改变行为，7 个无文档、全部不在设置页 | 用户不可见的行为分叉（浏览器工具、工具链历史、上下文位置、离线模式…） | 见 §3.3 |
| 10 | 桌面 UI：3 套反馈通道、13 个表单未接共享编辑条、6 种时间格式、35 处 JS 内写死颜色、CSS 500+ 原始色值、z-index 3→10000 | 设计语言不统一、改主题 / 改语言时漏项 | 见 §4 |

---

## 1. 写死（hard code）

### 1.1 模型名与提供方
- 能力按名字：`src/media/visionCapability.js:1-13`（gpt-4o / gpt-5 / gpt-6 / claude-3 / gemini / qwen-vl）；推理强度：`src/shared/modelCatalog.js:17-22`、`src/openai.js:475`；「额外快速」挑小模型的名字正则 `src/judge/fastJudge.js:44`（待随功能下线）。
- 默认模型名散在 6 处：`modelCatalog.js:2-12`（gpt-6.1-sol / gpt-6-astra / gpt-6-luna / gpt-4.1 / gpt-4.1-mini / llama3.1）、`src/shared/llmProviders.js:3`、`ios/Melo/ChatGPTAccount.swift:156`、`ios/Melo/ImageWorkflow.swift:38`（gpt-image-2）、`src/images/imageSettings.js:15`（gpt-image-2.5-sunburst）、`src/tts.js:47`（speech-01-turbo）、`src/media/extractors/audioExtractor.js`（whisper 相关 59 处）。
- Codex 端点被当作唯一合法值校验：`src/judge/fastJudge.js:30`。
- 建议：能力标志进模型目录（`/models` 元数据或用户勾选），代码只读标志；默认名只留 `llmProviders` 一处。与 `docs/smart-model-routing-plan-20261023.md` §3.1 同一件事。

### 1.2 语言
- 回复模板按用户消息的 CJK 正则选中 / 英：`shared/agent/turn.js:144`、`src/services/chat/execution/invokeModelNode.js:525`、`shared/agent/completion.js:113-117`；预算用完模板只有中文（`shared/protocol/agent-loop.json budget.replyTemplate`）；空回复兜底只有英文（`finalizeNode.js:110-112`）；`invokeModelNode.js:85` 只有中文。
- 服务端发给 UI 的中文事件名 32 个，21 个没有翻译行：压缩早期对话、工具结果已压缩、运行预算已用完、执行已停止、整理回答与引用、核对任务交付、核对图片结果、图片输入准备、对话摘要降级 / 已恢复、早期话题原文、保存回答、OCR 交叉核对、原有连接、本地模型、自定义兼容服务、豆包 · 火山方舟、通义千问 · 百炼、项目、已删除的项目、张三（fixture 名泄到正式代码）。
- 42 处服务端回复 / 错误文案中文写死（非事件）：`discordVoiceRuntime.js:157-177`、`operationLedger.js:38-39`、`src/tools/workspace.js:5`、`executionPipeline.js:34-87`、`imageTask.js:297,361`…
- `interfaceLanguage` 只在 `src/domain/settings/localPreferences.js:3` 定义，`src/` 无消费者；默认界面 / 语音语言 zh-CN（`localPreferences.js:3-4`、`desktop-ui/voiceInput.js:80`）。
- 提示词层只认中英：`src/services/chat/systemPrompt.js:86-112`（"简版清单""一句话总结"、远程 ~600 汉字）、`src/services/chat/messageBuilder.js:195-199` 画图意图正则、`src/images/imagePrompts.js:22-24`；界面却支持 ja / ko / es。
- 建议：事件只发 id + 参数由 UI 翻译；回复文案按"对话语言"三级选（Agent 设置 → 用户消息语言 → 界面语言），远程渠道按频道语言。

### 1.3 端口、地址、路径
- F5-TTS 7860：`src/server.js:1046,1107`、`src/http/ttsRoutes.js:141`、`desktop-ui/app.js:612`（正则判状态，bug 级）。
- Ollama 11434：`src/config.js:14`、`src/tts.js:102`、`audioExtractor.js:66,91`、`src/memory/offline/compact.js:24-26`（另有 lmstudio 1234、llamacpp 8080）、`src/memory/status.js:255`。
- 转写服务 = 主端口 + 1（`desktop-app/main.swift:1120`、`audioExtractor.js:298` 注释）；`desktop-app/main.swift:34` 写死源码目录 `Desktop/melo/Melo Desktop Project`。
- 仓库里出现本机绝对路径：`scripts/android-pet-assets.js:11` `DEFAULT_SOURCE = '/Users/mortred/Documents/New project/desktop-pet'`；`scripts/install-desktop-app.sh:12,21` `~/Desktop/melo/…`。
- 建议：本机服务端口进 config 带默认；前端读配置 URL；仓库内不出现用户目录。

### 1.4 身份、角色、别名
- `'main'` 兜底 47 处；`src/domain/task/taskService.js:25` `TASK_OWNERS` 固定四个 id；`src/agents/team.js:15-19` 团队预设成员 id + 中文角色名；默认 Agent 名英文写死 `src/domain/agent/agentLibrary.js:101-142`。
- 渠道别名硬加 `melo`：`telegramAddressHelpers.js:62`、`discordParsing.js:196`；语音唤醒词注释写死 "懂王"（`discordVoiceSession.js:397`）。

### 1.5 agent loop / 工具 / 记忆（10-23 第一轮，摘要）
- 循环：`agent-loop.json` 10 轮 / 32 调用 / 20 分钟 / 40 万 token / 120 次工具（env 可改）；`shared/agent/turn.js:24` 连续失败 3 / 无进展 5（contract 外）；子 Agent 8 轮 / 深度 2（`subAgent.js:37-38`）；工具超时 60 s（`executor.js:34`）；证据 8 条、观察 128 条；只有第一轮流式（`invokeModelNode.js:243`）。
- 搜索：权重表 `searchRouter.js:10-26`；`search.js:84` 死关键词；`search.js:95` / `searchRouter.js:299-317` "先搜"提示词；`search.js:102` web_search 必需；Hosted 回执缺失原替换文（Codex 在途已改）。
- 记忆：`contextWindow.js:14-23`（80k / 60k / 6 / 3）、`sessionMemory.js:34-43`（4 / 12 / 80 / 6）、`frame.js:28-32`、`chatThreadContext.js:38-40`、`agentMemoryContext.js:26-27`、`store.js:594-596`（14 天 / 0.5 / 常青三类，env 可改）；`factPolicy.js:13-16` 纠正主题只认三种；`heuristics.js:50-72,93-101` 澄清词表与"≤36 字即上下文回复"。

### 1.6 数字常量
- 模块顶部无任何 env / config 覆盖的常量 227 个；`MELO_*` 环境变量 116 个。
- 用户可感知的几组：搜索 `webSearchTool.js:152-175`（8 条 / 25 s / 14 s / 6000 字 / 缓存 2 h，时效 15 min）、`fetchUrlTool.js:21-28`（20000 字 / 30 s）、`socialLinkReader.js:104-108`；渠道 `telegramReplyScore.js:40`（0.55、灰区 0.30–0.55）、轮询 12、离线积压 60 s；后台 dreaming 6 h / 24 h / 空闲 10 min / 启动 3 min、预压缩 0.7 / 120 s、文件安全闸 120 s / 5 min。
- 建议分三档：用户可感知 → 设置页；运维类 → config.json 带默认；实现细节 → 集中 `limits.js`。

---

## 2. 逻辑不明确 / 重复 / 矛盾

### 2.1 同一件事多套实现
- 搜索规划两套并存：`prepareNode.js:152` 先 `buildSharedSearchPlan`（`shared/agent/search.js planRequest`），`:400` 无 `sharedPlan` 时再走旧 `constrainSearchPlan`；`search.js:62` 内部又调用旧路由 `router.buildSearchPlan` 取 `lookup`；提示词由 `src/retrieval/searchRouter.js` 按有无 `sharedPlan` 二选一。route 名共 12 个（none / fetch-url / social-link / browser / phone / hosted-search / http-search / legacy-search / browser-search / melo-web / codex-native / unavailable），`unavailable` 有 7 种 reason。
- 搜索结果适配层 `src/services/search/searchTask.js`（95 处 legacy / compat）自述"没有生产调用方被迫迁移"（`:13-16`），legacy 输出与结构化 evidence 长期并行。
- 意图分类两套：桌面 `src/retrieval/intentRouter.js`（规则 + 模型），手机 `ios/Melo/AgentLoop.swift` `PhoneIntent`（同一份 contract 正则但独立实现）；完成回执由共享 core 生成，各宿主再各自决定是否交付文本。
- 问候 / 确认词表至少 5 份且互不相同：`prepareNode.js:175`（含 ok / okay / 好 / 好的）、`prepareNode.js:415`（不含 ok / 好的 → 同一轮 `allowLiveSpeech` 与 `skipMemory` 判定不一致）、`searchRouter.js:178`、`requestPolicy.js:69`、contract `intent.patterns.shortAck / contextualReply`。
- CJK 判定 6 种范围写法（`一-鿿` ×5、`㐀-鿿` ×3、含日韩的宽范围 ×3…），同一句话在不同模块可能被判为"是 / 不是中文"。
- `escapeHtml` / `escape` 在 `desktop-ui` 有 12 个文件各自定义（共 16 份）；URL 正则在 `src/` + `shared/` 定义了 46 次。

### 2.2 行为由隐藏条件决定
- 回答模型：`chatExecutionRunner.js:119-124` `conversationModelSelected ? config.model : activeLlmProfileId ? '' : env.MELO_MODEL`，再由 `invokeModelNode.js:50` 叠 Agent 模型；核验模型 `verifier` 永远等于 `config.model`（Agent 用别的模型时核验用的却是默认模型）。
- 工具整轮消失：`requestPolicy.js:82-95` 算术 / 翻译 / "只凭上下文" → `mode: none`，模型连 calculator 都看不到。
- 图片快路径：`imageEditFastPath.js:267-269` "换背景" + 有图 → 绕过整个 ReAct 栈，失败才回落；用户看不出走了哪条路。
- 工具组一旦激活永不收回（`toolGroups.js:69-73`，按对话持久化）；浏览器工具只在 `MELO_CDP_ENABLED=1` 时存在。
- 只在第一轮流式输出，调过工具后的最终回答整段到达（`invokeModelNode.js:243`）。

### 2.3 隐藏的环境开关（18 个 `=== '1'` 开关）
`MELO_CDP_ENABLED`、`MELO_TOOL_CHAIN_HISTORY`、`MELO_TURN_CONTEXT_IN_SYSTEM`、`MELO_OFFLINE_ONLY`、`MELO_DISABLE_MEDIA`、`MELO_DISABLE_EXTERNAL_WEB_READERS`、`MELO_TOOL_TRACE_ALWAYS`、`MELO_FUNCTION_CALLING`、`MELO_TEST_MODE` 及 9 个 debug 开关。其中 `MELO_TURN_CONTEXT_IN_SYSTEM`、`MELO_DISABLE_MEDIA`、`MELO_CLASSIFIER_MODEL` 在 docs 零提及；全部不在设置页。建议：行为类开关进 config + 设置页"高级"，debug 类集中一份文档。

### 2.4 体量与可维护性
- `desktop-ui/app.js` 6881 行、`webSearchTool.js` 2812、`memory/store.js` 2625、`chat/controller.js` 1621、`openai.js` 1511、`socialLinkReader.js` 1451、`bashRiskParser.js` 1374、`server.js` 1347、`fileSafetyGate.js` 1328。
- 正式代码只有 3 处 TODO —— 问题不在标注，而在"audit #N / bug audit Tn"式补丁注释堆叠（`invokeModelNode.js` 一个文件里 9 处），逻辑靠注释串联。

---

## 3. UI 不统一

### 3.1 桌面（desktop-ui）
- 反馈通道 3 套并用：`showError` 71 处、`showFlashToast` 10 处、页面内 `role="status"` 文本 23 处（`aria-live` 只有 9 处）；外加原生 `window.alert`（`imageControls.js:224,229`）和 `window.prompt`（`features/chat/controller.js:441`，且为英文硬编码 "Paste a link to attach to this chat"）。
- 设置编辑：共享 `EditSession / renderEditActions`（编辑 / 保存 / 取消）只有 7 个模块在用；13 个表单仍是裸 `type="submit"`：artifact-create / update、command-run、connector-config、file-save、model-config、project-book-create、project-create / update、skill-custom-create / update、task-create、task-pricing。
- 页头两种：`h1.page-title compact`（app.js、viewThread、两个 view.js）与 `h2.pane-title`（11 个模块）；小节标题 `subsection-title` 同时用 h2 和 h3；卡片标题 `card-title` 同时用 h2 / h3。
- 按钮：`small-button` 161 处一统天下，另有 chip-button / section-button / ghost-button / composer-icon-button / settings-save-button / settings-edit-button 等 13 种类名，没有主次按钮体系。
- 空状态文案三种口吻："还没有…"（5）、"没有…"（8）、"暂无…"（1）。
- 术语：同一概念 资料（27 键）/ 知识（11）/ 文档（2）；对话（78）/ 聊天（10）/ 会话（2）；工作区（8）/ 目录（15）。
- 时间格式 6 种写法：`toLocaleString()` ×3、`toLocaleString(currentLanguage())` ×2、`formatTime()` ×2、`toLocaleTimeString()`、`toLocaleString('en-US')`、`Intl.DateTimeFormat`。
- 颜色：JS 里写死 35 处（`neuralSatellite.js:2-6` 五个模块色、`executionScene3D.js` 灯光色、`src/shared/executionScene.js:7-11` 模块色与坐标）；CSS 原始色值 `executionPanel.css` 114、`neural.css` 113、`neuralGlass.css` 83、`styles.css` 58、`modelPresentation.css` 48（`tokens.css` 只有 15），`var(--)` 477 处 —— 主题换色会漏一半。
- `!important` 37 处；`z-index` 取值 3 / 4 / 5 / 6 / 8 / 9 / 10 / 40 / 50 / 60 / 80 / 90 / 100 / 1000 / 9000 / 9999 / 10000；`font-size` 字面值 50 种。
- 内联 `style="` 14 处（app.js 3、neuralShell 2、memory/viewPane 2…）。
- `launchScreen.js` 是经典脚本，i18n 门禁已允许例外，仍含中文硬编码。

### 3.2 手机（iOS）
- `.font(.system(size:` 26 处（`ContentView.swift` 17）而非语义字体；`Color(hex/red:` 26 处原始色；`Text(verbatim:)` 17 + 插值 `Text("\(…)")` 16 处绕过本地化（`AgentEditor.swift:102`、`CapabilityElevationViews.swift:73-100`）。
- 与桌面的术语需对表：桌面 10-22 改为「知识库 / 成果库」「这台电脑上」，手机对应「这台手机上」；资料 / 知识 两词在两端仍混用。

### 3.3 跨端
- 执行事件名由服务端中文直出，桌面有翻译行的能译，手机场景包直接显示；缺行的 21 个两端都裸露。
- 桌面 `interfaceLanguage` 五语，手机 `InterfaceLanguage` 枚举（`InterfaceLanguage.swift:9`）各自维护。

---

## 4. 建议的处理顺序（可直接转成实施方案）

1. **语言与事件**（§1.2 + §3.3）：事件改 id 化 + 翻译行补齐；回复文案按对话语言；把 `[一-鿿]` 判定收敛为 contract 里的一份 `cjkPattern`。
2. **模型能力进目录**（§1.1）：随智能模式 P1 一起做。
3. **端口 / 路径进配置**（§1.3）：小改动，含 `app.js:612` 正则与 `scripts/android-pet-assets.js:11`。
4. **搜索规划合一**（§2.1）：保留 `planRequest`，旧路由只剩提示词渲染；`searchTask` 适配层要么完成迁移要么删除。
5. **UI 体系**（§3.1）：反馈通道合一（toast + 页面状态两种）、13 个表单接共享编辑条、页头 / 标题 / 按钮层级定一张表、空状态与术语统一（资料 / 对话 / 工作区）、时间格式统一 `formatTime(currentLanguage())`、颜色全部进 `tokens.css`。
6. **开关与常量**（§1.6 + §2.3）：行为开关进设置页"高级"，常量分三档归位。
7. **身份 / 角色**（§1.4）：owner 与团队预设改读 agentProfiles。

## 5. 方法与未覆盖

- 以 grep / 读码为主，统计数字来自本次扫描（可用相同命令复现）；行号对应 2026-10-24 工作树。
- 未覆盖：Android 工程、`shared/agent/dist` 产物、测试代码、`voice-packs`、桌宠 `desktop-pet/` 上游源码。
- Codex 在途改动（目标检查、智能模式 P0/P1）落地后，§1.5、§2.1 中与之重叠的条目需复核。
