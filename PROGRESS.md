# Melo 进度日志

> 新条目追加在本文件顶部（时间倒序）。
> 当本文件超过 160 行或 8000 字符时，按 CLAUDE.md §3 自动压缩：最旧 70% 归档为一句话摘要，最新 30% 保留完整格式。

---

## 2026-04-26 02:30 — Phase 7d-5α-A1 commit 8+9 fix：MELO_HOME 隔离修复（Q1a + Q2b）+ 串读 audit

- 做了什么（修复 commit 856aa07 在 Codex review 中触发的 C 评级）：
  - **Q1a 落实**：`stateStore.js` 把 `let markdownSynced = false` 替换为 `markdownSyncedByHome = new Map()`，所有读写通过 `getMeloHome()` 索引。`isMarkdownSyncedForCurrentHome()` + `markCurrentHomeMarkdownSynced()` 两个 helper 替换原 boolean 直接读写。生产单 home 时 Map 始终只有 1 个 entry——行为等价。
  - **Q2b 落实**：`createAgentMarkdownFileHelpers({ agentsDir })` 现在接受 string OR `() => string`。`markdownSync.js` 改为传 `() => join(getMeloHome(), 'desktop', 'agents')`，每次 `getAgentMarkdownPaths` 调用都重新解析 home。desktopStore 的现有调用方（传 string）不受影响——纯添加新形态，向后兼容。
  - **顺手 audit 抓到第三个 bug**：`src/memory/checkpointer.js` 的 `const THREADS_DIR = join(getMeloHome(), 'desktop', 'threads')` 也是模块加载时固定。改成 lazy `threadsDir()` 函数。这个 bug 早就在原代码里，我的 refactor 只是放大了它的可见性（从前 desktopStore 一起 cache-bust 时间接掩盖了）。
  - **新增 `src/state/stateStoreHomeIsolation.test.js`（3 个测试）**——专门压住这一类 home-leak bug：
    - 两个 home 各自 state.json 不互相串读
    - createChat 在 home B 不污染 home A 的 state.json
    - 两个 home 各自的 IDENTITY.md 都被正确导入（这是 markdownSynced 单例 bug 的精确回归测试，会失败如果 Q1a 没做）
- 为什么：CLAUDE.md §4 C/D gate 强制——commit 856aa07 评 C，必须先停下来按 Codex 意见重出方案、用户判断后才能动代码。Q1a + Q2b 是用户确认的方案。fix 里同时做了未覆盖的 audit 工作（checkpointer.js）防止下次再撞同类 bug。
- 产出 / 提交哈希：未提交
  - 4 个文件改动：
    - `src/services/agent/markdownFiles.js`：factory 加 `resolveAgentsDir = typeof agentsDir === 'function' ? agentsDir : () => agentsDir`，向后兼容
    - `src/state/markdownSync.js`：lazy `agentsDir` getter 替换 module-load-time 计算
    - `src/state/stateStore.js`：`markdownSyncedByHome` Map + 两个 helper
    - `src/memory/checkpointer.js`：`THREADS_DIR` 改为 `threadsDir()` lazy 函数
  - 1 个新测试文件：`src/state/stateStoreHomeIsolation.test.js`（3 tests，全绿）
  - 回归：services + desktopStore + search + state 套件 306/306（+3 from new isolation tests）；跨域 583/583 全绿

## 2026-04-26 01:30 — Phase 7d-5α-A1 收尾 (Commit 8+9 合并)：state-machine 全部搬出 desktopStore

- 做了什么（一个 big-bang commit 完成 commit 8/9 + cec12c3 cleanup）：
  - **新增 `src/state/markdownSync.js`**（~140 行，2 个 export + 1 个私有 helper + 1 个本地 let）
    - `importAgentMarkdownFiles`、`queueAgentMarkdownPrime`、`primeAgentMarkdownFiles`（私有）、`markdownPrimeQueued`（私有 let）
    - 所有 deps 已外部可达；`getAgentMarkdownPaths` 通过本模块独立 `createAgentMarkdownFileHelpers({ agentsDir })` factory 绑定，与 desktopStore 的实例并行存在但解析到同一目录
    - `syncAgentMarkdownFiles` **故意留在 desktopStore**——它依赖 `effectiveAgentProfile`（57 caller），不在本 phase 范围
  - **新增 `src/state/stateStore.js`**（~140 行，6 个 export）
    - `STATE_PATH` 改为私有 lazy `statePath()` getter（**关键修复**：测试用 `import('./desktopStore.js?t=...')` cache-bust 重载 desktopStore 但 dependency 模块只加载一次，所以 `getMeloHome()` 不能在 module load 时定 — 必须每次 call 时 read）
    - `stateWriteQueue`、`markdownSynced` 私有 let
    - `readStateSnapshot`、`persistStateAtomically`、`loadState`、`saveState`：byte-identical bodies
    - **新增 `enqueueStateWrite(work)` 助手**：CLAUDE.md §5 carve-out — 因为 `updateStateAtomically` 留在 desktopStore（依赖 `ensureSelectedEntities`，57 caller 不能在本 phase 搬），它需要和 stateStore 的 saveState 共享同一个 queue。`enqueueStateWrite` 是这种"模块边界绕开 let-import 只读限制"的最小开销手段。
  - **`src/desktopStore.js` 改造**：
    - 删除：`STATE_PATH` const、`stateWriteQueue` let、`markdownSynced` let、`markdownPrimeQueued` let、`readStateSnapshot`、`persistStateAtomically`、`loadState`、`saveState`、`importAgentMarkdownFiles`、`primeAgentMarkdownFiles`、`queueAgentMarkdownPrime`（共 ~200 行）
    - 改写 `updateStateAtomically` 函数体——从直接突变 `stateWriteQueue` 改成调用 `enqueueStateWrite(work)`。这是**§5 单点 carve-out**，明确记录在 commit message 里。
    - 删除 `cec12c3` 留下的两个 dead `export` 关键字：`findProjectById` 和 `ensureSelectedEntities`（Codex C-grade 评估明确指出这种 export 不能消除将来 runner 移出时的循环依赖；现在收回）
    - 添加 import 块从 `./state/markdownSync.js` 和 `./state/stateStore.js`
- 为什么：
  - **这是 7d-5α-A1 9-commit 计划的最后一步**。完成后 state-machine 完全搬出 desktopStore，runner 主体（`runChatAgentExecutionGraph`）所需的 `saveState` 现在能 byte-for-byte import from stateStore，不再有循环依赖。
  - **Phase 7d-5α-A1 至此完成 foundation 部分**。后续 7d-5β / 7d-5γ 还要处理 ~10 个 prompt/context helper 才能真搬 elephant，但那是另一个 phase 的工作。
- 产出 / 提交哈希：未提交
  - 2 个新文件（markdownSync.js + stateStore.js）共 ~280 行
  - desktopStore.js 净减约 196 行（原 7304 → 现 7186）
  - 累计 7d-5α-A1：8 个 state 模块拆分 + 1 个 fix commit。desktopStore.js 总计从 8527 → 7186 = **净减 1341 行**（-15.7%）
  - 回归：services + desktopStore + search + state 套件 303/303；跨域 images+tools+media+memory+agents+openai 583/583 全绿

## 2026-04-26 00:55 — Phase 7d-5α-A1 commit 7 fix：恢复 sanitizeWorkspacePath wrapper + 审计 commits 1-6

- 做了什么：
  - **commit 7 (`7b051fa`) 触发 C 评级回归修复**：原 desktopStore 里 `sanitizeWorkspacePath` 是个 1-arg local wrapper（绑定 `APP_ROOT` 给 2-arg 的 `sanitizeWorkspacePathRaw`），`normalizeProject` 通过它调用。我搬到 stateHydration.js 时**绕过了 1-arg wrapper**，直接用了 2-arg 函数，导致相对路径 `workspacePath` 进入 normalizeProjectRaw 后调 `resolve(undefined, rawPath)` 抛 TypeError。
  - 修复：在 stateHydration.js 中重新引入 local 1-arg wrapper（与原 desktopStore 字面一致），改回 normalizeProject 使用它。这才是真正的 byte-for-byte。
  - **顺手 audit 之前 6 个 commit**（chatPruning / chatPersistence / chatThreadContext / memorySnapshot / diskSkills + commit 7 的其它部分）—— 检查每个搬过去的函数是否漏掉同类 wrapper。**结果干净**：commits 1-6 没有同类 bug。bug 仅限于 commit 7 的 `normalizeProject` —— 它是唯一一个搬走的"local wrapper 函数本身又依赖另一个 local wrapper"的案例。
  - **新增 `src/state/stateHydration.test.js`（10 个测试）**——专门覆盖：相对路径 / 嵌套相对路径 / 绝对路径 / 空路径四种 workspacePath 输入、hydrateState 走完整流水线时相对路径仍然解析、legacy "How to use Melo" 项目过滤逻辑、createDefaultState 形状、normalizeChat 最小输入 + viz/citations/metadata 保留。
- 为什么：
  - byte-for-byte 规则的盲点：防"顺手简化"，但防不了"看漏一个间接绑定"。原 desktopStore 里 `function sanitizeWorkspacePath(rawPath) { return sanitizeWorkspacePathRaw(rawPath, APP_ROOT); }` 只 4 行，搬迁时眼睛漏过去了，结果直接 import 了底层 `sanitizeWorkspacePathRaw`（2-arg）当成 `sanitizeWorkspacePath` 用——源代码看起来 byte-identical 但语义破了。
  - 这次修复 + 测试覆盖应该让相同类型的 bug 在未来被立刻抓到（任何人改了 normalizeProject 都会踩到 relative-path 的回归测试）。
  - audit 提供了对 commits 1-6 的信心：它们都没有同类盲点。
- 产出 / 提交哈希：`a6c1802`（A 评级，180K tokens，0 critical findings）
  - `src/state/stateHydration.js`：恢复 local `sanitizeWorkspacePath` wrapper（4 行）+ normalizeProject 改用它
  - 新增 `src/state/stateHydration.test.js`（10 个回归测试，全绿）
  - 回归：services + desktopStore + search + state 套件 303/303；跨域 583/583 全绿

## 2026-04-26 00:25 — Phase 7d-5α-A1 (Commit 7/9)：抽出 stateHydration 簇（hydrate 流水线 + 5 个伴随符号）

- 做了什么：把 desktopStore 里 state-hydration 流水线 + 它依赖的所有 desktopStore-local 符号一次性搬到新建的 `src/state/stateHydration.js`：
  - 4 个 hydrate 函数：`hydrateState` / `hydrateChatThreads` / `createDefaultState` / `threadCheckpointMatches`（后者 hydrateChatThreads 私有）
  - 2 个 normalize 函数：`normalizeChat` / `normalizeProject`（local wrapper，绑定 sanitizeWorkspacePath/APP_ROOT/defaultProjectTime 给 projectService）
  - 1 个内部 helper：`buildThreadMemorySummary`（normalizeChat 私有）
  - 4 个常量数据：`BUILTIN_CONNECTORS` / `defaultProjectTime` / `LEGACY_EXAMPLE_PROJECT_ID` / `LEGACY_EXAMPLE_PROJECT_NAME`
  - 顺手清掉了 desktopStore 里的 `ONE_DAY_MS` 死 const（仅 defaultProjectTime 一个 caller，已随之迁移）
- 关于 byte-for-byte 的一处机械适配：`APP_ROOT` 在原 desktopStore.js 里是 `dirname(dirname(fileURLToPath(import.meta.url)))`（自身在 src/ 下），新模块在 src/state/ 下深一层，需多 wrap 一次 `dirname(...)` 才能算出**相同**的目录。**值完全一致**，仅公式形态有 1 个 dirname 的差。文件头注释明确标注了这个适配点。
- 为什么：
  - hydrateState 是 readStateSnapshot 调用的 4 个核心 helper 之一（commit 9 stateStore 必须能 import 它）。
  - normalizeChat 在 desktopStore 里有 5 个调用点，但**只有 hydrateState/hydrateChatThreads 这两个会进入 stateStore 的同侧调用链**——其它 3 处（chat-record builder + telegram + discord）后续可保持现状再 import。
  - BUILTIN_CONNECTORS 是 createDefaultState 的硬依赖，它有 5 个外部 caller 在 desktopStore，全部改成 import from stateHydration.js（而不是单独建 builtinConnectors.js 增加文件数）。
  - 所有外部 deps 已经在 src/memory/、src/services/、src/state/agentProfiles.js 等 leaf 模块——零循环。
- 产出 / 提交哈希：未提交
  - 新增 `src/state/stateHydration.js`（~430 行含注释，9 个 export）
  - `src/desktopStore.js` 净减约 380 行（11 处定义被替换成短注释 + 加 8 行 import 块）
  - 回归：services + desktopStore + search + state 套件 293/293；跨域 583/583 全绿

## 2026-04-25 23:55 — Phase 7d-5α-A1 (Commit 6/9)：抽出 mergeDiskSkillsIntoState

- 做了什么：把 `mergeDiskSkillsIntoState`（41 行）从 desktopStore 搬到新建的 `src/state/diskSkills.js`。byte-for-byte 移植。
- 为什么：
  - `mergeDiskSkillsIntoState` 是 `readStateSnapshot` 调用的 4 个 helper 之一（commit 9 stateStore 必须能 import 它）。
  - 它的 3 个 deps（`loadSkillsFromDisk` / `BUILTIN_SKILLS` / `normalizeCustomSkill`）全部已在外部模块（agents/skillsDisk.js + services/skill/skillService.js），是真正的纯叶子。
  - 在 desktopStore 里另有 1 个外部 caller `reloadDiskSkills`（用户手动"重新扫描磁盘技能"按钮）—— 这个 caller 现在 import from diskSkills.js。
- 产出 / 提交哈希：`c332b07`
  - 新增 `src/state/diskSkills.js`（~65 行含注释，1 个 export）
  - `src/desktopStore.js` 净减约 39 行
  - 回归：services + desktopStore + search + state + agents 套件 434/434；跨域 images+tools+media+memory+openai 全绿

## 2026-04-25 23:35 — Phase 7d-5α-A1 (Commit 5/9)：抽出 memorySnapshot 簇（最大单个 commit，~400 行）

- 做了什么：把 desktopStore 里 memory-snapshot 流水线一次性搬到新建的 `src/state/memorySnapshot.js`：
  - `syncMemoryStoreSnapshot`（7 行 — 入口，写错就 console.warn 不阻塞）
  - `buildMemoryStoreEntries`（**384 行** — 把 state 转换成 memory store 行的核心逻辑）
  - `buildSpeakerMemoryNamespace`（10 行 — 为 Telegram/Discord 用户生成命名空间）
- 为什么：
  - `syncMemoryStoreSnapshot` 是 `persistStateAtomically` 调用的 3 个 helper 之一（commit 9 stateStore 必须能 import 它），所以这步是 stateStore 移动的 prerequisite。
  - `buildMemoryStoreEntries` 是 `syncMemoryStoreSnapshot` 唯一的内部 caller，必须一起搬。
  - `buildSpeakerMemoryNamespace` 在 `buildMemoryStoreEntries` 里被用，同时在 desktopStore 还有 3 个 caller（都在 `buildAgentMemoryNodeContext` 内，那是未来 7d-5γ 的 work）。这 3 个 caller 现在 import from memorySnapshot.js。
  - 这 3 个函数所有外部 deps 都已可达：`replaceMemories` / `extractSpeakerFacts` / `getSpeakerFactStorageKey` / `enabledTiers` / frame+scene helpers / `messageVisibleText` / `messageSearchText` / `messageTextForContext`（commit 3 已搬）/ `normalizePromptHistory` / `normalizeApprovals` / `normalizeTasks` / `allAgentIdsFromProfiles` / `normalizeAgentProfile` / `summarizeAgentPrompt` / `normalizeAgentStorageId` / `nowIso` / `normalizeExtractedMedia` / `memoryKindForExtractedMedia`。零循环。
- 产出 / 提交哈希：`f0b528e`
  - 新增 `src/state/memorySnapshot.js`（~430 行含注释，3 个 export，最大单 commit）
  - `src/desktopStore.js` 净减约 401 行
  - 回归：services + desktopStore + search + state 套件 293/293；跨域 583/583 全绿（首次合并跑出现 2 个 flaky 失败，单独跑全绿，确认非本次 commit 引入——是已知的跨套件状态串扰问题，与 memory-isolation.test.js 共用 ~/.melo 路径有关）

## 2026-04-25 23:10 — Phase 7d-5α-A1 (Commit 4/9)：persistChatThreads 加入 chatPersistence.js

- 做了什么：把 `persistChatThreads`（19 行）从 desktopStore 搬进上一轮已建立的 `src/state/chatPersistence.js`。byte-for-byte 移植。
- 为什么：commit 3 把 `ensureChatThreadContext` + `buildThreadCheckpointPayload` 都搬到了 `src/state/chatThreadContext.js`，所以 `persistChatThreads` 现在所有 deps 都已外部化（4 个全部可达：`saveThreadCheckpoint` + `pruneThreadCheckpoints` 在 memory/checkpointer.js，另两个在 chatThreadContext.js）。`chatPersistence.js` 现在收纳了完整的"chat → 磁盘 state.json + thread checkpoint"持久化路径。
- 产出 / 提交哈希：`8ab7817`
  - `src/state/chatPersistence.js` 增加 `persistChatThreads` 函数 + 调整文件头注释和 import
  - `src/desktopStore.js` 净减约 17 行（删 1 处定义 + 加 3 行 import）
  - 回归：293/293 + 583/583 全绿

## 2026-04-25 22:55 — Phase 7d-5α-A1 (Commit 3/9)：抽出 chatThreadContext 簇（缓存 + builder + checkpoint payload）

- 做了什么：把 chat-thread-context 相关 9 个符号一次性搬到新建的 `src/state/chatThreadContext.js`：
  - 3 个常量：`MAX_CONTEXT_RECENT_MESSAGES`、`MAX_CONTEXT_MEMORY_MESSAGES`、`MAX_CONTEXT_MEMORY_ITEMS`
  - 6 个函数：`messageTextForContext`、`setChatThreadContextCache`、`getChatThreadContextCache`、`buildThreadContextForChat`、`ensureChatThreadContext`、`buildThreadCheckpointPayload`
  - 全部 byte-for-byte，函数体逐字节复制，仅加 `export` + 文件头注释。
- 为什么：
  - `ensureChatThreadContext` 有 6 个 desktopStore 调用点（persistChatThreads、两个 memory-summary helper、conversation-continuity context builder、chat 执行图入口），是后续 commit 4 (`persistChatThreads`) 和 commit 7 (`hydrateChatThreads`) 都要依赖的 prerequisite。
  - 这一簇内部互调（cache helper ↔ builder ↔ entry），但**对 desktopStore 外部完全无依赖**——所有外部 deps 都已经在 `src/memory/`、`src/services/chat/`、`src/services/message/` 里。零循环风险。
  - `MAX_CONTEXT_MEMORY_ITEMS` 在新模块外还有 1 个 caller（`uniqueMemoryLines`），所以 desktopStore re-import；另两个 const 只在 `buildThreadContextForChat`（已搬走）内用，不需要 re-import。
- 产出 / 提交哈希：`2cc94a8`
  - 新增 `src/state/chatThreadContext.js`（~115 行含注释，9 个 export）
  - `src/desktopStore.js` 净减约 80 行（删 6 处函数定义 + 3 个常量 + 加 9 行 import 块）
  - 回归：services + desktopStore + search + state 套件 293/293；跨域 583/583 全绿

## 2026-04-25 22:30 — Phase 7d-5α-A1 (Commit 2/9)：抽出 serializeChatForPersistence 纯叶子

- 做了什么：把 desktopStore 里 `serializeChatForPersistence`（17 行 pure object reshape）搬到新建的 `src/state/chatPersistence.js`。
- 为什么：
  - 上一轮 Commit 1 chatPruning 拿到 A 评级、零 findings，path A1 范式有效。继续按 leaf-first 顺序推进。
  - `serializeChatForPersistence` 是 `persistStateAtomically` 调用的三个 helper 之一，本身完全无依赖（纯对象 reshape），是这一轮唯一可以独立搬走的。
  - 同 layer 的 `persistChatThreads` 暂时**不**搬——它依赖 `ensureChatThreadContext`（被 6 处调用，跨 chat 域非纯 state-store 范畴），需要一个单独 commit (Commit 3) 处理。
- 调研发现的小幅计划修订：原"7 个 commit"扩展到"9 个 commit"（多出 chatThreadContext 模块、且 chatPersistence 分两次 commit 才完整）。
- 产出 / 提交哈希：`4d81ef4`
  - 新增 `src/state/chatPersistence.js`（~35 行含注释，1 个 export）
  - `src/desktopStore.js` 净减约 14 行（删 1 处定义 + 加 1 行 import）
  - 回归：services + desktopStore + search + state 套件 293/293；跨域 583/583 全绿

## 2026-04-25 22:00 — Phase 7d-5α-A1 (Commit 1/7)：抽出 chatPruning 模块（撤回 cec12c3 错误方向，重做 path A）

- 做了什么：
  - **承认上一轮 cec12c3 走错了方向**（Codex 评级 C，说"export 不能消除 desktopStore↔runner 循环依赖"）。
  - 用户选 path A1 稳扎稳打方案：把 state-machine 真搬到 `src/state/` 下的独立叶子模块，每个 commit 处理一个聚类。
  - **本 commit 是 7 个 commit 中的第 1 个**：把 4 个 chat-pruning 相关符号全量搬出 desktopStore 到新建的 `src/state/chatPruning.js`：
    - `MAX_RECENT_CHATS`（const）
    - `oldestUnlockedChat`、`pruneExcessChats`、`assertCanCreateChat`（function）
  - byte-for-byte：所有函数体逐字节移植，仅加 `export` 关键字 + 文件头注释。
  - desktopStore 现在通过 `import` 引用，4 个调用点零改动。
- 为什么：
  - chatPruning 是 readStateSnapshot 的间接 dep（startup 自动 prune 用到）。把它先搬出去是后续真正抽 stateStore 的前置工作之一。
  - 选它做第 1 个 commit 是因为它是真正的纯叶子——`oldestUnlockedChat` / `pruneExcessChats` / `assertCanCreateChat` 之间互相调用，但**对 desktopStore 外部无任何依赖**（只摸 `state.chats` + `MAX_RECENT_CHATS` 自身），是 path A1 里风险最低的起手。
- 后续 commit 计划（如果第 1 个评级过：B 及以上）：
  - **Commit 2** `chatPersistence.js`：`serializeChatForPersistence` + `persistChatThreads`（后者需顺带处理它对 `ensureChatThreadContext` 的依赖）
  - **Commit 3** `memorySnapshot.js`：`syncMemoryStoreSnapshot`
  - **Commit 4** `diskSkills.js`：`mergeDiskSkillsIntoState`
  - **Commit 5** `stateHydration.js`：`hydrateState` + `hydrateChatThreads` + `createDefaultState`
  - **Commit 6** `markdownSync.js`：`importAgentMarkdownFiles` + `queueAgentMarkdownPrime`
  - **Commit 7** `stateStore.js`：quartet (load/save/updateAtomically/persist/readSnapshot) + queue + markdownSynced。在这一步同时清理 cec12c3 留下的 5 个死 export。
- 产出 / 提交哈希：未提交
  - 新增 `src/state/chatPruning.js`（~50 行，4 个 export）
  - `src/desktopStore.js` 净减约 35 行（删 4 处定义 + 加 6 行 import 块）
  - 回归：services + desktopStore + search + state 套件 293/293；跨域 583/583 全绿
  - 这次没加新测试——纯位置迁移，行为已被现有 desktopStore 测试覆盖

## 2026-04-25 21:30 — Phase 7d-5α：暴露 state-machine helpers 为后续 elephant 移植铺路

- 做了什么：在 `src/desktopStore.js` 给 5 个 state-machine 关键函数加 `export` 关键字（`loadState`、`saveState`、`updateStateAtomically`、`findProjectById`、`ensureSelectedEntities`）。**纯加 export，不动一行逻辑**——严格符合 CLAUDE.md §5 byte-for-byte 规则。
- 为什么：上一轮调研 elephant (`runChatAgentExecutionGraph` 517 行) 发现它依赖 17 个 desktopStore-local 符号，其中最核心的是 state-machine 锁（`saveState` 等）。要让 elephant 真正搬到 `src/services/chat/chatGraphRunner.js`，必须先消除"被搬走的代码反过来 import desktopStore"造成的循环依赖风险——而消除循环依赖的 byte-for-byte 安全方式就是先 export 现有函数。同时调研中发现：原以为是 elephant 阻塞物的 `createStateGraph` / `runStateGraph` / `GRAPH_END` 已经在 `src/agentGraph.js` 是独立模块（之前历史改造已完成），所以原本 7d-5β 计划已经无效，这一步直接合并掉。
- 7d-5 后续路线（不做即决断，留给用户）：
  - **7d-5γ**：把 desktopStore 里 ~10 个 prompt/context helper 一次性搬出去（`buildChannelRoutePrompt`、`buildToolRoutingPrompt`、`buildAgentMemoryNodeContext`、`buildMatcherContextFromChat`、`buildProjectContextSection`、`summarizeConnectorPrompts`、`summarizeSkillsPrompts`、`buildDynamicContext`、`formatSessionMemoryBlock`、`formatModelMessageForVisionDebug`）。
  - **7d-5δ**：终于可以 byte-for-byte 搬 `runChatAgentExecutionGraph` + `sendChatMessage` + `planChatGraphAction` + `runTaskAgentExecutionGraph`。
- 产出 / 提交哈希：未提交
  - 5 处 `export` 添加（共增 ~12 行注释 + 5 个 export 关键字）
  - 回归：services + desktopStore + search + state 套件 293/293；跨域 images+tools+media+memory+agents+openai 583/583 全绿
  - 这次不增加新测试——纯增加可见性的改动不会改变行为，原有测试已经覆盖这些函数的行为。

## 2026-04-25 19:30 — Phase 7d-2：抽出 systemPrompt（chatExecutionService 拆解 ②/N）+ 首条 byte-for-byte 移植规则落盘

- 做了什么：
  - **CLAUDE.md §5 新增 "byte-for-byte 移植" 硬规则**：第一刀必须逐字节移植，不允许顺手简化。规则配套 5 步流程（移植 → 写测试 → 删原位 → 跑回归 → 后续可选独立简化 commit）。这条规则的契机是 7d-1 中我把 `IMAGE_FOLLOW_UP_PATTERN` 的 `\b` 顺手丢掉，制造了 `photography` 误匹配的真实回归。
  - **Phase 7d-2 抽 systemPrompt**：新建 `src/services/chat/systemPrompt.js`，把 `buildReActSystemPrompt` + 它依赖的 5 个 helper（`summarizeAgentPrompt`、`buildConversationFormattingRules`、`buildOutputHardConstraints`、`detectInputLanguage`、`buildLanguageConstraint`）整体搬走。**全程 byte-for-byte**，移植过程中自查发现 2 处偏差（`buildLanguageConstraint` 末两行换序了 + Write 工具把 `\uXXXX` 转义成 literal CJK 字符；前者立即修正，后者因 RegExp 编译后语义等价而保留并在 commit message 里说明）。
  - desktopStore 只保留 3 个内部还在用的符号：`summarizeAgentPrompt`（行 1431 chat-record builder 处用）、`buildLanguageConstraint`（行 5649 chat 执行图）、`buildReActSystemPrompt`（行 5635 + 5994 两处执行图）。其余 3 个（formatting/hardConstraints/detectInputLanguage）在 desktopStore 没有 in-module caller，没回 import。
- 为什么：
  - 7d-2 是 chatExecutionService 拆解的第二步，承接 7d-1 messageBuilder 的范式。系统 prompt 的 6 个 helper 都是纯函数、唯一输入是 profile / config / 文本片段，完全无状态依赖，直接搬最干净。
  - byte-for-byte 规则是 7d-1 上次回归的直接产物——这次 7d-2 全程严格遵守，过程中 2 处偏差自查就抓回来了，证明规则在生效。
- 产出 / 提交哈希：`ffc477a`
  - 新增 `src/services/chat/systemPrompt.js`（~210 行，6 个 export，**byte-for-byte 港**）
  - 新增 `src/services/chat/systemPrompt.test.js`（25 个单元测试全绿，专门覆盖语言检测的 6 大语种 + buildLanguageConstraint 行序回归 + buildReActSystemPrompt 的 base/empty-block/intent-flag/remote-flag 行为）
  - `CLAUDE.md` 新增 §5 "byte-for-byte" 规则（用户随后又增加 §4 D/C/B/A/S 评分规则，组合在一起形成 7d 后续工作的双重约束）
  - `src/desktopStore.js` 净减约 195 行（8355 → 8169）
  - 回归：services + desktopStore + search + state 套件 293/293（增量 27 个新测试）；跨域 images+tools+media+memory+agents+openai 583/583 全绿

## 2026-04-25 19:03 — 增加 git pp 后 D/C/B/A/S 质量评估 gate + codex.md 改本地派生

- 做了什么：
  - 新增 `EVALUATION.md`，把 Claude 代码评估拆成 `D / C / B / A / S` 五档，并明确 `C` 或 `D` 时必须停止继续改写，先按 Codex 意见重新给出方案让用户判断。同步更新 `CLAUDE.md` §4 和 `scripts/codex-review.sh`，让每次 `git pp` 后的 Codex review 都强制输出质量评级、风险等级和必要的 Claude 整改意见。
  - **`codex.md` 改为本地派生产物**：加进 `.gitignore`、`git rm --cached` 移出版本管理。CLAUDE.md §2 补充新会话开局先跑 `npm run progress:codex` 即可。这是 7d-2 review 抓到的 ⚪-tier 工作流缺陷的处理——任何提交进 git 的 codex.md 都至少落后 1 个 commit（无法引用自己所在的 commit hash），review 工具会反复误判"快照陈旧"。
- 为什么：
  - 用户要求每次 `pp` 后不只是审查，还要形成可执行的质量判断；当效果只到 `C` 时，不能让 Claude 继续沿着可能错误的方向写，而是先让 Claude 基于 Codex 的思路重出方案，再由用户决定是否重写。
  - codex.md untrack 顺便消除每次 PROGRESS 更新都要 churn 一次 codex.md 的两步 commit 浪费——backfill commit 现在只动 PROGRESS.md。
- 产出 / 提交哈希：`1f636e2`

## 2026-04-25 00:20 — Phase 7d-1：抽出 messageBuilder（chatExecutionService 拆解 ①/N）

- 做了什么：开启 Phase 7d（chatExecutionService 大重构）的第一个子阶段。新建 `src/services/chat/messageBuilder.js`，把 desktopStore 里"chat → model-ready messages" 的整条纯函数流水线搬出来：
  - 6 个函数：`messageToModelContent`、`modelRichMediaAttachments`、`followUpPatternForSourceMessage`、`shouldCarryForwardRecentMedia`、`mergeRichMediaContextIntoMessage`、`stripHistoricalRichMediaFromMessage`、`buildModelMessagesFromChat`（entry point）+ `summarizeAttachmentsForPrompt`
  - 9 个常量：`MODEL_{IMAGE,AUDIO,VIDEO,LINK}_ATTACHMENT_PATTERN`、`RICH_MEDIA_ATTACHMENT_KINDS`、`{IMAGE,AUDIO,VIDEO,LINK}_FOLLOW_UP_PATTERN`
  - 顺便清掉了 dead code `modelImageAttachments`（定义但从未被调用）
  - desktopStore 通过 `export { buildModelMessagesFromChat }` re-export 保持公共 API 不变；server.js 零改动
- 为什么：
  - 7d 是整个解耦任务最大的一块（chat execution graph + 发送流水 + tool 编排），按"最纯函数先抽"的 strangler 策略拆成多个子阶段。先抽 messageBuilder 是因为它纯函数、无状态依赖、自成闭包，也是 7d 后续子阶段（system prompt assembly / graph runner / sendChatMessage）都要依赖的上游。
  - 带来的好处：这套"chat → 模型消息窗口"的逻辑（compact 边界、token 窗口、rich media carry-forward、历史媒体剥离）之前**零测试覆盖**；现在有 23 个单元测试锁住每条边界（file:// 丢弃 / data: URI 保留 / 4-turn 距离上限 / URL 去重 / group chat senderName 前缀 / compact 边界之前的消息被跳过 等等）。
  - 过程中发现自己一开始的"简化重写"悄悄改了行为（intro text 回退语 / `audio_attachment` 嵌套结构 / "Additional attachments:" 标签 / 单 text-part collapse），**回退成了字节级忠实移植**。未来 7d 其它子阶段必须继承这条纪律。
- 产出 / 提交哈希：`8c387a4`
  - 新增 `src/services/chat/messageBuilder.js`（~280 行含注释，17 个 export）
  - 新增 `src/services/chat/messageBuilder.test.js`（23 个测试全绿）
  - `src/desktopStore.js` 净减 **269 行**（原 8527 → 现 8258），这是 Phase 7 所有子阶段里最大的一次瘦身
  - 回归：services + desktopStore + search + state 套件 266/266；跨域 images+tools+media+memory+agents+openai 583/583 全绿

## 2026-04-24 23:45 — Phase 7c：抽出 agentProfileService 纯逻辑核心（desktopStore 解耦 ③/④）

- 做了什么：新建 `src/services/agent/agentProfileService.js`，提取 `updateAgentProfile` / `createCustomAgent` 里的三块纯逻辑：
  1. `normalizeAgentUpdatePatch(rawPatch)` — identity/soul 别名消歧（`identify` → `identity`、`soul.md`/`soul` → `soulMd`），把 raw channels 从 patch 里抽出来单独返回（防止绕过下面的 stale-draft guard）。
  2. `mergeChannelsWithStaleDraftGuard(incomingRaw, persistedRaw)` — 防止 UI 端"空 draft"误覆盖已持久化的 channel 配置的核心逻辑（参考 `feedback_preserve_user_config.md`）；service 里的版本接受 persisted 作为参数，成为一个无状态纯函数。
  3. `buildNewCustomAgent(existingProfiles)` — 分配下一个 custom agent id + 拼装默认 profile 种子。
- 为什么：
  - 这三块逻辑之前是 `updateAgentProfile` 240 行大函数里最复杂也最容易出错的部分，出过至少一次生产事故（channel token 被 `undefined` spread-merge 静默擦掉）。搬到独立模块 = 可独立跑 18 个单元测试验证每条规则（别名优先级、空 draft 检测、voiceReply 单独作为 user config 等），覆盖度远胜原先"只在集成流程里偶然执行到"。
  - 保留在 desktopStore 的部分：`updateStateAtomically` 原子写 + `writeMarkdownFile` 文件 I/O + UI settings 突变 —— 这些需要 state-machine 锁 + 副作用编排，不是 service 该碰的。
  - `testAgentChannelConnection` 留给后续 channel-specific service，不在 7c 范围。
- 产出 / 提交哈希：`7250cd7`
  - 新增 `src/services/agent/agentProfileService.js`（~180 行含注释，3 个 export）
  - 新增 `src/services/agent/agentProfileService.test.js`（18 个单元测试，全绿，专门覆盖别名优先级 + stale-draft guard 边界）
  - `src/desktopStore.js` 精简：`updateAgentProfile` 头部约 100 行 inline 逻辑 → 3 行 service 调用；`createCustomAgent` 中间 ~20 行 → 1 行 `buildNewCustomAgent`
  - 回归：services + desktopStore + search + state 套件 242/242；跨域 images+tools+media+memory+**agents** 583/583 全绿

## 2026-04-24 23:00 — Phase 7b：抽出 workspaceService（desktopStore 解耦 ②/④）+ 强化 review prompt

- 做了什么：
  - **Phase 7b**：把 `readWorkspaceFilePreview` / `saveWorkspaceFile` / `applyArtifactToWorkspaceFile` 的业务逻辑抽到新模块 `src/services/workspace/workspaceService.js`。服务只做 I/O + 输入校验（读/写主动通过 DI 可被 mock），**不碰 state 突变**——UI 状态（selectedFilePath / activeMode / project.updatedAt / saveState）由 desktopStore 的 wrapper 在同一份 state 快照上完成，避免 double-load。`selectWorkspaceFile` 留在 desktopStore 不动（纯 UI 状态突变，不属于 workspace I/O）。
  - **Review prompt 强化**：之前 Codex 在 21K tokens 里跳过 `git show` 直接结论。把 prompt 改成**强制 4 步探索**（git log → git diff --stat → 逐 commit `git show` → 按需聚焦），并把"不能跳过"、"必须看每个 commit" 写成硬性规则；调整输出格式要求更严格（总评必须三选一、每条发现带文件:行号）。
- 为什么：
  - Phase 7b 延续 7a 的低风险范式，继续给 desktopStore 瘦身；同时完善 `src/services/workspace/` 下的层次结构（底层 `workspaceFiles.js` 是原语，新增的 `workspaceService.js` 是 orchestration，职责分层清晰）。
  - Review prompt 要对得起 "每次 push 强制 review" 这条 CLAUDE.md §1 规则——上次那份输出只看了最后一个 commit，起不到跨 commit 把关的作用。
- 产出 / 提交哈希：
  - `33aba21` refactor(workspace): extract workspaceService from desktopStore (Phase 7b)
  - `0f7d2af` tune(codex-review): force explicit git log + per-commit git show walk
- 细节：
  - 新增 `src/services/workspace/workspaceService.js`（~110 行，3 个 export）
  - 新增 `src/services/workspace/workspaceService.test.js`（12 个单元测试，全绿）
  - `src/desktopStore.js` 3 个 wrapper 改薄（原 61 行 → 38 行）
  - `scripts/codex-review.sh` prompt 大改（强制探索步骤 + 硬性规则 + 严格输出格式）
  - 回归：services+desktopStore+search 套件 224/224；跨域 images+tools+media+memory 442/442 全绿

## 2026-04-24 22:10 — Phase 7a：抽出 searchService（desktopStore 解耦 ①/④）

- 做了什么：把 `streamSearchFileGroups` / `streamSearchFileHits` 的 orchestration 搬到新模块 `src/services/search/searchService.js`，工作区解析通过 `deps.resolveWorkspace` 注入。desktopStore 保留同名 export 作为 8 行薄壳，只负责把 `loadState → ensureSelectedEntities → findProjectById → buildWorkspaceSnapshot` 组装成 resolver 传进去。常量 `MAX_SEARCH_FILE_GROUPS` / `MAX_LINES_PER_FILE_GROUP` 一并迁移，外加清掉了从未被调用的 `streamWorkspaceContent` 导入。
- 为什么：desktopStore.js 8792 行 / 59 export，是当前架构最大的瓶颈。按照"低风险高信噪比先做"的分阶段策略，search 是最小入口（只 2 个 export、0 个现成测试、下游只有 server.js 1 个调用点），用来沉淀抽服务的范式：DI 边界 + 薄壳 re-export + 独立单元测试。下一步做 workspaceService，再做 agentProfileService。
- 产出 / 提交哈希：`8c03a68`
  - 新增 `src/services/search/searchService.js` + `searchService.test.js`（9 个独立测试，全绿）
  - `src/desktopStore.js` 精简 ~55 行（3351–3417 + 两个常量 + 1 个未用 import）
  - 回归：services/search/desktopStore 套件 212/212；跨域 images+tools+media+memory 442/442 全绿



- 做了什么：新增 `scripts/sync-codex-progress.js` 与 `npm run progress:codex`，从 `PROGRESS.md`、git 状态和最近提交自动生成仓库根目录 `codex.md`。
- 为什么：让 Claude / Codex 后续会话只读一个快照文件就能快速接续，减少跨会话上下文丢失。
- 产出 / 提交哈希：`3fcbdea`

## 2026-04-24 21:30 — 首次远程推送 + 工作协议落盘

- 做了什么：配置 `origin = github.com/MortredVigoss/Melo`，把三个积压阶段压成 3 个 commit 全量推送到 `origin/master`（首次推送）。
- 为什么：CLAUDE.md §1 要求每个 ≥1h 工作块 push；之前一直没有 remote 所以积压了多个未推送的修复。
- 产出 / 提交哈希：
  - `5f128c6` fix(audio): transcription soft-fallback + codex env-backed mode
  - `8fb3cf9` fix(image): add instructions field required by /codex/responses
  - `f87c06c` chore: add CLAUDE.md working protocol + PROGRESS.md timeline

## 2026-04-24 20:00 — 修复图片生成 HTTP 400

- 做了什么：给 `src/images/codexImageEngine.js` 的请求体加上 `instructions` 字段，满足 `/codex/responses` 的硬性要求；加 debug log 定位到根因；加回归测试锁住字段。
- 为什么：之前所有画图请求都在 300–600ms 内被 400 拒掉，模型在对话里编造"等了 180 秒"并让用户保存 SVG——掩盖了真实失败。
- 产出 / 提交哈希：`8fb3cf9`

## 2026-04-24 19:00 — 修复 4 处历史测试失败

- 做了什么：`audioExtractor.js` 加 codex-env-fallback 和 whisper-unavailable 软降级；`openai.js` 去掉 audio_attachment 的 `[Audio attachment: …]` 占位符。
- 为什么：测试套件里 4 个 pre-existing failure 阻塞，与本次画图工作无关但同属 codex 路径。
- 产出 / 提交哈希：`5f128c6`（143/143 测试绿）

## 2026-04-24 14:00 — 初始化工作协议

- 做了什么：新建 `CLAUDE.md`（三条硬性规则：满 1h 提交并推送、`PROGRESS.md` 状态看板、2 页阈值自动摘要压缩）与本 `PROGRESS.md`。
- 为什么：建立跨会话的稳定工作节奏和可追溯性，防止长任务中丢失上下文。
- 产出 / 提交哈希：`f87c06c`
