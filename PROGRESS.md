# Melo 进度日志

> 新条目追加在本文件顶部（时间倒序）。
> 当本文件超过 160 行或 8000 字符时，按 CLAUDE.md §3 自动压缩：最旧 70% 归档为一句话摘要，最新 30% 保留完整格式。

---

## 2026-04-26 16:45 — Phase 7d-5δ commit 7a：抽出 MODE_DEFS（elephant 抽取的最后一个 prereq）

- 做了什么：
  - **新增 `src/services/chat/modeDefs.js`** —— `MODE_DEFS` 静态 3 条目数组（chat/cowork/code）byte-for-byte 搬走。零依赖纯数据。
  - **`src/desktopStore.js`**：顶部 import 块加 4 行；删 20 行原定义换 2 行 stub。3 个 caller（line ~1476/~3640/~4176）走 imported name。
- 为什么：`runChatAgentExecutionGraph`（即将抽走的 elephant）有两个剩余 LOCAL 依赖：`MODE_DEFS` + `getSharedSkillIndex`。前者有 3 callers（runner 占 1，desktopStore 占 2）必须先抽到 leaf；后者只有 runner 1 caller，跟着 runner 一起搬。这是 elephant 抽取前的最后一个 prereq。
- 回归：services + state + desktopStore + memory + agents 全绿。
- 提交哈希：（待 commit）
  - desktopStore: 6202 → 6188（-14 行）

## 2026-04-26 16:30 — Phase 7d-5δ commit 6：抽出 runTaskAgentExecutionGraph（第一个 runner 落地，pattern 验证通过）

- 做了什么：
  - **新增 `src/services/chat/taskExecutionRunner.js`** —— `runTaskAgentExecutionGraph`（87 行 async）byte-for-byte 搬走。12 个 upstream import 全是 leaf 模块产出（前 5 个 commit 的累计成果）：
    - agentGraph: `createStateGraph` / `runStateGraph` / `GRAPH_END`
    - state: `findProjectById` / `effectiveAgentProfile`
    - services: `buildWorkspaceSnapshot` / `taskExecutionPrompt` / `normalizeTasks` / `normalizeApprovals` / `buildToolRoutingPrompt` / `buildProjectContextSection` / `buildReActSystemPrompt`
    - memory: `normalizeConversationSnippet`
    - openai: `createOpenAICompatibleReply`
  - **零 desktopStore.js 反向 import**——这意味着 runner 抽走没有循环依赖，前 5 个 prerequisite commit 的全部目的就是为了这一刻。
  - **`src/desktopStore.js`**：顶部 import 块加 4 行；删原函数定义（87 行）换 3 行 stub。唯一内部 caller (line ~1332, inside `runTaskWorkerModel`) 走 imported name。
- 为什么：runner 抽取的第一刀，验证 path B 整体设计可行。87 行任务执行图相对 chat 执行图（~520 行 elephant）小很多，先抽小的让 gate 复审 pattern。
- 回归：services + state + desktopStore + memory + agents 全绿。
- 提交哈希：（待 commit）
  - desktopStore: 6282 → 6202（-80 行；本会话内累计已减 1003 行：8527→6202，进度 38%）

## 2026-04-26 16:00 — Phase 7d-5δ commit 5：抽出 effectiveAgentProfile + projectAgentOverrideFor（实查后 8 callers、不是 57）

- 做了什么：
  - **复用 `src/state/agentProfiles.js`**（已存在的模块，含 normalizeAgentProfile / normalizeAgentProfiles 等）—— `effectiveAgentProfile`（21 行）+ `projectAgentOverrideFor`（8 行）byte-for-byte 追加进去并 export。两者**逻辑上属于同一域**（profile 组合：base + project-level override），自然落在 normalizeAgentProfile 旁边。
  - **`src/desktopStore.js`**：扩展原 `from './state/agentProfiles.js'` 的 import 列表加 2 行；删两处 LOCAL 定义（共 ~30 行）换 3 行 stub。10 个内部 caller（effectiveAgentProfile 8 + projectAgentOverrideFor 2）全走 imported name。
- **关于"57 callers"误报的更正**：早前 PROGRESS 记录说 effectiveAgentProfile 有 57 callers——实查只有 **8**。可能那个数字来自另一个会话的笔记，或者跟 `agentUsesTool` 的某个分布混了。今天对函数做 grep -c 确认 8。教训：pre-extraction 调研必须跑实际 grep，不能信旧 PROGRESS 笔记里的体感数字。
- 为什么：runner 抽取最后一个 prerequisite。`runTaskAgentExecutionGraph` / `runChatAgentExecutionGraph` 都用 `effectiveAgentProfile` 计算当前 agent 的有效 profile；现在它在 leaf 模块，runner 抽出去就没有循环导入风险了。
- 回归：services + state + desktopStore + memory + agents 全绿。
- 提交哈希：`7055c17`
  - desktopStore: 6303 → 6282（-21 行）

## 2026-04-26 15:30 — Phase 7d-5δ commit 4：抽出 taskExecutionPrompt（依赖单 imported helper，又一个真叶子）

- 做了什么：
  - **新增 `src/services/task/taskPrompt.js`** —— `taskExecutionPrompt`（26 行纯函数）byte-for-byte 搬走。唯一依赖 `agentUsesTool` 已经在 `services/agent/agentTools.js`。
  - **`src/desktopStore.js`**：顶部 import 块加 2 行；删原函数定义（26 行）换 2 行 stub。唯一内部 caller (line ~4171, inside `runTaskAgentExecutionGraph`) 走 imported name。
- 为什么：runner 抽取 prerequisite #3。`runTaskAgentExecutionGraph` 的 prepare 节点要 `taskExecutionPrompt`；现在只剩 `effectiveAgentProfile`（最后一个、最大、57 callers）和 runner 本身待抽。
- 回归：全绿。
- 提交哈希：`12e85aa`
  - desktopStore: 6325 → 6303（-22 行）

## 2026-04-26 15:00 — Phase 7d-5δ commit 3：抽出 buildWorkspaceSnapshot（带 APP_ROOT 深度调整）

- 做了什么：
  - **新增 `src/services/workspace/workspaceSnapshot.js`** —— `buildWorkspaceSnapshot`（~52 行 async）byte-for-byte 搬走。新模块在 `src/services/workspace/`（3 层深），所以：
    - **APP_ROOT 计算用 4 个 dirname** 替代 desktopStore 的 2 个，值相同公式不同——同 Phase 7d-5α-A1 commit 7 stateHydration.js 的处理方式。
    - **`sanitizeWorkspacePath` 1-arg wrapper byte-identical 复制**给新模块自用，desktopStore 那份继续保留（还有另一个 in-module caller 在 line ~5956）。同样是 commit 7 的处理方式。
    - 其余 deps（`stat` / `listWorkspaceEntries` / `readWorkspaceFile` / `COMMAND_TEMPLATES` / `commandTemplateDescriptor`）都已在外部 leaf 模块。
  - **`src/desktopStore.js`**：顶部 import 块加 7 行；删 `buildWorkspaceSnapshot` 定义（52 行）换 5 行 stub。8 个内部 caller 走 imported name。
- 为什么：runner 抽取 prerequisite #2。任务 / 聊天执行图的 prepare 节点都要 `buildWorkspaceSnapshot`；要把它们搬出去，先把这个 helper 拎成 leaf。APP_ROOT 处理用上次已经验证过的 commit 7 模式。
- 回归：services + state + desktopStore + memory + agents 全绿。
- 提交哈希：`f3f61d5`
  - desktopStore: 6365 → 6325（-40 行）

## 2026-04-26 14:30 — Phase 7d-5δ commit 2：抽出 4 个 findXById finder 簇

- 做了什么：
  - **新增 `src/state/stateLookups.js`** —— 4 个 trivial finder 一起 byte-for-byte 搬走：`findProjectById` / `findExternalConnectorById` / `findTaskById` / `findApprovalById`，共 ~16 行。每个都是 1 行 `state.X.find(...)` 纯函数。
  - **`src/desktopStore.js`**：顶部 import 块加 7 行；删 4 处函数定义（共 16 行）换 4 行 stub。35 个内部 caller 走 imported name。
- 为什么：runner 抽取的 prerequisite。`runTaskAgentExecutionGraph` / `runChatAgentExecutionGraph` 都用 `findProjectById`；要把 runner 搬到独立 leaf，finder 必须先有自己的 leaf 不然就要走 DI 注入或 export-at-tree（cec12c3 那条路被 gate 评 C）。把 4 个 trivial finder 一起搬是最自然的边界——和 Phase 7d-5γ commit 1（COMMAND_TEMPLATES + descriptor）同款打包。
- 回归：services + state + desktopStore + memory + agents 全绿。
- 提交哈希：`be96ec6`
  - desktopStore: 6367 → 6365（-2 行；函数体很小，主要是 import 块抵消了瘦身）

## 2026-04-26 14:00 — Phase 7d-5δ commit 1：抽出 chat-graph action planner 簇（7 个互引的 LOCAL helper 一并搬走）

- 做了什么：
  - **新增 `src/services/chat/chatActionPlanning.js`** —— 一个自包含的 7 函数簇 byte-for-byte 搬走（共 ~210 行）：
    - `normalizeGraphNeedle`（pure string 规整）
    - `extractSearchQueryFromMessage`（best-effort 搜索词提取）
    - `planCommandAction`（curated 本地命令匹配）
    - `extractConnectorToolInput`（external-mcp tool 输入解析）
    - `planExternalConnectorAction`（external-mcp tool 匹配）
    - `planChatGraphAction`（thin entry：先 external 再 command 再 null）
    - `buildApprovalResponse`（plan 落地后写给用户的回复）
  - 只 export 2 个（planChatGraphAction + buildApprovalResponse），其余 5 个都是簇内私有 helper——它们之间互引但**对外**只有 1 个调用点（line ~3781 / ~3807，全在 `runChatAgentExecutionGraph` 里）。所以一次 commit 把整个簇搬走是最干净的边界。
  - 唯一外部依赖 `agentUsesTool`（已在 services/agent/agentTools.js）。
  - **`src/desktopStore.js`**：顶部 import 块加 7 行；删 221 行（7 函数 + 间隔注释）换成 6 行 stub。
- 为什么：7d-5δ 的目标是 elephant 抽取（runChatAgentExecutionGraph + runTaskAgentExecutionGraph + sendChatMessage）。但执行图依赖 `planChatGraphAction` + `buildApprovalResponse`——这两个又依赖 5 个簇内私有 helper。先把整个 planning 簇拎出去，elephant commit 才能干净 import。这是 7d-5α-A1 的同款"先抽 prerequisite、再抽消费者"路径。
- 回归：services + state + desktopStore + memory + agents 全绿。
- 提交哈希：`7866271`
  - desktopStore: 6572 → 6367（-205 行；本会话内累计已减 838 行：8527→6367）

## 2026-04-26 13:30 — Phase 7d-5γ commit 4：抽出 buildAgentMemoryNodeContext + 私有 helper（最大单 commit 瘦身）

- 做了什么：
  - **新增 `src/services/agent/agentMemoryContext.js`** —— `buildAgentMemoryNodeContext`（337 行）+ 它唯一专用的 5 行私有 helper `latestUserMessageRecord` 一起 byte-for-byte 搬走。两者绑得很紧（latestUserMessageRecord 只有这一个 caller），合一个 self-contained leaf 是最自然的边界，复用 commit 1（COMMAND_TEMPLATES + descriptor）的同款打包模式。
  - **`src/desktopStore.js`**：顶部 import 块加 5 行；删 latestUserMessageRecord 定义（5 行）+ buildAgentMemoryNodeContext 定义（337 行）共 342 行，换成两段共 6 行 stub 注释。唯一内部 caller (line ~3955 prepare-node) 走 imported name。
- 关于"7+ LOCAL deps"实查更正：commit 3 一样，Explore agent 的报告把外部 imported 的符号误判为 LOCAL。实际只有 1 个真 LOCAL（latestUserMessageRecord），其余 12 个全是从 memory/store.js、memory/attic.js、memory/heuristics.js、memory/speakerProfile.js、state/memorySnapshot.js、services/activity/、services/approval/、services/task/ 里 import 来的。**Lesson**：Explore agent 的"deps 报告"必须再用 desktopStore 顶部 import 块逐个 cross-check，不能盲信。
- 回归：services + state + desktopStore + memory + agents 全绿；这是单 commit 史上最大瘦身。
- 提交哈希：`b30d563`
  - desktopStore: 6902 → 6572（-330 行；本会话内累计已减 633 行：8527→6572，进度近 40%）

## 归档摘要（2026-04-26 04:30 之前的所有条目）

> 按 CLAUDE.md §3 自动压缩：每条仅保留标题 + 一句话结论 + commit hash。完整原始条目见 git history (`git log --follow -p PROGRESS.md`)。

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
