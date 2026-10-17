# Changelog

Notable user-facing changes. Internal details and verification notes live in `PROGRESS.md` and `docs/`.

## 2026-10-17

### Tool calling
- One result envelope for every tool: `status` is `ok`, `empty`, or `error`, with a canonical error code (`NO_RESULTS`, `PERMISSION_DENIED`, `TIMEOUT`, `BUDGET_EXHAUSTED`, …) and a short hint. Empty results are no longer reported as failures.
- The tool set exposed to the model is stable within a conversation (core tools always present; browser / document / media groups activate on demand and stay), so provider prompt caches survive routing changes.
- Each turn runs under a run budget — 20 minutes, 400k input tokens, 120 tool calls by default (`MELO_RUN_DEADLINE_MS`, `MELO_RUN_MAX_INPUT_TOKENS`, `MELO_RUN_MAX_TOOL_CALLS`). Members, skills, and teams get a narrowed share of the parent budget. When the budget is spent Melo says so and stops instead of hanging.
- Every tool call is recorded (redacted arguments, hash, the exact output the model saw) under `desktop/execution-scenes/<run>.tools.jsonl`; a cancelled or failed turn leaves a short tool trace in the chat so "continue" picks up where it stopped.
- Native tool calling for Anthropic Messages (`tools` / `tool_use` / `tool_result`, with cache control) and, opt-in, OpenAI-compatible Chat Completions (`toolCalling: "native"` on the connection or `MELO_CHAT_TOOLS=1`). Codex / Responses requests are unchanged.
- MCP tools live in their own registry and are merged per Agent; model-facing names are `mcp__server__tool`.
- Tools describe their own capability, workspace, UI module, and concurrency rules.

### Long conversations
- Compaction appends one topic card per summarised segment instead of rewriting a single summary; cards keep numbers, paths, and identifiers verbatim and reference message ids. Existing summaries become a historical card automatically.
- New `read_history` tool reads any message range back verbatim (same project / channel isolation as `search_history`).
- When a message returns to an earlier topic, the original text of the matching card is attached to that turn.
- Raw history per turn is capped at 64k tokens by default (`MELO_HISTORY_WINDOW_TOKENS`); compaction runs in the background before the window fills, and the chat shows when a compaction is running.
- Attachments larger than 4 KB are stored as files under the data home and served locally; conversations become much smaller on disk and on the phone. Older conversations migrate the next time you send a message in them.
- The desktop renders the last 60 messages with "load earlier".

### Memory
- Project memory book: decisions and project context extracted from any conversation in a project are shared with every Agent in that project (auto rows marked `[auto]`; confirm, re-file, or stop them on the project page). Hand-written entries are supported.
- Personal profile: preferences, identity, and corrections you promote to "personal" appear in every local conversation.
- Each reply lists the memories it was given, with "记到项目 / 记成个人 / 停止使用" actions; category and pinned state are editable on the memory page.
- Remote channels are isolated from local project / personal / Agent memory at the SQL layer.
- Memory rows edited on both devices show a conflict with "use desktop" / "use phone".

### iPhone
- The desktop conversation summary (and topic cards) sync to the phone; the phone builds requests from messages after the compaction boundary with the summary prepended.

### Upgrading
- No manual migration. Keep your data home (`.tmp/melo-home-user/` or `MELO_HOME`); rebuild and reinstall the desktop app with `npm run build:desktop && npm run install:desktop`.
