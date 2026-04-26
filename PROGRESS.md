# Melo 进度日志

> 新条目追加在本文件顶部（时间倒序）。
> 当本文件超过 160 行或 8000 字符时，按 CLAUDE.md §3 自动压缩：最旧 70% 归档为一句话摘要，最新 30% 保留完整格式。

---

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

## 2026-04-26 06:30 — Phase 7d-5α-A1 fix-6：StateLoadContext 贯穿全 chain（结束 6 轮 isolation 修复）

- 做了什么（用户选 (i) — 把 home 升格为 first-class context object，贯穿整个 state I/O 子系统）：
  - **checkpointer.js**：`loadThreadCheckpoint` / `saveThreadCheckpoint` / `pruneThreadCheckpoints` / `deleteThreadCheckpoint` / `invalidateThreadCheckpointCache` 全部接受可选 `{ threadsDir }` 参数。提供时使用显式目录；不提供时 lazy 解析（向后兼容）。
  - **缓存改 by-dir 索引**：原 `checkpointCacheByHome`（以 `getMeloHome()` 为 key）改为 `checkpointCacheByDir`（以 resolved threadsDir 为 key）。bucket 与磁盘路径 1:1 对应——不会再发生"buck 命中但磁盘指向另一个目录"。
  - **stateHydration.js**：`hydrateChatThreads(state, { threadsDir? })` 接受参数，贯穿到内部的 `loadThreadCheckpoint` 调用。
  - **chatPersistence.js**：`persistChatThreads(chats, { threadsDir? })` 接受参数，贯穿到 `saveThreadCheckpoint` + `pruneThreadCheckpoints`。
  - **stateStore.js — 核心整合**：
    - `captureLoadContext()` 扩展为 `{ home, stateFilePath, threadsDir, getAgentMarkdownPaths }`
    - `readStateSnapshot` 一次性捕获 ctx，把 `threadsDir` 传给 `hydrateChatThreads`，把整个 `ctx` 传给 `saveState`（用于 repair-save）
    - `saveState({ ctx? })` 和 `persistStateAtomically({ ctx? })` 接受 ctx 选项；如果有就用 ctx 的 `stateFilePath` + `threadsDir`，否则 lazy fallback（保留 `capturedStatePath` 兼容老调用方但不推荐）
  - **新增 `src/state/stateLoadContextChain.test.js`（2 个测试）**：
    1. `readStateSnapshot: thread checkpoint reads honor the home captured at the top of the load chain` —— 在 home A 和 home B 各放一份**相同 chat id 不同内容**的 checkpoint，readStateSnapshot 启动后立即切 env，断言 hydrate 回来的 chat.messages 是 home A 的内容。这是抓 fix-5 漏掉的"hydrateChatThreads 跨 home 串读"的精确回归测试。
    2. `readStateSnapshot repair-save: thread checkpoint writes land in the captured home` —— state.json 有 chat with inline messages（触发 hydration 修复 + repair-save），启动 load 后切 env，断言 home A 的 threads/ 收到 checkpoint 文件、home B 的 threads/ 保持空。
- 为什么：6 次 C 评级的核心信号是**state machine 与 memory 子系统的 home 处理深度纠缠**——单纯逐函数 capture 不够，需要在外层 orchestration 一次捕获、贯穿整个调用 chain 的所有 home-derived 路径。fix-6 把 ctx 作为 first-class 参数传穿了 state I/O 全栈（read + hydrate + repair-save 三条路径）。
- 关于剩余的潜在 leak（已确认不修）：
  - `mergeDiskSkillsIntoState` 走的是 `os.homedir()` 派生的 `SKILLS_DISK_ROOT`，**不读 MELO_HOME**——不属于本类 bug。
  - `memory/store.js` 有自己的 `_resetStoreForTests` API + 缓存 sqlite 句柄，跨 home 切换需要测试主动 reset，不是 fix-6 的范围。
- 产出 / 提交哈希：未提交
  - `src/memory/checkpointer.js`：4 个 op 接受 `{ threadsDir }`，缓存改 by-dir
  - `src/state/stateHydration.js`：`hydrateChatThreads` 接受 `{ threadsDir }`
  - `src/state/chatPersistence.js`：`persistChatThreads` 接受 `{ threadsDir }`
  - `src/state/stateStore.js`：ctx 扩展 + 贯穿 readStateSnapshot 到 saveState
  - `src/state/stateLoadContextChain.test.js`（新，2 tests）
  - 回归：services + desktopStore + state + memory 套件 616/616（+2 from new chain isolation tests）；跨域 281/281 全绿

## 2026-04-26 07:30 — Phase 7d-5α-A1 fix-7：memory store cross-home isolation（pre-push gate 第一次实战）

- 做了什么（f3b0f29 触发的第 7 次 C 评级修复——这次是 memory store sqlite 的 cross-home 串读串写）：
  - **`src/memory/store.js` 大幅重构**：
    - 提取 `applyMemoryStoreSchema(database, vecLoaded)` 私有函数（schema CREATE TABLE + 全部 migrations + vec0 setup）。`getDb()` 调用它。disposable handle 也调用它。
    - 新增 `withDisposableStoreAt(storePath, work)`：开 fresh sqlite handle，跑 schema setup，跑 work，关闭。**不**触碰 cached production handle。
    - 新增 `runInTransactionOn(database, work)`：手动 BEGIN/COMMIT/ROLLBACK 包裹给一个具体 db。disposable path 用它代替 module-level `runInTransaction`（后者通过 `getDb()` 用 cached handle）。
    - `replaceMemories(entries, { storePath })`：当 storePath 提供且 ≠ `_openedStorePath` 时走 disposable path（withDisposableStoreAt + runInTransactionOn）。否则保持原行为（getDb + runInTransaction）。
    - 提取 `_runReplaceMemoriesOn(database, entries, vecLoaded, runTx)`：原 replaceMemories 的 ~80 行 SQL body 抽出，参数化 db + vecLoaded + tx wrapper。
    - **`getCachedEmbedding(text, modelId, database)` 接受 explicit database**（之前 ALWAYS 走 `getDb()`）。passed 时用，否则 fallback。
    - **`resolveCacheModelId(explicit, database)` 也接受 explicit database**——这个是关键：之前 `getCachedEmbedding` 的 db 是 passed 的，但它内部调 `resolveCacheModelId` 而 `resolveCacheModelId` 又调 `getDb()` —— Codex review 4 个 C 评级才把这个 transitive call chain 暴露完。
  - **`src/state/memorySnapshot.js`**：`syncMemoryStoreSnapshot(state, { ctx })` 接受 ctx，forward `ctx.storePath` 给 `replaceMemories`。
  - **`src/state/stateStore.js`**：`captureLoadContext()` 增加 `storePath: join(home, 'desktop', 'store.sqlite')`；`persistStateAtomically({ ctx })` 把 `{ ctx }` 传给 `syncMemoryStoreSnapshot`。
  - **新增 fix-7 回归测试**：`readStateSnapshot repair-save: memory store writes land in the captured home`——构造 home A 的 state.json 含可索引 chat，readStateSnapshot 启动，立即切 env=B，断言 home A 的 store.sqlite 存在、home B 的 store.sqlite **不**存在。在 fix-7 之前会失败（leaked 到 home B），现在通过。
- 关于 pre-push gate 的实战：
  - 用户在 fix-6 commit 之前已经把 `git pp` 改成 push 前先做 Codex evaluation——评 C/D 直接 block push。
  - fix-6 (08cfab3) push 时 review 评 C 但**没被 gate 拦**（旧版 git pp 还是后审）。
  - fix-7 之前的 commit (f3b0f29) push 时 **新版 gate 第一次实战**——pre-push evaluation 直接给 C 并 block 推送。**坏代码没出本地**，证明 gate 工作正常。
  - 所以 f3b0f29 本地有，但远端没有——本次 fix-7 commit 是在 f3b0f29 基础上叠加，最终一并 push。
- 这是连续第 7 次 C，每次都是同一类 home-leak 在更深层：
  1. wrapper bypass (sanitizeWorkspacePath)
  2. path const at module load (lazy resolution)
  3. cache flat key (nested by home → by dir)
  4. async body lazy reads env (capture at queue)
  5. orchestration multi-read (unified outer capture)
  6. hydrate/persist chains (ctx threading)
  7. **memory store cached sqlite handle (disposable path + transitive db threading)**

  关键 lesson：transitive call chain 隔离比想象中难。`getCachedEmbedding(database)` 看起来已经 captured 了，但内部 `resolveCacheModelId()` 又自己调 `getDb()`——helper 之间相互调用时，每一步都要传 db。
- 产出 / 提交哈希：未提交
  - `src/memory/store.js`：~150 行重构（schema 提取 + disposable handle + db 参数 threading）
  - `src/state/memorySnapshot.js`：syncMemoryStoreSnapshot 接受 ctx
  - `src/state/stateStore.js`：captureLoadContext 增加 storePath
  - `src/state/stateLoadContextChain.test.js`：新增第 3 个测试覆盖 memory store
  - 回归：services + desktopStore + state + memory 套件 617/617；跨域 281/281 全绿

## 2026-04-26 05:30 — Phase 7d-5α-A1 fix-5：readStateSnapshot 整体 home capture（CLAUDE.md §6 落到调用链）

- 做了什么（2063d9e 触发的第 5 次 C 评级修复——这次是整体 capture chain 一致性）：
  - `readStateSnapshot` 入口处通过 `captureLoadContext()` **一次性捕获** home + stateFilePath + getAgentMarkdownPaths，整个 load chain 共享这一组捕获值。函数体内部**零 `getMeloHome()` 读取**——所有需要 home 的 helper（`isMarkdownSyncedFor` / `markSyncedFor` / `importAgentMarkdownFiles` / `queueAgentMarkdownPrime` / 修复保存 `saveState`）都接受显式参数。
  - `markdownSyncedByHome` 的 helper 重命名为 `isMarkdownSyncedFor(home)` / `markSyncedFor(home)` —— 接受显式 home 参数而不是各自再读 env。
  - `importAgentMarkdownFiles(state, providedGetAgentMarkdownPaths?)` 和 `queueAgentMarkdownPrime(state, providedHome?, providedGetAgentMarkdownPaths?)` 接受可选的 captured helpers / home。如果不传，函数自己捕获（向后兼容任何同步调用方）。
  - `saveState(state, { capturedStatePath })` 和 `persistStateAtomically(state, { capturedStatePath })` 新增 optional `capturedStatePath` 选项，让 readStateSnapshot 的 repair-save 路径绑死到捕获的 stateFilePath。
  - **强化测试**：原 `importAgentMarkdownFiles` 测试只断言 `main` agent，但 `main` 是循环第一个，路径在第一个 await 之前就解析了——旧 lazy 代码可能假绿。改成断言 `research`（第二个内置 agent，至少在一个 await 之后才解析路径），真正能抓到"async 体内 lazy 读 env"的旧 bug。
  - **新增 `readStateSnapshot wraps the entire load chain in a single home capture` 测试**：调度 readStateSnapshot 之后立即切 MELO_HOME，等 prime microtask flush 完成，断言 home A（捕获的 home）收到所有写入、home B（flip 后的 env）零写入。
- 为什么：CLAUDE.md §6 已经写下了"调度时捕获 env"的规则，但 fix-4 只把规则应用在 markdownSync.js 的两个独立函数上。Codex review 指出**调用链整体的 capture 一致性也是 §6 的范围**——单独捕获每个函数还不够，外层 orchestration 必须给整个 chain 一次性 capture。这次修复把 `readStateSnapshot` 重新定位为唯一 capture 点。
- 这是连续第 5 次 C，每次都是 §6 规则的不同 layer：模块级 const → flag 单例 → 缓存 key → async 体内 lazy → **multi-step orchestration 整体 capture**。
- 产出 / 提交哈希：未提交
  - `src/state/stateStore.js`：`captureLoadContext()` helper、isMarkdownSyncedFor/markSyncedFor 接受 home 参数、saveState/persistStateAtomically 接受 capturedStatePath 选项
  - `src/state/markdownSync.js`：importAgentMarkdownFiles + queueAgentMarkdownPrime 接受 optional captured helpers/home（向后兼容）
  - `src/state/markdownSyncAsyncTiming.test.js`：原测试改成断言 `research` agent；新增 readStateSnapshot full-chain capture 测试
  - 回归：services + desktopStore + state + memory 套件 614/614（+1 from new full-chain test，原 import 测试改强）；跨域 281/281 全绿

## 归档摘要（2026-04-26 04:30 之前的所有条目）

> 按 CLAUDE.md §3 自动压缩：每条仅保留标题 + 一句话结论 + commit hash。完整原始条目见 git history (`git log --follow -p PROGRESS.md`)。

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
