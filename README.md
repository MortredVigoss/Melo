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

- `~/.melo/config.json` by default
- `MELO_HOME=/some/path` if you want a custom config folder

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
| `MELO_COMPACT_QUALITY_GATE` | `audit` (default) writes a quality block to `~/.melo/desktop/dreams/YYYY-MM-DD.md` for every LLM-produced compact summary; `fallback` also skips the LLM result when it scores below threshold; `disabled` turns the audit off. |
| `MELO_DREAMING_ENABLED=0` | Pause the background dreaming sweep entirely. |

See `docs/memory-architecture.md` §3 for the full env table.

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

## Test and verification

```bash
npm run build
npm run build:desktop
npm run install:desktop
npm run verify:red-green
```

`npm test` is currently an alias for `npm run verify:red-green`.

## Cleanup

Melo stores runtime state under the configured `MELO_HOME` directory. To reset local config or conversation state, remove that directory and restart Melo.
