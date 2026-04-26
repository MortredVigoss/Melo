# Melo 进度日志

> 新条目追加在本文件顶部（时间倒序）。
> 当本文件超过 160 行或 8000 字符时，按 CLAUDE.md §3 自动压缩：最旧 70% 归档为一句话摘要，最新 30% 保留完整格式。

---

## 2026-04-26 19:00 — Phase 7d-5δ commit 8b：updateStateAtomically 搬回 state/stateStore.js（§5 carve-out 反转）

- 做了什么：
  - `updateStateAtomically`（13 行）从 desktopStore byte-for-byte 搬到 `src/state/stateStore.js`——它原本就该在那里（和 saveState / persistStateAtomically / readStateSnapshot 一起）。Phase 7d-5α-A1 commit 9 曾因为 ensureSelectedEntities 的 58 callers 把它留在 desktopStore，加了 §5 carve-out + `enqueueStateWrite` 桥梁。commit 8a 把 ensureSelectedEntities 拎到 stateSelections.js，这个 carve-out 失去存在理由。
  - `stateStore.js` 增加 1 行 `import { ensureSelectedEntities } from './stateSelections.js'` + 30 行 byte-for-byte 移植。
  - `enqueueStateWrite` 留 export 但加了备注"now mostly historical, can be retired in cleanup"。
  - `desktopStore.js` import 列表加 `updateStateAtomically`，删 13 行原定义换 4 行 stub。**24 个内部 caller** 全部走新 import。
- 为什么：path B 的精神就是"helper 放在该在的地方"。stateStore 是状态机模块——updateStateAtomically 跟 saveState 共用同一个 module-private queue，住一起最干净。
- 回归：services + state + desktopStore + memory + agents 全套绿（一次小 flake 是已知 store.* 测试 isolation 问题，re-run 全绿）。
- 提交哈希：（待 commit）
  - desktopStore: 5516 → 5501（-15 行）

## 2026-04-26 18:30 — Phase 7d-5δ commit 8a：抽出 ensureSelectedEntities（最大 LOCAL 依赖之一）

- 做了什么：
  - **新增 `src/state/stateSelections.js`** —— `ensureSelectedEntities`（67 行）byte-for-byte 搬走。这个函数对 hydrated state 做"selection coercion"——把无效/已删除的 selectedX 字段回拉到合理默认。所有 7 个上游依赖（normalizeAgentProfiles、sortChats、allAgentIdsFromProfiles、MODE_DEFS、BUILTIN_SKILLS、BUILTIN_CONNECTORS、normalizePromptHistory）都已是 leaf 模块。
  - **`src/desktopStore.js`**：顶部 import 块加 4 行；删 67 行函数定义换 2 行 stub。**58 个内部 caller**全部走 imported name（最大单 commit 的 caller-rewrite 量）。
- 中间小坑：第一稿写错了 sortChats 的 import path（写成 `./chatPruning.js`，实际在 `./conversation.js`）。18 个测试 SyntaxError 即时抓到。教训：**别凭印象写 import path，每次都 `grep export ... <symbol>` 先确认**。
- 关于 sendChatMessage（commit 8 还没结束）：
  - sendChatMessage 实际有 **6 个 LOCAL 依赖**（不止之前估的 4 个）：updateStateAtomically(24 callers) / getDesktopBootstrap(37) / scanRecentChatsForSkillProposals(2) / buildConnectors(3) / refreshChatMemorySummary(6) / isAbortError(2) / extractUrlAttachmentsFromText(2)。
  - 本 commit 把 ensureSelectedEntities 拎出去作为最大 LOCAL 阻塞物的清理（PROGRESS 旧记录说 57 callers，实测 58——这次 grep 正确）。
  - 完整 sendChatMessage 抽取还需要 prep 1-2 个剩余 LOCAL 才安全；本 session 不再继续，下次开局再说。
- 回归：services + state + desktopStore + memory + agents 全套 **723/723 全绿**。
- 提交哈希：`9955870`
  - desktopStore: 5577 → 5516（-61 行；本会话累计 8527→5516 = **-3011 行 = -35.3%**）

## 2026-04-26 18:00 — desktopStore unused-import cleanup（path B 完成后的 housekeeping）

- 做了什么：用 Python 解析 desktopStore.js 的所有 110 个 import 块，对每个 named import 的 local 名字在文件 body（非 import / 非 export-from）中扫一遍。结果：**39 个 block 含未用 symbol**，其中 22 个整块删、17 个 trim 部分。
- 中间小坑（自查 + 测试抓到）：第一版脚本没处理"花括号里夹注释"——`./state/agentProfiles.js` import 块里有几行 `// Phase 7d-5δ commit 5: ...` 注释，注释内容包含"projectAgentOverrideFor"字样。脚本把 `{...}` 里逗号 split 成 names 时，**注释和它后面的真 symbol 被合成一个奇怪的 multiline 字符串**——结果 `projectAgentOverrideFor` 没被识别成独立 name，trim 时被丢掉，14 个测试 ReferenceError。手工把它加回 import 即修。
- **最终保留 desktopStore 完全用得上的 imports**：删了 ~22 个完全死的 import block（agentGraph、tools/registry getTool/getAllTools、retrieval/intentRouter、memory/attic/frame/scene/embeddings/contextCompact/speakerProfile/speakerFacts，等等），trim 了 17 个 block 的部分 symbol（保留还在用的）。
- 为什么：path B 抽走了大象 + 各 helper 后，desktopStore 自身已经不再调用这些函数——但 import 行作为"再 import 回来给将来可能用"的死代码留了下来。Codex 之前评 D 时也提到 unused imports 是干扰项，独立 cleanup commit 比塞进 byte-for-byte 抽取里更干净。
- 回归：services + state + desktopStore + memory + agents 全套 **723/723 全绿**。
- 提交哈希：`46a85b8`
  - desktopStore: 5681 → 5576（-105 行；本会话累计 8527→5576 = **-2951 行 = -35%**）

## 2026-04-26 17:45 — Phase 7d-5δ commit 7d：smoke 测试加 MELO_HOME 隔离（gate 第三次 D + 数据丢失事件 + 恢复）

- **事件**：上一次提交（`7b9662e`）的 smoke 测试**没有隔离 MELO_HOME**。在我本地跑测试的瞬间 `~/.melo/desktop/state.json` 被覆盖成 fixture 内容（15376 字节 → 1582 字节），`store.sqlite` 时间戳也被改写（memory 行很可能被 `replaceMemories` 清空）。Gate 评 D 阻断了 push（commit 没出本地）但伤害**已经在本机发生**。
- **恢复**：
  - 把 fixture 损坏的 `state.json` 重命名为 `state.json.fixture-overwrite-2026-04-26` 留作取证。
  - `cp state.json.bak-20260422-224446 state.json` 恢复 4 天前的备份。`memory store.sqlite` 没备份恢复不了——损失的是过去 4 天产生的 chat / 项目设置变更 + 全部 memory rows（chat 历史里 indexed 的那些）。
- **修复 commit 7c 的测试**：
  - 顶部 `mkdtempSync(tmpdir())` 创建 `melo-chat-runner-test-XXXXX/`，`process.env.MELO_HOME = TEST_HOME` 在 import runner 之前。
  - 用 `await import('./chatExecutionRunner.js')` 动态导入，避免 ESM 静态 import 的 hoisting 在 env 设置前就触发。
  - `after()` hook：rmSync TEST_HOME + 还原 MELO_HOME；并且**捕获 `~/.melo/desktop/state.json` 的 mtime before/after**——如果跑完测试发现真 home 被改 throw 一个明确报错。这是双保险（grandtotal 第二次写错就立即红）。
- 验证：跑测试前后 `~/.melo/desktop/state.json` mtime + 字节数完全不变，TEST_HOME 里写出 fixture 文件，2/2 测试绿，全套 723 = 721 全绿。
- Lessons：
  1. 任何 smoke 测试触发 `saveState` 的，必须在 import 前 mkdtemp + 设 MELO_HOME。CLAUDE.md §6 已经规定异步边界要捕获 env，**测试边界同理**。
  2. 写新测试**不要在自己的 dev home 上首跑**——应该先在临时目录跑通再视情决定是否安全在 home 上跑。
  3. 这次事故 gate 抓到了但**事后**——不能靠 gate 兜底所有 destructive bug，需要 review 习惯先看 "saveState / replaceMemories / 写盘函数" 是否经过隔离。
- 回归：services + state + desktopStore + memory + agents 全套 **723/723 全绿**。
- 提交哈希：`b4cc16a`（mtime guard 后续在 7e/follow-up 改为 opt-in 默认关闭，避免并发 dev Melo 误红——此项即 Codex B-finding 跟进）

## 2026-04-26 17:00 — Phase 7d-5δ commit 7b：**抽出 runChatAgentExecutionGraph 大象**（517 行 byte-for-byte 一刀搬走）

- 做了什么：
  - **新增 `src/services/chat/chatExecutionRunner.js`** —— `runChatAgentExecutionGraph`（517 行 async）byte-for-byte 搬走。**~30 个 imports** 全部映射到现有 leaf 模块——前面所有 commit（7d-5β commit 1 到 7d-5δ commit 7a）都是为了这一刻的零依赖大象。
  - **`getSharedSkillIndex` 同行迁移**：原 desktopStore module-level singleton（`createSharedSkillIndexFactory({ buildSkillIndex })` 的产物），唯一 caller 就是 runner。和 runner 一起搬到新模块后仍然是 module-private singleton（Node module cache 保持稳定）。
  - **`src/desktopStore.js`**：顶部 import 块加 8 行；删 517 行函数体 + 4 行 getSharedSkillIndex const 换 6 行 stub。唯一内部 caller (line ~6002, inside `sendChatMessage`) 走 imported name。
- 为什么：完成 desktopStore 主肉抽取的最关键一步。Chat 主路径（runner）现在是独立 leaf 模块；server.js 和 sendChatMessage 都通过 imported name 访问。结合前面 6 个 prerequisite commit + 1 个 task runner commit，整个 7d-5δ 的设计目标达成。
- 中间踩坑（gate 抓到一次 D）：
  - 第一稿忘了 import `buildChannelRoutePrompt`——按 desktopStore 现有 import 块映射时漏了 remote/ 目录。grep 自查发现并修复。
  - **第二稿被 gate 评 D 阻断**：runner 调用 `getAllTools()` 但 import 块里只导了 `getTool`，主聊天路径 `shouldInjectToolsPrompt() === true` 时直接 ReferenceError。719/719 测试全绿掩盖了——因为 chat runner 没有端到端测试覆盖 prepare 阶段的 tools-prompt 分支。byte-for-byte 规则保护函数体，**不防 import 块漏写**。修复加了 `getAllTools` 到 registry import（1 行）。
  - **Follow-up TODO（本会话不做）**：给 chatExecutionRunner.js 加一个最小 smoke 测试，至少导入新模块 + 用 mock state 跑通 prepare 阶段，避免下次 import 漏写假绿。
- **回归**：services + state + desktopStore + memory + agents 全套 **719/719 全绿**——elephant 是最 stress 的整合点，全套通过证明 byte-for-byte 港无漂移。
- 提交哈希：`9c76db9`（commit 7b 主体）+ `91a25d9`（getAllTools 漏 import 修复）
  - desktopStore: 6188 → 5681（-507 行；本会话内累计已减 1846 行：8527→5681，进度 56%）

## 2026-04-26 16:45 — Phase 7d-5δ commit 7a：抽出 MODE_DEFS（elephant 抽取的最后一个 prereq）

- 做了什么：
  - **新增 `src/services/chat/modeDefs.js`** —— `MODE_DEFS` 静态 3 条目数组（chat/cowork/code）byte-for-byte 搬走。零依赖纯数据。
  - **`src/desktopStore.js`**：顶部 import 块加 4 行；删 20 行原定义换 2 行 stub。3 个 caller（line ~1476/~3640/~4176）走 imported name。
- 为什么：`runChatAgentExecutionGraph`（即将抽走的 elephant）有两个剩余 LOCAL 依赖：`MODE_DEFS` + `getSharedSkillIndex`。前者有 3 callers（runner 占 1，desktopStore 占 2）必须先抽到 leaf；后者只有 runner 1 caller，跟着 runner 一起搬。这是 elephant 抽取前的最后一个 prereq。
- 回归：services + state + desktopStore + memory + agents 全绿。
- 提交哈希：`2f52bf2`
  - desktopStore: 6202 → 6188（-14 行）

## 归档摘要（2026-04-26 04:30 之前的所有条目）

> 按 CLAUDE.md §3 自动压缩：每条仅保留标题 + 一句话结论 + commit hash。完整原始条目见 git history (`git log --follow -p PROGRESS.md`)。

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
