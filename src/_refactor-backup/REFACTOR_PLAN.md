# desktopStore.js Refactor Plan

> Backup: `desktopStore.js.<timestamp>.bak` in this folder. Every phase keeps the
> backup so we can always diff against the monolith.

## Baseline inventory (2026-04-20)

- `src/desktopStore.js` — **11,728 lines, 59 exports**
- Consumers:
  - `src/server.js` — imports **49** of the 59 exports (the main consumer)
  - `src/index.js` — imports `createCustomSkill`
  - `src/agents/skillDrafting.js` — imports `normalizeCustomSkill`
  - `scripts/smoke-desktop.js` — imports `buildConversationContinuityContext`
  - Test files (10): `desktopStore.*.test.js`, `tts.test.js` (indirect)

## Target layering (user-proposed)

### 1. Query / Runtime layer — `src/runtime/QueryEngine.js`
Goal: one-turn execution kernel, UI-agnostic.
Absorbs from desktopStore:
- `runChatAgentExecutionGraph`
- System-prompt assembly
- Tool loop
- Verification loop
- Compact / memory injection
- Model invoke
- Turn lifecycle

### 2. State / Session layer — `src/state/*`
Currently all state lives in one blob. Split into:
- `state/conversation.js` — chats, messages, message blocks
- `state/workspace.js` — projects, workspace files, artifacts
- `state/agentRuntime.js` — agent profiles, model config, channels
- `state/uiPreferences.js` — selectedChatId, activeView, search strings
- `state/backgroundTasks.js` — tasks, approvals, task lanes

### 3. Service layer — `src/services/*`
Pull domain capabilities out as services:
- `services/search/fileSearch.js` — `streamSearchFileHits`
- `services/memory/*` — memory injection + compact (already partly in `src/memory/`)
- `services/compact/compact.js`
- `services/artifact/artifact.js`
- `services/approval/approval.js`
- `services/media/` — voice rewrite, TTS integration
- `services/connector/externalConnector.js` — external MCP-style connectors
- `services/remote/telegram.js`, `services/remote/discord.js` — polling runtimes

## Execution strategy

### Principles
1. **Preserve exports one-by-one.** Every extracted function gets a pass-through
   re-export from `desktopStore.js` (at least initially) so no importer ever
   breaks. Once a downstream is migrated to the new path, the pass-through can
   be removed.
2. **Zero behavior change per phase.** Each phase is a pure move + thin
   adapter, never a rewrite. Rewrites come in later passes once the structure
   is stable.
3. **Tests must pass after every phase.** Full suite:
   `node --test src/**/*.test.js`
4. **One commit = one phase.** Makes bisecting easy if something slips.

### Dependency hygiene rules
- `state/*` must not import `services/*` or `runtime/*`
- `services/*` may import `state/*` and each other when the dep graph is a DAG
- `runtime/*` may import both, but nothing in `state/*` or `services/*`
  may import `runtime/*`
- Existing `src/memory/`, `src/agents/`, `src/tools/`, `src/mcp/` trees stay
  where they are — they pre-date this refactor

### File-move safety checklist (per phase)
- [ ] Copy target code into new file with identical exports
- [ ] Replace original code with re-export from new file
- [ ] Verify there are no circular imports:
      `node --check` + load-order smoke (`import('./desktopStore.js')`)
- [ ] Re-run all existing tests — nothing new should fail
- [ ] Verify persistence paths still point to same `MELO_HOME`-rooted files
      (no hidden `__dirname`/`import.meta.url` changes broke where we write)
- [ ] Manual smoke: bootstrap the app, load a chat, send a message

## Phased roadmap

Each phase is a separate session if needed. We never push two phases in one
commit.

### Phase 1 — Offline backlog filter (this session)
- **Size:** ~90 lines (lines 197–302 + tiny helpers)
- **Risk:** Low — self-contained, already has dedicated test file
  (`desktopStore.offlineBacklog.test.js`) using `__offlineBacklogTesting`.
- **Target:** `src/services/remote/offlineBacklogFilter.js`
- **Why first:** Tiny, well-tested, zero state dependencies. Proves the
  extraction + re-export mechanism round-trips.

### Phase 2 — Voice rewrite module
- **Size:** ~200 lines (extractVoiceSummary / rewriteForVoice /
  writeVoiceDebugLine / stripMarkdown helpers)
- **Target:** `src/services/media/voiceRewrite.js`
- **Risk:** Medium — calls into `openai.js` for inference; we need to keep
  the same debug-log file path.

### Phase 3 — External connector service
- **Size:** ~450 lines (create/update/remove/ping/read/preview/invoke)
- **Target:** `src/services/connector/externalConnector.js`

### Phase 4 — Search service
- **Size:** ~350 lines (streamSearchFileHits + weighted signal scoring +
  implicit address detection + group relationship graph)
- **Target:** `src/services/search/*`

### Phase 5 — Telegram runtime
- **Size:** ~900 lines
- **Target:** `src/services/remote/telegramPolling.js`

### Phase 6 — Discord runtime
- **Size:** ~950 lines (already has test via `__discordTesting`)
- **Target:** `src/services/remote/discordPolling.js`

### Phase 7 — Artifact + workspace file service
- **Target:** `src/services/artifact/*`, `src/services/workspace/*`

### Phase 8 — Task + approval service
- **Target:** `src/services/task/*`, `src/services/approval/*`

### Phase 9 — Skill service
- **Size:** Already partially split to `src/agents/` — finish the move.
- **Target:** `src/services/skill/*`

### Phase 10 — State split
- **Size:** Big (~3000 lines of state readers/writers)
- This is the most invasive phase. Done AFTER all services are out, so the
  state module only talks to persistence + normalization helpers.

### Phase 11 — QueryEngine
- **Size:** ~1500 lines (sendChatMessage + buildModelMessagesFromChat +
  tool loop + verification loop + compact injection)
- **Target:** `src/runtime/QueryEngine.js`
- **Risk:** Highest. Only attempted after state/services are tidy and the
  surface area of this module is the well-understood "turn executor".

### Phase 12 — Cleanup
- Remove pass-through re-exports from `desktopStore.js`
- Point consumers directly at the new modules
- `desktopStore.js` becomes either a barrel re-export or is deleted
