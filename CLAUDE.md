# Melo 工作协议（Working Protocol）

本文件是本仓库对 Claude 的强制工作规则，优先级高于默认行为。下面三条在每个会话里都要主动执行，不需用户反复提醒。

## 1. 阶段性提交 + 推送（每满 1 小时）

- 从第一次写盘开始计时。只要当前阶段累计工作时长 **≥ 60 分钟**，就必须：
  1. `git add` 本阶段改动的相关文件（按文件名点名，不要用 `-A` / `.`）。
  2. `git commit`，用一句话描述 "为什么" 而非 "改了什么"，按仓库现有风格写 message。
  3. **`git pp`**（= push + Codex 自动审查；等价于 `./scripts/codex-review.sh`）。
     - 如果本轮修改量小、不想耗 Codex 额度，可以退回 `git push`，但任何超过 1h 的批次必须跑 `git pp`。
     - `git pp` 在 push 成功 **之后** 才调用 `codex review`，review 不会阻断推送；即便 review 失败，commit 已经落盘到远端。
     - Review 用中文输出，阶段总评 + 风险等级 + 按优先级列出的发现，格式由 `scripts/codex-review.sh` 内嵌的 prompt 约束。
- 中途如果到了一个天然节点（feature 完成、测试全绿、bug 定位到根因修好），即便不满 1 小时也应该提交，不必死等整点。
- 永远 **新建 commit**，不要 `--amend` 已经 push 出去的 commit。
- 永远不要带 `--no-verify` / `--no-gpg-sign` 绕过钩子，除非用户明确要求。

### 新克隆的仓库如何启用 `git pp`

`git pp` 的 alias 存在 `.git/config`（不会进 commit），所以每个新 clone 要跑一次：

```bash
git config --local alias.pp '!./scripts/codex-review.sh'
```

脚本本身 (`scripts/codex-review.sh`) 已经入库，不用单独拷贝。前置依赖：`codex` CLI（`npm i -g @openai/codex`）并已登录。

## 2. PROGRESS.md 作为状态看板

- 仓库根目录维护一份 `PROGRESS.md`，记录 **做过了什么** 和 **当前进行到哪一步**。
- 每次完成一个可验证的步骤（测试通过、bug 修复、feature 落地、重要重构）就追加一条，格式：
  ```
  ## YYYY-MM-DD HH:MM — <一句话标题>
  - 做了什么：…
  - 为什么：…
  - 产出 / 提交哈希：<commit-sha>
  ```
- `PROGRESS.md` 是时间轴日志，不做分章节结构化——按时间倒序从顶部追加最新条目，旧的往下压。
- 它与 `git log` 的区别：`git log` 面向代码变更，`PROGRESS.md` 面向 **意图与上下文**，便于未来新会话快速接续。

## 3. 2 页阈值 = 自动摘要压缩

- 每次要往 `PROGRESS.md` 追加条目前，先检查当前文件长度：
  - **> 2 页**（近似 = 超过 160 行，或超过 8000 字符）触发自动压缩。
- 压缩步骤：
  1. 把最旧的 70% 条目合并写成一节「## 归档摘要（YYYY-MM-DD 之前）」，每条保留：标题 + 1 句话结论 + commit hash。
  2. 删掉被归档的原始条目。
  3. 保留最近 30% 的详细条目不动，再把新条目追加进去。
- 压缩是 **幂等** 的——每次触发都只压旧条目，最新的永远是完整格式。
- 压缩后要和正文改动一起进入同一个 commit，message 前缀加 `progress: `。

## 其他既有规则（不在本文件但仍生效）

- `~/.claude/projects/-Users-mortred-Desktop-melo/memory/MEMORY.md` 中的 Melo 六条硬性规则继续适用（方案评分先行、红绿灯检测、功能隔离、UI 对齐、设计语言统一、配置保留）。
- 所有总结用中文输出。
