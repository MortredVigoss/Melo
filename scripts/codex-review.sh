#!/usr/bin/env bash
# codex-review.sh — push and review.
#
# Flow:
#   1. Capture upstream SHA (where origin/<branch> is right now).
#   2. Run a pre-push Codex evaluation for the commits about to be pushed.
#      If the quality grade is C/D (or the grade is missing), stop before push.
#   3. git push with whatever args were forwarded.
#   4. Ask `codex review --base <that_sha>` to review everything between
#      the old remote position and our new HEAD (i.e. exactly the diff
#      the remote just received).
#
# The pre-push evaluation is the blocking gate. The post-push review is a
# read-only cross-check after the commits are already on the remote — it does
# NOT block the push. If post-push review fails (network / quota / user kills
# it), that's fine, the push has already landed.
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

run_codex_range_review() {
  local review_phase="$1"
  local review_context="$2"
  local review_base="$3"
  local review_head="$4"
  local review_count="$5"
  local review_short_base="$6"
  local review_short_head="$7"

  # We can't use `codex review --base <sha>` with a custom prompt — those two
  # flags are mutually exclusive in codex-cli 0.124.0. Workaround: run `codex
  # exec` in read-only sandbox and let the agent invoke `git show / git log`
  # itself to inspect the range. Read-only sandbox keeps it from touching the
  # working tree even by accident.
  codex exec --sandbox read-only - <<PROMPT
# 任务
审查仓库中从 commit \`${review_short_base}\` 到 \`${review_short_head}\` 之间这 ${review_count} 个 commit 的所有改动，给出一次**正式**的代码审查，并按 \`EVALUATION.md\` 的 D/C/B/A/S 标准评分。

本次审查阶段：${review_phase}
${review_context}

# 必须按顺序完成的探索步骤（不能跳过任何一步）

## Step 0 ─ 读取评分标准
运行：
\`\`\`
cat EVALUATION.md
\`\`\`
如果文件不存在，也必须按本 prompt 里的 D/C/B/A/S 规则评分；如果文件存在，\`EVALUATION.md\` 优先。

## Step 1 ─ 列出范围
运行：
\`\`\`
git log --oneline --no-decorate ${review_base}..${review_head}
\`\`\`
输出会显示 ${review_count} 个 commit。**必须**在你的推理中确认：你看到了 ${review_count} 个 commit；如果数量不符就停下来报错。

## Step 2 ─ 按文件统计改动体量
运行：
\`\`\`
git diff --stat ${review_base}..${review_head}
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
- \`git diff ${review_base}..${review_head} -- <path>\` → 这段 range 对该文件的净影响
- \`cat <path>\` / \`git show ${review_head}:<path>\` → 新版本全文
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
质量评级：S / A / B / C / D —— <不超过 20 字的一句话根据>

<第三行>
风险等级：低 / 中 / 高 —— <不超过 20 字的一句话根据>

<空行>

<按优先级列出发现，每条一行>
🔴 [src/foo/bar.js:42] 具体问题描述 → 具体建议
🟠 [src/openai.js:128] ...
🟡 ...
🔵 ...
⚪ ...

<仅当质量评级为 C 或 D 时必须输出>
Claude 需停止继续改写，先按以下意见重新出方案给用户判断：
- <给 Claude 的整改意见 1>
- <给 Claude 的整改意见 2>

需要用户确认的新方案问题：
- <需要用户判断的问题 1>
- <需要用户判断的问题 2>
\`\`\`

# 硬性规则
- **绝对不要**在没完成 Step 0-3 的情况下就下结论
- 整份输出 ≤ 60 行；发现少的时候也要保留总评 + 质量评级 + 风险 + "无具体发现"
- 不要复述 diff 内容，不要写 "这次改了 X 文件 Y 行" 之类的摘要——那是 \`git log\` 已经做过的事
- 每次都必须给出 \`质量评级：S / A / B / C / D\`，即便没有发现问题也不能省略评分
- 评级为 \`C\` 或 \`D\` 时，不要只列 bug；必须输出给 Claude 的整改意见，并要求 Claude 重新给方案让用户判断
- 评级到 \`C\` 就进入重新方案 gate：Claude 不应直接继续改代码

PROMPT
}

# ─── Capture pre-push upstream SHA ───────────────────────────────────────────
# `@{upstream}` is the tracked remote ref (e.g. origin/master). This can fail
# on a branch that has never been pushed — we detect that and fall back below.
base_sha="$(git rev-parse '@{upstream}' 2>/dev/null || true)"
head_sha="$(git rev-parse HEAD)"

# ─── Pre-push evaluation gate ────────────────────────────────────────────────
pre_base_sha="$base_sha"
pre_commit_count="0"

if [ -z "$pre_base_sha" ]; then
  # First push on this branch: review the tip commit before sending it out.
  pre_base_sha="$(git rev-parse "${head_sha}^" 2>/dev/null || true)"

  if [ -z "$pre_base_sha" ]; then
    echo "⚠️  Cannot determine a pre-push review base — blocking push so the change is not sent without evaluation." >&2
    exit 1
  fi

  if ! git cat-file -e "${pre_base_sha}^{commit}" 2>/dev/null; then
    echo "⚠️  Pre-push review base $pre_base_sha is unreachable — blocking push so the change is not sent without evaluation." >&2
    exit 1
  fi

  pre_commit_count="$(git rev-list --count "${pre_base_sha}..${head_sha}")"
elif [ "$pre_base_sha" != "$head_sha" ]; then
  if ! git cat-file -e "${pre_base_sha}^{commit}" 2>/dev/null; then
    echo "⚠️  Pre-push review base $pre_base_sha is unreachable — blocking push so the change is not sent without evaluation." >&2
    exit 1
  fi

  pre_commit_count="$(git rev-list --count "${pre_base_sha}..${head_sha}")"
fi

if [ "$pre_commit_count" != "0" ]; then
  pre_short_base="$(git rev-parse --short "$pre_base_sha")"
  pre_short_head="$(git rev-parse --short "$head_sha")"
  pre_review_output="$(mktemp -t melo-pre-pp-review.XXXXXX)"

  echo ""
  echo "──────────────────────────────────────────────────────────────"
  echo "🧪 Pre-pp evaluation: ${pre_short_base}..${pre_short_head}  (${pre_commit_count} commit(s))"
  echo "──────────────────────────────────────────────────────────────"
  echo ""

  if ! run_codex_range_review \
    "pre-pp evaluation（push 前阻塞 gate）" \
    "这是 push 前评估。若质量评级为 C 或 D，本脚本会阻止 git push；请直接给出 Claude 需要如何重出方案。" \
    "$pre_base_sha" "$head_sha" "$pre_commit_count" "$pre_short_base" "$pre_short_head" | tee "$pre_review_output"; then
    echo "❌ Pre-pp evaluation failed — blocking push." >&2
    exit 1
  fi

  pre_quality_grade="$(sed -nE 's/^质量评级[[:space:]]*[：:][[:space:]]*([SABCD]).*/\1/p' "$pre_review_output" | head -n 1)"
  rm -f "$pre_review_output"

  if [ -z "$pre_quality_grade" ]; then
    echo "❌ Pre-pp evaluation did not output a parseable quality grade — blocking push." >&2
    echo "   Expected line like: 质量评级：A —— ..." >&2
    exit 1
  fi

  if [ "$pre_quality_grade" = "C" ] || [ "$pre_quality_grade" = "D" ]; then
    echo "❌ Pre-pp evaluation grade is ${pre_quality_grade} — blocking push. Claude must re-plan for user approval first." >&2
    exit 1
  fi
else
  echo "✅ Pre-pp evaluation skipped (no local commits ahead of upstream)."
fi

# ─── Push ────────────────────────────────────────────────────────────────────
# Forward every argument (e.g. `git pp -u origin feature`, `git pp --force-with-lease`).
git push "$@"
push_exit=$?
if [ $push_exit -ne 0 ]; then
  exit $push_exit
fi

# ─── Determine review range ──────────────────────────────────────────────────
head_sha="$(git rev-parse HEAD)"

if [ -z "$base_sha" ]; then
  # First push on this branch: review the tip commit after sending it out.
  base_sha="${head_sha}^"
elif [ "$base_sha" = "$head_sha" ]; then
  echo "✅ Push succeeded (no new commits to review)."
  exit 0
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

run_codex_range_review \
  "post-push review（push 后兜底复查）" \
  "这是 push 成功后的兜底复查。review 不会阻断已经完成的 push；若质量评级为 C 或 D，Claude 必须立即停止后续改写并重新给用户方案。" \
  "$base_sha" "$head_sha" "$commit_count" "$short_base" "$short_head"
