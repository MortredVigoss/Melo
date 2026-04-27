# Melo 进度日志

> 新条目追加在本文件顶部（时间倒序）。
> 当本文件超过 160 行或 8000 字符时，按 CLAUDE.md §3 自动压缩：最旧 70% 归档为一句话摘要，最新 30% 保留完整格式。

---

## 2026-04-27 18:30 — Codex C 修复：artifact 软删契约改为 server-driven（response to e1a8ecf C-grade post-push review）

- 上一刀 `e1a8ecf` 用前端 setTimeout 实现 5s undo 窗口，git pp post-push review 给 C：🔴 reload/close 时 timer 死掉 → server 没删但 UI 说 "Deleted"；🟡 单 toast 实例覆盖前一个 undo；⚪ DOM 状态机无自动化测试。用户选方案 C（最彻底）：后端 soft-delete + restore 端点。
- **Phase 1（后端契约）**：[workspaceMutations.js](src/services/workspace/workspaceMutations.js) 把 `deleteArtifact` 从硬删改为 stamp `deletedAt`；新增 `restoreArtifact`（清 deletedAt）+ `purgeStaleSoftDeletes({ olderThanDays = 7 })`（idempotent，evict 旧 tombstone）。`normalizeArtifact` ([artifactService.js](src/services/artifact/artifactService.js#L25)) 保留 deletedAt（仅当合法 ISO 时；malformed 字符串自动丢弃）。[desktopBootstrap.js](src/state/desktopBootstrap.js#L261) 入口算 `visibleArtifacts = state.artifacts.filter(a => !a?.deletedAt)`，4 处下游消费者全用 visible（projectArtifacts / activeChatArtifacts / 顶层 artifacts / summarizeProject）。[server.js](src/server.js) 新增 `POST /api/artifacts/restore`。
- **Phase 2（前端切到 server-driven）**：[handleDeleteArtifact](desktop-ui/app.js#L4604) 重写 —— 立刻 POST `/api/artifacts/delete`，server 已 commit；展示 undo toast 5s；onUndo POST `/api/artifacts/restore`。删除 `pendingArtifactDeletes` Map / `setTimeout(commitDelete)` / `.is-pending-delete` 类（不再需要客户端状态机）。reload/close 不再丢 timer：server 端记录已 stable。多 artifact 连续删除：每个独立 server 端 tombstone，UI toast 仍单实例（被覆盖时旧 row 仍 deleted；要恢复需找回 server log，acceptable trade-off）。
- **Phase 4（GC）**：[server.js](src/server.js) startup 调一次 `purgeStaleSoftDeletes({ olderThanDays: 7 })`，>7d tombstone 真删；非阻塞 + 错误 swallow（不影响 boot）。
- 测试：[workspaceMutations.test.js](src/services/workspace/workspaceMutations.test.js) 既有 deleteArtifact 测试改成 soft-delete 契约（artifacts.length 不减、deletedAt set、bootstrap 隐藏）+ 新增 8 个测试覆盖 restore 成功 / unknown id / not soft-deleted / missing id + GC cutoff / idempotent / unparseable date / double-delete throws。**17/17 全绿**（原 9 + 8 新）。
- 验证：`npm run test:ui` 71/71；memory 套 330/330；workspace 套 17/17；check-syntax 全过。前端 handleDeleteArtifact 在新模型下变成 fire-and-forget pair (delete → restore on undo)，状态机已经被 server 端 17 个测试覆盖；DOM 部分是薄 toast，需要 jsdom 才能 unit test，留作下次 desktop-ui test harness 升级。
- 提交哈希：`af2e3b7`。

## 2026-04-27 18:00 — 5 处次级 UX 体验提升（PDF 入口 / state 路径 / lane overflow / search 空状态 / artifacts 软删）

- 用户审查发现"硬功能都通了，剩下的是体验不够清楚"，给了 5 条次级提升。两批 commit：
- **批 1 (`5f9107a`)** 4 条小改动：
  - **#5** 附件菜单加 PDF entry —— `accept="application/pdf,.pdf"`，title 解释 pdf-parse 抽取（[app.js:972](desktop-ui/app.js#L972)）。documentExtractor 实测仅支持 PDF（mimeType 含 'pdf' 或 `.pdf` 扩展名），accept 按实情写。
  - **#2** Advanced 页 Copy state.json path —— [advancedPage.js](desktop-ui/advancedPage.js) 加可选 `statePathHint` 参数（默认 `~/.melo/desktop/state.json`），page-kicker 下加 tip 行 + Copy path 按钮；新 action `copy-melo-state-path` 写剪贴板 + flash-toast 反馈；3 个新测试覆盖默认/自定义/hostile 转义。
  - **#3** Tasks 区域 overflow menu —— main 留主按钮，research/builder/reviewer 进 "⋯" 下拉（uiState.taskLaneOverflowOpen + outside-click 关闭，复用 composerAttachmentMenu pattern）。
  - **#4** Search 空状态分类提示 —— 新文案列出 chats & messages / prompt history / memory / artifacts / projects / skills/connectors / workspace files，pre-query 占位也同步更新；加 `.empty-state-title` / `.empty-state-meta` 样式。
  - 副作用：新加 `showFlashToast` helper（短 toast）给 #2 + 后续 #1 用；styles.css 新增 6 个类（flash-toast / page-kicker-tip / ghost-link / task-lane-overflow-* / empty-state-*），全部沿用 `--text-muted` / `--accent` / `--surface-2` token。
- **批 2 (本 commit)** Artifacts 软删 + undo toast：
  - 新增 [desktop-ui/undoToast.js](desktop-ui/undoToast.js) 纯 helper（`formatUndoCountdown` / `formatUndoToastLabel` / `nextCountdownTickMs`），16 单测覆盖整数秒边界 / 100ms floor / 非 finite 输入。
  - app.js: `pendingArtifactDeletes: Map` state；`handleDeleteArtifact` 重写为软删（5s timer + `setTimeout(commitDelete)`）；`showUndoToast` DOM helper 渲染底部带倒计时的 Undo banner，点 Undo 清 timer + 撤销，超时调真 `/api/artifacts/delete`；artifact card 加 `.is-pending-delete` 灰显类。
  - 验证：`npm run test:ui` **71/71 全绿**（55 之前 + 16 undoToast）；memory 套 330/330；check-syntax 全过；UI 实际 toast 弹出 + Undo 行为留用户手测。
- 提交哈希：`5f9107a`（批 1）+ `e1a8ecf`（批 2）。

## 2026-04-27 17:30 — desktop-ui test harness 落地：videoStatus + advancedPage 双双抽出可测

- 上一会话末标记的 follow-up：desktop-ui 缺 unit-test harness，已累积两条同源 Codex finding（本批 ⚪ `describeVideoExtractionStatus` + 14:30 Advanced page B `smoke/E2E 缺失`）。这一刀一并闭环。
- **Phase 1 (`a9aa5a8`)**：byte-for-byte port `describeVideoExtractionStatus` → [desktop-ui/videoStatus.js](desktop-ui/videoStatus.js)；app.js 改 `import` 删原位；新增 [videoStatus.test.js](desktop-ui/videoStatus.test.js) 14 个分支测试（no entry / 非 array / id 缺失 / video-audio-transcript ± keyframes / video-keyframes-only ± frames / unknown source / multi-entry pick-match / malformed metadata）；`package.json` 加 `npm run test:ui` → `node --test 'desktop-ui/**/*.test.js'`，把既有 `viz/{citationRenderer,vizRenderer}.test.js` 也纳入入口（之前没有 npm script 跑它们）。
- **Phase 2**（本 commit）：`renderAdvancedPage` 151 行从 [app.js:9672](desktop-ui/app.js#L9672) 抽到 [advancedPage.js](desktop-ui/advancedPage.js)，改成 `({ data, adv, escapeHtml, scheduleRefresh })` 显式参数（CLAUDE.md §5 "byte-for-byte port + import path 调整"，逻辑零变化；只是 lexical capture → explicit param）。app.js call site 把 `uiState.bootstrap` / `uiState.advanced` / `escapeHtml` / `() => Promise.resolve().then(refreshAdvancedStatus)` 显式传入。新增 [advancedPage.test.js](desktop-ui/advancedPage.test.js) 17 个 smoke：4 subsection 都在、empty-state 4 个、external-mcp 列表 + Ping、cli servers + Disconnect、plugins + 空 hooks、running task + Kill / 非 running 不出现、loading 文案翻转、error alert 转义、4 种 lazy-fetch 短路条件、hostile 输入 escapeHtml 全程。
- 验证：`npm run test:ui` **52/52 全绿**（21 既有 viz + 14 videoStatus + 17 advancedPage）；memory 套 330/330 不退化；check-syntax 全过；renderAdvancedPage 调用点单一（`renderCustomizePage` 内），call-site 改动 review 范围明确。
- 闭环：本批 Codex ⚪ + 14:30 Advanced B 两条 follow-up 同步关闭；后续 desktop-ui 改动有了"抽纯函数 + 加 *.test.js"的标准模式可复用。
- 提交哈希：`a9aa5a8`（Phase 1）+ `7a6710e`（Phase 2）。

## 2026-04-27 16:50 — TTS / 视频 / 配置入口 4 处体验断点

- 用户审查："硬功能基本都通了，剩下的是体验不够清楚。"4 条按推荐方案改：
- **#1 TTS Auto 显式化** ([app.js:1074](desktop-ui/app.js#L1074))：默认 `ttsEngine='auto'` 但 Voice 面板没有 Auto radio，选 auto 时面板看起来什么都没勾。新加 Auto radio 在最上，hint "Tries API voice first · falls back to macOS say · default"，匹配 [speakText:4265](desktop-ui/app.js#L4265) 的真实 fallback 顺序。
- **#2 Browser voice 桌面端改名** ([app.js:1090](desktop-ui/app.js#L1090))：检测到 `window.webkit.messageHandlers.meloVoice`（WKWebView）时 label 从 "Browser voice" 改成 "Desktop native voice"，hint 改成 "AVSpeechSynthesizer via system bridge · picker unused here"。真实浏览器仍叫 Browser voice。逻辑零改，仅命名诚实化。
- **#3 视频附件状态 chip** ([app.js:1205](desktop-ui/app.js#L1205))：抽 `describeVideoExtractionStatus(message, attachment)` helper，匹配 `extractedMedia[]` 里 `attachmentId === attachment.id` 的 entry，按 `metadata.source` 渲染："video-audio-transcript" → `transcript ✓ · keyframes ✓ (N)`、"video-keyframes-only" → `keyframes ✓ (N) · no audio transcript`、entry 缺失 → `extraction unavailable`。不动 [videoExtractor.js](src/media/extractors/videoExtractor.js) 后端契约，只读已有字段。
- **#4 Voice 面板底部加跳转** ([app.js:1196](desktop-ui/app.js#L1196))：复用既有 `select-customize-item` action（`section=connectors`, `id=openai-compatible`），加两个 `.tts-panel-link` —— "配置 MiniMax 自定义语音 →" / "配置 Whisper 转写 →"，都跳到同一个 connector 详情面板（MiniMax + Whisper 两套 key 在同一表单 [app.js:8888](desktop-ui/app.js#L8888)）。styles.css 加 `.tts-panel-footer` + `.tts-panel-link`，沿用 `--text-muted` / `--accent` 设计语言。
- 红绿灯：check-syntax 全过；memory 测试 330/330 不退化（未动 src/）；desktop-ui 无 unit test 框架，UI 实际渲染 + 跳转留用户手测验证。
- 提交哈希：`9f5a87a`。
- **未修 follow-up（下次统一）**：desktop-ui 缺 unit test harness，已累积 2 条同源建议 —— 本批 Codex ⚪「`describeVideoExtractionStatus` 多分支无自动覆盖」+ 14:30 Advanced page Codex B「smoke/E2E 缺失」。下次专门一刀：抽 `videoStatus.js` 等纯函数到独立模块、用 `node:test`（或 happy-dom）建 desktop-ui test harness，把两条 follow-up + 未来 UI 纯函数统一纳入。比逐个修更经济。

## 归档摘要（2026-04-27 16:25 之前的所有条目）

> 按 CLAUDE.md §3 自动压缩：每条仅保留标题 + 一句话结论 + commit hash。完整原始条目见 git history (`git log --follow -p PROGRESS.md`)。

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
