# Melo 进度日志

> 新条目追加在本文件顶部（时间倒序）。
> 当本文件超过 160 行或 8000 字符时，按 CLAUDE.md §3 自动压缩：最旧 70% 归档为一句话摘要，最新 30% 保留完整格式。

---

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
