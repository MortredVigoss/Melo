# Melo 进度日志

> 新条目追加在本文件顶部（时间倒序）。
> 当本文件超过 160 行或 8000 字符时，按 CLAUDE.md §3 自动压缩：最旧 70% 归档为一句话摘要，最新 30% 保留完整格式。

---

## 2026-04-28 11:00 — Codex D 第二轮：MCP lifecycle reconciler（全局 disable 真生效）

- 上一刀 `4d9dc73` push 又被 Codex D 阻断，3 个 finding 都是 lifecycle 真 bug：
  - 🔴 `bootstrapMcpServers` 只 connect effective servers，**不 disconnect 已不在 effective map 的 active client**。`/api/mcp/preset-toggle` 关闭 antv-chart 后，effective 没它了，但 child process 还跑、`mcp:antv-chart:*` tools 仍在 toolRegistry 里 register 着，已授权 agent 仍能调 → 全局 disable 实际不生效。
  - 🔴 `connectMcpServer(disabled=true)` 在 disabled 直接 return，**不 disconnect 同名旧 client**。user 把自己 mcpServers `disabled: true` 后，server 仍跑。
  - ⚪ preset-toggle 缺 lifecycle 测试。
- 用户拍板：lifecycle 修 + Q1=保留 stale agent whitelist（用户可撤销，跟之前一致）+ Q2=保留（user 删除 config 后 agent whitelist 也保留）。
- 修：
  - **抽 `reconcileMcpLifecycle({ effective, activeNames, disconnect })`** 纯函数（[manager.js](src/mcp/manager.js)）：拿 effective vs active snapshot 对比，标 stale 为 `removed` 或 `disabled`，调 disconnect 副作用。`bootstrapMcpServers` 用它先 reap 再 connect。
  - **`connectMcpServer(disabled=true)`** return 前先 disconnect 同名旧 client（覆盖 user-server flip 到 disabled 场景）。
  - 文档化契约：agent stale whitelist 保留是 OK 的，因为 lifecycle 真 unregister 了 tool（modeling 层切断）+ whitelist 在 config 层（保留可撤销），两层独立。
- 7 个 lifecycle 测试覆盖：preset toggled off / user disabled=true / user removed from config / 健康 steady state / 冷启动 / 混合多 reason 同次 reconcile / 无 disconnect 时 pure read。
- 验证：`src/**/*.test.js` **1143/1143 全绿**（前次 1136 + 7 新 lifecycle）；`npm run test:ui` 74/74；check-syntax 全过。
- 提交哈希：待填。

## 2026-04-28 10:30 — Codex C 第二轮：mcpAuthSurface 统一 + boolean 严格 + 测试 NUL 修复

- 上一刀 `799a9a4` push 又被 Codex C 阻断，3 个 finding 都真：
  - 🔴 per-agent UI 只列 built-in presets，**user-configured `mcpServers` 注册了 tool 但 UI 看不见 → user MCP 永远 deny-all 死锁**。
  - 🟠 `Boolean(body?.enabled)` 把 `"false"` / `"0"` 等 truthy 字符串当 true，`/api/mcp/preset-toggle` 可被误开启。
  - ⚪ `src/mcp/manager.test.js:78` 行因为我打字时输入 control char 实际有 literal NUL 字节，git 识别为 binary。
- 用户决定（同意推荐 A+A）：user-configured MCP 跟 built-in 同 4 层模型；全局 preset 关闭后 agent stale 授权保留可撤销（已在前次实现）。
- 修：
  - **🔴 `bootstrap.customize.mcpAuthSurface[]`**（[desktopBootstrap.js](src/state/desktopBootstrap.js)）—— built-in presets ∪ user `config.mcpServers` 的 unique 联合；每条带 `source: 'preset'\|'user'`、`enabled` 状态、command/args/description。User 条目 `enabled` 由 `disabled` 字段决定（不受 preset flag 影响）；id 撞名时 user 覆盖 preset（与 `buildEffectiveMcpServers` 同语义）。Agent UI [app.js:8068](desktop-ui/app.js#L8068) 改用 `mcpAuthSurface`（`mcpPresets` 留作 legacy fallback），现在 user MCP 也会出现在 chip-row。
  - **🟠 `/api/mcp/preset-toggle` 严格 boolean**（[server.js](src/server.js)）：`typeof body.enabled === 'boolean'` 才放行，否则 400 + 错误信息 `"\`enabled\` must be a literal boolean"`。
  - **⚪ NUL 修**（[manager.test.js](src/mcp/manager.test.js)）—— 用 python 直接定位 byte 3628 替换为 ASCII 空格。`file` 命令现报 UTF-8 text 不再 binary。
- 新增回归测试：[agentTools.test.js](src/services/agent/agentTools.test.js#L93) 的 `user-configured MCP servers are whitelistable too` —— 显式 pin "filter 不区分 preset vs user，只看 server id" 这个语义；任何 `mcp:my-custom-server:*` 都受同一白名单 gate。
- 验证：`src/**/*.test.js` **1136/1136 全绿**（前次 1135 + 1 新 user-MCP 测试）；`npm run test:ui` 74/74；check-syntax 全过。`/api/mcp/preset-toggle` boolean 校验是 server.js 内联代码，没有单独 endpoint test 框架；contract 在代码 + 注释 + commit message 里 pin 住。
- 提交哈希：`4d9dc73`。

## 2026-04-28 10:00 — Codex D 修复：MCP 默认全关 + cwd 不再吹 sandbox + path 加严 + agent UI 撤销已有授权

- 上一刀 `3007bdf` push 被 Codex D 阻断（4 个 finding）。原因是我误读用户原话"默认只启用搜索和 PDF" —— 那指的是 melo 既有的搜索 + PDF 附件入口，**不是** markdown2pdf MCP。stdio MCP 默认开等于 approval/whitelist 之前进程已运行，跟安全模型矛盾。
- **🟠 默认全关**：[config.js](src/config.js) `enableMarkdown2PdfMcp` 改 `false`（与 `enableAntvChartMcp` 对齐）；注释明文 4 层状态契约。
- **🟠 cwd 不再叫 sandbox**：[manager.js](src/mcp/manager.js#L37) + [client.js](src/mcp/client.js) 注释重写 —— cwd 只控默认落盘位置，**不限制绝对路径 / `..` / fs API**。真正的访问控制靠 per-agent whitelist + per-call approval。
- **🟠 path 校验加严**：[mcpServerWorkspaceDir](src/mcp/manager.js#L48) 现禁绝 `.` / `..` / 全空白 / sanitise 后无字母数字 leaf；用 `path.resolve` 做最终路径校验，不在 workspace root 下的强制走 `mcp-server` fallback。新加 2 条边界测试覆盖 dot/dotdot/whitespace/multi-dot + workspace-root 越界。
- **🔵 agent UI 撤销已有授权**：[app.js:8083](desktop-ui/app.js#L8083) 改 `disabled` 属性 → CSS 类 `.is-disabled-preset`（点击仍生效）。chip 行为：whitelist 已有 → 总是允许撤销（避免 stale 授权在全局重启后静默继承）；whitelist 没有 + 全局关 → 弹 flash-toast 提示 "enable in Advanced first"，不写入 whitelist。
- **README 加 4 层状态文档**：installed / globally enabled / agent authorised / per-call approval —— 用户能看清"我现在到底在哪一层"。
- 验证：`src/**/*.test.js` **1135/1135 全绿**（前次 1133 + 2 path 边界）；`npm run test:ui` 74/74；check-syntax 全过。
- 提交哈希：`799a9a4`。

## 归档摘要（2026-04-28 09:00 之前的所有条目）

> 按 CLAUDE.md §3 自动压缩：每条仅保留标题 + 一句话结论 + commit hash。完整原始条目见 git history (`git log --follow -p PROGRESS.md`)。

- **2026-04-28 09:00 — MCP 全局接入 + per-agent 白名单 + Advanced UI（AntV chart + markdown→pdf）** —— 4 phase 一次性：BUILTIN_MCP_PRESETS（antv-chart + markdown2pdf）+ McpStdioClient cwd + 默认 cwd 子目录；agent profile `enabledMcpServerIds`（deny-all）+ filterMcpToolsForAgent prompt/dispatch 双 enforcement；buildMcpTool 默认 requiresPermission=true 走 approval；bootstrap mcpPresets[] + Advanced toggle UI + agent customize chip-row + `/api/mcp/preset-toggle` 端点。30 新单测，1133/1133 全绿。`8778052` + `3ae3285`
- **2026-04-27 16:50 — TTS / 视频 / 配置入口 4 处体验断点** —— Voice 面板加 Auto radio + WKWebView 改名 Desktop native voice + 视频附件 chip 读 extractedMedia 显示真实状态 + Voice 面板加配置 MiniMax/Whisper 跳转。`9f5a87a`
- **2026-04-27 19:30 — Codex D fix: desktopStore re-export gap + server import smoke net** — af2e3b7→768d511 left `restoreArtifact`/`purgeStaleSoftDeletes` un-re-exported, server boot would throw on first ESM load; added the missing re-exports + `src/server.imports.smoke.test.js` (parses server.js import list and asserts every name is reachable through desktopStore). Codex S. `5a888ee`
- **2026-04-27 19:00 — Codex C round 2: artifact soft-delete reader audit + 11 regression tests** — af2e3b7 missed 4 readers (dynamicContext/search/apply/connector count); added `isLiveArtifact`/`visibleArtifacts` helper, wired 7 readers, +11 tests. `768d511`
- **2026-04-27 18:30 — artifact soft-delete contract → server-driven** — `e1a8ecf` used a client setTimeout (timer lost on reload) → Codex C; switched to server-side `deletedAt` + `/api/artifacts/restore` + 7d GC, client became fire-and-forget pair, 17 backend tests. `af2e3b7`
- **2026-04-27 18:00 — 5 处次级 UX 体验提升** —— 批 1 `5f9107a`：PDF 入口 + Advanced Copy state.json + Tasks lane overflow + Search 空状态分类提示 + showFlashToast helper。批 2 `e1a8ecf`：artifacts 软删 + undo toast 第一版（client-timer，被 18:30 D-grade 改成 server-driven）；undoToast.js + 16 单测。test:ui 71/71，memory 330/330。
- **2026-04-27 17:30 — desktop-ui test harness 落地** —— byte-for-byte port `describeVideoExtractionStatus` + 拆 `renderAdvancedPage` 成显式 props；`npm run test:ui` 52/52 全绿；闭环 14:30 Advanced B + 本批 ⚪ 两条 same-root follow-up；后续 desktop-ui "抽纯函数 + .test.js" 标准模式确立。Codex S。`a9aa5a8`+`7a6710e`
- **2026-04-27 16:25 — Codex B 第三轮：threshold capture 真正 mid-call 锁定** —— compactQualityThreshold 始终返回 finite number（空/非法 → 0.6 默认），evaluator 不再回头读 env；contract test 锁定 mid-call env 突变不影响 fallback 决定。`da4e09e`
- **2026-04-27 16:10 — Codex B 追加 follow-up：MELO_SUMMARY_QUALITY_THRESHOLD="" 边界** —— `Number('') === 0` 让 fallback 全放行；trim + 空字符串短路 + 2 回归测试。`d339782`
- **2026-04-27 15:55 — Codex B 4 条 follow-up：bench rank / vec-aware / threshold capture / fallback DI** —— 🔵 `--rank tier\|global` 默认 tier；🟡 `embeddingActive && vecAvailable` 才报 ANN；🟡 入口 capture threshold；⚪ `_setCallLocalLlmForTests` DI hook + 4 mock 测试。`9d504b2`
- **2026-04-27 15:30 — F-3C：README "Memory and embeddings" 节落地** —— bge-m3 onboarding 引导（`ollama pull bge-m3` + 4 级降级链 + env 矩阵 + bench 跑法）；闭环最后一条横评扣分项。`dece161`
- **2026-04-27 15:15 — F-2C：reference-free summary quality + dreams diary 接入** —— 新增 `src/memory/dreaming/summaryQuality.js`（length / entityCoverage / tokenGroundedness 三指标 score = 0.1+0.4+0.5）+ `auditSummary` 写当日 DREAMS.md；`compact.js` 接入按 `MELO_COMPACT_QUALITY_GATE` 处理 LLM 输出；18 新单测 + memory 套 323/323 全绿。`aad4f72`
- **2026-04-27 14:45 — F-1A：memory retrieval bench（黄金集 + recall@k 报告）** —— 新增 `bench/memory/{golden.example.json, README.md}` + `scripts/bench-memory.js` + npm `bench:memory`；支持 `--no-embed` / `--validate` / `--json` / `--threshold-recall5` CI gate；305/305 memory tests 不退化。`eb74e07`
- **2026-04-27 14:30 — 后台能力分层：MCP / plugins / background-tasks 挪到 Customize → Advanced** —— 新增 renderAdvancedPage() 4 subsection；侧栏 Runtime → Advanced 入口 coerce；删 684 行死代码；regression 1057/1057；Codex B。`e9eb5b6`+`40c747b`
- **2026-04-27 14:00 — UI overlap 全局 audit：根因 .detail-card height: 100% 一处修光** —— 删 styles.css:3262 `height: 100%`，保留 min-height; 6 类 UI 叠加 audit 仅此一处中招。Codex A。`2731e90`
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
