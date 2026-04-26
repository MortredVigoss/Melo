# Melo 进度日志

> 新条目追加在本文件顶部（时间倒序）。
> 当本文件超过 160 行或 8000 字符时，按 CLAUDE.md §3 自动压缩：最旧 70% 归档为一句话摘要，最新 30% 保留完整格式。

---

## 2026-04-27 01:35 — Video 改成诚实的功能模型（Phase 1：UI 文案不再暗示能看画面）

- 用户要求："第一阶段 UI 明确写成 Video audio/transcript，不要暗示能看画面"。
- 现状审计：`src/media/extractors/videoExtractor.js` 跑 `ffmpeg -i ... -vn ...` 把视频里的视频流去掉只留音轨，再走 `extractAudioContent` 转写——下游模型本质拿到的就是 audio transcript。但 UI 上：
  - 附件菜单按钮就写一个 "Video"，没任何提示
  - Drop banner "Drop image, video, or audio files here to attach them."
  - 消息流里渲染成 `<video controls>` 大播放器，没有任何"模型只看到音频"的提示
  → 容易让用户以为 agent 会看画面、问"视频里那个红色物体是什么"——结果模型只能从音轨转写凭空编。
- Phase 1 修复（`desktop-ui/app.js` + `desktop-ui/styles.css`）：
  - Composer 附件菜单 "Video" 按钮：保留主标 + 加 11px 副标 "audio transcript only"；hover title 完整说明 "Video → audio is transcribed; visual frames are not sent to the model in this phase."
  - Drop banner：改为 "Drop image, audio, or video here. Video files are sent as audio transcripts only."
  - 消息流里视频卡片的 caption 旁边追加斜体 hint "audio transcript only"——用户回看历史时也能看到模型实际看到了什么。
  - CSS 加 `.composer-menu-item-text`（flex column, line-height 1.2）+ `.composer-menu-item-hint`（var(--text-soft) 11px）+ `.media-caption-hint`（同色 italic 11px）。
- Phase 2（未做，留作下一步）：关键帧抽取——每隔 N 秒或场景切换抽 3-8 张图作 image_url / vision context，与音轨 transcript 一起送模型。`videoExtractor.js` 现成路径里加 `ffmpeg -vf "select='eq(pict_type\,I)'"` 关键帧筛选 + base64 image 列表。
- 验证：`node --check desktop-ui/app.js` 通过；regression 303/303 绿。
- 提交哈希：（待 commit）

## 2026-04-27 01:10 — Composer Link 入口统一 URL 分类（共用 detectUrlKind/promoteTextUrlsToAttachments）

- 用户要求："手动点 Link 添加时也调用同一套 detectUrlKind/promoteTextUrlsToAttachments，YouTube/音频/视频/PDF/普通网页不管是粘贴文字还是点 Link，都得到同样的 kind/mimeType/title"。
- 之前 `desktop-ui/app.js → promptComposerLinkAttachment` 硬编码 `kind: 'link'`，跟 `src/services/chat/sendChatMessage.js` 走 `promoteTextUrlsToAttachments` 的"粘贴文字"路径分类完全脱钩——粘 `https://youtu.be/X` 拿 `kind: 'video'`，点 Link 输入同 URL 拿 `kind: 'link'`，下游模型 prompt 拿到不同信号。
- 修复：
  - `src/server.js` 加 `/shared/urlDetector.js` 静态路由（仿 `/vendor/three/` 套路），把 `src/media/urlDetector.js` 暴露给浏览器。该文件纯 regex 无 Node 依赖，浏览器直接 `import` 安全。
  - `desktop-ui/app.js` 顶部 `import { promoteTextUrlsToAttachments } from '/shared/urlDetector.js'`；`promptComposerLinkAttachment` 改为先 validate http(s)、再交给 `promoteTextUrlsToAttachments(url, uiState.composerAttachments)`，结果 enrich `id: crypto.randomUUID()` + `sizeLabel: ''` 后 push，URL 已存在自动 dedup（顺手修了之前 manual link 不去重的小坑）。
  - `src/media/urlDetector.test.js` 加 6 个 case 锁住"promoted shape 跨所有 kind 一致"的契约（video-platform→video / image / audio / PDF→link+pdf-mime / plain link / 单 bare URL 一份附件），避免未来无意识改动让 manual-link 路径默默 drift。
- 验证：syntax check 三个文件全过；regression `services + state + desktopStore + media` 303/303 绿（之前 285，新增 6 个 urlDetector + 12 个 media 周边自检）。
- 提交哈希：（待 commit）

## 2026-04-27 00:45 — Artifacts UI 重新设计：按钮统一文字版（设计语言一致）

- 用户截图反馈："右边这个 ui 太丑了，两个巨大的按钮，然后中间的 edit 又不像是按钮很难点击到，你去重新设计一下 ui，记得 ui 设计的统一性，按钮设计的风格语言要统一"。
- 根因：`<button class="small-button is-outline">` 内部塞 `<span class="toolbar-icon">${icon.pencil}</span>` + 文字，但 `.small-button` 没有 `display: inline-flex` / `gap`（不像 `.ghost-button`），SVG 直接以原始尺寸渲染，文字被挤到旁边——既丑也不像按钮。
- 修复：改成纯文字 `.small-button` 变体，对齐已有的 `Queue write to <file>` 文字按钮风格：
  - Edit → `.small-button.is-outline`（克制的次级动作）
  - Delete → `.small-button.is-danger`（红色，语义警示）
  - Queue write → `.small-button.is-primary`（保持原色）
- 顺手清掉新引入但不再用的 `pencil` / `trash` icon 定义；编辑表单加 `surface-card` 类，让它在视觉上跟创建表单一致。
- 验证：`node --check desktop-ui/app.js` 通过；regression 285/285 绿。
- 提交哈希：（待 commit）

## 2026-04-27 00:30 — Artifacts CRUD：补 service-layer 单元测试（B-finding 跟进）

- 做了什么：新增 `src/services/workspace/workspaceMutations.test.js`，8 个测试覆盖刚抽出的 `updateArtifact` + `deleteArtifact`：
  - title-only patch 保留 content / id / chatId / projectId / createdAt
  - 空 / 纯空白 content 报错 + 状态不变
  - 未知 artifactId 报错（update + delete 各一）
  - 缺失 artifactId 报错
  - title + language + kind + content 同时 patch + identity 字段 preserved
  - delete 删除指定行 + 保留其余 + 项目 updatedAt 被 bump
  - delete 未知 id 报错 + 状态不变
- 用与 chatExecutionRunner.test.js / desktopBootstrap.test.js 相同的 mkdtemp + dynamic-import + after()-cleanup 模式，跑测前后 `~/.melo/desktop/state.json` mtime + size 验证未变。
- 回归：service-only 8/8 绿；全套 regression（services + state + desktopStore + memory + agents）合并跑一次有已知 store.* isolation flake，re-run 干净。
- 提交哈希：（待 commit）

## 2026-04-27 00:00 — Artifacts：从只读产物架升级成可管理知识架（语义闭环修复 + UI/API CRUD）

- **修复语义闭环**：`src/services/chat/dynamicContext.js` 第 ~67 行原读 `artifact.summary`（artifact 记录里**根本没有这个字段**——一直在喂 `undefined`），改成 `truncateText(artifact.content || '', 180)`，让 agent prompt 拿到真正的内容前 180 字符。
- **后端**：
  - `src/services/workspace/workspaceMutations.js` 新增 `updateArtifact(artifactId, patch)` + `deleteArtifact(artifactId)`。前者支持 partial patch（只 patch 提供的 title/content/language/kind 字段，identity / chatId / projectId / createdAt 永远不动）；后者从 state.artifacts 过滤删除。两者都用 `updateStateAtomically` 防止与新 artifact 创建并发冲突。
  - `src/desktopStore.js` 加 re-export。
  - `src/server.js` 加 `POST /api/artifacts/update` + `POST /api/artifacts/delete` 路由（与已有 `/api/artifacts` create / `/api/artifacts/apply` 同款 POST + body 风格）。
- **UI**（`desktop-ui/app.js`）：
  - 新增 `pencil` + `trash` 两个 SVG icon。
  - `uiState` 加 `editingArtifactId` + `editingArtifactDraft`。
  - `renderArtifactsPage()` 详情面板：当 `editingArtifactId === active.id` 时渲染 `data-form="artifact-update"` 编辑表单（title/language/kind/content 四字段），否则渲染原视图加 Edit / Delete / Queue write 三个按钮。
  - 4 个新 handler：`handleStartEditArtifact` / `handleCancelEditArtifact` / `handleUpdateArtifact` / `handleDeleteArtifact`。delete 用 `window.confirm()` 防误触。
  - 4 个新 action case + 1 个新 form-submit case + 1 个新 input handler 分支（`artifact-update`）。
- **Decision recorded**：用户选了"可管理的知识架"——现在 UI 文案保留 "Artifacts"，因为它**真的是可管理产物**了（不是 saved snippets）。
- **Tests**：services + state + desktopStore + memory + agents 全套绿。**UI 未做浏览器手测**——CLAUDE.md 说"can't test the UI = say so"。建议你启动 `npm start` 在真实 Melo 里点一下 Edit/Delete 按钮 + 改个 title 验证。
- 提交哈希：（待 commit）

## 归档摘要（2026-04-27 之前的所有条目）

> 按 CLAUDE.md §3 自动压缩：每条仅保留标题 + 一句话结论 + commit hash。完整原始条目见 git history (`git log --follow -p PROGRESS.md`)。

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
