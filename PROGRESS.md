# Melo 进度日志

> 新条目追加在本文件顶部（时间倒序）。
> 当本文件超过 160 行或 8000 字符时，按 CLAUDE.md §3 自动压缩：最旧 70% 归档为一句话摘要，最新 30% 保留完整格式。

---

## 2026-04-27 15:30 — F-3C：README 加 Memory & embeddings 引导（bge-m3 部署门槛闭环）

- 横评第三个扣分项：bge-m3 1GB 模型无 onboarding。用户选最轻量方案 C —— README 引导，不动 desktop-ui。
- README.md 加 "Memory and embeddings" 一节：one-time setup（`ollama pull bge-m3` + `doctor` + `memory-status --live`）/ 4 级降级链（bge-m3 → OpenAI fallback → custom HTTP → 关键词）/ 5 个核心 env 开关（含本批次新加的 `MELO_COMPACT_QUALITY_GATE`）/ benchmark 跑法（接 F-1A）。
- 跟 desktop-ui 解耦：选择 C 是因为 90% 用户其实读 README，引导落 README 比起做新弹窗 UI 更省工 + 不破坏既有 UI。如果以后想升 A（启动弹窗），可把这节改成 onboarding 文案的源。
- 提交哈希：`dece161`。

## 2026-04-27 15:15 — F-2C：reference-free summary quality + dreams diary 接入

- 横评里"本地 LLM 摘要质量没实测"的扣分项。读代码发现 `frame.js` 的 frame summary 是字符切片（grounded≈1，无胡编风险），真正可能胡编的是 `offline/compact.js` 的 LLM compact（qwen2.5:3b 默认），所以 quality gate 接到那里。
- 新增 `src/memory/dreaming/summaryQuality.js`：纯模块，三指标 score = 0.1·length + 0.4·entityCoverage + 0.5·tokenGroundedness。Latin 词 + CJK per-char + bigram 实体抽取，全部 reference-free。`auditSummary({summary, source, label})` 直接 append 到当日 DREAMS.md（一行 audit block，PASS/FAIL + 三指标），diary 写失败 swallow 不破坏热路径。
- `compact.js` 接入：LLM 返回成功时按 `MELO_COMPACT_QUALITY_GATE` 处理 —— 默认 `audit`（写 diary，行为不变）/ `fallback`（diary + score 不通过则继续下一 candidate）/ `disabled`（完全跳过）。模式在 compactOffline 入口一次性 capture（CLAUDE.md §6）。
- 验证：18 个新单测（tokenize/extractEntities/evaluateSummaryQuality/auditSummary/diary append-only）+ 整个 memory 测试套 **323/323 全绿**（含原 305 + 18 新加）；check-syntax 全过；compact.test.js 既有 ruleBasedCompact + LLM-disabled 测试不受影响。
- 提交哈希：`aad4f72`。

## 2026-04-27 14:45 — F-1A：memory retrieval bench（黄金集 + recall@k 报告）

- 横评 melo / openclaw / hermes 时把"召回 top-5 ≥ 85%"当成尚未基准化的扣分项；这一刀把它变成可跑的脚本，不动 `src/memory/`。
- 新增 `bench/memory/{golden.example.json, README.md}` + `scripts/bench-memory.js`：默认读 `bench/memory/golden.json`（gitignored，私密 query 不入版本），跑 `recallMemoriesTiered`，按 `expectedIds` + `expectedSubstrings` 判 hit，输出 `results-YYYY-MM-DD.md` 含 Recall@1/5/10、scene/frame/content per-kind hit、平均延迟、misses 详情。
- CLI: `npm run bench:memory`，支持 `--no-embed`（强制关键词通路）、`--validate`、`--json`、`--threshold-recall5 0.85`（CI gate exit 2）。env 启动时一次性 capture（CLAUDE.md §6）。
- 验证：305/305 memory unit tests 全绿（未动 src/）；脚本端到端 sandbox MELO_HOME 上跑过 friendly-fail（缺 golden / 空 store）+ 命中（recall@5=100%）+ threshold gate（pass=0/fail=2）+ JSON 模式 + check-syntax 全过。
- 提交哈希：`eb74e07`。

## 2026-04-27 14:30 — 后台能力分层：MCP / plugins / background-tasks 挪到 Customize → Advanced

- 用户要求："MCP、plugins、background-tasks 先不要全塞主 UI。建议做一个 Advanced / Runtime 页面，明确标注实验性/开发者功能。里面只放查看状态、reload、disconnect、kill task 这种安全操作，新增/编辑配置可以晚一点做。"
- audit（详见上一刀提案）：MCP 双入口（Customize → Connectors 详情面板 external-mcp 分支 + Customize → Runtime 整页 + Code 页面侧栏 MCP shelf + Customize → Connectors 顶部 Create 表单）；plugins 后端有 hook 系统但 UI 完全没暴露；background-tasks Code 页面 task panel 在用，`/api/background-tasks/{run,status,kill,list}` 端点存在但 UI 没消费 list/kill。**关键提醒**：openai-compatible LLM provider 跟 external-mcp 共享 Customize → Connectors，LLM 配置不能藏。
- 走方案 B（中等迁移）：
  - **新增 `renderAdvancedPage()`**（4 个 subsection）：External MCP connectors（list + Ping refresh）/ CLI stdio MCP servers（list + Reload all + Disconnect by name）/ Plugins（list + hooks 只读）/ Background shell tasks（list + Kill on running）。顶部 `Experimental` chip + 描述文字"安全操作 + 配置编辑延后"。
  - **uiState.advanced 缓存** + `refreshAdvancedStatus()` 三端点 `Promise.all`（容错：单端点失败 → partial-load 提示，三端点全失败 → 阻塞展示）。
  - **侧栏改造**：Customize sub-section 列表 Runtime → Advanced；旧 `selectedCustomizeSection: 'runtime'` 在 renderCustomizePage 入口 coerce 成 `'advanced'`（持久化设置不破老用户）。
  - **Customize → Connectors 拆分**：external-mcp 从列表筛掉 + renderConnectorDetails 的 external-mcp 分支换成"已迁至 Advanced"提示卡 + 顶部 Create 表单删除。LLM provider (openai-compatible) 配置原位保留。
  - **Code 页面**：删 "MCP-style connectors" inspector card + 删 External tools inspector card；Task panel 保留（agent lane runner 是日常工作流，跟"后台任务管理"不是一回事）。
  - **slash command + palette**：`/mcp browse` + `open-runtime` palette 命令都改路由到 `selectedCustomizeSection: 'advanced'`。
  - **后端**：`/api/mcp/{servers,disconnect,reload}` + `/api/background-tasks/{list,kill}` + `/api/plugins` 全部已存在，**零后端改动**。
- 后续 cleanup：删 684 行死代码——`renderRuntimeBrowserPanes` (188 行) + `renderExternalConnectorShelf` + `renderExternalToolForms/Results` + `renderExternalConnectorCreateCard` + `selectedRuntimeConnector/Entry` + `syncRuntimeSelection` + `handleLoadRuntimePreview` + `handleCreateExternalConnector/UpdateExternalConnector/RemoveExternalConnector/InvokeExternalTool` + 6 个 dead action case + `uiState.runtimeSelection/runtimePreview/externalToolInputs`。
- 验证：`node --check` 全过；regression 全套 **1057/1057 全绿**；UI 手测留给用户验证 Customize → Advanced 渲染 + Refresh / Reload all / Disconnect / Kill task 功能。
- Codex 前置 review 评 **B**（"实现正确，缺少覆盖" + ⚪ 建议补 smoke/E2E 覆盖 advanced 导航 / 关键按钮 / API 映射，desktop-ui 没现成的 E2E 框架，留 follow-up）；cleanup commit 等 review。
- 提交哈希：`e9eb5b6`（feat 主刀） + `40c747b`（chore cleanup）。

## 2026-04-27 14:00 — UI overlap 全局 audit：根因 .detail-card height: 100% 一处修光

- 用户反馈 + 截图：Customize → Agents → 金冬天 详情面板里，"Operator" preset 卡（包括 `focused` chip 和 Operator 标题）**穿出**外层 detail 卡的圆角下边框继续往下铺。要求审查整个 UI 里其他类似"框互相叠加"的位置。
- 排查：
  - 全 stylesheet **零** `position: sticky`、所有 `position: absolute` 都有 `position: relative` 父级——不是 sticky/orphan-absolute 类问题。
  - 真因：[styles.css:3262](desktop-ui/styles.css#L3262) `.detail-card { height: 100%; }` 把 detail 卡渲染高度钉在 `.agent-detail-column` 可视高度上，内容（Persona scope + meta-grid + Role prompt + Preset import + 编辑器 + Mood + MiniMax voice）比列高时下边框画在中段、子卡 `.preset-card` 物理上铺到边框外面。
  - `.detail-card` 同时被 Agent / Skill / Connector / Custom skill 详情**全部共用**——一处改全治。
- 修复（`desktop-ui/styles.css`）：删 line 3262 的 `.detail-card { height: 100% }`。保留 [3953](desktop-ui/styles.css#L3953) 的 `padding: 24px; min-height: 100%`：内容短时仍填满列、内容长时卡随内容长高、下边框始终包住所有子卡。
- 全局 audit 同步扫了 6 个类别：
  - 其他 card 类的 `height: 100%` 钉死 — 22 处全检，**仅** `.detail-card` 一处中招。其他要么是 layout 容器（`.page` / `.customize-layout` / `.search-stage`）、要么自带 `overflow:hidden` + 内部 grid 滚动（`.search-panel` / `.model-setup-card`）。
  - z-index 层级 — 8 处 fixed/absolute 模态层叠合理：toast 9999 > citation drawer 9000 > edit menu 80 > tool permission 60 > palette/agent dropdown 50 > tts panel 5。唯一小隐患 citation drawer 9000 > tool permission 60，两者同时出现概率极低。
  - `transform: translate` — hover 微抖（1px）+ 抽屉滑入动画，全部范围内偏移无叠加。
  - 负 margin — 仅 `margin-top: -4px` 两处（`.tts-panel-hint` / `.agent-compact-note`）字距微调。
  - max-height 无 `overflow:auto` 配套 — 17 处全部带 `overflow: auto/hidden`，无裸溢出。
  - 其他 `.feature-card` / `.surface-card` / `.artifact-card` / `.project-card` / `.chat-card` — 全部无 height 约束，自然随内容长高。
- 结论：UI 这一类 bug **根因只有一个**，已修。其他类别没等效问题。
- Codex 前置 review **A 级**："小范围正确修复，风险低，无具体发现"。
- 提交哈希：`2731e90`（已 push origin/master）。

## 归档摘要（2026-04-27 13:30 之前的所有条目）

> 按 CLAUDE.md §3 自动压缩：每条仅保留标题 + 一句话结论 + commit hash。完整原始条目见 git history (`git log --follow -p PROGRESS.md`)。

- **2026-04-27 13:30 — Codex C #16/#17/#18/#19 fix chain：customize grid 1101px+ 真实可用宽度** —— 三轮宽度+折叠 Codex C 闭环：grid 220/270/440 总 700px，撤单列折叠，修 ≤1100px overflow:hidden 裁切。`3022905`+`f20767b`+`bcc2b09`+`ae0a964`
- **2026-04-27 13:00 — Customize 页面布局调整：列宽 + 卡片间距 + 重复 .toggle-row 清理** —— grid 改 220/270/440-1fr；删旧 `.toggle-row` 副本；padding 14×16 给文字呼吸；`.skill-health-card` 加 margin-top。`ab06fca`
- **2026-04-27 12:30 — Codex C #15 fix：stale localStorage cache 不再回写覆盖 saved default** —— `src/shared/minimaxVoiceResolver.js` 抽出纯函数（cache 校验后才优先；stale cache 命中 fallback 链 + drop flag 清 localStorage）；10 个 unit case + 3 个 SECRET_LIKE 防擦 case，bisect 验证。（待 commit）
- **2026-04-27 12:00 — Codex C #14 fix：activate-minimax-voice 不再擦掉 saved Default Voice ID** —— client 优先链加 `bootstrap.settings.config.minimaxVoiceId` fallback + 三者都空时 toast 错误不发 POST；server `SECRET_LIKE_CONFIG_KEYS` 加 `minimaxVoiceId` 兜底防意外擦。（待 commit）
- **2026-04-27 11:30 — Codex C fix：MiniMax 数据契约统一 + 测试按钮支持 saved key** —— `connectorRollup.js` 给 connector config 加 4+4 字段（minimax/whisper），TTS 面板改读 `hasMinimaxKey`，`/api/tts/test-minimax` 表单空字段 fallback 到 saved。（待 commit）
- **2026-04-27 11:00 — MiniMax 完整配置入口：connector 表单 + agent voiceId 字段 + 测试播放** —— bootstrap 暴露 `hasMinimaxKey/maskedMinimaxApiKey/minimaxGroupId/minimaxVoiceId`；server 加 `POST /api/tts/test-minimax`；connector 表单加 4 input + Test 按钮；agent 编辑页加 minimaxVoiceId 字段。（待 commit）
- **2026-04-27 10:30 — Codex C #12 fix：WKWebView Browser voice 流式累积 + 末段一次播报** —— Desktop app 下 streaming TTS 累积成末段单播（WKWebView bridge 不支持 FIFO 队列）；真浏览器仍逐句 enqueue speechSynthesis。（待 commit）
- **2026-04-27 10:00 — Browser voice 在 desktop app 没声音 fix：路由到 Swift native bridge** —— `speakWithBrowser` 检测 `webkit.messageHandlers.meloVoice`，desktop app 走 Swift AVSpeechSynthesizer；voice picker 在 desktop 下 disabled + 提示。（待 commit）
- **2026-04-27 09:30 — TTS 拆清楚三种声音来源：Browser / macOS / Edge / MiniMax / API** —— 把"System voice"拆成 Browser voice（speechSynthesis）+ macOS voice（/usr/bin/say）；新加 `/api/tts/say-voices` 端点。（待 commit）
- **2026-04-27 09:00 — Codex B 跟进：OCR 受控测试 + ESRCH 严格断言** —— 加 `_setTesseractForTests` DI hook + 2 个 mid-createWorker / mid-recognize abort 测试；yt-dlp 测试 `process.kill(pid, 0)` 收紧到只接 `/ESRCH/`。（待 commit）
- **2026-04-27 08:30 — Codex C #11 fix：fake yt-dlp 改 exec 防 orphan + OCR 提前注册 abort listener** —— fake bash 末行 `sleep 99999` → `exec sleep`；`runOcrWithAbort` listener 提前到 createWorker 之前注册 + flag/workerRef 三种 abort 路径。（待 commit）
- **2026-04-27 08:00 — Codex B 跟进：OCR 改 Tesseract worker 可中断 + yt-dlp 测试反假绿加固** —— `Tesseract.recognize` 换成 `createWorker` + `worker.recognize` + 可 terminate；yt-dlp fake 写 4 marker 证明 SIGKILL 真生效。（待 commit）
- **2026-04-27 07:30 — Codex C #10 fix：videoExtractor 直接调 AbortSignal.any 改走 composeAbortSignals** —— 抽出 `composeAbortSignals(...signals)` 通用版；videoExtractor.js 3 处 `AbortSignal.any` 全替换；2 个 monkeypatch 回归证 fallback 仍 propagate。（待 commit）
- **2026-04-27 07:00 — Phase 4 第 1 刀：orchestrator abort 全链路 + 全 extractor signal 贯通** —— image / PDF / link / yt-dlp 信号链路一次扫干净；`combineSignals` 抽到 common.js；4 个 orchestrator-level integration test。（待 commit）
- **2026-04-27 06:30 — Codex B-grade follow-up：AbortSignal.any 兼容 fallback + 测试 fixture-fail 显式 skip** —— `combineSignals` 加 Node <20.3 manual fallback；whisper-cli 假绿测试改 `t.skip()`。`424cbe8`
- **2026-04-27 05:00 — audioExtractor signal 测试反假绿 + 下载阶段补 signal（C #6）** —— 加 `_setWhisperCliForTests` DI hook 解决 module-load 资源化；OpenAI 测试 authMode 改 'api-key'；新增 download abort 测试；`readAttachmentBuffer` 接 signal 走 combineSignals。`aadc7dd`
- **2026-04-27 04:30 — audioExtractor 全链路 signal 化（C #5）** —— `tryWhisperCpp` / `convertToWavForNative` 走 `execFileAsync({ signal })`；native + OpenAI fetch 走 combineSignals；3 个真 child-kill / fetch-abort 测试证明 backend 真响应 abort。`0ed90fd`
- **2026-04-27 04:00 — Video Phase 3 hardening：audio + keyframes 真并行** —— audio + keyframes 改 `Promise.all` 并行，独立 budget（audio 10s / keyframe 5s）；新增 `withAudioBudget` + `audioBranch`（spawnWithAbort 接 ffmpeg）；slow/hanging audio + 100ms budget → frames-only entry。`1f29b00`
- **2026-04-27 03:30 — Video Phase 3 落地：keyframes 不再依赖 transcript 成功** —— 加 `_setExtractAudioContentForTests` DI hook；audio 抽取 fail/null 时不再吞 keyframes，改返 `source: 'video-keyframes-only'` entry；意外抓到 silent-video 真 bug（ffmpeg -vn 在无音轨时 reject 整个 extraction）。`a5d855c`
- **2026-04-27 03:00 — Video Phase 2 修复 #2：abort 链路贯通 ffprobe + ffmpeg** —— 抽 `spawnWithAbort(bin, args, { signal, collectStdout, onSpawn })` 统一 child + signal 耦合；`probeDurationSec` 接受 signal；3 个 child-kill 测试用真挂死的 `node -e setInterval` 证 SIGKILL 实落地。`1dba8b4`
- **2026-04-27 02:30 — Video Phase 2 修复：keyframe 抽取 5s 硬超时** —— 加 `KEYFRAME_BUDGET_MS = 5000`、`extractKeyframes(_,_,{signal})` 接收 AbortSignal、`withKeyframeBudget(work, ms)` race 内部 AbortController 与 setTimeout，超时 SIGKILL ffmpeg 子进程 + resolve []，transcript 成头等公民。`5d33930`
- **2026-04-27 02:00 — Video Phase 2 上线：关键帧抽取（音轨 transcript + 5 张关键帧）** —— `videoExtractor.js` 加 `probeDurationSec` + `extractKeyframes`，每 N 秒一帧 / scale 512px / JPEG q4 / cap 8 张；`messageBuilder.js` 按 `attachmentId` 把 keyframes emit 成 `image_url` parts；UI 副标改 "transcript + keyframes"。后被 5d33930 / 1dba8b4 / a5d855c 多轮 Codex C-grade gate 修补。`adb21ca`
- **2026-04-27 01:35 — Video Phase 1：UI 文案诚实化** —— 视频 attachment 实际只走 `ffmpeg -vn` 抽音轨转写、无视觉信息，UI 加副标 "audio transcript only" / drop banner / caption hint 三处同步，避免用户误以为模型能看画面。`75b9370`
- **2026-04-27 01:10 — Composer Link 入口统一 URL 分类** —— `desktop-ui/app.js` 的 manual Link 改走 `promoteTextUrlsToAttachments`（共享 `/shared/urlDetector.js` 静态路由），YouTube/音频/视频/PDF/普通网页粘贴文字 vs 点 Link 得到同样的 kind/mimeType/title；6 个 promoted-shape 契约测试。`207ea6a`
- **2026-04-27 00:45 — Artifacts UI 按钮重新设计** —— Edit/Delete 改 `.small-button` 文字变体（is-outline / is-danger / is-primary），跟已有 Queue write 同款语言；删 unused pencil/trash icon；编辑表单加 surface-card 类对齐创建表单。`0a8064a`
- **2026-04-27 00:30 — Artifacts CRUD：补 service-layer 单元测试** —— `workspaceMutations.test.js` 加 8 个测试覆盖刚抽出的 `updateArtifact` + `deleteArtifact`（identity 保留 / 空 content 拒 / 未知 id 报错 / 项目 updatedAt bump 等），用 mkdtemp + dynamic-import + after()-cleanup 同款隔离模式。`fac4732`
- **2026-04-27 00:00 — Artifacts：只读产物架升级成可管理知识架** —— 修语义闭环（`artifact.summary` 不存在字段 → 改读 `artifact.content` 安全截断）；后端 + UI 加 update/delete CRUD（POST `/api/artifacts/update` / `/api/artifacts/delete`）；UI 加 Edit/Delete 按钮 + 编辑表单 + UUID + uiState.editingArtifact{Id,Draft}。`2777eab`
- **2026-04-26 23:30 — Phase 7d-5ζ：Telegram + Discord polling clusters 一并搬走** —— `src/services/remote/telegramPolling.js`(~610 行) + `discordPolling.js`(~750 行) byte-for-byte 抽出；desktopStore 净减 ~1140 行 → 2029（本会话累计 -76.2%）。`5419a9b`
- **2026-04-26 23:00 — Phase 7d-5ε commit 3：4 簇 mutations 一并抽走** —— project + task + workspace + approval = 17 funcs / 412 行，4 个 sibling leaf 模块同 commit 创建；workspaceMutations.js 后续作为 Artifacts CRUD 升级落点。`b997e14`
- **2026-04-26 22:30 — Phase 7d-5ε commit 2：抽出 Skill mutations 簇** —— `src/services/skill/skillMutations.js` byte-for-byte 把 10 个 exported skill CRUD 搬走（~331 行）。`208e51d`
- **2026-04-26 22:00 — Phase 7d-5ε commit 1：抽出 External Connector CRUD 簇** —— 7 个 exported CRUD 函数搬到 `src/services/connector/externalConnectorMutations.js`（~277 行）。`9721cd1`
- **2026-04-26 21:30 — desktopStore unused-import cleanup r2 + PROGRESS condense** —— 第二轮死 import 清理（9 整删 + 2 trim），同时 PROGRESS 从 189 → 127 行。`55b7630`
- **2026-04-26 21:00 — Phase 7d-5δ commit 8f：抽出 sendChatMessage（path B 真正收尾）+ scanRecentChatsForSkillProposals** —— `src/services/chat/sendChatMessage.js`（~360 行）+ `src/state/skillProposalScan.js`（49 行）；本会话累计突破半数 (-51.2%)。`9895335` + `f1ced20`
- **2026-04-26 20:30 — Phase 7d-5δ commit 8e：抽出 getDesktopBootstrap + 4 cluster-private helper** —— `src/state/desktopBootstrap.js`(~240 行)；getAgentMarkdownPaths 工厂用 lazy `() => join(getMeloHome(), ...)` 形式遵守 CLAUDE.md §6 调度时捕获 env。`0a05a30` + `e7d2872`
- **2026-04-26 20:00 — Phase 7d-5δ commit 8d：抽出 search-results builder 簇（644 行 6 函数 + 1 const，单 commit 第二大瘦身）** —— `src/services/search/searchResultsBuilder.js` byte-for-byte 抽走整个 cluster；getDesktopBootstrap 的最大 LOCAL 依赖。`edd3e76`
- **2026-04-26 19:30 — Phase 7d-5δ commit 8c：抽出 refreshChatMemorySummary + buildConnectors** —— refreshChatMemorySummary 追加到 chatThreadContext.js；buildConnectors 搬到新建 `src/services/connector/connectorRollup.js`（共 105 行）。`66cd1a8`
- **2026-04-26 19:00 — Phase 7d-5δ commit 8b：updateStateAtomically 搬回 state/stateStore.js（§5 carve-out 反转）** —— 13 行 helper 从 desktopStore byte-for-byte 搬到该住的 stateStore.js；§5 carve-out 失去存在理由后退役。`3c71ee6`
- **2026-04-26 18:30 — Phase 7d-5δ commit 8a：抽出 ensureSelectedEntities（最大 LOCAL 依赖，58 callers）** —— 67 行 selection-coercion helper 搬到 src/state/stateSelections.js；retire 了 §5 carve-out 的 ensureSelectedEntities 阻塞物，让 8b 能把 updateStateAtomically 搬回 stateStore。`9955870`
- **2026-04-26 18:00 — desktopStore unused-import cleanup（path B 完成后的 housekeeping）** —— Python 脚本扫 110 个 import block，22 整删 + 17 trim，共减 105 行；中间踩过"花括号里夹注释"导致 `projectAgentOverrideFor` 被误吞的小 bug，regression suite 即时抓到。`46a85b8`
- **2026-04-26 17:45 — Phase 7d-5δ commit 7d：smoke 测试加 MELO_HOME 隔离（gate 第 3 次 D + 数据丢失事件 + 恢复）** —— 此前 7c smoke 测试没隔离 MELO_HOME，运行时**真覆盖了 ~/.melo/desktop/state.json**；恢复 04-22 备份；测试加 mkdtemp + after() hook + mtime 哨兵双保险。`b4cc16a`
- **2026-04-26 17:00 — Phase 7d-5δ commit 7b：抽出 runChatAgentExecutionGraph 大象（517 行）** —— 单 commit 史上最大 byte-for-byte 抽取；getSharedSkillIndex 同行迁移；gate 一次 D（getAllTools 漏 import）即时修复。`9c76db9` + `91a25d9`
- **2026-04-26 16:45 — Phase 7d-5δ commit 7a：抽出 MODE_DEFS** —— 20 行静态数组，elephant 抽取的最后一个 prereq。`2f52bf2`
- **2026-04-26 16:30 — Phase 7d-5δ commit 6：抽出 runTaskAgentExecutionGraph（第一个 runner，pattern 验证通过）** —— 87 行任务执行图搬到 services/chat/taskExecutionRunner.js，零 desktopStore 反向 import。`ce97d12`
- **2026-04-26 16:00 — Phase 7d-5δ commit 5：抽出 effectiveAgentProfile + projectAgentOverrideFor** —— 两个 profile 组合 helper 放进现成的 state/agentProfiles.js；实查 8 callers 不是 57。`7055c17`
- **2026-04-26 15:30 — Phase 7d-5δ commit 4：抽出 taskExecutionPrompt** —— 26 行纯函数搬到 services/task/taskPrompt.js，唯一依赖 agentUsesTool 已是 leaf。`12e85aa`
- **2026-04-26 15:00 — Phase 7d-5δ commit 3：抽出 buildWorkspaceSnapshot（带 APP_ROOT 深度调整）** —— 52 行 async 搬到 services/workspace/workspaceSnapshot.js，APP_ROOT 用 4 个 dirname 重算（同 stateHydration 模式）。`f3f61d5`
- **2026-04-26 14:30 — Phase 7d-5δ commit 2：抽出 4 个 findXById finder 簇** —— `findProjectById/findExternalConnectorById/findTaskById/findApprovalById` 共 16 行搬到 src/state/stateLookups.js；35 callers 走 imported name。`be96ec6`
- **2026-04-26 14:00 — Phase 7d-5δ commit 1：抽出 chat-graph action planner 簇** —— 7 函数（normalizeGraphNeedle / planCommandAction / planExternalConnectorAction / 等 + planChatGraphAction + buildApprovalResponse）共 ~210 行搬到 services/chat/chatActionPlanning.js。`7866271`
- **2026-04-26 13:30 — Phase 7d-5γ commit 4：抽出 buildAgentMemoryNodeContext + 私有 helper（单 commit 史上最大瘦身 -330 行）** —— 337 行函数 + 5 行 latestUserMessageRecord 搬到 services/agent/agentMemoryContext.js；解码"Explore agent 报 7+ LOCAL deps，实查只 1 个"。`b30d563`
- **2026-04-26 13:00 — Phase 7d-5γ commit 3：抽出 buildChannelRoutePrompt（实查后是真叶子）** —— 117 行函数搬到 services/remote/channelRoutePrompt.js；中间踩过一个 import 路径错认（normalizeConversationSnippet 实际在 memory/heuristics.js 不在 viz/citation.js），被测试套件即时捕获。`8bda000`
- **2026-04-26 12:45 — Phase 7d-5γ commit 2：抽出 buildToolRoutingPrompt（拿到 S 评级）** —— commit 1 把 COMMAND_TEMPLATES 抽走后 buildToolRoutingPrompt 降级为零依赖叶子。Codex 评 S。`de7815c`
- **2026-04-26 12:30 — Phase 7d-5γ commit 1：抽出 COMMAND_TEMPLATES + commandTemplateDescriptor** —— 静态数据 + 专用 shaper 一起搬到新建 services/command/ 子目录，6 个内部 caller 走 imported name。`6e2e171`
- **2026-04-26 12:00 — Phase 7d-5β commit 3：抽出 buildDynamicContext + PROGRESS condense** —— 61 行 async 搬到 services/chat/dynamicContext.js；同 commit 把 fix-5/6/7 三个详细条目移入归档。`6d18e87`
- **2026-04-26 11:30 — Phase 7d-5β commit 2：抽出 buildProjectContextSection（单依赖）** —— 5 行函数搬到 services/project/projectContext.js，唯一依赖 agentUsesTool 已经是 leaf。`8364a5f`
- **2026-04-26 11:00 — Phase 7d-5β commit 1：4 真叶子 bundle commit + re-export fixup** —— matcherContext / connectorPrompts / skillPrompts / visionDebug 共一个 commit，gate 抓出 contract-break (C → A fixup)。`d056e8d` + `ce56b0c`
- **2026-04-26 10:15 — git pp B-finding 顺手修：commit_count == 0 早退出** —— 本地落后 upstream 时不再浪费一轮 Codex eval。`5742e66`
- **2026-04-26 10:00 — git pp 第二轮收紧：显式 refspec push** —— 用 `git push <remote> HEAD:<remote-branch>` 替代裸 `git push`，绕开 push.default 影响。`2c43ec2`
- **2026-04-26 09:30 — git pp 收紧范围：上游必需 + 拒绝额外参数** —— 强制 tracking upstream + 拒绝转发任何 args + pre/post 共用 base_sha。`137c9a6`
- **2026-04-26 09:00 — Phase 7d-5α-A1 fix-8：applyMemoryStoreSchema 返回 vecAvailable（第 8 次 C 评级修复）** —— vec_memories CREATE 失败时把 disposable handle 的 vec 标志降为 false，下游 _runReplaceMemoriesOn 不再 prepare 不存在的 vec_memories；fix-7 测试加固直接查 memories 行。`5d2c6ac`
- **2026-04-26 07:30 — Phase 7d-5α-A1 fix-7：memory store cross-home isolation（pre-push gate 第一次实战）** —— `applyMemoryStoreSchema` 抽出私有函数；`withDisposableStoreAt` + `runInTransactionOn` 给替代 storePath 走独立 sqlite 句柄；`getCachedEmbedding`/`resolveCacheModelId` 都接受 explicit database 参数（transitive call chain 隔离）；新增 fix-7 回归测试。`559fbae`
- **2026-04-26 06:30 — Phase 7d-5α-A1 fix-6：StateLoadContext 贯穿全 chain（结束 6 轮 isolation 修复）** —— 把 home 升格为 first-class context object：`checkpointer` 4 op + `hydrateChatThreads` + `persistChatThreads` 全部接受 `{ threadsDir }`；缓存改 by-dir 索引；`captureLoadContext` 扩展为 `{home, stateFilePath, threadsDir, getAgentMarkdownPaths}` 贯穿整个 load chain；新增 stateLoadContextChain.test.js（3 tests）。`f3b0f29`
- **2026-04-26 05:30 — Phase 7d-5α-A1 fix-5：readStateSnapshot 整体 home capture（CLAUDE.md §6 落到调用链）** —— `captureLoadContext()` 在 readStateSnapshot 入口一次性捕获 home + path + helpers，整个 load chain 共享；`saveState/persistStateAtomically` 接受 `capturedStatePath`；新增 readStateSnapshot full-chain capture 测试。`08cfab3`
- **2026-04-26 04:30 — Phase 7d-5α-A1 fix-4：async-timing capture (Q5-B + Q6-b + CLAUDE.md §6 落盘)** —— `queueAgentMarkdownPrime` + `importAgentMarkdownFiles` 改成调度/入口时一次性捕获 home-bound factory，async 体内禁止再读 env；CLAUDE.md §6 写入硬规则。`2063d9e`
- **2026-04-26 03:30 — Phase 7d-5α-A1 fix-3：cache-level cross-home isolation (Q3-B + Q4-b + 扩大 audit)** —— `checkpointCache` 改嵌套 `Map<home, Map<threadId>>`、`markdownPrimeQueued` 改 Set；4 项 module-level state 全审计无遗漏。`a104f23`
- **2026-04-26 02:30 — Phase 7d-5α-A1 commit 8+9 fix：MELO_HOME 隔离修复 (Q1a + Q2b)** —— `markdownSynced` 单 boolean → by-home Map；`createAgentMarkdownFileHelpers` 接受 lazy `() => agentsDir`；checkpointer.js 的 `THREADS_DIR` const 改 lazy。`808db9e`
- **2026-04-26 01:30 — Phase 7d-5α-A1 收尾 (Commit 8+9)：state-machine 全部搬出 desktopStore** —— 新增 `markdownSync.js` + `stateStore.js`（共 ~280 行）；desktopStore 净减 ~196 行（7304 → 7186）；`enqueueStateWrite` §5 carve-out。`856aa07`
- **2026-04-26 00:55 — Phase 7d-5α-A1 commit 7 fix：恢复 sanitizeWorkspacePath wrapper + 审计 commits 1-6** —— `stateHydration.js` 找回 1-arg local wrapper（绕 2-arg `Raw` 函数的 byte-for-byte 漏洞）；新增 10 个回归测试。`a6c1802`
- **2026-04-26 00:28 — git pp 改成 push 前先 evaluation** —— `scripts/codex-review.sh` 升级双门：pre-push evaluation 解析评级阻断 C/D，保留 post-push 兜底。（用户改，未单独 commit；后续被 `f4bc254` 替换）
- **2026-04-26 00:25 — Phase 7d-5α-A1 (Commit 7/9)：抽出 stateHydration 簇** —— 9 个 export（4 hydrate + 2 normalize + 1 helper + 4 const），`APP_ROOT` 多套一层 `dirname` 适配深 1 层目录。`7b051fa`
- **2026-04-25 23:55 — Phase 7d-5α-A1 (Commit 6/9)：抽出 mergeDiskSkillsIntoState** —— 41 行纯叶子搬到 `diskSkills.js`，desktopStore 的 `reloadDiskSkills` 从此 import。`c332b07`
- **2026-04-25 23:35 — Phase 7d-5α-A1 (Commit 5/9)：抽出 memorySnapshot 簇 (~400 行最大单 commit)** —— `syncMemoryStoreSnapshot` + `buildMemoryStoreEntries`(384 行) + `buildSpeakerMemoryNamespace`，零循环。`f0b528e`
- **2026-04-25 23:10 — Phase 7d-5α-A1 (Commit 4/9)：persistChatThreads 加入 chatPersistence.js** —— commit 3 已搬走 `ensureChatThreadContext`，所以 4 个 deps 全外部化。`8ab7817`
- **2026-04-25 22:55 — Phase 7d-5α-A1 (Commit 3/9)：抽出 chatThreadContext 簇** —— 9 个 export（cache helper + builder + checkpoint payload），后续 commit 4/7 的 prerequisite。`2cc94a8`
- **2026-04-25 22:30 — Phase 7d-5α-A1 (Commit 2/9)：抽出 serializeChatForPersistence 纯叶子** —— 17 行 pure object reshape 单独 commit；同时把原"7-commit 计划"修订为 9 commit。`4d81ef4`
- **2026-04-25 22:00 — Phase 7d-5α-A1 (Commit 1/7)：抽出 chatPruning（撤回 cec12c3 错方向，重做 path A）** —— 4 个 chat-pruning 符号搬到 `state/chatPruning.js`，byte-for-byte。`80efd7d`
- **2026-04-25 21:30 — Phase 7d-5α：暴露 state-machine helpers 为后续 elephant 移植铺路** —— 5 个函数加 `export` 关键字，纯加 export 不动逻辑。（无独立 commit hash；后续被 `856aa07` 调整覆盖）
- **2026-04-25 19:30 — Phase 7d-2：抽出 systemPrompt + CLAUDE.md §5 落盘** —— `buildReActSystemPrompt` + 5 helper 搬走（~210 行 + 25 测试）；§5 byte-for-byte 规则首次写入。`ffc477a`
- **2026-04-25 19:03 — 增加 git pp 后 D/C/B/A/S 质量评估 gate + codex.md 改本地派生** —— `EVALUATION.md` 写入五档评分；`codex.md` 加进 `.gitignore`。`1f636e2`
- **2026-04-25 00:20 — Phase 7d-1：抽出 messageBuilder (chatExecutionService 拆解 ①/N)** —— 8 函数 + 9 常量搬走（~280 行），desktopStore 净减 269 行（最大单次瘦身），首次发现"简化重写"陷阱并回退。`8c387a4`
- **2026-04-24 23:45 — Phase 7c：抽出 agentProfileService 纯逻辑核心** —— 3 块纯逻辑（normalize patch / stale-draft guard / new agent seed），18 个新单元测试。`7250cd7`
- **2026-04-24 23:00 — Phase 7b：抽出 workspaceService + 强化 review prompt** —— 3 个 workspace I/O 函数 + 测试；`codex-review.sh` 强制 4 步探索流程。`33aba21` + `0f7d2af`
- **2026-04-24 22:10 — Phase 7a：抽出 searchService (desktopStore 解耦 ①/④)** —— 2 个 search 函数搬到 `services/search/`，DI 边界 + 薄壳 re-export 范式确立。`8c03a68`
- **2026-04-24 21:47 — `npm run progress:codex` 自动生成 codex.md 快照** —— 跨会话快速接续机制。`3fcbdea`
- **2026-04-24 21:30 — 首次远程推送 + 工作协议落盘** —— 配置 `origin = github.com/MortredVigoss/Melo`，3 个积压 commit 全量推送。`5f128c6` + `8fb3cf9` + `f87c06c`
- **2026-04-24 20:00 — 修复图片生成 HTTP 400** —— `/codex/responses` 请求体加 `instructions` 字段，模型不再编造"等了 180 秒"。`8fb3cf9`
- **2026-04-24 19:00 — 修复 4 处历史测试失败** —— `audioExtractor.js` 加 codex-env-fallback；`openai.js` 去掉 `[Audio attachment: …]` 占位符。`5f128c6`
- **2026-04-24 14:00 — 初始化工作协议** —— 新建 `CLAUDE.md`（三条硬性规则）和 `PROGRESS.md`。`f87c06c`
