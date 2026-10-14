# Melo Local

Local-first Melo CLI.

## What this build does

- Runs fully on your machine as a terminal app
- Uses either an OpenAI-compatible API key flow or Codex-backed OAuth mode, depending on your config
- Avoids the old Claude web login, upgrade, and companion-app paths

## Requirements

- Node.js `18` or newer
- No third-party npm dependencies are currently required for the CLI itself
- The desktop app build also expects the macOS tools already used elsewhere in this project

## Install

This project currently runs with the files already in the repo. There is no separate `npm install` step unless we add dependencies later.

## Quick start

```bash
npm run build
npm run install:desktop
node src/index.js doctor
node src/index.js config set apiKey sk-...
node src/index.js config set model gpt-4.1
node src/index.js chat "Say hello as Melo."
```

Or start an interactive session:

```bash
node src/index.js
```

## Config

Melo stores config in:

- `<project>/.tmp/melo-home-user/config.json` by default, shared by Desktop, CLI and doctor
- `MELO_HOME=/some/path` or `node src/index.js --home /some/path doctor` for an isolated data directory

Existing `~/.melo` data is preserved, not merged or deleted. Use `MELO_HOME="$HOME/.melo"` to access the old CLI store explicitly. A Desktop launched with an explicit `MELO_HOME` uses that directory without importing legacy settings.

Supported environment overrides:

- `MELO_API_KEY`
- `OPENAI_API_KEY`
- `MELO_BASE_URL`
- `OPENAI_BASE_URL`
- `MELO_MODEL`
- `MELO_SYSTEM_PROMPT`
- `MELO_MOCK_RESPONSE`

`MELO_MOCK_RESPONSE` is meant for local smoke tests and bypasses the network call.

### Resolution priority

Config resolution currently follows this order:

- `MELO_AUTH_MODE` overrides file config for auth mode
- `MELO_BASE_URL` overrides `OPENAI_BASE_URL`, which overrides file config
- `MELO_MODEL` overrides file config
- `MELO_SYSTEM_PROMPT` overrides file config
- `MELO_API_KEY` overrides `OPENAI_API_KEY`, which overrides file config

If you are using API key mode, pick a model your provider actually exposes. The bundled defaults currently include `gpt-4.1` and `gpt-4.1-mini` for API mode.

## Memory and embeddings

Melo's memory stack (`docs/memory-architecture.md`) does semantic recall at three layers — scene / frame / content — backed by 1024-dim embeddings stored in `sqlite-vec`. The default embedding backend is **bge-m3** running locally through Ollama; it carries multilingual conversations (zh / en mixed) and stays fully offline.

### One-time setup

```bash
# 1. install Ollama (https://ollama.com/download) — only needed once
# 2. pull the embedding model (≈1 GB)
ollama pull bge-m3
# 3. verify Melo can see it
node src/index.js doctor
node scripts/memory-status.js --live
```

`memory-status --live` probes the actual embedding provider and reports the model id, vector dim, and any drift against the on-disk index. Exit code 2 means the live model disagrees with what was used to build the existing vectors — re-embed before that drift causes silent recall regressions.

### What happens if bge-m3 isn't there

The recall path degrades, it doesn't crash. In order:

1. **bge-m3 via Ollama** (default): full 3-tier ANN recall with hybrid keyword + vector scoring.
2. **OpenAI `text-embedding-3-large`** (fallback): used automatically when `OPENAI_API_KEY` is set and bge-m3 isn't reachable. Same 1024 dim, same index. Disabled when `MELO_OFFLINE_ONLY=1`.
3. **Custom HTTP embedder**: set `MELO_EMBED_PROVIDER=custom-http` + `MELO_EMBED_HTTP_URL` to point at your own service.
4. **Keyword fallback**: zero-dependency BM25 / FTS5 path. No semantic similarity, but every recall API still returns reasonable hits — useful while you're still pulling the model.

### Useful env switches

| Variable | Effect |
|---|---|
| `MELO_OFFLINE_ONLY=1` | Disable all cloud backends (embed + compact). bge-m3 becomes mandatory; recall falls back to keyword if it's missing. |
| `MELO_EMBED_PROVIDER` | Force a specific backend (`ollama` / `openai` / `custom-http`). Default is auto-detect (ollama → openai → custom-http). |
| `MELO_OLLAMA_EMBED_MODEL` | Override the Ollama model name (default `bge-m3`). |
| `MELO_COMPACT_QUALITY_GATE` | `audit` (default) writes a quality block to `$MELO_HOME/desktop/dreams/YYYY-MM-DD.md` for every LLM-produced compact summary; `fallback` also skips the LLM result when it scores below threshold; `disabled` turns the audit off. |
| `MELO_DREAMING_ENABLED=0` | Pause the background dreaming sweep entirely. |

See `docs/memory-architecture.md` §3 for the full env table.

### Prompt, verification and speech pipeline

Melo retains the user's original message. Stable instructions precede variable reference data;
explicit language/translation/format requests override persona style defaults, never safety or approvals.
Intent and risk are separate: writing or coding about high-stakes topics still enables uncertainty verification.
Negative or quoted action words do not create automatic local-command approvals. Workspace search requires an explicit local target; public web lookup follows the search router.
Simple arithmetic, supplied-text translation and explicit closed-context questions omit tool schemas. Attachments, custom or explicitly requested executable skills, high-risk tasks and ambiguous follow-ups retain normal tools and approval checks.
Explicit no-network requests disable automatic URL promotion/remote extraction; forbidding broad search still permits reading a specifically requested URL.
The verifier receives bounded, source-labelled tool excerpts and must quote actual evidence before accepting a claim or replacing an incorrect sentence.
This is an evidence-assisted check, not a guarantee of factual correctness; missing evidence remains labelled, including on Telegram/Discord.

Speech waits for the finalized answer except for simple greetings/acknowledgments. Draft text can still appear immediately.
The verified source form is retained as `metadata.canonicalReply` when channel formatting changes it; existing desktop/remote renderers are unchanged.
Failed/cancelled sends discard unspoken audio. History compression summarizes only new complete turns since the previous boundary and retains recent turns.

| Variable | Effect |
|---|---|
| `MELO_CONTEXT_BUDGET_TOKENS` | Whole-request estimated budget, default `60000`, including instructions, messages, media and output reserve. Estimates are not exact provider token counts. |
| `MELO_OUTPUT_RESERVE_TOKENS` | Output/reasoning headroom, default `8000` (capped to one third of the whole budget). |
| `MELO_PROMPT_DEBUG=1` | Log section IDs, estimated counts and dropped/truncated section/message counts, not prompts, URLs, keys or evidence bodies. |
| `MELO_CLASSIFIER_MODEL` | Optional classifier override. OAuth otherwise uses the configured chat model, not an assumed mini-model alias. |
| `MELO_VERIFIER_MODEL` | Optional verification model override; otherwise follows the agent's model. |
| `MELO_CODEX_FAST_REASONING_EFFORT` | Classifier/verifier reasoning override, default `low`; does not alter the main reply's reasoning setting. |

OAuth cache grouping is stable per home/account/agent/chat/model while request session IDs remain unique.
This reuses the existing `prompt_cache_key` field; it does not enable server-side conversation storage or unverified private-endpoint features.
Actual cache hits and latency savings depend on the provider and are not guaranteed.
Run `npm run test:prompt-pipeline` for isolated mock-model integration tests; the same suite is included in `npm test`.

### Benchmarking recall quality

The `Memory-Redesign-Proposal.md` Phase C target was top-5 recall ≥ 85% on real chat data. To measure it on your own store:

```bash
cp bench/memory/golden.example.json bench/memory/golden.json
# fill golden.json with 30–50 real (query, expected) pairs — see bench/memory/README.md
npm run bench:memory
# CI gate: exit 2 if recall@5 < 0.85
npm run bench:memory -- --threshold-recall5 0.85
```

`bench/memory/golden.json` is gitignored — it holds private conversation excerpts.

## MCP security model

Melo ships built-in stdio MCP servers (browser automation, AntV chart generator, markdown→PDF, …) but does **not** default-trust them. Stdio MCPs run arbitrary local processes — file IO, network, exec — so the access path is gated through four explicit layers, in order:

| Layer | What it controls | Where you toggle it |
|---|---|---|
| **1. Installed** | `npx` can pull the package off-the-shelf when the server starts. Nothing is downloaded ahead of time. | `package.json` only lists transitive deps; the MCP packages are pulled by `npx -y` on first connect. |
| **2. Globally enabled** | Whether the server starts at all. The associated `enable*Mcp` config flag flips this. | Customize → Advanced → "Built-in MCP servers" toggle, or the `enable*Mcp` field in `$MELO_HOME/config.json`. **All built-ins default to off.** |
| **3. Agent authorised** | Whether a specific agent (main / research / a custom one) is allowed to call this server's tools. Default is **deny-all** for every agent. | Customize → Agents → the "Stdio MCP servers" chip-row on each agent. Empty = no MCP access. |
| **4. Per-call approval** | Even after the first three layers pass, every tool invocation pops the in-app Tool Permission Request modal (Allow once / Always allow / Deny). | The modal itself; "Always allow" persists per-tool inside the chat session. |

Each MCP server is launched with its working directory set to `$MELO_HOME/desktop/mcp-workspace/<server>/` so artefacts it writes without an explicit path land in a predictable spot. **This is a default, not a sandbox** — a process that wants to read or write outside that directory still can. Real isolation comes from layers 3 and 4: an agent without authorisation never sees the tool, and an authorised tool call still requires an explicit user approval before it runs.

If the four-layer model feels too strict for a daily setup, leave the layers as-is and use "Always allow" inside the approval modal once per (agent, tool) pair — that turns layer 4 off without weakening 1-3.

## Test and verification

```bash
npm run build
npm run build:desktop
npm run install:desktop
npm run verify:red-green
```

`npm test` is currently an alias for `npm run verify:red-green`.

The verification gate uses an isolated `.tmp/melo-home-verify` directory, including native Desktop launches. It builds/installs both desktop entry points and checks rendered agent saves, transcript persistence/search, scrolling, and the diagnostics panel in headless Chrome. It uses a mock model, so it does not demonstrate live model or website access. Set `MELO_TEST_CHROME` to override the Chrome executable.

On a locked/headless machine, `MELO_SKIP_NATIVE_LAUNCH=1 npm test` runs the remaining checks and explicitly reports both native launch checks as YELLOW, not passed. Rerun without that flag on an unlocked desktop to complete native acceptance.

## Runtime diagnostics

```bash
node src/index.js doctor --json
node src/index.js doctor --storage
node src/index.js doctor --probe
```

Customize → Advanced shows the same runtime home, config path, PID, port and startup revision. Doctor verifies the running server's instance identity instead of trusting whichever process answers on that port. `--probe` adds reader dependency/network checks; it does not send a model request.

Capability indicators describe evidence, not just installation: green means a real result within 24 hours at the stated level; yellow means untested, partial, cached, simulated or outdated; red means a failed recent attempt. OCR is not image understanding; a video title is not a transcript; search results are not fetched article bodies. Codex native search is recorded only after a completed tool event. The small evidence file stores metadata only, never prompts, URLs, keys or response bodies. Set `MELO_DIAGNOSTICS_RECORD=0` to disable recording.

A fresh search-results page does not make cached article bodies fresh: search evidence tracks `contentFreshFetched` and `contentFromCache` separately. Results backed entirely by URL-cache bodies remain yellow. Memory status resolves the same data home as the running app and CLI.

## Reminders and execution safety

Reminders are saved atomically to `<MELO_HOME>/reminders.json` before the tool reports success. They belong to the originating chat: model-supplied destination IDs cannot redirect them, and list/cancel actions are chat-scoped. Delivery adds a message to that chat and, for Telegram/Discord, sends to its original remote thread using the agent's current channel settings. No model or TTS request is needed.

Melo must be running for on-time delivery. Startup restores saved reminders, including overdue ones; long waits are chunked to avoid Node timer overflow. Failed deliveries stay pending and retry after one minute. Local reminder messages are deduplicated; remote delivery is at-least-once, so an ambiguous network failure can cause a duplicate. Shutdown keeps pending reminders on disk. This is not an operating-system alarm or a notification that works while Melo is closed.

Every background shell launch now emits a `tool_permission` event and waits for one-shot file-safety approval before starting. Destructive shell commands remain rejected in favor of the existing two-confirmation trash workflow. Mutation endpoints reject foreign browser origins, including attempts to forge approval responses. Existing local native/CLI callers without an Origin header remain supported.

Tool deadlines abort the signal passed to the underlying tool and suppress late output. The shell tool terminates its owned process group. Third-party tools must honor the cancellation signal; JavaScript cannot forcibly terminate an arbitrary in-process function that ignores it. `npm run test:audit-fixes` covers these contracts, reminder persistence/recovery, and queued state-home isolation; the full red/green gate also exercises the HTTP boundary and URL-cache evidence.

## Cleanup

`doctor --storage` is read-only and separates local model weights, tools, chats/settings, caches and logs. Do not remove the whole data directory to reclaim cache space: it contains user data and downloaded models.

Generated media-cache entries retain their seven-day TTL and are swept on writes, at most hourly, to a default 256 MiB budget (`MELO_MEDIA_CACHE_MAX_BYTES` overrides it). Only hashed cache entries are eligible; unrelated files and linked directories are excluded. This is a periodic budget, not a hard instantaneous size limit. Search-trail and image-debug logs stop appending when an individual file reaches 8 MiB without truncating old logs. The storage panel warns when aggregate logs exceed its suggested budget; it never deletes chats, agent settings or models.

Background-task Kill now signals the owned process group and waits for cleanup on server exit. Playwright sessions carry their owner's PID and a run nonce. Shutdown reaps only owned sessions; startup can reap sessions whose owner has exited, never another live Melo's browser or unowned legacy sessions.

## 多平台模型连接

在“系统 → 模型”中分别保存各平台的 API Key / 支持的 OAuth 连接，测试实际请求后切换。模型只提供推理，Melo 保留自己的任务执行逻辑。支持范围、操作和真实验收边界见 [模型连接说明](docs/llm-connections.md)。
