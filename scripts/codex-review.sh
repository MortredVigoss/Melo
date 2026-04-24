#!/usr/bin/env bash
# codex-review.sh — push and review.
#
# Flow:
#   1. Capture upstream SHA (where origin/<branch> is right now).
#   2. git push with whatever args were forwarded.
#   3. Ask `codex review --base <that_sha>` to review everything between
#      the old remote position and our new HEAD (i.e. exactly the diff
#      the remote just received).
#
# The review is a read-only cross-check after the commits are already on
# the remote — it does NOT block the push. If review fails (network /
# quota / user kills it), that's fine, the push has already landed.
#
# Install the git alias once per repo:
#   git config --local alias.pp '!./scripts/codex-review.sh'
# Then use `git pp` instead of `git push`.

set -euo pipefail

# ─── Prerequisites ───────────────────────────────────────────────────────────
if ! command -v codex >/dev/null 2>&1; then
  echo "❌ codex CLI not found. Install with: npm install -g @openai/codex" >&2
  echo "   (then run \`codex login\` if it prompts)." >&2
  exit 127
fi

# ─── Capture pre-push upstream SHA ───────────────────────────────────────────
# `@{upstream}` is the tracked remote ref (e.g. origin/master). This can fail
# on a branch that has never been pushed — we detect that and fall back below.
base_sha="$(git rev-parse '@{upstream}' 2>/dev/null || true)"

# ─── Push ────────────────────────────────────────────────────────────────────
# Forward every argument (e.g. `git pp -u origin feature`, `git pp --force-with-lease`).
git push "$@"
push_exit=$?
if [ $push_exit -ne 0 ]; then
  exit $push_exit
fi

# ─── Determine review range ──────────────────────────────────────────────────
head_sha="$(git rev-parse HEAD)"

if [ -z "$base_sha" ] || [ "$base_sha" = "$head_sha" ]; then
  # First push on this branch, OR nothing new pushed (everything was
  # already on the remote). Fall back to reviewing the tip commit.
  base_sha="${head_sha}^"
fi

# Base might be unreachable locally if the branch was force-pushed or
# the old upstream commit was garbage-collected.
if ! git cat-file -e "${base_sha}^{commit}" 2>/dev/null; then
  echo "⚠️  Push succeeded, but base ref $base_sha is unreachable — skipping review." >&2
  exit 0
fi

# Empty range: nothing to review (e.g. re-push of same HEAD).
if [ "$(git rev-list --count "${base_sha}..${head_sha}")" = "0" ]; then
  echo "✅ Push succeeded (no new commits to review)."
  exit 0
fi

# ─── Review ──────────────────────────────────────────────────────────────────
commit_count="$(git rev-list --count "${base_sha}..${head_sha}")"
short_base="$(git rev-parse --short "$base_sha")"
short_head="$(git rev-parse --short "$head_sha")"

echo ""
echo "──────────────────────────────────────────────────────────────"
echo "🔍 Codex review: ${short_base}..${short_head}  (${commit_count} commit(s))"
echo "──────────────────────────────────────────────────────────────"
echo ""

# We can't use `codex review --base <sha>` with a custom prompt — those two
# flags are mutually exclusive in codex-cli 0.124.0. Workaround: run `codex
# exec` in read-only sandbox and let the agent invoke `git show / git log`
# itself to inspect the range. Read-only sandbox keeps it from touching the
# working tree even by accident.
codex exec --sandbox read-only - <<PROMPT
# 任务
审查仓库中从 commit \`${short_base}\` 到 \`${short_head}\` 之间这 ${commit_count} 个 commit 的所有改动，给出一次**正式**的代码审查。这是每次 push 之后的强制复查，需要认真对待——不是 pre-merge 闲聊。

# 必须按顺序完成的探索步骤（不能跳过任何一步）

## Step 1 ─ 列出范围
运行：
\`\`\`
git log --oneline --no-decorate ${base_sha}..${head_sha}
\`\`\`
输出会显示 ${commit_count} 个 commit。**必须**在你的推理中确认：你看到了 ${commit_count} 个 commit；如果数量不符就停下来报错。

## Step 2 ─ 按文件统计改动体量
运行：
\`\`\`
git diff --stat ${base_sha}..${head_sha}
\`\`\`
这是"全景图"——哪些文件、分别改了多少行。凭这个决定每个文件值不值得细看。

## Step 3 ─ 逐 commit 看 diff（非常重要）
对范围内**每一个** commit 都运行：
\`\`\`
git show --stat --patch <sha>
\`\`\`
**不允许跳过任何 commit**。即便某个 commit 看起来"只是文档 / 只是配置"也要扫一眼确认——很多回归就藏在这些地方。

## Step 4 ─（可选）聚焦阅读
看到可疑点想看某文件的完整上下文时：
- \`git diff ${base_sha}..${head_sha} -- <path>\` → 这段 push 对该文件的净影响
- \`cat <path>\` / \`git show ${head_sha}:<path>\` → 新版本全文
- \`rg <symbol> <path>\` → 看调用关系

# 审查清单（过每一项时心里过一遍）

1. 🔴 **Bug / 逻辑错误 / 回归** — 改动是否破坏既有功能、边界条件是否覆盖、异常路径是否被处理
2. 🟠 **安全** — 注入 / 越权 / 凭证或密钥泄漏 / 路径穿越 / SSRF / 命令拼接 / 任意代码执行
3. 🟡 **资源与并发** — 句柄泄漏、未清理的 timer/interval/listener、未 await 的 Promise、AbortSignal 未传递、竞态
4. 🔵 **API 契约** — 改动是否静默影响了跨模块 / 跨进程 / 跨 PR 的调用方（导出签名、返回值形状、错误类型等）
5. ⚪ **测试** — 新增代码是否有对应测试、是否存在 mock 过度导致"假绿"、是否存在只在本机能过的 flaky 前提

# 必须跳过（不要浪费 token 讨论）
- 代码风格 / 命名偏好 / 注释密度（除非严重影响可读性）
- "可以再抽一个函数 / 再加一层抽象" 之类的重构建议
- ESLint / TypeScript 已经能自动捕捉的问题
- 已经被新增测试覆盖且明确通过的行为

# 输出格式（严格）

**用中文**输出，按下面的结构——其它任何前言、复述 diff、步骤日志一概不要。

\`\`\`
<第一行总评，必须恰好是下列之一>
✅ 可以合入，无需跟进
🟡 可以合入，但有建议
🔴 建议立即跟进修复

<第二行>
风险等级：低 / 中 / 高 —— <不超过 20 字的一句话根据>

<空行>

<按优先级列出发现，每条一行>
🔴 [src/foo/bar.js:42] 具体问题描述 → 具体建议
🟠 [src/openai.js:128] ...
🟡 ...
🔵 ...
⚪ ...
\`\`\`

# 硬性规则
- **绝对不要**在没完成 Step 1-3 的情况下就下结论
- 整份输出 ≤ 60 行；发现少的时候可以只有 2-3 行（总评 + 风险 + "无具体发现"）
- 不要复述 diff 内容，不要写 "这次改了 X 文件 Y 行" 之类的摘要——那是 \`git log\` 已经做过的事
- 如果审完确实没发现问题，就只输出 **一行**：\`✅ 可以合入，无需跟进\`（不要加任何解释）

PROMPT
