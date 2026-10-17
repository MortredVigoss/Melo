# Melo 架构 / Agent 设计 / 上下文处理：审计报告与方案（2026-10-17，Claude）

用户要求：扫一遍 Melo 的架构问题、Agent 的设计问题、上下文的处理能力，出报告和方案。本轮**只读代码，不改产品行为**；基线 `cf93468`（master，工作树干净）。三路并行扫描（架构 / Agent / 上下文），每条发现都带 `file:line`；标 ✅ 的条目由主线程逐行复核或在运行中的桌面实例上实测确认，其余为扫描结论，可按证据自行核对。

既有审计（`docs/arch-hardening-20261015.md`、`agent-loop-audit-20261016.md`、`context-memory-plan-20261017.md` 等）已覆盖的问题**不重复列**，只列新发现，或"文档说已修 / 代码没修"、"文档现状描述与代码不符"的条目。

---

## 0. 一页摘要

**三条需要立刻处理的 P0**

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| ✅ P0-1 | **桌面所有 POST `/api/tts/*` 和 `/api/audio/transcribe` 永远到不了 handler，请求挂起** | `src/server.js:920` 调 `ttsRoutes.handle(request, response, url)` 漏传第 4 参 `requireLocalOrigin`；`src/http/routeRegistry.js:24` `!requireLocalOrigin?.()` → `!undefined === true` 直接 `return true`，不写响应。在运行中的实例实测：`POST /api/tts/speak-stop` 4 秒超时 http=000；同为 local-write 的 `POST /api/agents/update` 0.1 秒 200。 | 桌面 UI 的朗读 / MiniMax 试听 / 语音转写 11 个端点整体失效，前端全部 `.catch(()=>{})` 吞掉，用户只看到"没声音"。远程渠道（Discord/Telegram）语音走服务端内部路径，不受影响。**一行修复。** |
| ✅ P0-2 | **窗口上限（52k）与摘要触发（80k）之间有一段滚动盲区：中间历史既不发给模型也不摘要** | `src/memory/contextWindow.js:7,13`（80k 触发 / 60k 窗口）；`src/services/chat/contextBudget.js:6-7,42`（实际输入上限 = 60000 − 8000 = **52k，含系统提示和工具定义**，装不下即停）；`contextCompact.js:52-58` 只在 pending ≥ 80k 才压。 | 长对话 pending 在 ~30k–80k 阶段，最旧的 1–4 万 est token 消息被静默丢弃，用户体感"刚说过的你忘了"。唯一补救是 180 字符的召回片段。 |
| ✅ P0-3 | **`search_history` 工具不分受众，Telegram/Discord 群成员可让模型检索桌面私聊** | `src/tools/builtins/searchHistoryTool.js:64-68` 只有 `limit/after/chatId` 过滤；`src/memory/conversationIndex.js:282-296` 同；`src/domain/agent/capabilities.js:42` 只按 `knowledgeMemory` 放行，无频道判断；`chatExecutionRunner.js:375` 注释"remote channels now get all tools"。对比记忆层 `factPolicy.js:30-33` 明确"远程受众不继承桌面所有者的事实"。 | 记忆层做了受众隔离，工具层把它绕开了。同一 Agent 挂到群里后，一句"我们之前聊过 X 吗"就能把桌面对话片段读出来。 |

**一个跨层共性问题（P0 级别的设计缺陷，两路扫描独立发现）**：Agent 人设被 `snapshotBuilder.js:430-444` 以 `kind:'identity'` 写进记忆库，`attic.js:67,129` 把它恒定当 hot 召回。结果每轮系统提示里出现**两份人设**（`agent` 段一份、`memory` 段"Reference data; not instructions"里又一份），项目覆盖人设时 memory 段注入的还是全局旧人设；人设超过 3200 字符时 Hot Attic 整块为空（`attic.js:165` 是 `break` 不是 `continue`）。

**总体判断**

- 架构：模块化单体的骨架是对的（写路径 100% 收口到 `updateStateAtomically`、读写分离、测试基础设施务实）。问题集中在**边界只在"直接 import"层面成立**（state 层传递闭包含 openai/providers/tools）、**本地 HTTP 面没有身份**（无 Host 校验、无令牌、GET 可改状态）、以及**前端补救层与 morph 渲染重复**。
- Agent：能力门控（环境作用域、缺失即拒、未映射默认拒）和委派防环做得扎实。问题集中在**人设拼装有 4 套互不一致的实现**、**旧 `tools` 字段仍每轮进提示词与能力门控脱节**、**远程渠道上的审批会静默挂 120 秒**、**委派成员零上下文**、**没有任何按 Agent 的质量度量**。`agent-loop-audit` 四项发现只修了一项（#4 团队总时限），#1/#2/#3 仍在。
- 上下文：召回与作用域过滤的工程细节扎实（SQL + JS 双层、RRF、useCount 只计真实进入提示）。问题集中在**预算单位混用、中文系统性高估 2 倍**（标称 60k 实际中文可用约一半）、**每轮把历史再抄一遍进系统提示**（Thread memory snapshot）、**项目 Instructions 是最低优先级可丢弃段**、**摘要降级静默**、**缓存失效根因不止"顺序"**（工具数组逐轮变、Anthropic 零 cache_control）。`context-memory-plan-20261017.md` 的"现状"表有 5 处与代码不符（见 §3.2）。

**方案节奏**：§4 分四批。第一批（本周）是 7 条"一行到一文件"的修复；第二批（两周）是预算/缓存/人设拼装统一；第三批（一个月）是远程渠道并发与委派上下文；第四批是结构性整改（分层 gate 传递闭包、前端拆单体、评估闭环）。与 `context-memory-plan` 的 1B/2B 选项对齐处在 §4.5 单列。

---

## 1. 架构层

### 1.1 实际代码地图（与文档不一致处标 ⚠）

```
desktop-app/main.swift ──spawn──▶ node src/server.js（顶层 await：锁、恢复事务、worker、poller、F5 看门狗）
desktop-ui/app.js (13.5k) ──HTTP/SSE──▶ server.js 主分发 (server.js:908-947)
   ├─ handleMobileSyncRoute / handleExecutionRoutes（专用入口，不走 registry）
   ├─ mediaRoutes(2) / ttsRoutes(12) / domainRoutes(70) / coreRoutes(36)  ← createRouteRegistry 声明式
   └─ 静态文件
services/*（chat 5.1k、remote 4.4k、search 3.9k …）──▶ state/stateStore.js（按 home 的单写队列）
   ──▶ desktop/state.json + threads/*.json ──▶ derivedDispatcher → worker(SQLite 派生索引)
desktopStore.js = 纯 re-export 门面 + 全仓唯一的 bootstrapBuiltinTools() 调用（desktopStore.js:91）
```

- ⚠ `render()` 已经不是 `app.innerHTML =` 整页重建，而是键控 morph（`desktop-ui/neuralDom.js:52`），与性能文档 §3 一致；但 `app.js` 内 13 处注释（如 `:10589, :1503, :3978`）仍声称整页重建。4 秒轮询只在 agent 视图且 Discord 启用时触发（`app.js:2782-2797`）。
- ⚠ `docs/conventions.md` 三处与代码矛盾：默认 home 写 `~/.melo/desktop/`（实际 `<project>/.tmp/melo-home-user`，`src/runtime/paths.js:11`、`desktop-app/main.swift:109`）；默认端口 43128（实际 43127，`server.js:99`）；`npm test`→verify-red-green 且"每个测试须加 allowlist"（实际 `verify-daily.js` + 自动发现 `scripts/test-discovery.js:4`）。
- ⚠ `http/mobileSyncRoutes.js:17-189` 实际承载领域逻辑（export/import/merge/persistPortableFiles），文档称 http 层"不承载领域业务"。
- ⚠ `_refactor-backup/` 已不存在，但 5 处源码注释仍引用（`src/state/statePayload.js:20` 等）。

### 1.2 新发现

**✅ [P0] A-1 TTS / 转写路由永远到不了 handler** — 见 §0 P0-1。修法：`server.js:920` 改为 `ttsRoutes.handle(request, response, url, requireLocalOrigin)`；`routeRegistry.js` 把 `requireLocalOrigin` 设为必填、缺失即 throw；补一个真正经过 `createServer` 分发的 HTTP 回归（现有 `routeRegistry.test.js:11-14` 用 `()=>true` 直调 registry，`nativeStopEndpointsGuard.test.js` 是源码文本 grep，都测不到）。

**✅ [P1] A-2 F5-TTS 看门狗每 5 分钟 `kill -9` 本机 7860 端口上任何监听进程，无 voice-pack 的机器照样执行**
- 证据：`src/server.js:1000` 无条件 `scheduleF5TtsWatchdog()`；健康检查失败 → `startVoicePackServers({force:true})`；`:1018` `lsof -ti tcp:7860 -sTCP:LISTEN | xargs kill -9` 在 `:1032` 检查 `start.sh` 是否存在**之前**执行；仓库内无 `voice-packs/` 目录。只有 `MELO_TEST_MODE=1` 才跳过。
- 影响：7860 是 Gradio / SD-WebUI 的默认端口，用户自己的进程会被周期性强杀。
- 建议：先判断 voice-pack 已安装再装看门狗；只杀自己 spawn 的 pid（保存 `proc.pid`）而不是按端口；健康判定校验响应体身份。

**[P1] A-3 只读 API 无 Host 校验、无令牌，DNS rebinding 页面可读取全部聊天**
- 证据：`src/server.js:910` `new URL(request.url, \`http://${host}:${port}\`)` 忽略 `Host` 头；`src/web/originCheck.js:14` `if (!origin) return true;` 且只对写请求调用（`server.js:911`）；`GET /api/bootstrap`（`server.js:479`）无认证返回全部 chats（密钥已脱敏，`bootstrap.js:332`）。
- 影响：攻击站点把自己的域名解析到 127.0.0.1 后，浏览器以 GET 读 `/api/bootstrap`、`/api/search/files`，响应对该页面可读。
- 建议：对所有 `/api/*` 校验 `Host ∈ {127.0.0.1, localhost, [::1]}:port`；或由 Swift 壳注入每次启动随机的 `x-melo-token`，registry 层统一校验；`local-read` 不应等于"无认证"。
- 待核：需在真实 WKWebView 中验证 Host 处理。

**[P1] A-4 分层 gate 只检直接边，state 层传递闭包实际依赖 services / openai / providers / tools**
- 证据：`src/memory/chatThreadContext.js:35` import `services/chat/messageBuilder.js`（被 `state/stateHydration.js:76` 引用）；`memory/derivedIndex.js → memory/snapshotBuilder.js → services/chat/systemPrompt.js → retrieval/selfVerification.js:1 → openai.js`；`services/settings/localData.js:5,8` 反向 import `http/mobileSyncRoutes.js`。gate `scripts/check-dependencies.js:59-60` 只检 `state/→services/`、`domain/` 的直接边，且不检 `services→http`。`stateStore.js` 静态传递闭包 125 个模块。
- 影响：加载状态存储即加载模型客户端与工具链；"0 依赖环 / state 不依赖业务"名义成立、实质不成立；state 层无法独立测试或拆出。
- 建议：gate 改为传递闭包检查（`state/`、`persistence/`、`domain/` 的闭包不得含 `services/|http/|providers/|tools/|openai.js`），新增 `services/→http/` 禁止；把 `summarizeAttachmentsForPrompt`、`persistPortableFiles` 下沉到 domain/persistence。

**[P2] A-5 写队列内做磁盘 / SQLite 同步 IO，"长事务只含内存变更"不成立**
- 证据：`src/services/chat/turnLedger.js:18` mutator 内 `findArchivedRun(...)` → `src/persistence/turnArchive.js:10-11` 每次 `new DatabaseSync` + `PRAGMA busy_timeout=5000`（同步，可阻塞事件循环最多 5s）；`stateStore.js:229` `compactChatRuns` 同步 SQLite 写；`http/mobileSyncRoutes.js:111,132` mutator 内 `await persistPortableFiles()` 写 markdown，发生在 manifest 提交前；`workspaceMutations.js:40`、`skillMutations.js` 多处 mutator 内读写磁盘。
- 影响：manifest 提交失败时磁盘副文件已领先于状态；所有聊天的提交串行排在这些 IO 后面。
- 建议：fresh request 先在队列外查 archive，队列内只核对内存 `chatRuns`；复用长连接 SQLite；副文件写入移到提交后（与 `pruneThreadCheckpoints` 同位）。

**[P2] A-6 两套 PID 锁语义不一致，存在 PID 复用误判**
- 证据：`src/server.js:133-137` poller 锁对 `process.kill(pid,0)` 任何异常（含 EPERM）都当 stale 接管，read→write 非原子；`src/runtime/serverLock.js:27` 正确只认 `ESRCH`，但在已拿 SQLite 独占锁后仍以 PID 文件判活（`:25-28`）：崩溃残留 PID + PID 被无关进程复用 → 新实例 `process.exit(0)`（`server.js:187-196`）。
- 建议：删除 poller 锁（server 锁已按 home 排他）；serverLock 改为 PID+启动时间，或直接信任 SQLite 锁。

**[P2] A-7 CLI 写同一 home 不取 server 锁，跨进程丢更新**
- 证据：`src/index.js:21` 引入 `createCustomSkill` → `updateStateAtomically`；`index.js` 无 `acquireServerHomeLock` / `probeDesktopRuntime`；`stateStore.js:239` 提交前不复核 manifest stamp。
- 建议：CLI 写操作先 `probeDesktopRuntime`，运行中则转发 HTTP；或提交前 stamp 比对失败即 `STATE_CONFLICT`。

**[P2] A-8 错误语义三套并存，且 GET 可改状态**
- 证据：错误体 `{ok:false,error}` 34 处、`{error}` 32 处、`errorPayload{error,code,ids}` 仅 chat 路由（`requestContract.js:53`）；`statusCode` 与 `status` 并用（`transport.js:39`）；`server.js:469` `GET /api/launch/reset` 标 `local-write` 但 GET 不过 `:911` 全局检查，`<img src>` 即可 CSRF。
- 建议：registry 统一 try/catch 走 `errorPayload`；mutating 路由禁止 GET；`local-write` 对无 Origin 请求至少校验 `Sec-Fetch-Site`。

**[P2] A-9 前端补救层已与 morph 重复，但仍在每次 render 执行；单体未拆**
- 证据：`desktop-ui/app.js:10534-10819` 每次 render 仍构建整页 HTML 字符串再 `updateNeuralWorkspace`（`neuralDom.js:15-19` 逐节点 `outerHTML` 比对）；`render(` 调用点 180 处；capture/restore 类函数 15 个（app.js 6 + `scrollPreservation.js` 6 + 其它 3），外加 typing/scroll 两道 defer 守卫（`:10561-10586`）；app.js 占 desktop-ui 代码 51%。
- 影响：morph 本应保留节点身份（焦点、scrollTop），补救层现在是"双保险"，掩盖 morph 的缺陷；全页字符串生成 + outerHTML 比对成本随线程长度线性增长。
- 建议：先用测试验证 morph 对焦点/滚动的保留，再逐个删补救函数；`renderPage()` 按 activeView 拆成模块，`changedSections` 直接决定调用哪个子渲染。

**[P2] A-10 账本路径上的静默 catch 会把聊天卡在 `running`**
- 证据：`src/services/chat/sendChatMessage.js:131` `await interruptChatRun(context, error).catch(() => {})`；该事务失败则 `chatRuns` 保持 `running`：相同 requestId 重试 → `turnLedger.js:21` 409；`chatMutations.js:55`、`chatDeletion.js:11`、`chatWorkspaceFiles.js:70` 全部拒绝，直到重启由 `taskRunLifecycle.js:42-44` 改为 interrupted。`runtime/postTurnTasks.js:10` 也无差别吞掉所有后置任务（会话记忆、事实提升、embedding 补齐）错误，无计数无日志。
- 建议：至少写 stderr + 诊断计数；`interruptChatRun` 失败重试一次或在 diagnostics 暴露"pending interrupt"。

**[P2] A-11 组合根藏在兼容门面；一处私有 home 解析器与运行时不一致**
- 证据：`src/desktopStore.js:91` `bootstrapBuiltinTools()` 是全仓唯一注册点（import 副作用）；`chatExecutionRunner.js` / `skillExecutor.js` 直接用 registry 却不自举——不经由 server.js/index.js 的入口（worker、基准脚本、单测）工具表为空。`src/images/sdcppEngine.js:379-388` 自带三级回退（含 `~/.melo`），`imageTool.js:294` 优先用它而非 `context.meloHome`。
- 建议：`bootstrapBuiltinTools()` 移到 `server.js` / `index.js` 显式调用；删除 `defaultMeloHomeDir`，统一走 `resolveRuntimePaths`。

**[P2] A-12 文档与脚本漂移**：`conventions.md` 三处错误（见 1.1）；`package.json` 40 余个手工 `test:*` allowlist 与 `scripts/verify-daily.js:12` 自动发现并存；5 处注释引用不存在的 `_refactor-backup/`。建议以 README / 性能文档为准重写 conventions §1、§3；只保留 `test` / `test:full` / `test:architecture*` 等少数入口。

### 1.3 值得保留

1. **写路径收口彻底**：生产代码 0 处 `saveState(`，`persistStateAtomically` 仅 `stateStore.js` 内 3 处，73 处业务变更全部走 `updateStateAtomically`；无变化事务不重写 manifest（`stateStore.js:311`）。
2. **读写分离 + 外部变更检测**：`readCommitted`（`stateStore.js:168-196`）用 dev/ino/size/mtime/ctime 戳 + 3 次重读窗口；`ownedSnapshot.js:10-33` 对 `messages` 延迟拷贝。
3. **config 写也有队列**：`config.js:350-358` `withConfigLock` 按 home 串行，21 处 `saveConfig` 均在锁内。
4. **测试基础设施务实**：自动发现 + 隔离 `MELO_HOME` + 隔离期必须有原因和到期日（`test-discovery.js:19-23`，当前隔离 0）；按改动范围计划；`src/` 测试:源码文件比 300:392。
5. **请求身份 / 回放语义清晰**：`turnLedger.js:41-47` 账本与助手消息同一事务；`REQUEST_ID_CONFLICT / INTERRUPTED / REPLY_UNAVAILABLE` 分明；重启 `running→interrupted` 有明确恢复。

---

## 2. Agent 层

### 2.1 Agent 模型速写（与文档不一致处标 ⚠）

1. **数据构成**：一个 Agent = `normalizeAgentProfile()` 的 33 个键（`src/state/agentProfiles.js:134-169`）：身份 5（`name/description/instructions/rolePrompt/systemPrompt`）+ 兼容别名 5（`identity/identify/soulMd/soul.md/soul`，均由 `instructions` 派生）+ `capabilities`(11) + `collaboration`(6) + `contextSources`(3) + `channels`(2×21) + 语音 7 + 旧字段 `tools/enabledSkillIds/enabledConnectorIds/enabledMcpServerIds/mood`。磁盘拆成 `agentProfiles / agentChannelBindings / agentVoiceSettings` 三表（`src/domain/agent/agentState.js`），运行时合回一个对象。
2. **人设真相**：`instructions` 是唯一可写来源；`composeAgentInstructions` 用 `## 工作要求/身份/风格/补充要求` 四节拼接，`agentInstructionFields` 反解（`src/domain/agent/agentDocument.js:2-32`）。无标题的自由文本全部落入 `rolePrompt`。
3. **project override**：`effectiveAgentProfile` = `{...global, ...override}` 再 `mergeAgentInstructions`；override 含 `instructions` 字符串则**整体替换**（`agentDocument.js:34`）；UI 在 project 范围保存时总发全文 → 项目人设是全量快照，之后改全局不再传播。能力取交集、协作取交集（`agentProfiles.js:350-357`）。
4. **提示词拼装**：`buildReActPromptSections` 22 个片段（16 必选 + 6 可裁，`src/services/chat/systemPrompt.js:204-227`）。Agent 段 = `summarizeAgentPrompt`：`User-selected role` / `Role purpose` / 固定一句 / `instructions` 全文 / **旧 `tools` 列表** / 频道摘要（`:34-60`）。随后 `mode` 段再注入一句「You are Melo Chat/Cowork/Code」。
5. **工具门控三层**：prompt 可见性 `toolsForCapabilityScope`（`chatExecutionRunner.js:394`）→ 调度白名单 `visibleToolIds`（`:674`）→ 执行器环境作用域 `executeTool` 从 `currentRequestContext()` 取 `capabilityScope`，缺失即拒（`src/tools/executor.js:46-52`）。工具→能力映射硬编码（`capabilities.js:28-56`），未映射默认拒。未迁移（`capabilities=null`）的 Agent 走 `legacy` 全放行。
6. **协作**：`delegate` 工具 → `runConfiguredMember` → `runSubAgent`；成员只收到 `task` 文本 + 上游 handoff JSON，**不继承任何对话历史 / 记忆 / 项目上下文**（`src/agents/subAgent.js:149-167`、`team.js:103`）。
7. ⚠ 不一致：(a) `MELO_OVERVIEW.md:343` 仍把"能力依赖调用方传参（漏传即放行）"列为剩余重点，代码已改为环境作用域缺失即拒（`executor.js:46-48`）——文档过期。(b) `agent-evolution:10`"Markdown 仅显式导入/导出"：实际每次保存都自动写 `AGENT.md/IDENTITY.md/SOUL.md`（`agentExport.js:20-37`），且无 state.json 的首启会**自动导入**磁盘 IDENTITY/SOUL（`stateStore.js:125-127`）。(c) `agent-settings:9` 说旧 Tools UI 已清除，但旧 `tools` 字段仍每轮进提示（B-2）。(d) `voiceRewrite.js:19-24` 头注说"输出纯中文、TTS 层剥韩文"，代码 `:203-206` 却刻意保留韩文再被 `tts.js:197` 剥掉——三处策略互相矛盾。

### 2.2 `agent-loop-audit-20261016` 四项发现的现状

| 发现 | 当前代码 | 证据 |
|---|---|---|
| #1 同一失败耗尽全部轮次 | **未修**。主循环、子 Agent、技能均无"工具+参数+错误"重复判定；`operationLedger` 只在 task 模式且只拦截 `result IS NULL` 的同指纹 | `chatExecutionRunner.js:572-776`；`subAgent.js:175-309`；`operationLedger.js:13-15,46-52` |
| #2 插件回调在超时/取消之外 | **未修**。`tool:before` 仍在创建 controller/计时器前 await；`tool:after` 在 `clearTimeout` 后 await；`emitHook` 无截止时间 | `executor.js:127,194/220,223/230`；`plugins/hooks.js:121-137` |
| #3 卡住的底层执行持续占用工作区 | **未修**。租约仍等待 `pending` 全部 settle；无隔离/终止/blocked 回执；排队时无 abort 竞速 | `workspaceScheduling.js:13-14,18,25-30` |
| #4 团队总结绕过总时限 | **已修**。总结用 `teamController.signal`，`budgetTimer` 在 `finally` 才清 | `team.js:93,133-138` |

### 2.3 新发现

**✅ [P0] B-1 人设被二次注入到 memory 块，项目覆盖时注入的是全局旧人设** — 见 §0。证据：`snapshotBuilder.js:430-444`、`attic.js:67,129,165`、`agentMemoryContext.js:44-45,103-108`（`atticEnabled` 默认 true）、`factPolicy.js:44`（identity 对 `canRecallMemory` 直接 true）。临时 home 探针实测 memory 块出现 `## Hot Attic … - [identity] User-selected role: … ## 身份 … Enabled agent tools: …`。建议：`injectHotAttic` 的 kinds 去掉 `identity`（或 `buildAgentMemoryNodeContext.accept` 过滤）；identity 条目只存 name/description 摘要；`attic.js:165` `break`→`continue` 并改用 `estimateTextTokens`。

**[P1] B-2 system prompt 仍按旧 `tools` 字段宣称「Enabled agent tools」，与能力门控脱节**
- 证据：`systemPrompt.js:35,55` → `summarizeAgentTools(profile.tools)`；`agentTools.js:103` 空列表回退为全部 7 项；`agentProfileService.js:222-233` 新建 Agent `capabilities: emptyCapabilities()` 却 `tools: [...DEFAULT_AGENT_TOOL_IDS]`。
- 影响：能力全关的新 Agent 每轮被告知拥有 Local command / Local files / Search，模型尝试调用后被 `CAPABILITY_DENIED`，浪费轮次并误导。
- 建议：用 `CAPABILITY_LABELS` + `contextSources` 生成摘要，或删除此行（工具定义已随 function calling 下发）。

**[P1] B-3 远程渠道上任何需审批的工具都会静默挂起 120s 后被拒**
- 证据：`telegramPolling.js:435-452` / `discordPolling.js:517` 调 `sendChatMessage` 不传 `sseEmitter`；`permissions.js:126-174`、`fileSafetyGate.js:104,168,199` 只通过 `sseEmitter` 通知且无 emitter 时照常等待 `PERMISSION_TIMEOUT_MS=120_000`。
- 影响：Discord 用户让有 `writeFiles/runCommands` 能力的 Agent 写文件 → 2 分钟无响应 → "permission timed out"；期间整个轮询循环（B-4）被阻塞。
- 建议：`isRemoteChannel` 时在 `toolsForCapabilityScope` 后再过滤需审批工具，或 `requestPermission` 无 emitter 时立即明确拒绝并在 prompt 声明"本渠道无审批入口"。

**[P1] B-4 多 Agent 共用一个串行轮询循环，单条回复阻塞所有 Agent**
- 证据：`discordPolling.js:309-310,385,517`（`for agentId … for rawMessage … await sendChatMessage`）；`server.js:1172-1200` 单一 `runDiscordPollLoop`。
- 建议：每个 Agent 独立调度（按 token 分 worker），回复异步投递，轮询只负责入队。

**[P1] B-5 成员只要有一次工具失败就整体判 failed，拖垮团队结论与复核循环**
- 证据：`subAgent.js:307,322`（`ok: !exhausted && failedTools === 0`）；`handoff.js:10` 状态由 `outcome.ok` 决定，成员自报 `status` 被忽略；`team.js:122,131`。
- 影响：一次 `file_read` 不存在、一次搜索超时 → 成员 failed、团队"未全部完成"、复核循环永不 accepted。
- 建议：`ok` 以是否给出 handoff/结论为准，`failedTools` 只作元数据。

**[P1] B-6 委派 / 团队成员零上下文：只拿到最新一句话**
- 证据：`chatExecutionRunner.js:497`（`task: … || latestUserMessage`）；`subAgent.js:149-167` 系统提示仅 `instructions + HANDOFF + 工具`；`team.js:69-72` 主 Agent 汇总也无历史、无记忆、无项目资料、无 name/description。
- 影响："按上面方案实施"这类委派成员无从理解；`contextSources`/知识/记忆对成员全部失效。
- 建议：给成员传入 `compactSummary`（或最近 N 轮摘要）与项目 `selectedMaterials`，用同一 `summarizeAgentPrompt` 生成成员身份段。

**[P1] B-7 项目范围的频道配置可保存、可"测试成功"，但永远不会被轮询**
- 证据：UI 频道区不按 scope 隐藏（`desktop-ui/app.js:8232-8350`）；`agentMutations.js:46-55` 项目分支合并 `channels`；`channelConnection.js:18-23,103-116` 支持 `scope:'project'`；轮询只读全局 `state.agentProfiles`（`discordPolling.js:310`、`telegramPolling.js:309`）；`dedupeAgentChannelTokenOwners` 也只在全局分支调用（`agentMutations.js:65-68`）。
- 建议：project 范围隐藏频道区并后端拒绝 `channels` 写入 override，或让轮询读 `effectiveAgentProfile`。

**[P1] B-8 人设拼装 4 套互不一致的实现**
- 证据：主对话 `systemPrompt.js:34-60`（含 name/description/tools/channels）；成员 `subAgent.js:149-158`（仅 instructions）；团队汇总 `team.js:70`（仅 instructions）；Discord 语音 `discordVoiceSession.js:453-466`（按 identity→soul→rolePrompt→systemPrompt 别名拼接，顺序与 canonical 四节不同、无标题）。
- 建议：抽出单一 `renderAgentIdentity(profile, {variant})`，四处复用。

**[P2] B-9 `instructions` 上限 200,100 字符远超 60k token 预算，超限后报错归咎于"消息"**（`agentProfileService.js:77-78`；`systemPrompt.js:208` agent 段 required；`contextBudget.js:36,60` 文案"current message, attachments…"）。建议保存时按 token 估算校验并提示。

**[P2] B-10 mode 与 Agent 身份叠加**：「User-selected role: X」之后紧跟「You are Melo Chat/Cowork/Code」（`systemPrompt.js:208-209`；`modeDefs.js:10-28`）；mode 随 `settings.activeMode` 粘滞到新对话（`app.js:452-467,6255-6262`；`sendChatMessage.js:218`）。建议 mode 降为风格后缀（不含「You are」），或并入 Agent。

**[P2] B-11 群聊回复评分不可配置、仅调试日志可解释；`isEnglishOnlyPersona` 死代码**：阈值/权重硬编码（`telegramReplyScore.js:31-41`、`discordReplyScore.js:34-39`）；channel 仅有 `nicknames` 字段且 **UI 无输入框**（`agentChannels.js:60`）；决策只写 `[dc-route]` 调试行；`replyScoreSignals.js:108-125` 导出后无调用方。建议频道增加 `replyPolicy`（mention-only/auto/threshold）与 nicknames 输入；signals 写入执行记录。

**[P2] B-12 评估 / 反馈闭环缺失：没有任何"按 Agent"的质量或成功率度量**：`skill_runs` 无 agent 列（`skillRuns.js:20-31`）；`memory_hits.outcome='used'` 仅表示"进了 prompt"；自我校验只在模型主动打不确定标记时触发（`chatExecutionRunner.js:807-855`）；`judge/` 只做意图分类；`dreaming/` 只做记忆整理。建议执行记录加 `agentId` 维度聚合（工具失败率、`CAPABILITY_DENIED` 次数、成员 exhausted 率、群聊回复后用户是否追问），在 Agent 页展示。

（另两条 P2：`registry.js:24` 导入 `agentTool` 未使用；`markdownSync.js:97-104` 旧格式/首启路径用 `normalizeAgentProfile` 规范化稀疏 override 会把内置 `name/description/rolePrompt` 写进项目覆盖——仅影响 `_storageFormat<3` 或无 state.json 首启。）

### 2.4 值得保留

1. **能力作用域不可被调用方放宽**：`executeTool` 只认环境 `currentRequestContext()`，options 只能收窄；`narrowCapabilityScope` 冻结对象取交集（`executor.js:44-61`、`capabilityScope.js:15-23`）。
2. **未映射工具默认拒绝 + 混合动作按参数判定**（`capabilities.js:43-55`）。
3. **委派链防环与深度限制完整**（`delegate.js:47-48`；`subAgent.js:136` 深度顶点隐藏 `agent/delegate`）。
4. **团队预算与取消语义清晰**（`team.js:88-107,131-138`，摘要可回退为确定性 `teamDigest`）。
5. **记忆对远程受众的硬隔离**（`factPolicy.js:30-46`、`snapshotBuilder.js:87-96`；memory-isolation 测试覆盖跨聊天/跨项目）。
6. **上下文预算失败即明确报错而非静默截断**（`contextBudget.js:35-39,60`）。

---

## 3. 上下文处理层

### 3.1 一轮请求的上下文装配（桌面，Codex Responses 通道）

请求体 = `instructions`（系统提示）+ `tools[]` + `input[]`（历史）。`src/openai.js:1113-1130`。

**系统提示**（`systemPrompt.js:204-227`，顺序固定）：

| # | 片段 | 内容 | 预算 | 每轮变化 |
|---|---|---|---|---|
| 1-3 | base / format / operating | 固定文案 ~1.7k 字符 | required | 否 |
| 4 | agent | 角色 + IDENTITY/SOUL 全文 + 旧 tools + 频道摘要 | required，**无上限** | 否 |
| 5-7 | mode / tool-routing / connectors | 固定 | required | 否 |
| 8 | skills | 按本条消息匹配的技能摘要 | required | **是** |
| 9 | tools | 搜索路由 + 工具策略说明 | required | **是** |
| 10-11 | output / channel | 固定 | required | 否 |
| 12 | uncertainty | 623 字符，仅 intent 需核实时 | required | **是** |
| 13 | language | 按输入语种 | required | 换语种时变 |
| 15 | citation | 1430 字符 | required | 否 |
| 16 | current-date | 日期 | required | 按天 |
| 17 | selected-materials | 知识片段 ≤8 块 × 1200 字符 | required（`maxTokens 12000` 不生效） | **是**（无相关度阈值，总给满 8 块） |
| 18 | compact | 对话摘要 | 可选 prio 100，≤6000 | 再压缩时变 |
| 19 | session-memory | 本对话事实 ≤12 条 | 可选 prio 90，≤3000 | 每 4 轮 |
| 20 | memory | Hot Attic → speaker → corrections 6 → scenes 3 → frames 8 → prompts 12 → facts → approvals 6 → tasks 6 | 可选 prio 80，≤5000 | **是** |
| 21 | dynamic | **Thread memory snapshot**（当前请求 + 最近回答 + 6 早期用户 + 6 早期助手 + 4 最近，各 220 字符）+ 选中文件 + 工作区 28 项 + 命令输出 + 成果 | 可选 prio 70，≤6000 | **是（每轮必变，含当前消息）** |
| 22 | project | 项目名/摘要/工作区/Instructions | 可选 **prio 60，最低，可整段丢弃** | 否 |

可选片段 18-22 共享 `recallBudget = min(16000, remaining/2)`，按优先级分完即丢（`contextBudget.js:63-73`）。

**tools[]**：`web_search`（按 searchPlan）+ `image_generation`（按图像意图）+ 原生 function 定义（按能力/搜索计划逐轮过滤）。`openai.js:283-299,1105-1106`；`runner.js:384-398`。**逐轮变化**。

**input[]**：`buildRecentWindow` 按 60k est（内部 ×3/4 = 45k raw）向前取，至少 6 条（`messageBuilder.js:544-561`；`contextWindow.js:46`）→ `fitRequestContext` 总预算 60k − 输出预留 8k = **52k 含系统提示和工具定义**；必含最新用户消息及 Responses 工具链全部项（不可拆），然后从新到旧整对加入，塞不下即停——**此处不再保证 6 条**（`contextBudget.js:41-100`）。工具循环每轮 `function_call_output` 截 8000 字符，≤32 调用/轮，最多 10 轮，每轮重新 `fitRequestContext`。

### 3.2 `context-memory-plan-20261017.md`「现状」逐项核对

| 文档声称 | 代码实际 | 一致? |
|---|---|---|
| 历史最多约 6 万 token | 窗口预筛 60k est（=45k raw）；最终整请求 ≤52k est **含系统提示和工具**；估算器中文 2 tok/字（`tokenEstimate.js:5,34`），o200k 约高估 2 倍 → 中文真实历史往往只有 2–3 万真 token | **不一致**（偏乐观、单位混用） |
| 至少保留最后 6 条 | 仅 `buildRecentWindow` 保证；`fitRequestContext` 可裁到只剩最新用户消息 | **部分不一致** |
| 超约 8 万触发 6 段式摘要 | 一致；但失败回退为本地 LLM / TextRank 未写（C-6） | 一致，回退未写 |
| 每 4 轮抽事实、默认本对话 | 一致（`sessionMemory.js:34,84-92`） | 一致 |
| 超出窗口后电脑只剩摘要几句 | 还有同对话旧消息召回（prompts ≤12 条 180 字符 + frames 8 + scenes 3） | **不完整** |
| 24 轮中位 1.27 万 / 最大 10.5 万 / 缓存命中 4% | 仓库内无探针数据（`.tmp/context-20261017/` 是 worktree，只有两张截图）；52k 上限下出现 10.5 万输入只能来自估算偏差 / 原生 web_search 内部轮次 / reasoning 回放 | **待核** |
| 缓存失效原因：动态内容在系统提示里排在历史前 | 属实，但还有三个：tools 数组逐轮变（前缀最前端失效）；Anthropic 通道**完全没有** `cache_control`（`providers/anthropic.js:19-27`）；chat-completions / API Responses 没有 `prompt_cache_key`（只有 Codex 有，`openai.js:1120`） | **不完整** |
| 个人 / Agent 范围事实会共享 | 会，但只有两条路：按问题召回的 corrections 组（**仅 6 个名额**）或 Hot Attic（需 correction/decision 或 useCount≥5 且 14 天内）；不是"每轮都带" | **部分不一致** |
| 聊天记录搜索是唯一串口子，不分项目 | 不分项目属实；**还跨本地/远程受众**（P0-3） | **不完整** |
| 手机 60 条 / 48KB 无摘要 | 一致；但预算先扣 `instructions`（角色+资料+召回）和 2048 预留，资料大时历史被挤掉 | 一致，偏乐观 |

### 3.3 新发现

**✅ [P0] C-1 `search_history` 跨受众** — 见 §0 P0-3。建议：`searchHistory` 增加 `audience/source` 与 `projectId` 过滤（索引表加列），默认只搜同受众 + 同项目；远程频道默认不暴露该工具；文档 2A 的"按范围限制"要把受众写进去。

**✅ [P0] C-2 窗口与摘要触发之间的滚动盲区** — 见 §0 P0-2。建议：触发条件改为「`fitRequestContext.diagnostics.droppedMessages > 0` 即压缩掉出窗口的部分」，或把 `COMPACT_TRIGGER_TOKENS` 与有效输入上限联动（≤ inputLimit − 系统提示实际大小）；至少把 droppedMessages 作为执行事件暴露给 UI。

**[P1] C-3 项目 Instructions 是最低优先级可选片段，长对话中会被整段静默丢弃**
- 证据：`systemPrompt.js:222-226` 优先级 compact 100 > session 90 > memory 80 > dynamic 70 > **project 60**；`contextBudget.js:63-73` 共享 16000 预算分完即 `droppedSections.push`；算术：compact 满额 8000 + memory 6667 + session ~1000 已超 15600，dynamic/project 为 0。只在 `MELO_PROMPT_DEBUG=1` 时打印（`runner.js:460`）。
- 建议：project 设为 required（≤3000 且稳定可缓存），或优先级提到 compact 之上；droppedSections 写入执行记录。

**[P1] C-4 「Thread memory snapshot」每轮把历史再抄一遍进系统提示**
- 证据：`dynamicContext.js:179-184` 注入 `renderStructuredThreadContext`；`threadContext.js:106-213`：当前请求、最近回答、6 早期用户、6 早期助手、4 最近消息各 220 字符 → 最多约 4000 字符/轮，而这些消息同时在 history 里；含当前消息所以每轮必变。
- 影响：每轮 ~2–8k est token 重复；是系统提示里最靠前且必变的大块之一，直接导致 memory/dynamic/project 之后全部不可缓存。
- 建议：桌面主聊天路径去掉 snapshot（保留 `clarificationFrame` 一小段，或移到最后一条 user 消息）；`earlierUserContext` 与窗口去重。

**[P1] C-5 缓存失效根因不止"顺序"**：工具数组逐轮变（`runner.js:384-398`、`searchRouter.js:236-245`、`openai.js:283-299`）；Anthropic 无 `cache_control`；非 Codex 通道无 `prompt_cache_key`。建议：工具集按 Agent 固定（路由只写进提示不增删 tools）；Anthropic 在稳定前缀末尾和历史末尾各放一个 `cache_control`；chat-completions / Responses 也传 `prompt_cache_key`。注意 `memoryUsage` 的"是否进提示"判定依赖 `request.systemPrompt.includes(renderedText)`（`runner.js:590`），若把召回移到 user 消息里需同步改。

**[P1] C-6 云端摘要失败时静默用本地 LLM / TextRank 替代，边界照样前移，无质量校验**
- 证据：`contextCompact.js:211-219` catch 后 `useOffline()`；`offline/compact.js:114-161` 永远返回 `ruleBasedCompact`（TextRank）；`runner.js:341-350` 只要非空就写 `compactSummary` / `compactBoundaryMessageId` 并 `compactFailures=0`；`auditSummary` 只在离线本地 LLM 路径调用；块头统一为「=== Previous Conversation Summary ===」。
- 影响：网络抖动一次，之后 45k token 历史永久只剩抽句摘要，用户和模型都不知道是降级产物；再压缩时以它为「Previous summary」继续压。
- 建议：回退摘要打标记（source: rule/local/cloud）并延后推进边界，下一轮重试云端；云端摘要也过 `auditSummary`。

**[P1] C-7 项目 / Agent / 个人范围的共享事实并不可靠进入提示**：corrections 组 `limit:6` 与 verification-correction 共用、按问题相关度召回（`agentMemoryContext.js:53`）；Hot Attic 门槛高（`attic.js:31-40,74-86`）；`sessionMemory.js:195` `slice(-80)` 不分类别丢最旧事实；`MEMORY_INJECT_LIMIT=12` 按类别排序，correction 多时 project_context 永远进不来。建议：共享作用域事实走固定小块（即 plan 2B 的个人档案/项目记忆本），不与召回竞争；80 条上限改为按类别保护。

**[P1] C-8 工具循环链不可裁剪，长循环会在工具已执行后抛 `CONTEXT_BUDGET_EXCEEDED`**：`contextBudget.js:21-25` Responses 链从最新用户消息到末尾全部 required，`:59-60` 超限直接 throw；每个工具输出 8000 字符、每轮 ≤32 调用、最多 10 轮；该 code 全仓无专门处理。建议：循环内对旧的 `function_call_output` 做二次压缩（保留 call_id + 摘要），或接近上限时强制 finalize。

**✅ [P2] C-9 Agent 身份进 Hot Attic** — 同 B-1，补充：`attic.js:165-168` `cost > tokensRemaining` 时 `break`（不是 `continue`），成本按 `length/4` 估（中文低估 6 倍）。

**[P2] C-10 token 估算四处四套单位，对中文系统性高估**：`tokenEstimate.js:5` 非拉丁 1.5 tok/字 × `:34` 4/3 = 2 tok/字（o200k 中文约 0.7–1.0）；Hot Attic `length/4`；知识按字符；手机按 UTF-8 字节；`MELO_CONTEXT_BUDGET_TOKENS` 全局 60000、仅 env 可调、不随模型。影响：中文用户可用窗口约标称一半；大上下文模型被卡在 60k，小本地模型又溢出。建议：按 provider 校准系数（或用 Codex 返回的 usage 反推），预算按模型目录取；统一走 `estimateTextTokens`。

**[P2] C-11 Dreaming 在桌面实际几乎不会跑**：`dreaming/scheduler.js:56-57` 只注册 6h/24h `setInterval`，无启动即跑；`_lastIncrementalIso` 仅内存；`startIdleWatch` 全仓无生产调用方；`memory-architecture.md:186-189` 声称有 10 分钟空闲触发。影响：进程存活不足 6h 则 attic 重评/合并/回填/命中清理从不执行，`memory_hits` 无限增长。建议：启动后延迟几分钟跑一次增量；持久化 lastRun；接 powerMonitor。

**[P2] C-12 每轮做两遍召回、MMR 实际死代码、窗口排除用的是裁剪前的消息集、Agent 级自纠错永不跨对话**：`agentMemoryContext.js:66-83` 先 `recallMemoryGroups` 再 `recallMemoriesTiered` 覆盖 prompts/facts；`store.js:1378` 有 query 时不走 `applyMmrRerank`（生产永远有 query）；`runner.js:245,419` `includedMessageIds` 取自 `fitRequestContext` 之前的窗口；`snapshotBuilder.js:329-331` 自纠错写 `agent:` 命名空间但 `factPolicy.js:30-33` 无 scope 时按 chat 过滤；查询 embedding 无超时保护（worker 60s）。建议：tiered 开启时跳过 flat prompts 组；RRF 后再 MMR；`includedMessageIds` 用 `preparedRequest.messages`；自纠错显式 `scope:'agent'`；embedding 加 1–2s race。

### 3.4 值得保留

1. **作用域双重过滤**：命名空间在 SQL 层（`store.js:495,679`），chat/project/agent/personal 与 forgotten/quarantined/validTo 既在 SQL（`activeMemorySQL`，`:663-668`）又在 JS（`canRecallMemory`）；删除来源对话的事实自动隔离（`factRecords.js:70-76`）。
2. **记忆反馈在最终预算之后记录**，useCount 只给真正进入提示的行，`memoryUsage`（≤40 条）持久化到回复供用户查看（`runner.js:590-598`；`store.js:2057-2073`）。
3. **摘要工程细节扎实**：按完整轮次切块、超大首轮用「PARTIAL HISTORY EXCERPT」诚实标注、原子持久化、熔断 3 次（`contextCompact.js:64-79`；`derivedState.js:16-24`）。摘要后原文仍留在对话、记忆库与 FTS 中。
4. **向量不随快照重建丢失**：按 search_text 哈希缓存 embedding，补齐 worker 增量跑；关键词与向量 RRF 融合，未 embedding 的新行照样能精确匹配（`store.js:1211-1216,1237,1366-1377`）。
5. **媒体 token 控制**：历史轮剥附件、4 轮内跟进才拼回；当前输入超限明确报错；Codex `prompt_cache_key` 按 home/account/model/chat 哈希，稳定且不泄露 id。

---

## 4. 方案

原则：先修"一行到一文件、可立刻验证"的；再统一"同一件事四种做法"的；最后做结构性整改。每条给改法 / 涉及文件 / 验证方式 / 工作量。**不建议**一次性大重构——这个仓库的 byte-for-byte 抽服务纪律（CLAUDE.md §5）是对的，继续沿用。

### 4.1 第一批：本周，7 条小修（合计 ≈ 1 人日）

| # | 修法 | 文件 | 验证 | 量 |
|---|---|---|---|---|
| 1 | `ttsRoutes.handle(request, response, url, requireLocalOrigin)`；registry 把 `requireLocalOrigin` 设必填、缺失 throw | `server.js:920`；`routeRegistry.js:24` | 新增经 `createServer` 的 HTTP 回归：POST `/api/tts/speak-stop` 必须 200；在运行实例 curl 复测 | 0.5h |
| 2 | Hot Attic 召回 kinds 去掉 `identity`；`attic.js:165` `break`→`continue`，成本用 `estimateTextTokens` | `attic.js:129,165`；或 `agentMemoryContext.js` accept 过滤 | 临时 home 探针：memory 块不再出现 `[identity]`；`attic.test.js` 补用例 | 1h |
| 3 | `search_history` 加 `audience/source` + `projectId` 过滤；远程渠道默认不暴露 | `searchHistoryTool.js:64-68`；`conversationIndex.js:282-296`（索引表加 `source`/`project_id` 列 + 迁移）；`chatExecutionRunner.js:375` 附近 | `memory-isolation.test.js` 加"Telegram 对话搜不到 desktop 私聊"用例 | 3h |
| 4 | project 段改 required（或 prio > compact）；`droppedSections` 写入执行记录 | `systemPrompt.js:226`；`contextBudget.js:63-73`；`executionPipeline.js` | `contextBudget.test.js`：compact 满额时 project 仍在 | 1h |
| 5 | 删除 system prompt 里的旧 `tools` 行，或改为按 `capabilities` 生成 | `systemPrompt.js:35,55`；`agentTools.js:103`；`agentProfileService.js:222-233` 新建 Agent 不再写 `tools` 默认 | `systemPrompt.test.js`：能力全关的 Agent 提示里不出现 "Local command" | 1h |
| 6 | F5 看门狗：先判 voice-pack 存在；只杀自己 spawn 的 pid | `server.js:1000,1014-1036` | 无 voice-pack 时启动日志不出现 `[voice-pack] Killed` | 1h |
| 7 | `interruptChatRun` / `postTurnTasks` 的静默 catch 至少写 stderr + diagnostics 计数 | `sendChatMessage.js:131`；`postTurnTasks.js:10` | `diagnostics` 新增 `pendingInterrupts` / `postTurnFailures` 字段 | 1h |

### 4.2 第二批：两周内，预算 / 缓存 / 人设统一（≈ 4–5 人日）

**B-1 预算与压缩联动（修 P0-2）**
- `COMPACT_TRIGGER_TOKENS` 不再是固定 80k，改为「`fitRequestContext` 报告 `droppedMessages > 0`」即触发对掉出窗口部分的压缩；或至少 trigger ≤ `inputLimit − 系统提示实际估算`。
- `contextWindow.js` 与 `contextBudget.js` 的 6 条保底统一到 `fitRequestContext`。
- 验证：构造 pending=40k 的对话，断言没有消息被静默丢弃。

**B-2 token 估算校准**
- `tokenEstimate.js` 按 provider 家族给系数（o200k 中文 ~0.9、Claude ~1.4）；用 Codex 返回的 `usage.input_tokens` 做在线校准（记录估算/实际比，EMA）。
- `MELO_CONTEXT_BUDGET_TOKENS` 默认值按模型目录（`src/providers/modelCatalog` 或等价）取，不再全局 60k。
- Hot Attic / 知识 / 手机统一走同一估算器（手机可先把 48KB 字节换算为同口径）。
- 验证：同一段中文对话，估算与 Codex 实际 usage 偏差 < 20%。

**B-3 缓存友好的请求布局**
- 系统提示分两层：**稳定前缀**（base/format/operating/agent/mode/routing/connectors/output/channel/citation/project）+ **逐轮尾部**（skills/tools 策略/uncertainty/language/date/materials/compact/session/memory/dynamic）。稳定前缀在前且不变。
- 去掉 Thread memory snapshot（C-4），只保留 `clarificationFrame`；或把它和召回一起移到最后一条 user 消息的前缀块（需同步改 `runner.js:590` 的 `includes` 判定）。
- tools 数组按 Agent 固定（能力决定），搜索/图像路由只写进提示不增删工具定义。
- Anthropic 通道加 `cache_control`（稳定前缀末尾 + 历史末尾）；chat-completions / API Responses 传 `prompt_cache_key`。
- 验证：执行详情已显示缓存命中 token（`executionDetails.js:29`），对比改前后同一对话 10 轮的命中率；目标 Codex 通道 > 60%。

**B-4 人设拼装单一实现**
- 新增 `src/domain/agent/renderAgentIdentity.js`：`renderAgentIdentity(profile, {variant: 'chat'|'member'|'team-lead'|'voice'})`，输出 canonical 四节；主对话 / `subAgent.js:149-158` / `team.js:70` / `discordVoiceSession.js:453-466` 四处改调它。
- 同时修 `voiceRewrite.js:19-24` 注释与 `:203-206` 代码的矛盾：语音层不再刻意保留韩文（MiniMax 中文定制音色读韩文很差，用户已明确要求纯中文）；`tts.js:197` 的 `stripKoreanForMinimax` 保留为兜底。
- 验证：四条路径的身份段 snapshot 测试一致。

**B-5 摘要降级可见**
- `contextCompact.js` 回退摘要打 `source: 'rule'|'local'|'cloud'`；rule 来源不推进 `compactBoundaryMessageId`，下一轮重试云端；云端也过 `auditSummary`。
- UI 执行详情显示"本轮摘要来源"。

### 4.3 第三批：一个月内，远程渠道与协作（≈ 5–6 人日）

**C-1 远程渠道审批语义**：`isRemoteChannel` 时过滤需审批工具，或 `requestPermission` 无 emitter 立即拒绝 + 提示声明"本渠道无审批入口"（B-3）。
**C-2 轮询并发**：每 Agent 独立轮询 worker，回复异步投递（B-4）。配合 `agent-loop-audit` #1：主循环 / 子 Agent / 技能加"工具+参数+错误"重复失败提前终止（同指纹连续 2 次即停）。
**C-3 成员上下文**：委派传 `compactSummary` + 最近 N 轮摘要 + 项目 `selectedMaterials`；`ok` 以是否给出结论为准（B-5/B-6）。
**C-4 项目范围频道**：project 范围隐藏频道区 + 后端拒绝写入 override（B-7）。
**C-5 `agent-loop-audit` #2/#3**：插件回调加截止时间与 abort 竞速；工作区租约加 blocked 状态与恢复入口。
**C-6 工具链压缩**：循环内对旧 `function_call_output` 二次压缩（C-8）。

### 4.4 第四批：结构性（按季度）

1. **分层 gate 传递闭包化**（A-4）：`scripts/check-dependencies.js` 改为闭包检查 + `services→http` 禁止；下沉 `summarizeAttachmentsForPrompt`、`persistPortableFiles`。
2. **本地 HTTP 面身份**（A-3/A-8）：Swift 壳注入启动随机 token，registry 统一校验；`Host` 白名单；mutating 路由禁 GET；错误体统一 `errorPayload`。
3. **前端拆单体**（A-9）：先用测试证明 morph 保留焦点/滚动，逐个删 15 个补救函数；`renderPage()` 按 activeView 拆模块。
4. **评估闭环**（B-12）：执行记录加 `agentId` 聚合（工具失败率 / `CAPABILITY_DENIED` / 成员 exhausted / 群聊追问率），Agent 页展示；`skill_runs` 加 agent 列。
5. **Dreaming 真正运行**（C-11）：启动延迟增量 + 持久化 lastRun + powerMonitor。
6. **文档对齐**：重写 `conventions.md` §1/§3；`MELO_OVERVIEW.md:343` 能力段更新；`agent-loop-audit` 标注 #4 已修；`memory-architecture.md` §10 provider 一节标注"不在聊天路径"；`context-memory-plan` 现状表按 §3.2 修正。

### 4.5 与 `context-memory-plan-20261017.md` 的衔接

该方案的 **1B 话题分段** 和 **2B 个人档案 / 项目记忆本** 仍是正确方向，但本审计建议**先做 4.2 的 B-1/B-2/B-3**，原因：
- 1B 的"预计每轮输入降一半"建立在当前估算器之上，而估算器对中文高估 2 倍（C-10），实际收益需要校准后重估。
- 1B 的话题卡会进系统提示，若 B-3 的稳定前缀 / 逐轮尾部分层不先做，话题卡只会再增加一块逐轮变化的内容，缓存命中更低。
- 2B 的"固定小块"正是 C-7 的解法；做 2B 时直接把 project 段改 required（4.1 #4）即可复用。
- 2A 的"按范围限制"必须把**受众**（desktop / telegram / discord）写进去，不只是项目（P0-3）。

---

## 5. 数字附录

| 指标 | 值 |
|---|---|
| JS 源码（不含 test / node_modules） | 108,558 行（src 77,754 / desktop-ui 23,443 / 其余 7,361）；Swift 11,995 |
| 测试文件 | 393 个 `.test.js`（src 300 / desktop-ui 65 / 其余 28）+ 29 个 iOS；src 测试代码 60,209 行 |
| 空 `catch {}` / 仅注释 catch（src 非测试） | 184 / 59；另 `.catch(()=>{})` 78、`.catch(()=>null/''/false)` 113；分布 services 41、tools 36、memory 29、media 14、http 11、server.js 10 |
| `updateStateAtomically` vs 直接写 state | 73 vs 0 |
| 路由 | core 36 / domain 70 / tts 12 / media 2；mobileSync、execution 专用入口 |
| system prompt 片段 | 22（16 必选 + 6 可裁）；预算 60k，输出预留 8k，召回 ≤16k，Hot Attic 800 |
| 工具 | registry 30 + 动态 `mcp:*` / `skill:*`；能力映射覆盖 30 |
| Agent 字段 | 33 键；`instructions` 上限 200,100 字符 |
| 循环上限 | 主对话 10 轮；成员 8/20 轮、32k、3–15 分钟；技能 6/16；团队 1–8 人、复核 ≤5、15 分钟/300k；审批 120s；工具 60s |
| `src/memory/` | 非测试 10,967 行（store.js 2,685）；测试 7,599 |
| 记忆层生产调用 | contextWindow / contextCompact / sessionMemory / recallMemoryGroups + recallMemoriesTiered / attic / threadContext / knowledgeIndex / embeddings / conversationIndex 每轮；snapshotBuilder→derivedIndex / repair / speakerFacts 后台 |
| 记忆层**不在**聊天路径 | providers/*（Chroma/LanceDb/HttpProxy/Router）、`reassessAttic`（仅 sweep）、`startIdleWatch`（无调用方）、`applyMmrRerank`（有 query 时不走）、`summaryQuality.auditSummary`（仅离线本地 LLM） |

关键预算常量全表见扫描原稿（`tokenEstimate.js:2-34`、`contextWindow.js:7-19`、`contextBudget.js:6-7,42,63`、`systemPrompt.js:221-226`、`sessionMemory.js:34-121`、`agentMemoryContext.js:51-131`、`store.js:600-845,1316-1376`、`attic.js:31-40,126-165`、`frame.js:28-32`、`scheduler.js:18-21`、`knowledgeIndex.js:27-129`、`dynamicContext.js:16-237`、`functionCalling.js:4,79`、`ConversationHistory.swift:6-25`）。

## 6. 未验证边界

- A-3 DNS rebinding 需在真实 WKWebView 中验证 Host 处理；A-7 需确认用户是否在桌面运行时使用 CLI 写路径。
- `context-memory-plan` 的 1.27 万 / 10.5 万 / 4% 三个数字仓库内无探针数据，无法核对。
- 沙箱缺 native addon（`dirfdOps`），未实测全量工具提示字节数。
- 未审 iOS 侧 Agent / 上下文实现（只核对了 `ConversationHistory.swift`、`ChatStore.swift` 的常量与 `AgentProfile.swift` 已停用 mood 注入）。
- 本轮没有运行 `npm test`、没有改产品代码、没有 git 提交产品改动；只新增本文档。

---

## 7. 实施状态（2026-10-17 同日）

用户决定全部修复并暂时归档 Discord（与 Telegram 并列）。已落地（本地 `npm test` 日常层级 + 沙箱全量 JS 回归；浏览器测试在用户机器上跑）：

| 编号 | 状态 | 实际改动 |
|---|---|---|
| P0-1 / A-1 | ✅ | `server.js` 传入 `requireLocalOrigin`；registry 缺 gate 即 throw；新增 `src/http/ttsRoutes.http.test.js` 走真实 `createServer` |
| P0-2 / C-2 | ✅ | `resolveContextBudget` 单一来源：云端默认 160k、本地 24k、窗口 = 输入上限 × 0.75、压缩触发 = 窗口；fitter 丢消息时同轮强制压缩；`contextGap.test.js` 固定不变量 |
| 窗口拉长（用户） | ✅ | 同上；`MELO_CONTEXT_BUDGET_TOKENS` 仍可覆盖（上限 400k） |
| P0-3 / C-1 | ✅ | `message_scope` 侧表 + `tagChatScope` 回填；`search_history` 作用域来自执行上下文（受众 + 项目），远程渠道不能放宽 |
| B-1 / C-9 | ✅ | Hot Attic 不再召回 `identity`；`break`→`continue`；共享估算器 |
| A-2 | ✅ | 无 voice-pack 不装看门狗；只杀自己 spawn 的 pid |
| A-3 / A-8 | ✅ | `/api/*` Host 白名单（LAN 绑定除外）；无 Origin 写请求校验 `Sec-Fetch-Site` |
| A-4 | ✅ | gate 改传递闭包 + `services→http` 禁止；`attachmentSummary`、`extractedMedia` 下沉 domain；`trailLogger` 移 runtime；mobile-sync 业务逻辑移 `services/remote/mobileSync.js` |
| A-6 | ✅ | poller 锁只认 `ESRCH` |
| A-10 | ✅ | `failureCounters.js`：interrupt 重试一次后计数；post-turn 任务失败计数并写 stderr；诊断暴露 `failures` |
| A-11 | ✅ | `bootstrapBuiltinTools()` 在 `server.js` / `index.js` 显式调用；image tool 优先用执行器的 home |
| A-12 | ✅ | `conventions.md` 三处纠正 + 过时段落标注；`MELO_OVERVIEW.md:343`；loop-audit 状态；memory-architecture dreaming / provider 说明 |
| B-2 | ✅ | 系统提示改为按 `capabilities` 宣称能力；不再读旧 `tools` |
| B-3 | ✅ | 无审批入口时立即拒绝（`PERMISSION_NO_SURFACE`） |
| B-4 | ⏸ 归档后不适用 | Discord 已归档；恢复时再做每 Agent 独立轮询 |
| B-5 | ✅ | 成员 `ok` = 给出结论且无越权调用；自报 status 优先；团队/复核不再因单次工具失败假失败 |
| B-6 | ✅ | `memberBackground.js`：成员与团队 lead 收到项目说明 + 摘要 + 最近 6 轮（有界，放首条用户消息） |
| B-7 | ⏸ 归档后不适用 | 项目范围频道写入保留现状 |
| B-8 | ✅ | `domain/agent/agentIdentity.js` 单一渲染，四处复用；voiceRewrite 语言规则与纯中文人设一致 |
| B-9 | ✅ | 保存时按 token 估算拒绝过长人设（40k） |
| B-10 | ✅ | mode 改为「Working style」后缀，不再第二个 "You are" |
| B-11 / B-12 | ⏸ | 评分可配置与按 Agent 度量未做（见 §4.4） |
| loop-audit #1/#2/#3 | ✅ | `repeatGuard.js`；hooks 超时 + abort；工作区租约可取消、卡住标记 `WORKSPACE_BLOCKED` |
| C-3 | ✅ | project 段优先级 105、进入稳定前缀 |
| C-4 / C-5 | ✅（部分） | 逐轮段落移入当前用户消息（`turnContextPlacement`）；Anthropic `cache_control`；OpenAI 一方 `prompt_cache_key`。**未做**：工具数组按 Agent 固定（搜索路由仍逐轮增删工具），见 §4.2 B-3 |
| C-6 | ✅ | 摘要来源持久化（`compactSummarySource`）、降级头、下一轮重试云端（≤3 次、20s） |
| C-7 | ⏸ | 固定小块（plan 2B）待用户选择方案 |
| C-8 | ✅ | `compactToolChain`：超预算先压缩旧工具输出再重试 |
| C-10 | ✅（部分） | 非拉丁 1.5→1.0；Hot Attic 用共享估算器；知识/手机单位未统一 |
| C-11 | ✅ | dreaming 启动后 3 分钟补跑、lastRun 持久化 |
| C-12 | ✅ | tiered 时跳过 flat prompts；RRF 后 MMR；`includedMessageIds` 用实际发送集合；自纠错 `scope:'agent'`；embedding 2.5s 上限 |
| A-5 / A-7 / A-9 / B-12 | ⏸ | 写队列内 IO、CLI 锁、前端补救层、评估闭环：结构性，另排 |

## 8. 工具调用链优化（2026-10-17，用户追加要求）

只读复核后做的改动，行为不变、输出等价（沙箱等价性脚本逐样本比对）：

| 位置 | 问题 | 改动 | 实测 |
|---|---|---|---|
| `memory/tokenEstimate.js` `estimateTextTokens` | 正则 `match(/[^\u0000-\u024f]/gu)` 为每个中文字符分配一个数组元素；fitter 每轮对全部消息重估 | 无分配的码点计数循环（代理对按 1 个码点） | 232k 字符 ×50：600ms → 38ms |
| `truncateToTokens` | 二分查找，每步对切片重新估算 | 单次前向扫描，与整串估算 ceil 完全一致 | 232k 字符 ×5：257ms → 4ms |
| `estimateMessageTokens` | 协议消息每次 `JSON.stringify(responseItems)` | 按消息对象 WeakMap 记忆，内容/条目引用或长度变化即失效 | 10 轮工具循环 fit：156ms → 11ms |
| `chatExecutionRunner` 工具循环 | 每轮重建 `skillToolsById`、`visibleToolIds`、`allowedDispatchTools`（全量 `filterMcpToolsForAgent`）、全部 Agent 的 `effectiveAgentProfile` 合并、成员背景文本；`toolCalls.find` / `execResults.find` O(n²) | 提到循环外、首次用到时惰性计算；按 id 建 Map | — |
| `config.js` `loadConfig` | 每次权限检查 / 压缩等都读盘 + JSON.parse config.json | 按 `stat`（mtime/size/ino）校验的原始 JSON 缓存，返回深拷贝 | 每次工具调用省一次文件读取 |

未改：`executeToolCalls` 的"并发安全成组、串行工具 flush"策略是正确性属性，保留；`executeTool` 每次调用的 realpath/stat（3–4 次系统调用）相对工具本身开销可忽略，不加缓存以免引入状态。

**顺带修复的既有 UI bug**：在「语音风格要求 / Edge TTS 音色」文本框编辑后直接点「保存修改」，blur 触发的 `change` 会整页 render 替换按钮，首次点击被吞（`desktop-ui/app.js` change handler 对这三个字段无条件 `render()`）。现在只有 `<select>` 才立即重绘，与通用分支一致；`telegramArchive.browser.test.js` 在归档 Discord 后恰好暴露了它。

