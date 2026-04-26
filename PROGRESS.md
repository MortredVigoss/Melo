# Melo 进度日志

> 新条目追加在本文件顶部（时间倒序）。
> 当本文件超过 160 行或 8000 字符时，按 CLAUDE.md §3 自动压缩：最旧 70% 归档为一句话摘要，最新 30% 保留完整格式。

---

## 2026-04-26 12:00 — Phase 7d-5β commit 3：抽出 buildDynamicContext（中等复杂叶子，依赖已外部化）

- 做了什么：
  - **新增 `src/services/chat/dynamicContext.js`** —— `buildDynamicContext`（61 行）byte-for-byte 搬走。3 个依赖（`ensureChatThreadContext` from `state/chatThreadContext.js`、`renderThreadContext as renderStructuredThreadContext` from `memory/threadContext.js`、`truncateText` from `shared/helpers.js`）都已经在外部 leaf 模块里，直接 import 即可。
  - **`src/desktopStore.js`**：顶部 import 块加 1 行；删原函数定义（61 行）换成 2 行 stub 注释。两个内部 caller (line ~4479 / ~4956 prepare-node + task-graph) 走 imported name。
- 为什么：commit 1+2 抽完真叶子和单依赖。commit 3 是"中等"——3 个依赖但全部已外部化，不需要先搬其它符号，直接抽走。
- 顺手的 PROGRESS.md 压缩：本次 commit 把 `fix-5/6/7` 三个详细条目（共 ~76 行）移到归档摘要区，只保留 title + 1 句结论 + commit hash。这三个条目对应的修复链已经全部收尾（fix-5→6→7→8 序列闭合），完整版仅在 git history 中需要时可查。
- 回归：services + state + desktopStore + memory + agents 套件全绿。
- 提交哈希：（待 commit）
  - desktopStore: 7128 → 7072（-56 行）

## 2026-04-26 11:30 — Phase 7d-5β commit 2：抽出 buildProjectContextSection（单依赖叶子）

- 做了什么：
  - **新增 `src/services/project/projectContext.js`** —— `buildProjectContextSection`（5 行）byte-for-byte 搬走。它依赖的 `agentUsesTool` 在新模块里直接 `import` from `../agent/agentTools.js`（已经是 leaf）。
  - **`src/desktopStore.js`**：顶部 import 块加 1 行（按 project/ 域排在 connector 后面）；删原函数定义（5 行），换成 3 行 stub 注释。两个内部 caller（line 4464 / 4956）走 imported name 自然链接。
- 为什么：commit 1 抽完 4 个零依赖叶子之后，单依赖（仅依赖一个已 imported 的 leaf）就是下一个最低风险的台阶。`buildProjectContextSection` 不仅短，依赖的 `agentUsesTool` 也已经在 service 模块里了。
- 回归：services + state + desktopStore + memory + agents 套件全绿。
- 提交哈希：（待 commit）
  - desktopStore: 7124 → 7128（+4 是因为 import 块的注释 + import 行多于函数的减量；函数已搬走是关键）

## 2026-04-26 11:00 — Phase 7d-5β commit 1：4 个真叶子 helper 一并 byte-for-byte 抽走

- 做了什么（用户选"4 leaves 合一 commit"）：
  - **新增 4 个 leaf 模块**（每个零 desktopStore-LOCAL 依赖，纯函数）：
    - `src/services/chat/matcherContext.js` — `buildMatcherContextFromChat`（30 行）
    - `src/services/connector/connectorPrompts.js` — `summarizeConnectorPrompts`（6 行）
    - `src/services/skill/skillPrompts.js` — `summarizeSkillsPrompts`（38 行，原 export）
    - `src/services/chat/visionDebug.js` — `formatModelMessageForVisionDebug`（24 行）
  - **`src/desktopStore.js`**：顶部 import 块加 4 行；删 4 处函数定义（~95 行），每处替换为 stub 注释。`summarizeSkillsPrompts` 保留 back-compat re-export（gate 第 9 次 C 抓出来的契约）。
  - **`src/desktopStore.skills.test.js`**：`summarizeSkillsPrompts` import 改成指向新位置作为 canonical 路径（re-export 仍可用）。
- 为什么：
  - 7d-5β 目标是 prompt/context helpers 下沉到 services/。这 4 个是 ZERO LOCAL deps 真叶子，最低风险起手。
  - 用户选"合 commit"——单独 4 commit + 4 gate ROI 不高；一次审 4 个 byte-for-byte port 差异表面清晰。
- 关于第 9 次 C：第一刀里直接删了 `summarizeSkillsPrompts` 的 export，gate 抓到"契约破坏"。fix（用户选 A 路径）：保留 re-export，把"是否清理 dead export"留给将来独立 cleanup commit。
- 回归：services + state + desktopStore + memory + agents 套件全绿；总测试数 ~597（+0 from this commit）。
- 提交哈希：`d056e8d`（commit 1 主体）+ 后续 fixup（保留 re-export，gate 第 9 次 C 修复）
  - desktopStore: 7205 → 7124（-81 行）

## 2026-04-26 10:15 — git pp B-finding 顺手修：commit_count == 0 早退出

- 做了什么：`scripts/codex-review.sh` 在算出 `commit_count` 后立刻判断为 0 则报错"先 `git pull --rebase`"。原流程会先跑一轮 Codex evaluation 再被 `git push` 拒绝，浪费一轮 token。
- 为什么：上一轮 `2c43ec2` 过 gate 时 Codex 评 B 留下的唯一非阻塞建议。CLAUDE.md §4 要求"B 的建议要记录并安排修"——既然已经在 gate-fix 流程里就顺手做掉。
- 提交哈希：`5742e66`

## 2026-04-26 10:00 — git pp 第二轮收紧：显式 refspec push（gate-on-gate-on-gate）

- 做了什么：
  - **`scripts/codex-review.sh`**：把 `@{upstream}` 用 `git rev-parse --symbolic-full-name` 解出全 ref（如 `refs/remotes/origin/master`），bash regex 拆成 `<remote>` + `<remote-branch>`。push 改为 `git push "$remote" "HEAD:$remote_branch"`，绕开用户的 `push.default`。
  - 头部注释同步更新流程描述。
- 为什么：上一轮（`137c9a6`）收紧后再过自己的 gate，被 Codex 评 C：裸 `git push` 受 `push.default` 影响——`matching` 会推**所有同名分支**（含 evaluation 没覆盖的），`current` 可能推到与 `@{upstream}` 不同名的远端 ref。显式 refspec 让 push 目标和 evaluation 范围一一对应，无论用户 git 配置怎么设。
- 没做的：Codex 还建议加一组 shell smoke 测试覆盖 `push.default=matching/current/simple` 等场景。和用户讨论后认为 ROI 不足（gate 自身每次跑都在测自己，两轮 C 已经准确捕获 bug），暂缓。
- 提交哈希：`2c43ec2`
  - `scripts/codex-review.sh`：显式 refspec push

## 2026-04-26 09:30 — git pp 收紧范围：上游必需 + 拒绝额外参数（gate-on-gate 修复）

- 做了什么：
  - **`scripts/codex-review.sh` 重写流程入口**：
    - 拒绝任何 `$@` 额外参数（自定义 refspec / `-u` / `--force-with-lease` 等）。原因：从这些 args 推断"实际将被 push 的 commit 集合"等价于重新实现 push 的 refspec 解析；与其猜，不如显式拒绝并提示用户用原生 `git push` 走手动 review。
    - 强制要求当前分支已有 tracking upstream。无 upstream 时直接报错并提示 `git push -u origin <branch>` 一次性设置。原因：原 fallback `${head_sha}^..${head_sha}` 在首次 push 多个 commit 时只评估 tip，**非 tip 的 commit 静默绕过 C/D 阻断**——Codex 抓到的精确 bug。
    - 把 `base_sha` / `head_sha` / `commit_count` / `short_base` / `short_head` 提到流程顶部解析一次，pre-push gate 和 post-push review **共用同一个 base**，杜绝两阶段 range 漂移。
    - 删除原 post-push 段独立的 base 推断分支（${head_sha}^ fallback、`base_sha == head_sha` 早返回、reachability 检查）——这些在新流程下都已经在顶部一次性处理。
    - `git push` 不再转发 `$@`，固定为"当前分支 → upstream"。
  - **`CLAUDE.md` §1**：在 `git pp` 条目下补一段"适用范围"，明文说明 upstream 必需 + 不接受额外参数，并指引边角场景用原生 `git push` + 手动 `codex review`。
- 为什么：`f4bc254`（pre-push gate 启用 commit）首次跑就被自己的 gate 评 C 阻断——发现 fallback 路径在首次 push 场景下会漏审非 tip commit，pre/post 两阶段还共用了不同的 base 推断逻辑。修复直接砍掉边角分支，把 gate 适用域收窄到"有 upstream 的当前分支正常推送"，宁可显式拒绝也不要静默漏审。
- 提交哈希：`137c9a6`
  - `scripts/codex-review.sh`：refuse-args + require-upstream + 共用 base
  - `CLAUDE.md`：§1 补适用范围说明

## 2026-04-26 09:00 — Phase 7d-5α-A1 fix-8：applyMemoryStoreSchema 返回 vecAvailable（第 8 次 C 评级修复）

- 做了什么：
  - **`src/memory/store.js`**：`applyMemoryStoreSchema(database, vecLoaded)` 改为返回 `{ vecAvailable }`。`vecAvailable` 反映 `CREATE VIRTUAL TABLE vec_memories` 实际是否成功（用 `SELECT 1 FROM sqlite_master` 验证表存在；`IF NOT EXISTS` 在某些 sqlite-vec 构建上会静默吞掉 "module not found"）。
  - **`getDb()`**：用返回值的 `vecAvailable` 决定 `_vecLoaded` 是否回退到 false——替换原来的"先 apply、再单独跑 SELECT 验证"两步逻辑（语义不变，避免重复 SQL）。
  - **`withDisposableStoreAt()`**：把返回的 `vecAvailable` 传给 `work(tempDb, vecAvailable)`，**而不是**之前传入的 `vecLoadedHere`（loadExtension 成功标志）。Codex fix-7 review 抓到的精确 bug：disposable handle 上即使 extension 加载成功，CREATE VIRTUAL TABLE 仍可能失败，下游 `_runReplaceMemoriesOn` 用旧的 `vecLoadedHere` 准备 INSERT/DELETE 语句，会 prepare 不存在的 `vec_memories` 表崩溃。
  - **`src/state/stateLoadContextChain.test.js` fix-7 测试加固**：除 store.sqlite 文件存在 + home B 不存在两个断言外，新增直接打开 home A 的 sqlite，`SELECT id, namespace, text FROM memories WHERE namespace = 'chat:CHAT_ID' AND id LIKE 'message:chat:CHAT_ID:%'` 验证消息内容真的写进了 memories 表。文件存在不等于行写入——schema apply 静默失败的话仍可能落出空 db。
- 为什么：第 8 轮 C 评级的发现："applyMemoryStoreSchema 捕获 vec_memories 建表失败后没有把 vecLoadedHere 降为 false，work(tempDb, vecLoadedHere) 仍会让 _runReplaceMemoriesOn 在 store.js:1135 prepare 不存在的 vec_memories"。把"是否真正可用"作为函数返回值——而不是依赖外层副作用（如 SELECT 验证再回写 _vecLoaded）——杜绝下游误用。
- 回归：`stateLoadContextChain.test.js` 3/3 绿；memory + state 套件 324/324 绿。
- 产出 / 提交哈希：(待提交，gate 决定能不能 push)
  - `src/memory/store.js`
  - `src/state/stateLoadContextChain.test.js`

## 归档摘要（2026-04-26 04:30 之前的所有条目）

> 按 CLAUDE.md §3 自动压缩：每条仅保留标题 + 一句话结论 + commit hash。完整原始条目见 git history (`git log --follow -p PROGRESS.md`)。

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
