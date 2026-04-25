#!/usr/bin/env bash
# codex-review.sh — pre-push evaluation gate + post-push backup review.
#
# Scope (intentional limitation, see CLAUDE.md §1 / §4):
#   • Reviews ONLY the range `<branch>@{upstream}..HEAD` of the current branch.
#   • Refuses to run when the current branch has no tracking upstream.
#     First-time setup: `git push -u origin <branch>` once, then `git pp` works.
#   • Refuses any extra arguments (refspecs, -u, --force-with-lease, etc).
#     For those edge cases use plain `git push` and review manually.
#
# Why these limits: the gate exists to evaluate the commit set *actually being
# pushed*. Inferring "what will be pushed" from forwarded `git push` args
# requires reimplementing push refspec resolution; we'd rather refuse and stay
# correct than guess and silently miss commits (Codex caught this on the
# first iteration of the gate).
#
# Flow:
#   1. Resolve base_sha = @{upstream}, head_sha = HEAD. Parse upstream into
#      <remote> + <remote-branch>. Fail if no upstream or no commits ahead.
#   2. Pre-push Codex evaluation over base..head. Block on C/D or unparseable.
#   3. git push <remote> HEAD:<remote-branch> — explicit refspec so push.default
#      can't widen or shift the actually-pushed ref past what we evaluated.
#   4. Post-push Codex review over the SAME base..head. Best-effort backup;
#      does not block.
#
# Install once per repo:
#   git config --local alias.pp '!./scripts/codex-review.sh'

set -euo pipefail

# ─── Prerequisites ───────────────────────────────────────────────────────────
if ! command -v codex >/dev/null 2>&1; then
  echo "❌ codex CLI not found. Install with: npm install -g @openai/codex" >&2
  echo "   (then run \`codex login\` if it prompts)." >&2
  exit 127
fi

# ─── Refuse extra arguments ─────────────────────────────────────────────────
# git pp is intentionally narrow. Forwarding arbitrary push args (refspec,
# --force-with-lease, multi-branch fan-out) means we can't reliably compute
# the commit range the remote will actually receive — the gate would miss
# commits in those cases.
if [ "$#" -gt 0 ]; then
  echo "❌ git pp does not forward arguments — it pushes the current branch to its tracked upstream." >&2
  echo "   For complex push patterns (custom refspec / -u / --force-with-lease / multiple refs)," >&2
  echo "   use plain \`git push\` and run a manual \`codex review\` afterward." >&2
  exit 1
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

# ─── Resolve range (single source of truth, shared by pre + post) ────────────
# `@{upstream}` is the tracked remote ref (e.g. origin/master). We refuse to
# guess if it's missing — see header.
base_sha="$(git rev-parse '@{upstream}' 2>/dev/null || true)"
if [ -z "$base_sha" ]; then
  current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
  echo "❌ Current branch '${current_branch}' has no tracking upstream." >&2
  echo "   git pp gates the range upstream..HEAD before pushing — without an" >&2
  echo "   upstream there is no well-defined range to evaluate." >&2
  echo "" >&2
  echo "   First-time setup (one-shot, then \`git pp\` works normally):" >&2
  echo "     git push -u origin ${current_branch}" >&2
  exit 1
fi

# Parse upstream into <remote> + <remote-branch> so the actual push uses an
# explicit refspec, immune to whatever `push.default` is set to. Otherwise
# `git push` with no args could push extra refs (push.default=matching) or
# a different branch name (push.default=current) that the evaluation didn't
# cover — the gate would silently miss commits.
upstream_full_ref="$(git rev-parse --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
if [[ ! "$upstream_full_ref" =~ ^refs/remotes/([^/]+)/(.+)$ ]]; then
  echo "❌ Could not parse upstream as refs/remotes/<remote>/<branch>: '${upstream_full_ref}'." >&2
  echo "   git pp requires a standard remote-tracking upstream so the push refspec is unambiguous." >&2
  exit 1
fi
remote="${BASH_REMATCH[1]}"
remote_branch="${BASH_REMATCH[2]}"

head_sha="$(git rev-parse HEAD)"

if [ "$base_sha" = "$head_sha" ]; then
  echo "✅ Already up to date with upstream — nothing to push."
  exit 0
fi

if ! git cat-file -e "${base_sha}^{commit}" 2>/dev/null; then
  echo "❌ Upstream base $base_sha is unreachable locally (force-pushed or GC'd)." >&2
  echo "   Run \`git fetch\` to refresh the upstream pointer, then retry \`git pp\`." >&2
  exit 1
fi

commit_count="$(git rev-list --count "${base_sha}..${head_sha}")"
short_base="$(git rev-parse --short "$base_sha")"
short_head="$(git rev-parse --short "$head_sha")"

# ─── Pre-push evaluation gate ────────────────────────────────────────────────
pre_review_output="$(mktemp -t melo-pre-pp-review.XXXXXX)"

echo ""
echo "──────────────────────────────────────────────────────────────"
echo "🧪 Pre-pp evaluation: ${short_base}..${short_head}  (${commit_count} commit(s))"
echo "──────────────────────────────────────────────────────────────"
echo ""

if ! run_codex_range_review \
  "pre-pp evaluation（push 前阻塞 gate）" \
  "这是 push 前评估。若质量评级为 C 或 D，本脚本会阻止 git push；请直接给出 Claude 需要如何重出方案。" \
  "$base_sha" "$head_sha" "$commit_count" "$short_base" "$short_head" | tee "$pre_review_output"; then
  rm -f "$pre_review_output"
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

# ─── Push (explicit refspec — push.default is bypassed) ─────────────────────
# Always push the local HEAD into the exact upstream branch we just evaluated.
# Bare `git push` would inherit push.default semantics (matching/current/etc)
# and could push refs the gate never reviewed.
git push "$remote" "HEAD:$remote_branch"

# ─── Post-push backup review (same range) ────────────────────────────────────
echo ""
echo "──────────────────────────────────────────────────────────────"
echo "🔍 Codex review: ${short_base}..${short_head}  (${commit_count} commit(s))"
echo "──────────────────────────────────────────────────────────────"
echo ""

run_codex_range_review \
  "post-push review（push 后兜底复查）" \
  "这是 push 成功后的兜底复查。review 不会阻断已经完成的 push；若质量评级为 C 或 D，Claude 必须立即停止后续改写并重新给用户方案。" \
  "$base_sha" "$head_sha" "$commit_count" "$short_base" "$short_head"
