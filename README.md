<p align="center">
  <img src="assets/melo-icon.png" width="96" alt="Melo icon">
</p>

<h1 align="center">Melo</h1>
<p align="center"><strong>One workspace for your models, projects, and memory.</strong></p>

Melo is a local-first AI workspace for macOS and iPhone. Bring the models you use, organize work into projects, and carry useful context from one conversation to the next.

Use it to research, write, code, and work with images and documents. Customize Agents for different tasks, let them collaborate, and follow their progress in a neural workspace. Conversations, saved knowledge, and memory are stored locally, with optional workspace sync; model requests use the connection you choose.

Native Android development (Kotlin + Jetpack Compose; Samsung Galaxy Z Fold6 / One UI 8.5 target): [build and validation notes](android/README.md).

## What you can do

- **Choose your models.** Connect Claude, OpenAI, OpenRouter, other supported APIs, or local models, and choose a model for each conversation.
- **Keep work together.** Organize conversations, instructions, and reference documents by project, with generated results kept separately from your knowledge library.
- **Build on past work.** Recall relevant history, share project memory, and save personal preferences for future conversations.
- **Work with Agents.** Give each Agent its own instructions, model, and capabilities. Delegate tasks or bring a team together for research, implementation, and review.
- **Use tools and media.** Work with files, commands, web research, MCP tools, and reusable skills on desktop. Use supported image, document, and voice features across devices.
- **See what is happening.** Follow execution steps, elapsed time, sources, and results, then revisit saved activity later.

## Compatibility

Melo connects to existing model and tool ecosystems, so you can choose the services that fit your work.

| Connection | Available setup |
| --- | --- |
| **Anthropic / Claude** | Anthropic Messages API with an API key. |
| **OpenAI** | OpenAI API and supported Codex OAuth connections. |
| **OpenRouter** | API key or supported browser authorization. |
| **Other providers** | Compatible API endpoints, with presets for DeepSeek, Gemini, Kimi, Qwen, and Doubao. |
| **Local and custom models** | Endpoints using a supported Chat Completions or Anthropic Messages protocol. |
| **Tools** | MCP servers and reusable skills, controlled by Agent capabilities and approvals. |

Model access, tool use, and media features depend on the selected provider, model, and account. Test your connection in Melo; see [model connections](docs/llm-connections.md) for setup details.

## Across your devices

- **macOS:** the full workspace for conversations, projects, memory, files, and tool execution.
- **iPhone:** a native app with its own model connections, conversations, media workflows, and text-based Agent teams. Independent chat works while the Mac is off; workspace synchronization is optional and configured separately.
- **Terminal:** interactive chat, single prompts, history search, and diagnostics.

Melo is actively developed, and the available tools differ by platform. Telegram and Discord integrations are temporarily archived; existing settings and conversation history are preserved.

## Recent updates

**October 17, 2026**

- Improved tool compatibility, execution controls, and activity history.
- Better context recall in long conversations and shared project memory.
- Improved iPhone conversation sync and attachment storage.

See the [changelog](CHANGELOG.md) for a brief update history.

## Run from source

You will need macOS 13 or newer, Node.js 22.13 or newer, and Xcode Command Line Tools. iPhone development also requires Xcode and device signing. Configure a model connection to start chatting.

```bash
git clone https://github.com/MortredVigoss/Melo.git
cd Melo
npm ci
npm run build
npm run build:desktop
npm run install:desktop
open "$HOME/Applications/Melo.app"
```

The first desktop build may download local embedding assets. Installation replaces `~/Applications/Melo.app` with your build. In Melo, open **System → Models**, add a connection, test it, and activate it.

For the terminal interface:

```bash
node src/index.js doctor
node src/index.js
node src/index.js chat "Summarize the project I am working on."
```

## Your data and permissions

Desktop and CLI data live in `.tmp/melo-home-user/` inside the checkout by default. Set `MELO_HOME` or use `--home` to choose another location. **Preserve this directory when updating:** it holds your conversations, settings, and memory.

Built-in memory retrieval runs locally. When you use a cloud model, the context needed for that request is sent to your configured provider. File and command access follows workspace permissions, Agent capabilities, and approvals. On iPhone, system data and selected files require local permissions; those grants do not transfer between devices.

## Development

The desktop and CLI share a modular Node.js core. The iPhone app uses SwiftUI and its own model connection path, with an optional service for workspace sync.

```bash
npm run test:plan    # preview checks for your changes
npm test            # run daily checks
npm run test:full   # run the full release gate
```

The full gate includes build, install, and native launch checks. See the [testing workflow](docs/testing-workflow.md) before running it.

- [Backend architecture](docs/backend-architecture.md)
- [Model connections](docs/llm-connections.md)
- [Memory architecture](docs/memory-architecture.md)
- [Image setup](docs/generation-setup.md)
- [iPhone development](ios/README.md)
- [UI design language](docs/ui-design-language.md)

Found a problem? Open a [GitHub issue](https://github.com/MortredVigoss/Melo/issues) with your platform and steps to reproduce. Remove credentials and private conversations from shared logs.
