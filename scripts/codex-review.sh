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

codex review --base "$base_sha" - <<'PROMPT'
用中文审查刚才推送到远端的这批改动。

**输出结构**（严格遵守）：

1. 首行总评（**必须**是下面之一）：
   - `✅ 可以合入，无需跟进` — 没有任何需要处理的问题
   - `🟡 可以合入，但有建议` — 有非阻塞的改进项
   - `🔴 建议立即跟进修复` — 发现了 bug / 回归 / 安全问题，应该马上再推一个修复 commit
2. 第二行：风险等级（低 / 中 / 高）+ 一句话根据。
3. 空行。
4. 按优先级逐条列出发现：
   - 🔴 **Bug / 逻辑错误 / 回归** — 影响功能正确性
   - 🟠 **安全** — 注入、越权、凭证/密钥泄漏、路径穿越、SSRF、命令拼接
   - 🟡 **资源与并发** — 句柄泄漏、竞态、未取消的 timer / interval、未 await 的 Promise、AbortSignal 未传递
   - 🔵 **API 契约** — 跨模块调用方会受影响的签名 / 行为变化
   - ⚪ **测试** — 覆盖缺口、flaky、mock 过度导致假绿

**必须跳过的东西**（不要提）：
- 代码风格、命名偏好、注释密度（除非严重影响可读性）
- "可以再抽一个函数 / 再加一层抽象"
- ESLint / TypeScript 能自动捕捉的问题
- 已经被现有测试覆盖且通过的行为

**长度限制**：整份审查 ≤ 60 行。发现少时更短。只列发现，不复述 diff。
每条发现格式：`[文件:行号] 一句话问题描述 → 建议做法`。

如果确实没问题，只输出 `✅ 可以合入，无需跟进` 这一行。
PROMPT
