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
