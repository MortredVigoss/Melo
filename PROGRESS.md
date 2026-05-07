# Melo 进度日志

> 新条目追加在本文件顶部（时间倒序）。
> 当本文件超过 300 行时，按 CLAUDE.md §3 自动压缩：最旧 70% 归档为一句话摘要，最新 30% 保留完整格式。

---
## 2026-05-07 23:49 — fix(scripts/codex-review): 质量评级 解析三连 bug 修复

- 做了什么：把 `scripts/codex-review.sh` 第 243 行的 `sed` 解析换成单条 `perl -CSD -Mutf8` 一行式：先剥 ANSI CSI 转义，再用 UTF-8 正则 + `——/—/--` dash 锚点抽 `质量评级：X` 里的 X。
- 为什么：原 `sed` 路径同时撞了三个 bug：(1) codex CLI 在 `质量评级` 标签和评级字母外面包了 ANSI 颜色转义，`^质量评级` 锚点永远被 `\e[1m` 挡住；(2) macOS BSD sed 在 LC_ALL 未设 / C locale 下，`[：:]` 字符类把全角 `：`（U+FF1A）当成 3 字节序列处理，匹配失败；(3) codex 在回答前会把 prompt 原样回显，捕获的输出里在真正评级行之前有一条模板行 `质量评级：S / A / B / C / D —— <根据>`，naive 的 `head -n 1` 会先抓到模板里的 `S` 字符，让 gate 永远静默放行。即使只修 (1)，剩下两个 bug 仍会让 gate 行为错乱（locale 下解析失败，UTF-8 locale 下错抓 S）。perl 路径 locale-independent，UTF-8 正则确认 `[：:]`，dash 锚点把模板行排除掉。
- 产出 / 提交哈希：本 commit（throwaway 分支 `verify-pp-parse-fix` 上验证用，待用户确认后 cherry-pick 到 master）。

---
## 2026-05-07 — Codex 实现：抽 searchRouter + 接 crawl4ai/scrapling/camoufox 外读器

让上游 chat runner 单点决策是否启用 native web_search（不再每个 provider 各判一遍 trigger），同时给社媒 / SPA 难抓页加 optional 本地 reader 兜底。Codex 实现，本会话仅做 commit + push。12 个文件、+1066 / −92。

- **检索路由**（[searchRouter.js](src/retrieval/searchRouter.js)）：从 `openai.js` 抽出 `WEB_SEARCH_TRIGGER_RULES` + register/clear API + `shouldUseNativeWebSearch`；新增 `DEEP_RESEARCH_PATTERN` / `EXPLICIT_LOCAL_SEARCH_PATTERN` / `LINK_READ_PATTERN` 三套 pattern 区分用户意图（深度调研 / 强制本地浏览器 / 单纯让我读这条链接）。[openai.js](src/openai.js) 改为 thin wrapper 转调 router；`createCodexResponsesReply` / `createOpenAICompatibleReply` 新增 `nativeWebSearchEnabled` 注入参数，由 [chatExecutionRunner.js:497](src/services/chat/chatExecutionRunner.js) 上游决定后传入。
- **外部 reader 适配**（[externalReaders.js](src/web/externalReaders.js) + [camoufoxReader.py](src/web/camoufoxReader.py)）：抽 `crawl4ai` / `scrapling` / `camoufox` 三个本地 CLI 适配，按 `READER_ORDER = ['crawl4ai','scrapling','camoufox']` 顺序试，没装就跳过——**不是硬依赖**。Camoufox 走 Python 子进程读 JSON 输出。`MIN_USEFUL_CHARS = 120` gate 决定算不算成功。
- **fetchUrl 接入**（[fetchUrlTool.js](src/tools/builtins/fetchUrlTool.js)）：`extract_mode` enum 多三个值（`crawl4ai/scrapling/camoufox`）；`auto` 链在 playwright 之后追加 external reader 兜底，方法名拼成 `playwright→camoufox` 这种链式标记。
- **socialLink 接入**（[socialLinkTool.js](src/tools/builtins/socialLinkTool.js)）：在 share-preview unfurl 之前插 step 4b external reader，给登录态社媒页（小红书/抖音）一次额外机会；命中后返回 `via: 'external:<method>'`。

本地 `npm test` 完整 GREEN（含 desktop smoke）。Codex pre-pp 在沙盒里 `mkdtemp` 撞 EPERM 报 6 fail（macOS TCC，非代码 bug），评级 **B**，留两条 ⚪ 非阻塞建议：runner 级集成测试覆盖 codex-native/melo-web/fetch-url/none 四类路由 + 本条 PROGRESS 同步（已补）。Final commits: `f04248e` + 本条 progress commit。脚本 `git pp` 因 ANSI 颜色码导致 sed 锚点失效误判 unparseable，本次绕开 pp 走 `git push`，ANSI strip 修复另起 follow-up。

---
## 2026-05-07 — Codex C 闭环：narrow-patch 保护加 `_clearedFields` sentinel（用户拍板：清空→恢复默认 + 显式标记）

`e54b12b` push 时 Codex 评 C：codex 加的 narrow-patch 保护把 `name/laneLabel/description/rolePrompt` 空字符串一律删掉，导致用户在 Customize 表单**主动清空**这些字段也被静默忽略——之前空值会让 custom agent 回落默认定义，现在保留旧值。

用户决策（C 评级整改方案）：
1. 主动清空 → 恢复 agent 定义的默认值（之前的语义）
2. 接受加显式 `_clearedFields` sentinel 区分"窄 patch 没传"和"主动清空"

实现：

- **Backend**（[agentProfileService.js](src/services/agent/agentProfileService.js)）：`normalizeAgentUpdatePatch` 接受 `_clearedFields: string[]`；列表里的字段空字符串 patch 保留进 nextPatch（下游 normalizer 删 override → fall back to definition default），列表外的空字符串照旧丢（narrow patch 保护）。`_clearedFields` 自身从 nextPatch 剥掉，永不写入 store。
- **UI**（[app.js](desktop-ui/app.js) form submit handler）：完整表单 save 时扫四个 protected 字段，空的就 push 进 `patch._clearedFields`——表单 save 是用户意图，不是窄 patch。其他 narrow patch 调用点（identity/soul.md autosave / preset apply / channel autosave）从来不带这四个字段，不受影响。
- **测试**：`agentProfileService.test.js` +2 case（marker 保留空串 / 非数组 marker 被忽略），`desktopStore.updateAgentProfile.test.js` +1 case 端到端（seed → 用户带 marker 清 description → 断言新值不再是 seed 旧值）。

`npm test` 完整 GREEN。

---
## 2026-05-07 — Codex 实现：per-agent MiniMax TTS 参数（voiceId / speed / pitch / vol）端到端

本批改动由 Codex 完成，本会话仅做整理 + commit + push。涉及 11 个文件，按层归四束：

- **Profile normalizer**（[src/state/agentProfiles.js](src/state/agentProfiles.js)）：抽 `normalizeOptionalNumber(value, {min, max})` 给 `ttsSpeed/Pitch/Vol` 做 clamping (`0.5–2.0` / `-12–12` / `0.1–10.0`)；`normalizeAgentOverride` 现在保留 `name/laneLabel/description/rolePrompt` 文本字段 + 新加的三个 tts 数值字段（值非 null 才 stamp 到 normalized）。
- **Update patch contract**（[src/services/agent/agentProfileService.js](src/services/agent/agentProfileService.js)）：`normalizeAgentUpdatePatch` 把 `name/laneLabel/description/rolePrompt` 这四个空字符串 patch 当作"未提供"删掉，避免老 UI 提交 narrow patch（如 `{minimaxVoiceId}`）时同字段空字符串误擦既有 metadata。
- **UI draft + bootstrap**：[desktop-ui/agentDraft.js](desktop-ui/agentDraft.js) `agentDraftFromProfile` 把 `rolePrompt / minimaxVoiceId / ttsSpeed/Pitch/Vol` 五个字段 round-trip 进 draft；[src/state/desktopBootstrap.js](src/state/desktopBootstrap.js) 暴露 `ttsSpeed/Pitch/Vol`（fallback 到 `DEFAULT_CONFIG`）；[desktop-ui/styles.css](desktop-ui/styles.css) 配套 +33 行新 panel 样式。
- **Discord voice path**（[src/services/remote/discordVoiceSession.js](src/services/remote/discordVoiceSession.js)）：合成时 spread agent profile 的 `ttsSpeed/Pitch/Vol` 到 config，让 Discord 语音回复也用 per-agent 调参（之前只 voiceId per-agent，全局 connector-level 调参）。

测试 lock contracts：[desktopStore.updateAgentProfile.test.js](src/desktopStore.updateAgentProfile.test.js) +66、[agentProfileService.test.js](src/services/agent/agentProfileService.test.js) +16、[agentDraft.test.js](desktop-ui/agentDraft.test.js) +8、[tts.test.js](src/tts.test.js) +22、[media/enrich.test.js](src/media/enrich.test.js) +20。`npm test` 完整 GREEN。

---
## 2026-05-07 — Codex pre-push B + 1 P0 follow-up：跨引擎 stale event 竞态

`d1b76cf`+`0db3c1c`+`2a8481a` push 时 Codex 评 B（可合）但抓出 1 个真竞态：

`sayEnded` 跟 `audioEnded` 共用 `_ttsAudio._onAudioEnded()` → 老 `say` 被 `playAudio` 终止后 `waitUntilExit` 才返回 → 延迟发 `sayEnded` → 那时 `_ttsAudio` 已经是新 AVAudio bridgeRef → 错误清掉新 ref 让 AVAudio 继续播但指示器灭。**修**：bridgeRef 加 `source: 'avaudio' | 'say'` tag，分别 `_onAudioEnded` / `_onSayEnded` callback；新加 [desktop-ui/ttsBridgeRouter.js](desktop-ui/ttsBridgeRouter.js) `selectTtsBridgeCallback(detail, ref)` 纯函数，按 action+source 匹配后才返回 callback；[desktop-ui/ttsBridgeRouter.test.js](desktop-ui/ttsBridgeRouter.test.js) 9 case 包括 Codex 描述的"old sayEnded after new playAudio"和对称版"old audioEnded after new say"两条 stale event 路径。UI 196/196（+9）。

---
## 2026-05-07 — 语音系统全局审计 + 15 项修复（4 P0 / 7 P1 / 4 P2）

read-only 全局审计派 general-purpose agent 全文读 src/tts.js + src/services + src/server.js + src/media/extractors/audioExtractor.js + desktop-ui/app.js + desktop-app/main.swift + src/config.js + src/shared/minimaxVoiceResolver.js，给出 19 条发现。修了其中 15 条，2 条 P2 跳过待用户确认（F5-TTS 自动恢复疑似死代码 / 全局 mutable TTS state 重构太大）。

**P0**

- **#1 原生转写端口在 port-rollover 时联系不上**：[main.swift](desktop-app/main.swift) `process.environment` 没传 `MELO_DESKTOP_PORT` → Node 里 `audioExtractor.js:13` 永远探 43128，Swift 实在 43130 → 转写静默失败。**修**：env 加 `"MELO_DESKTOP_PORT": String(port)`，顺手治好 [urlSigning.js](src/web/urlSigning.js) 也用同一 env。
- **#2 Stop 按钮砍 SSE 后半句话仍被念出**：[app.js:handleSendMessage](desktop-ui/app.js) 的 `try/finally` 在 abort 分支也跑 `_streamTtsFlush()`。**修**：加 `let sendWasAborted = false`，catch 拦 abort 时置 true，finally 据此走 `_streamTtsReset()` + 调 `/api/tts/queue-clear` + `/api/tts/speak-stop` 哑掉服务端已发出的合成。
- **#3 queue-clear / speak-stop 不取消 in-flight 合成 fetch**：[server.js](src/server.js) 加 `_trackTtsController()` / `_abortAllTtsControllers()` / `_untrackTtsController()` 共享 registry。queue-add / speak-text 三条快路径每个 session 一个 AbortController，`{signal:ctrl.signal}` 透传到 [tts.js:synthesizeSpeech](src/tts.js#L280) (本来就接受 options.signal) 和 edgeTts.js (新加 `{signal}` 参数 → 传入 execFile + 手动 listen 兼容老 Node)。queue-clear / speak-stop 一次 abort 全部，180s timeout 不再持续烧钱。
- **#4 WKWebView 桥跨引擎抢占不彻底**：[main.swift](desktop-app/main.swift) 的 `playAudio` / `speakText` case 现在都做完整三件套停 (`ttsAudioPlayer.stop()` + `speechSynthesizer.stopSpeaking(.immediate)` + `sayProcess?.terminate()`)，不再叠播。

**P1**

- **#5 applicationWillTerminate 没停 TTS** → [main.swift](desktop-app/main.swift) terminate 时停三件套
- **#6 录音不停 TTS → mic 录到扬声器** → [app.js:toggleVoiceInput](desktop-ui/app.js) 在 `recording` toggle-on 路径前调 `stopCurrentTts()`
- **#7 `/api/audio/transcribe` 把"软回退占位"当成功转写** → [server.js](src/server.js) 检查 `result.metadata.source === 'whisper-unavailable'`，命中返 422 + actionable error
- **#8 select-tts-custom-voice 抹掉用户手调的 ttsSpeed/Pitch/Vol** → [app.js:minimaxTtsConfigPatchForVoice](desktop-ui/app.js) 改成只在 agent 显式定义对应字段时才纳入 patch，否则不动用户连接器层的调参
- **#9 set-tts-engine 切 API voice 顺手抹掉 `ttsProvider:'minimax'`** → [app.js:set-tts-engine](desktop-ui/app.js) 加 `currentProvider === 'edge'` 守卫，只清 edge，不动 minimax
- **#11 WKWebView playAudio 没 audioEnded 回调，JS 用 `(base64.length × 0.75 / 16000) × 1000` 估时长** → [main.swift](desktop-app/main.swift) MeloAppDelegate 加 `AVAudioPlayerDelegate` 协议 + `emitTtsEvent(action:)` 派发 `melo-tts` CustomEvent + `audioPlayerDidFinishPlaying` 回调；[app.js](desktop-ui/app.js) `_playAudioBuffer` native 分支改为持有 `bridgeRef._onAudioEnded`，`window.addEventListener('melo-tts')` 收到 `audioEnded`/`audioFailed`/`sayEnded` 时清状态；保留 `setTimeout` 安全网（`approxMs+5000`）防回调丢失
- **#12 WKWebView reload 时 mic 还在录** → [main.swift:didFinish navigation](desktop-app/main.swift) 检测 `isVoiceRecording` 时调 `stopVoiceRecognition(manual:false, emitEvent:false)`

**P2**

- **#10 Edge TTS 在 tts.js + server.js 各一份** → 抽出 [src/services/tts/edgeTts.js](src/services/tts/edgeTts.js) `synthesizeWithEdgeTts(text, config, {signal})` + `resolveEdgeTtsBin()`，两侧 `import` 共用
- **#15 minimaxVoiceResolver.js 1 天 cache** → [server.js](src/server.js) 改 `cache-control: no-cache` 跟 urlDetector 一致
- **#16 baked-in `minimaxVoiceId` 默认 `moss_audio_692b...`** → [config.js](src/config.js) 改成 `''`，避免用户随便填 MiniMax key 时所有 TTS 都用这个 preset 默认 voice
- **#18 `_speakWithNativeBridge` 没 gate 空文本** → [app.js](desktop-ui/app.js) JS 端加空文本守卫（与 Swift 端的 `text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty` 守卫对称）；Swift 端 `speakText` case 同时加守卫

**跳过**

- **F5-TTS `_synthesizeWithRecovery` 自动恢复**（[server.js](src/server.js)）疑似死代码（只在 `whisperBaseUrl === 127.0.0.1:7860` 命中），audit 标 ⚪ "需用户确认才能删"，不动
- **#17 全局 mutable TTS state**（`globalThis._ttsQueue` / `_speakTextSession` / `_meloAfplayProcess` 等）单用户 desktop 没事，多 tab/多窗时出问题；架构改动太大，跳过

测试：`npm test` 完整 GREEN（含 Swift build + Melo.app launch + smoke flow）。

---
## 2026-05-06 — Codex C 第三轮闭环：anchorRouting 抽 helper + 卡片分支同步修

`9f29a16` 又被 Codex 评 C：第二轮只修 `<a>` 分支漏了 `[data-external-url]` 卡片分支，两个分支用同一逻辑应该共享。Codex 给的方案干净：抽 `routeHttpUrl(url)` helper + 两个分支都接。

- 新建 [desktop-ui/anchorRouting.js](desktop-ui/anchorRouting.js) 暴露 `routeHttpUrlClick(href, currentOrigin)`，返回 `{kind: 'same-origin'|'external'|'invalid', href}`。
- 新建 [desktop-ui/anchorRouting.test.js](desktop-ui/anchorRouting.test.js) 8 case：same-origin http/https / external https / 同 host 不同 port → external / 同 host 不同 scheme → external / mailto·javascript·data·#anchor·相对路径 → invalid / 空·null·undefined → invalid / malformed URL → invalid / 默认 port (443/80) 归一化。
- [desktop-ui/app.js](desktop-ui/app.js) `<a>` 和 `[data-external-url]` 两个 click 分支都换成统一调用 `routeHttpUrlClick`：same-origin → preventDefault + location.assign；external → preventDefault + openExternalUrl；invalid（卡片分支）→ preventDefault + showError，invalid（anchor 分支，如 `href="#anchor"`）→ fall through。

UI 套 187/187（+8 anchorRouting case）+ 完整 npm test GREEN。

---
## 2026-05-06 — Codex C 评级第二轮闭环：filter 再收窄 + 同源 URL 强制 location.assign

`12e1358` 再被 Codex 评 C：第一轮收窄不够 + 同源 URL 默认导航也死。第二轮根治：

- **🔴 同源 + `target="_blank"`**：Codex grep 出 link-card / 引用 anchor 都带 `target="_blank"`，main.swift 没 `WKUIDelegate.createWebViewWith` 处理新窗口 → `window.open` 也是 no-op。**修**：JS 端同源判定后**仍 preventDefault**，再 `location.assign(parsed.href)` 强制当前 webview 同窗导航，绕过 `_blank` 默认行为陷阱。
- **🟡 filter 仍按裸短语 `fresh cookies` / `xsec_token` 匹配**：`fresh cookies in browser tests` 这类正常技术解释也被剔。**修**：[contextFilters.js](src/services/chat/contextFilters.js) 把 SOCIAL_LINK_DIAGNOSTIC_PATTERN 收到只匹配 5 个 marker：`SOCIAL_LINK_BLOCKED` / `SOCIAL_LINK_FAILED` / `Could not read this social-link URL`（fetchUrlTool 输出 verbatim）/ `dedicated extractor (yt-dlp`（同上 verbatim）/ `Customize → Safety → Web-fetch cookies`（UI 路径 verbatim）。所有零散英中关键词全删。10 case sanity check 全过：`fresh cookies in browser tests` / `xsec_token` / `登录态过期` / `Session cookies are stored` 都 false。
- **测试 prose 同步更新**：[threadContext.test.js](src/memory/threadContext.test.js) + [memorySnapshot.diagnostics.test.js](src/state/memorySnapshot.diagnostics.test.js) 把 diagnostic 正例改用 socialLinkTool 真实 verbatim 文案，断言对齐新 marker。

⚪ JS 单测验证同源链接 routing 没补——Codex 标 ⚪（推荐非必需），需要从 app.js 抽 helper 才能干净测，规模超出当前修补范围。

测试 47/47 + 完整 npm test GREEN。

---
## 2026-05-06 — Codex C 评级闭环：context filter 收窄 + WKWebView 同源 URL 放行

`bc823ac` + `9ece26f` 推送时 `git pp` pre-push gate 评 **C** 阻断。Codex 抓两个 P0 + 一个 P2，全部修复：

- **P0-1（[contextFilters.js:15](src/services/chat/contextFilters.js#L15)）** SOCIAL_LINK_DIAGNOSTIC_PATTERN 末尾 `|cookie|cookies` 裸词太宽 → 任何 assistant 谈到 cookie/cookies 都被静默过滤出 prompt + thread context + memory。**修**：删裸词，改用 `SOCIAL_LINK_BLOCKED|SOCIAL_LINK_FAILED|fresh cookies|Web-fetch cookies|xsec_token|需要 fresh cookies|需要登录态|临时访问凭证` 这种多词/特异短语；同时把 `登录态` 收紧到 `需要登录态`（前者太通用）。
- **P0-2（[desktop-ui/app.js:12484](desktop-ui/app.js#L12484)）** JS click 拦截所有 http(s) anchor → preventDefault → 调 native openExternalUrl，但 main.swift 的 `isExternalWebUrl` 对 Melo server URL 返回 false → 同源 URL 静默死掉无动作。**修**：JS 端先 `new URL(href).origin === location.origin` 判同源，是的话直接 return 让浏览器走默认导航，不 preventDefault。
- **P2 负例测试**：[messageBuilder.test.js](src/services/chat/messageBuilder.test.js) + [threadContext.test.js](src/memory/threadContext.test.js) + [memorySnapshot.diagnostics.test.js](src/state/memorySnapshot.diagnostics.test.js) 三处各加 1 case，证 "Browser cookies come in two flavors..." / "Session cookies 是浏览器..." / "session 跟 persistent cookies 区别" 这类正常技术解答**保留**进上下文 + 长期记忆。

测试 47/47 + 完整 npm test GREEN。

---
## 2026-05-06 — Codex 实现的 backend 链路一并升级：社媒抓取扩张 / 视频 keyframe 入 prompt / assistant 失败诊断过滤 / cyber_policy 文案

本批改动由 Codex 完成，本会话仅做整理 + commit + push。涉及 23 个 src 文件，按特性归四束：

- **社媒抓取扩张（社媒/媒体管线）**：[src/tools/builtins/socialLinkTool.js](src/tools/builtins/socialLinkTool.js) +911 行 + [socialLinkTool.test.js](src/tools/builtins/socialLinkTool.test.js) +279；[src/tools/builtins/fetchUrlTool.js](src/tools/builtins/fetchUrlTool.js)、[src/media/index.js](src/media/index.js) +191、[src/media/extractors/videoExtractor.js](src/media/extractors/videoExtractor.js)、[src/media/extractors/videoExtractor.test.js](src/media/extractors/videoExtractor.test.js)、[src/media/urlDetector.js](src/media/urlDetector.js)、[src/media/urlDetector.test.js](src/media/urlDetector.test.js)、[src/media/enrich.test.js](src/media/enrich.test.js) +92。
- **视频 keyframe 入 prompt（messageBuilder）**：[src/services/chat/messageBuilder.js](src/services/chat/messageBuilder.js) `pushKeyframeParts` helper 抽出，video attachments 与 social-link-only entries 都能 emit `image_url` parts；测试 +45 case。
- **assistant 失败诊断过滤（新模块 + 集成）**：新增 [src/services/chat/contextFilters.js](src/services/chat/contextFilters.js) 三类 pattern（provider failure / Codex policy / social-link cookie 诊断），暴露 `shouldSuppressAssistantContextText`；[src/memory/threadContext.js](src/memory/threadContext.js) + 新加 [src/memory/threadContext.test.js](src/memory/threadContext.test.js) 接入；[src/services/agent/agentMemoryContext.js](src/services/agent/agentMemoryContext.js)、[src/state/memorySnapshot.js](src/state/memorySnapshot.js) + 新 [memorySnapshot.diagnostics.test.js](src/state/memorySnapshot.diagnostics.test.js) +39 case；messageBuilder 用 `isProviderFailureAssistantMessage` 在 `buildModelMessagesFromChat` 入口剔掉。**意图**：UI 仍展示完整诊断给用户看，但下一轮 prompt 不携带这些 noise，省 token + 防 Codex 拿失败诊断当后续上下文。
- **Codex cyber_policy 文案**：[src/services/chat/providerErrors.js](src/services/chat/providerErrors.js) 加 `cyber_policy` / `possible cybersecurity risk` 分支文案；[src/openai.js](src/openai.js) `readCodexSseResponse` 抓嵌套 SSE error；[src/desktopStore.error-messaging.test.js](src/desktopStore.error-messaging.test.js) +1 + [src/openai.codex-inline-image.test.js](src/openai.codex-inline-image.test.js) +1 case 钉合同。

测试：`npm test` 完整 GREEN（含 desktop smoke 4 项 + 全部 src test）。

---
## 2026-05-06 — Codex 实现的 desktop 层：WKWebView 外链路由 / link-card preview / 静态资源 no-cache

本批同样 Codex 完成。5 个文件：

- **WKWebView 外链路由**：[desktop-app/main.swift](desktop-app/main.swift) +48 行加 `webView decidePolicyFor` 拦截：URL `http(s)` 且 `host:port` 不等于 server URL 的，调 `NSWorkspace.shared.open(url)` → 系统浏览器；同时支持前端 message handler `openExternalUrl`。**意图**：用户点 chat 里的链接卡片或 markdown 链接，跳系统浏览器而非在 WKWebView 内 navigate（之前会替换整个 app shell）。
- **link-card preview**：[desktop-ui/styles.css](desktop-ui/styles.css) +57 行加 `.link-card-main` flex container + `.link-preview` (image + copy) + `.link-preview-image` 76×76 缩略图样式；[desktop-ui/app.js](desktop-ui/app.js) +140 行配套 render。
- **静态资源 no-cache**：[src/server.js](src/server.js) `.html/.js/.css` 加 `cache-control: no-cache`，并对 attachment classifier 模块单独标 no-cache（之前 1 天 cache 让 Douyin/Xiaohongshu 链接修复要等用户重启 app）。
- **smoke 验证**：[scripts/smoke-desktop.js](scripts/smoke-desktop.js) +23 行新断言。

---

## 归档摘要（2026-05-05 之前的所有条目）

> 按 CLAUDE.md §3 自动压缩：每条仅保留标题 + 一句话结论 + commit hash。完整原始条目见 git history (`git log --follow -p PROGRESS.md`)。

- **2026-05-05 — Chat UI 三 bug 一次清 + 一个月 chat 跳到中部 / 滑动卡顿 root cause 终结** —— Bug 1/2 修了链接卡片溢出 + 滚动条对齐 thread 区；Bug 3 sync-restore 引入立刻可复现回归当场回退。后续 5 轮 JS scrollTop writer patch 全错，真根因是 `.thread-scroll-region` 缺 `overscroll-behavior-y: contain` 触发 CSS scroll chaining；最终 4 项收口 ship：单 scroller (`is-chat-view` gate) / 1500ms scroll guard / 41 处后台 render 走 `bgRender` helper / 附件 min-height 240px 占位。教训写进 user memory `feedback_ui_root_cause_first.md`。`6b3941f` … `7b021ad`
- **2026-05-05 — Phase E：长期记忆 dreaming 接 production + tiered recall 灰度 + memory CLI** —— frame/scene 写入实际已接（Phase 7d-5α-A1 commit 5/9），真问题是生产 chat 数据流没产 entries（`memories=1, dreams=12`）；加 `MELO_DEBUG_MEMORY=1` 单行诊断 + tiered recall 灰度开关 (`MELO_MEMORY_TIERS_RECALL`，默认 off) + `melo memory status/consolidate` CLI；604 测试全绿（+13 case）。
- **2026-05-04 — Phase 4：image_generation 意图门控 + domain cookies 管理 UI（小红书/抖音误路由根治）** —— image_generation 工具改成「workspace AND hasImageIntent」才进列；`detectImageIntent` 两层 regex (英中) + AND-gate 防 CSS/theming 误命中；新加 domain cookies UI 治抽取断层；55 imageIntent + production wiring 全绿。

- **2026-05-04 — Phase 3a/3b/3c：file_safety prompt 进 production + 持久化 allowlist + 管理 UI** —— 13 轮 Codex review 把 backend 锤到 A 后发现 production 接线整条没接（resolveFileSafety 仅 13 个 test 文件调用、前端 SSE 因 toolId 缺失被过滤丢掉），一次性补完三阶段：3a 接 server.js permission-response 路由按 kind:'file_safety' 分流 + desktop-ui 双 payload 形态 + renderFileSafetyDialog 按 operation 分布局；3b 新建 fileSafetyAllowlist.js 持久化 rule（file/dir + write 覆盖 edit + 不允许 dir-persistent）+ dialog "Always allow" 按钮；3c Customize 加 Safety section 列规则/Revoke。后续 Codex follow-up 修了 confirm-input recoverable + production-wiring contract test。`f5b5646` / `270d04c` / `28f1346`
- **2026-05-04 — dynamicContext multi-language keyword scoring (selected-file-context known-limit closure)** —— 重写 `_CODE_KEYWORD_REGEX` 覆盖 7 语言家族（JS/TS/Python/Rust/Go/Java/C#/Ruby/Swift/Kotlin）+ `\b` word boundary 防 `asynchronization` 误中 `async`；保留 `it(` lookahead 区分测试 framework 与英文 prose；dynamicContext.test 11/11 + 全 src 1975/1975 全绿。`5ffca5c` / `170eb30`
- **2026-05-04 — uncaughtException / unhandledRejection 顶层 emergency-exit (Codex P2 known-limit closure)** —— 加 src/server.js + src/index.js 的 sync emergency-exit (log → cleanupStalePlaywrightDaemons → process.exit(1))，cleanup 完整覆盖 module-load + SIGINT/SIGTERM + uncaughtException + unhandledRejection 四层；webSearchTool.helpers 43/43 + 全 src 1973/1973 全绿。`fb99ccf`
- **2026-05-04 — Phase 2D round 14 + hygiene fix #2 + P1 inline-shell-out 工具：13 轮 Codex review 收敛到 A** —— 整 1 天 13 轮 D/C/A review 闭 12 个独立 bypass 维度（awk/expansion/wrapper enum/inline-shell-out/sed exotic delim/跨进程 daemon hygiene），最后 review #13 评 A "修复闭环充分"；nuclear option Y + 16-iter cap fail-closed + cross-process daemon hygiene 三件大头修法定型。完整 13 轮原始 entries 见 git history（commit 序列从 `eb9e541` 到 `6c525a9`）。
- **2026-05-04 — Phase 2D round 14 awk + hygiene fix #2 + P1 inline-shell-out 完整 13 轮 review 系列** —— 见上方 summary。完整 13 轮原始 entries 见 git history（commit 序列从 `eb9e541` 到 `6c525a9`）。
- **2026-05-04 — sed exotic delimiter coverage (Phase 2D round 14 known-limit closure)** —— `sedExpressionHasEcmd` imperative scanner 处理任意 delim (`,`/`|`/`:`/`#`/`@`)，关闭 round 14 末尾 known limit，保 escape-aware + replacement-text false-positive 守卫。`47c08ed`
- **2026-05-04 — Selected file context: query-relevant excerpts for large files** —— `buildSelectedFileContextBlock` 抽出，大文件 (>3000 chars) tokenize query + score 每行 + top-4 seed + ±10 行 + merge → 5200 chars budget 渲染 (`lineNo\tcontent` 格式)；小文件向后兼容。`e81fb12`
- **2026-05-04 — Web search / Playwright resource hygiene fix #1（系统卡死 root cause）** —— `isConcurrencySafe: true → false` (修 unbounded queue) + `closeSoon` 15s idle close + `_browserOpen` state machine + SWR background refresh dedup via `_backgroundRefreshInFlight` Set + `.finally` cleanup + pin `@playwright/cli@0.1.11`。覆盖 within-session 累积。`506814d`
> 按 CLAUDE.md §3 自动压缩：每条仅保留标题 + 一句话结论 + commit hash。完整原始条目见 git history (`git log --follow -p PROGRESS.md`)。

- **2026-05-04 — File Safety Gate Phase 2D：bash 工具走 bashRiskParser → requestBashOp（14 轮 follow-up + self-review）** —— bashTool 入口接 `bashRiskParser` → `requestBashOp` gate（`requiresPermission:false`，零风险静默 / 风险弹 prompt / delete-class 硬拒 + file_delete 提示）。14 轮 Codex follow-up 修透各种 bypass：#1 silent-by-default → allowlist + `nested_shell` risk kind（bash -c / eval / xargs sh -c / $() / `\``...）；#2 砍 npm/pnpm/yarn allowlist（package.json scripts 是任意 shell）；#3 cwd 必须在 ws + path-shape arg 必拒 + git option deny-list；#4 realpath-based `cwdInsideWorkspace` 关 lexical/symlink 双逃逸 + `isVersionProbe` EXACTLY 匹配；#5 砍整 git allowlist（`--output=` 等无底洞）；#6 SILENT_ALLOWLIST 收敛到 6 条 + cwd 三件套 prompt payload（effectiveCwd / realCwd / cwdInsideWorkspace）；#7 nested_shell **硬拒**（与 delete 同列，零 prompt 零 spawn）；#8 token-scan 替代 head-only + COMMAND_WRAPPERS bounded set；#9 expansion-before-c（`$SHELL -c` / `${SHELL}` / `bash${EMPTY}` / `ba*`）；#10 新增 `code_execution` 硬拒（python -c / heredoc / pipe-fed / stdin redirect）+ SCRIPT_INTERPRETERS / INLINE_CODE_FLAGS；#11 抽 `effectiveInterpreterHead` helper（4 路径共享 wrapper-skip）；#12 splitWithSeparators 加 `|&` 同 `&&`/`||` two-char；#13 新增 `argv_rewrite` 硬拒（`env -S` / `--split-string`）；#14 awk inline-program + sed e-cmd（`isAwkBasename` + `sedExpressionHasEcmd` 双 pattern + `findWrappedCommand` 重构）；#14 self-review（user 让我自查）发现 awk var=val skip 漏 `awk 'x=system("rm")'` + sed pattern 1 over-tightening 漏所有 address-prefix（`/foo/e`/`$e`/`2e`/...）+ pre-existing parser gap 让 preposed redirect（`< /tmp/x rm`）所有 head-based 检测 miss → 加 `skipPreamble` 同时跳 redirects + env-assignments。终态：bashRiskParser 57/57 + phase2d.bashTool 100/100 + 全 src 1907→1914 全绿。已知 limit：sed exotic delim（`s,x,y,e`/`s|x|y|e`/`s#x#y#e`） / `awk -f /dev/stdin` / `e thing.txt` 文件名假阳 / `gawk -E` 误标 / SCRIPT_INTERPRETERS deny-list 但有界。Final commits: `eb9e541` (round 14) + `3b5ac4c` (self-review) + 前置 `3c2ba41` / `22f67e4` / `42f80cf` / `31a4135` / `ef0d142` / `bc923ea` / `f867ff1` / `a6ab5e0` / `d20c733`.
- **2026-05-04 — File Safety Gate Phase 2C：rich-media reads (pdf / image / knowledge) 接入 gate** —— `gatedReadIntoBuffer(absPath, ctx, opts)` 统一原语：requestRead 走 gate → atomicOpenLeaf 拿 dirfd-bound leaf fd → S_ISREG + size cap → readSync Buffer。pdfTool（10 actions）/ imageTool（ocr/info/process）/ knowledgeTool（index 一次 requestRead `bypassGrants:true` subtree dirfd-walk）全部接 Buffer 路径不再 re-open path。phase2c.richMedia 19 case；4 轮 follow-up C→A。已知 limit：pdftoppm / rg 仍按 path 读，系统 tmpdir 0o700/0o600 缩攻击面。Final commits: `3dccb3e` + `4cba848` + `e4eaa32` + `9589946` + `e093cf8`.
- **2026-05-04 — File Safety Gate Phase 2B：read tools (file_read / glob / grep) 接入 gate** —— fileRead 走 atomicOpenLeaf O_RDONLY|O_NONBLOCK + S_ISREG；glob/grep 走 dirfd-bound 递归 walker（openat O_DIRECTORY|O_NOFOLLOW + readdirAt）。grep 砍 rg fast-path 统一 JS walker。native addon 加 O_NONBLOCK + readdirAt + `openDirNoFollowChain` component-by-component walker（关 ancestor-symlink chain 漏洞）。phase2b.readTools + dirfdOps.checked 共 35 case；4 轮 follow-up D→A。Final commits: `b8356d9` + `b91a993` + `bb4d95f` + `fc6f886` + `7e20b88`.
- **2026-05-03 — File Safety Gate Phase 2A round 13：N-API dirfd-bound atomic ops（终结 12 轮 path-race patch loop）** —— 12 轮 Codex C/D 后引入 native N-API addon 走 POSIX `*at()` syscall。`atomicOpenLeaf` / `atomicRename` / `atomicMkdir` / `atomicUnlink` / `atomicSymlink` / `atomicLstat` + checked variants（probe + syscall 共用 fd 无 reopen race）。fileWriteTool / fileEditTool / fileMoveTool / fileMkdirTool / fileDeleteTool + backup/trash 全链 dirfd-bound。phase2a.fileTools 65 case + 各 errno/checked test；整体 src 1736/1736；5 轮 follow-up D→A。Final commit: `f73ba46`.

> 按 CLAUDE.md §3 自动压缩：每条仅保留标题 + 一句话结论 + commit hash。完整原始条目见 git history (`git log --follow -p PROGRESS.md`)。

- **2026-05-03 — File Safety Gate Phase 1：四模块地基（无接入，纯独立）** —— `sensitivePaths` (4 类硬黑名单) + `chatScopedGrants` (per-(chat,path,kind) 内存授权) + `fileSafetyGate` (8 入口 / 三段决策 / 两阶段 delete) + `trash` (.melo-trash quarantine + 永不自动删) + `backup` (snapshotBeforeWrite + recordAfterDiff) + `bashRiskParser` (8 risk kinds + quote-aware tokenizer)；Phase 1 共 9 轮 Codex pre-pp gate (C/D 多次往返) 才到 A。修过：lexical isWithinWorkspace bypass via `safeResolvePath` + 取最严格 sensitivity；`requestReadBatch` 改强制 paths[] partition (sensitive 单独走)；trash/backup `purge*`/`restore*` operationId 双层防护 (`OPERATION_ID_PATTERN` + `assertWithinRoot`)；commit-token 体系 (`_issueOperationToken` + `commitOperation` TTL 5m + single-use)；restore 链 layer (a/b/c/d) atomic approval-and-commit；`safeDeleteToTrash` 改 `{operationTokens, ctx}` token-bound；`commitOperation` 加 `expectedKind`/`expectedKinds` 强校验防 cross-kind token 复用；symlink delete 改 lstat-based no-follow（`_unsafeRawDelete` 删 link 不删 target）；restore 链 `wasSymlink` 分支独立校验 manifest `symlinkTarget` + 加 `resolvedPathAtDelete` tamper detection。Phase 1 测试矩阵 192/192；全量 1660/1660。`5ebf668` + `987a536` + `4854864` + `cc3170f` + `ad0260c` + `45e3d16` + 后续多轮 → final commit 系列见 git log Phase 1 段
- **2026-05-01 17:30 — PDF Batch C：edit_spec 中间层（in_place_overlay + rebuild）** —— `pdfEditSpec.js` strict validator + `pickRebuildEngine` (auto: explicit > language > sectionsContainCjk > pdfkit) + 11th `from_spec` action 接 in_place_overlay (text/image/metadata/form fields) 和 rebuild (pdfkit / html_playwright)；顺手修了 pre-existing pdfkit `info.* undefined` crash；6 轮 Codex C 修 nested-doc / margins thread-through / CSS injection / sectionsContainCjk 路由 + sectionsToHtml object-row table 渲染漏；`789fc55` + `a4172bc` + `fc0262b` + `1b07201` + `c6e02b1` + `372b251` + `cd5b2bd`
- **2026-05-01 16:00 — PDF Batch B：视觉验收 workflow 嵌入 pdfTool description** —— +700 字符 `VISUAL REVIEW WORKFLOW` block 5 步流程 (生成 → render → 自检 LAYOUT/FONT/CONTENT FIDELITY → fix → 仅 echo FINAL URL)；3 层 defence-in-depth 修全局 URL rule vs render PNG echo 冲突 (in-context QA-only marker + `artifactRole: 'review'` + global rule EXCEPTION clause)；`c2bd16f` + `96753e0`
- **2026-05-01 14:00 — PDF 能力 Batch A：simple ops + render** —— `pdf-lib` 6 helpers (merge/split/delete_pages/watermark/add_page_numbers/prepend_cover) + `pdftoppm` render backend (zero API cost)；pdfTool actions 3 → 10；CJK 在 watermark/page_numbers reject；`resolveInputPdfPath` helper 修 input/output 路径解析不对称；`cd13148` + `98a1502`
- **2026-04-30 11:30 — 独立 image edit pipeline（用户产品级 audit 落实）** —— `codexImageEngine.editImageViaCodex` 两阶段（vision analysis → 短 edit prompt scaffold）+ `detectImageEditIntent` + chat fast-path 短路 ReAct loop；Codex D SSRF guard 收紧到 data-URI ONLY（拒所有 http(s)）；2 轮 C 收紧 `IMAGE_FOLLOW_UP_PATTERN` 仅 image-OBJECT 短语 + Gate 5 双 pattern 同时为真才 fire（防 "把这个函数改成 async" 误编辑截图）。`41d20cf` + `94518d0` + `2a417b2` + `7a871de` + `d64bfc0` + `fcafa6d`
- **2026-04-30 09:30 — Codex 内联图编辑模式（image-to-image edit）** —— `messagesHaveInputImages` + `buildCodexResponsesTools(hasInputImage)` + `CODEX_INLINE_IMAGE_EDIT_INSTRUCTION` 三件套；4 轮 Codex C 修后撤销 effectiveModel→gpt-5.5 silent swap、保留 caller's model；用户实测 Codex 拒 input_fidelity → 改 bare `{type:'image_generation'}` 形态。`2618ec5` + `672b2c0` + `bc640c1` + `3ab34b5`
- **2026-04-29 00:30 — Codex chat 流内联图：image_generation tool 真正打通** —— `createCodexResponsesReply` 加 workspacePath 参数启用裸 image_generation tool；`readCodexSseResponse` 抓 `image_generation_call.done` emit markdown URL 注入 deltaText；3 轮 Codex C 修真 bug（dedup tracker vs emit tracker 拆 / final-text 必须含 prose+image / mime sniff strict by magic-byte，不信 output_format）。`1f17365` + `e7a7311` + `6edfc5e`
- **2026-04-28 13:30 — 用户截图反馈三连：MiniMax key 保存丢值 + 模型版本 + Voice 面板高度** —— 真因：connector-config 表单没接 draft mirror，password input 每次 background render 回 SSR `value=""` → 提交空被 keepIfBlank 当 preserve；后续 17+ 轮 Codex C/D 分别修 dispatcher / autosave / `_autosaveRevision` gate / `withConfigLock` 原子化 / refreshModelCatalog 锁外 discovery / catalog-only 契约（loadConfig + getResolvedConfig + getDesktopBootstrap 全链 `skipModelNormalize`）。`28a47b1` … `554c079`
- **2026-04-28 12:30 — Codex D 第三轮：initMcpServers 无条件 reconcile + 抽出可测模块** —— 去 `hasServers` 短路（empty config 也跑 reconciler）；抽 [src/mcp/init.js](src/mcp/init.js) DI hook 可测；toolId.test.js 里 NUL 字节修成 unicode escape 让 git 当 text。`479a897` + `5a9afa9`
- **2026-04-28 12:00 — Codex C 第四轮：MCP server id 契约 + 共享 toolId helper（safe vs safe:evil）** —— 新建 [src/mcp/toolId.js](src/mcp/toolId.js) `MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9_-]+$/`，用 `parseMcpToolId` 替 `split(':')[1]` 防 agent 授权 `safe` 静默放行 `safe:evil`；启动时 stderr 警告非法 server name。`3876cdc`
- **2026-04-28 11:30 — Codex C 第三轮：agentDraftFor 漏 enabledMcpServerIds → 静默清空 + stale 撤销失效** —— 抽 [desktop-ui/agentDraft.js](desktop-ui/agentDraft.js) `agentDraftFromProfile(agent)` 纯函数补 `enabledMcpServerIds: Array.isArray(...) ? [...] : []` deny-all 默认；12 个契约测试覆盖 round-trip 保留、unsubmitted 不丢、stale chip whitelist 撤销路径。`75f9f72`
- **2026-04-28 11:00 — Codex D 第二轮：MCP lifecycle reconciler（全局 disable 真生效）** —— `bootstrapMcpServers` 加 reconciler phase，先 disconnect stale active 再 connect effective；`connectMcpServer(disabled)` 也 disconnect 旧 client；抽 `reconcileMcpLifecycle` 纯函数 + 7 lifecycle 测试。`6957783`
- **2026-04-28 10:30 — Codex C 第二轮：mcpAuthSurface 统一 + boolean 严格 + 测试 NUL 修复** —— bootstrap 暴露 built-in ∪ user MCP 的 union surface（之前 UI 只列 built-in，user MCP 死锁）；`/api/mcp/preset-toggle` 严格 `typeof === 'boolean'`；test 文件里 NUL 字节用 python 替换。`4d9dc73`
- **2026-04-28 10:00 — Codex D 第一轮：MCP 默认全关 + cwd reframe + path 加严 + agent UI 撤销** —— md2pdf 默认改 false（4 层模型）；cwd 不再叫 sandbox（不限制绝对路径），改 default working dir；path 禁 `.`/`..`/无字母数字 leaf + resolve 校验 root；chip 改 CSS 类（仍可点撤销已有授权）；README 加 4 层状态文档。`799a9a4`
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
