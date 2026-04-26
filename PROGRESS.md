# Melo 进度日志

> 新条目追加在本文件顶部（时间倒序）。
> 当本文件超过 160 行或 8000 字符时，按 CLAUDE.md §3 自动压缩：最旧 70% 归档为一句话摘要，最新 30% 保留完整格式。

---

## 2026-04-26 22:30 — Phase 7d-5ε commit 2：抽出 Skill mutations 簇（10 个 CRUD entry，~331 行）

- 做了什么：
  - **新增 `src/services/skill/skillMutations.js`** —— byte-for-byte 把 10 个 exported skill CRUD 搬走：`toggleSkill` / `createCustomSkill` / `updateCustomSkill` / `removeCustomSkill` / `exportSkillAsMarkdown` / `importSkillFromMarkdown` / `promoteSkillToDisk` / `reloadDiskSkills` / `applySkillProposal`(133 行最大) / `draftSkillFromChat`，共 ~331 行。
  - 16 个 imports 全部映射到 leaf 模块（state machine + skillService + skillsDisk + skillProposals + skillDrafting + diskSkills）。
  - **`src/desktopStore.js`**：12 行 re-export 块（server.js 依赖这些 export 名），删 10 处函数定义换 3 行 stub。
- 为什么：commit 1（external connector CRUD）+ commit 2（skill CRUD）共抽走 17 个 CRUD entry / 共 ~610 行。下一刀候选：project / task / approval CRUD。
- 回归：services + state + desktopStore + memory + agents 全套绿。
- 提交哈希：（待 commit）
  - desktopStore: 3891 → 3578（-313 行；本会话累计 8527→3578 = **-4949 行 = -58.0%**）

## 2026-04-26 22:00 — Phase 7d-5ε commit 1：抽出 External Connector CRUD 簇（7 个 CRUD entry，~277 行）

- 做了什么：
  - **新增 `src/services/connector/externalConnectorMutations.js`** —— byte-for-byte 把 7 个 exported CRUD 函数搬走：`createExternalConnector` / `updateExternalConnector` / `removeExternalConnector` / `pingExternalConnector` / `readExternalConnectorResource` / `previewExternalConnectorPrompt` / `invokeExternalConnectorTool`，共 ~277 行。所有 deps 都已是 leaf（state machine + connector primitives）。
  - **`src/desktopStore.js`**：6 行 re-export 块（server.js HTTP 路由依赖这些函数名），删 7 处函数定义换 6 行 stub。
- 为什么：path B 完成后 desktopStore 还有 ~4140 行——其中大块是 server.js 调用的 CRUD entry。External Connector 是其中域最清晰、deps 最少的一组，自然成簇。后续可类似处理 Skill CRUD / Project CRUD / Task & Approval CRUD / Telegram polling / Discord polling。
- 回归：services + state + desktopStore + memory + agents 全套绿。
- 提交哈希：（待 commit）
  - desktopStore: 4144 → 3891（-253 行；本会话累计 8527→3891 = **-4636 行 = -54.4%**）

## 2026-04-26 21:30 — desktopStore unused-import cleanup（path B 收尾后的第二轮 housekeeping）+ PROGRESS condense

- 做了什么：
  - **`src/desktopStore.js` 第二轮 cleanup**：path B 抽走 sendChatMessage / getDesktopBootstrap / search-results 之后又有一些 import 死了。Python 脚本（这次顺手修了"花括号里夹注释"bug——会先 strip 注释再 split names）扫出 9 个整删 + 2 个 trim。
  - **PROGRESS.md condense**：从 189 行压到 ~127 行。把 8a / cleanup-1 / 7d / 7b / 7a 这 5 个条目移入归档（保留 5 个最新：8b/8c/8d/8e/8f verbatim）；同时回填了所有 7d-5δ commit hash 占位。
- 回归：services + state + desktopStore + memory + agents 全套绿。
- 提交哈希：（待 commit）
  - desktopStore: 4159 → 4144（-15 行；path B 累计 8527→4144 = **-4383 = -51.4%**）

## 2026-04-26 21:00 — Phase 7d-5δ commit 8f：**抽出 sendChatMessage（path B 真正收尾）+ scanRecentChatsForSkillProposals**

- 做了什么：
  - **新增 `src/services/chat/sendChatMessage.js`** —— `sendChatMessage`（350 行 async）+ 两个 sendChatMessage-private helper（`extractUrlAttachmentsFromText` 3 行 + `isAbortError` 7 行）byte-for-byte 搬走。共约 360 行。所有 30+ imports 全部映射到 leaf 模块（前 8a-8e 全部铺设的成果）。
  - **新增 `src/state/skillProposalScan.js`** —— `scanRecentChatsForSkillProposals`（49 行）byte-for-byte 搬走。原本在 desktopStore；I/O orchestrator 跟 pure heuristics（`agents/skillProposals.js`）应该分开住，所以建独立 state-domain 文件而不是塞进 skillProposals.js。
  - **`src/desktopStore.js`**：4 个 import + 4 个 export-from re-export（`sendChatMessage` 为 server.js / 内部 caller，`scanRecentChatsForSkillProposals` 为 skill-proposals 测试文件）。删 4 处函数定义（共 ~410 行）换 ~12 行 stub。
  - 用 Python 脚本机械抽取 + 头部 import 块，避免手抄漏字符。
- **path B 完成**：8 个 sub-commit (8a 到 8f) 把所有 LOCAL prereq + sendChatMessage 全搬出来。整个 chat 主路径现在是独立 leaf 链。
- 回归：services + state + desktopStore + memory + agents 全套 **724/724 全绿**。
- 提交哈希：`9895335`（commit 8f 主体）+ `f1ced20`（missing-imports + smoke test fix）
  - desktopStore: 4542 → 4159（-383 行；本会话累计 **8527 → 4159 = -4368 行 = -51.2%** ——突破半数）

## 2026-04-26 20:30 — Phase 7d-5δ commit 8e：抽出 getDesktopBootstrap + 4 个 cluster-private helper

- 做了什么：
  - **新增 `src/state/desktopBootstrap.js`** —— byte-for-byte 把 5 个函数搬走：`availableModelsForConfig`(18 行) + `summarizeAgentProfile`(69 行) + `buildAgentProfiles`(25 行) + `buildProfile`(8 行) + `getDesktopBootstrap`(118 行) = ~240 行。前 4 个全是 cluster-private（只有 getDesktopBootstrap 调），打包同行。
  - **`getAgentMarkdownPaths` 工厂绑定**：`createAgentMarkdownFileHelpers` 是工厂函数，desktopStore 是绑死 `AGENTS_DIR` const 的；新模块用**lazy `() => join(getMeloHome(), 'desktop', 'agents')`** 形式（CLAUDE.md §6 指定的"调用时捕获 env"模式），避免 module-load 时冻结 home。
  - **`src/desktopStore.js`**：1 行 `import { getDesktopBootstrap } from './state/desktopBootstrap.js'` + 1 行 `export { getDesktopBootstrap } from ...`（back-compat re-export，给 server.js + 一些 `import * as store` 测试用）。删 5 处函数定义（共 ~240 行）换 ~10 行 stub。
- 中间小坑：第一稿没加 re-export，server.js / projectsDefault.test.js 都用 `import * as store` 拿 `store.getDesktopBootstrap`——失败 7 个测试。修：加 export from。同款 commit 7d-5β commit 1 的 contract-break / Phase 7d-5γ commit 1 的 re-export 教训。
- 回归：services + state + desktopStore + memory + agents 全套 **723/723 全绿**。
- 提交哈希：`0a05a30`（commit 8e 主体）+ `e7d2872`（§6 home capture fix + regression test）
  - desktopStore: 4764 → 4542（-222 行；本会话累计 8527→4542 = **-3985 行 = -46.7%**）

## 2026-04-26 20:00 — Phase 7d-5δ commit 8d：抽出 search-results builder 簇（644 行 6 函数 + 1 const，单 commit 第二大瘦身）

- 做了什么：
  - **新增 `src/services/search/searchResultsBuilder.js`** —— 把以下 8 个相互私有的 LOCAL 一并 byte-for-byte 搬走：
    - `MAX_SEARCH_RESULTS`（const）
    - `sortSearchItems`（cap helper）
    - `buildFeatureSearchEntries`（149 行，feature catalogue）
    - `buildRecentSearchSuggestions`（87 行）
    - `buildChatThreadSearchEntry` / `buildChatMessageSearchEntry`
    - `buildMemorySearchItem`（71 行）
    - `buildSearchResults`（281 行，唯一对外 export 的入口）
  - 11 个 imports 全部映射到现有 leaf 模块（memory/store, search/scoring, message/messageBlocks, message/messageSearch, conversation, etc.）。
  - **`src/desktopStore.js`**：顶部 import 块加 5 行（含注释）；删 644 行的 cluster body 换 9 行 stub。唯一外部 caller 是 getDesktopBootstrap（line ~3445），走 imported name。
- 用 Python 脚本机械抽出 cluster body + 头部注释 + import 块拼装新文件，避免手抄 644 行可能漏字符。`node --check` 验证语法 + 全套测试绿。
- 为什么：getDesktopBootstrap 还有 4 个 LOCAL 依赖（buildAgentProfiles / buildProfile / availableModelsForConfig / buildSearchResults）。`buildSearchResults` 是其中体量最大且 domain-specific（search），单独抽干净；剩 3 个小的下一刀和 getDesktopBootstrap 一起搬。
- 回归：services + state + desktopStore + memory + agents 全套 **723/723 全绿**。
- 提交哈希：`edd3e76`
  - desktopStore: 5408 → 4764（-644 行；本会话累计 8527→4764 = **-3763 行 = -44.1%**）

## 2026-04-26 19:30 — Phase 7d-5δ commit 8c：抽出 refreshChatMemorySummary + buildConnectors

- 做了什么：
  - **`refreshChatMemorySummary`（3 行）**：byte-for-byte 追加到 `src/state/chatThreadContext.js`——它的两个 deps（ensureChatThreadContext / renderStructuredThreadMemorySnapshot）已经在那个模块导入。零新 import。
  - **`buildConnectors`（102 行）**：byte-for-byte 搬到新建 `src/services/connector/connectorRollup.js`。APP_ROOT 用 4 个 dirname 重算（同 workspaceSnapshot.js / stateHydration.js 模式）。其他 deps（BUILTIN_CONNECTORS / COMMAND_TEMPLATES / formatUpdatedAt / maskSecret）都已是 leaf。
  - **`src/desktopStore.js`**：refreshChatMemorySummary 加进现有 `chatThreadContext.js` import 块；buildConnectors 单独 import；删两处函数定义共 105 行换 5 行 stub。所有 5+2 个 callers 走 imported name。
- 为什么：sendChatMessage 的剩余 LOCAL deps 中两个 mid-size 的，先解决。剩 isAbortError + extractUrlAttachmentsFromText（私有）+ scanRecentChatsForSkillProposals（已 export）+ getDesktopBootstrap（118 行 37 callers，下一刀）。
- 回归：services + state + desktopStore + memory + agents 全套绿（同款 store.* isolation flake，re-run 干净）。
- 提交哈希：`66cd1a8`
  - desktopStore: 5501 → 5408（-93 行）

## 2026-04-26 19:00 — Phase 7d-5δ commit 8b：updateStateAtomically 搬回 state/stateStore.js（§5 carve-out 反转）

- 做了什么：
  - `updateStateAtomically`（13 行）从 desktopStore byte-for-byte 搬到 `src/state/stateStore.js`——它原本就该在那里（和 saveState / persistStateAtomically / readStateSnapshot 一起）。Phase 7d-5α-A1 commit 9 曾因为 ensureSelectedEntities 的 58 callers 把它留在 desktopStore，加了 §5 carve-out + `enqueueStateWrite` 桥梁。commit 8a 把 ensureSelectedEntities 拎到 stateSelections.js，这个 carve-out 失去存在理由。
  - `stateStore.js` 增加 1 行 `import { ensureSelectedEntities } from './stateSelections.js'` + 30 行 byte-for-byte 移植。
  - `enqueueStateWrite` 留 export 但加了备注"now mostly historical, can be retired in cleanup"。
  - `desktopStore.js` import 列表加 `updateStateAtomically`，删 13 行原定义换 4 行 stub。**24 个内部 caller** 全部走新 import。
- 为什么：path B 的精神就是"helper 放在该在的地方"。stateStore 是状态机模块——updateStateAtomically 跟 saveState 共用同一个 module-private queue，住一起最干净。
- 回归：services + state + desktopStore + memory + agents 全套绿（一次小 flake 是已知 store.* 测试 isolation 问题，re-run 全绿）。
- 提交哈希：`3c71ee6`
  - desktopStore: 5516 → 5501（-15 行）

## 归档摘要（2026-04-26 04:30 之前的所有条目）

> 按 CLAUDE.md §3 自动压缩：每条仅保留标题 + 一句话结论 + commit hash。完整原始条目见 git history (`git log --follow -p PROGRESS.md`)。

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
