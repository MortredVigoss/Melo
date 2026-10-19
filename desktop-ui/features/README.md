# desktop-ui feature modules

Architecture plan P2 (`docs/architecture-maintainability-plan-20261019.md` §3.2 and §8): page code moves out of `desktop-ui/app.js` one feature at a time. `app.js` keeps navigation, composition and the top-level lifecycle (`uiState`, `render()` with all its focus / caret / scroll / IME / neural-scene / Agent-editor / draft protections, the document listeners, bootstrap loading). A feature owns its state, actions, requests, renderers and styles.

Done: `memory/` and `projects/` (P2a), `agents/` (P2b), 2026-10-19. Next: chat state / events and the remaining CSS (P2c).

## Layout of one feature

```text
features/<name>/
  index.js       install<Name>Feature(context) → the handle app.js composes; the only module app.js imports
  context.js     the narrow context: names it needs, checked by ../featureContext.js, bound once (ES live bindings)
  state.js       feature-owned state (create / reset); app.js never reads or writes it
  controller.js  action + form tables, listener entry points, loaders, save flows
  api.js         the only requests the feature makes (through app.js's shared api())
  view*.js       renderers; same DOM, classes, data-attributes, ids and action names as before the move
  <name>.css     feature styles, loaded by index.html right after styles.css
  *.test.js      jsdom unit tests driven through the registry like app.js drives them
```

Pure helpers that only the feature uses move into its directory under their old names (agents: `agentDraft.js`, `agentProfilePatch.js`, `agentMcpAuthorise.js`, `capabilityChoices.js`). Browser-only imports (`/shared/*.js`, `localSettings.js`) reach a feature through its context so the feature stays importable from node tests.

## Rules

- **Context, not uiState.** A feature receives named data accessors and callbacks (`checkFeatureContext` rejects a context that carries `uiState` or misses a name). Shared page data is read through accessors such as `getBootstrap()` or `activeProject()`, never written.
- **One registration per feature, no new `case`.** `app.js` calls `featureActions.register(feature.actions, '<name>')` and `featureForms.register(feature.forms, '<name>')` once. The click and submit listeners check `has(name)` synchronously and await `dispatch()` only for registered names, inside their existing `try` (errors still reach `showError`; form edit tickets still finish in `finally`). Never `await dispatch()` unconditionally: deferring every shell action by a microtask let the submit listener's queued `render()` run before the Agent form was read (caught by `agentSettings.browser.test.js`).
- **Listener entry points keep their positions.** Input / change / toggle branches become feature functions called where the branch used to be. Change handlers stay synchronous unless they handle the event: they return `false`, `true` or the pending promise, which the listener awaits.
- **Full re-render stays.** Features return HTML and call the `render` / `bgRender` they are given; partial rendering is a later, separate step. Do not move or bypass the protections in `render()`.
- **Render hooks, not moved protections.** When a feature needs a step inside `render()` (agents: editor caret / list and detail scroll capture and restore, the Discord runtime poll), it exports a named hook and `render()` calls it exactly where the inline call used to be. The generic guards (typing / scroll deferral, focused-input caret, nested and textarea scroll, composer, neural regions) stay in `render()`; order matters, so restore hooks are separate, not one `afterRender()`.
- **Moves first, changes second.** A move commit copies bodies byte-for-byte (CLAUDE.md §5) with only import / wiring edits; state isolation, context narrowing and behaviour fixes follow in their own commit.
- **CSS:** move only rules whose selectors all belong to the feature; leave grouped rules shared with other pages in `styles.css`; carry later media overrides along so they still follow the base rule; check computed styles before and after.
- **Map:** feature directories are owned in `architecture/module-annotations.json` (`desktop-ui/features/<name>/**`); run `npm run generate:module-map` after adding files.

## Memory (`memory/`)

Customize → Memory pane (status, repair / diagnose / connect, wipe), «记住的事实» editing, the project page «记忆本», and the reply footer «本回答参考的记忆».

- Context: `api`, `render`, `bgRender`, `showError`, `activeProject`, `escapeHtml`.
- Handle: `actions` (memory-fact-*, memory-ref-*, project-book-confirm/forget/restore, memory-pause/diagnose/connect/repair, refresh-memory-status, memory-wipe-*), `forms` (project-book-create), `handleFieldInput`, `handleInput`, `handleChange`, `handleToggle`, `onBootstrap(bootstrap)`, `renderPane()`, `renderProjectBook(project)`, `renderMessageRefs(message)`, `getState()`.

## Projects (`projects/`)

Project overview (search, archived switch, create form) and detail page (settings form incl. shared knowledge selection, default Agent / team, related chats and artifacts, archive, start chat / code).

- Context: `getBootstrap`, `api`, `render`, `showError`, `patchSettings`, `applyBootstrap`, `applyBootstrapPreservingDrafts`, `startProjectSession`, `activeProject`, `activeProjectChats`, `activeProjectArtifacts`, `renderMemoryBook` (from the memory handle), `escapeHtml`, `truncate`, `icon`.
- Handle: `actions` (clear-project-selection, save-project-team, clear-project-team, chat-from-project, code-from-project, toggle-project-form, toggle-archived-projects, archive-project), `forms` (project-create, project-update), `handleSearchInput`, `handleDraftInput`, `handleChange`, `renderPage()`, `getState()`.
- Stays in `app.js` (cross-page navigation / chat): `focus-project`, `select-project` (click and select), `startProjectSession`, `projectDefaultAgentId`, `newChatProjectId`.

## Agent settings (`agents/`)

The Agent page and Customize → Agents (both render the same workbench): selection and global / project-override scope, per-Agent drafts, save, create, reset override, Markdown import / export, avatar preview, capability and collaboration settings, the channel voice card, channel test, the Markdown / channel autosave timers with their flush and unload beacon, and the editor / scroll capture that `render()` calls.

- Context: `getBootstrap`, `app` (root element), `api`, `render`, `bgRender`, `showError`, `showFlashToast`, `patchSettings`, `applyBootstrap`, `applyBootstrapPreservingDrafts`, `refreshBootstrap` (quiet reload with the current search query), `storeBootstrap` (Markdown autosave landing: replaces page data and clears the error without a render, as before the move), `activeProject`, `agentProfileById`, `minimaxTtsConfigPatchForVoice` (TTS stays in app.js), `beginFormEdit` / `formEditToken` (the settingsFormEditors edit boundary), `nativeSettings`, `isAgentChannelAvailable`, `escapeHtml`, `icon`.
- Handle: `actions` (create-custom-agent, switch-agent-scope, export-agent-document, select-agent-editor-tab, import-agent-preset, reset-agent-draft, reset-project-agent-override, toggle-agent-tool / -skill / -connector / -mcp-server, reset-agent-skill-whitelist / -connector-whitelist, toggle-agent-secret, switch-agent-channel-tab, test-agent-channel, confirm-agent-settings, clear-agent-avatar), `forms` (agent-profile-update), listener entry points `handleToggle`, `handleInput`, `handleScroll`, `handleFileChange` (false or the pending import), `handleChange`; settingsFormEditors ownership `ownsFormDraft`, `formDraftScope`, `discardFormDraft`; render hooks `captureBeforeRender`, `restoreScrollAfterRender`, `syncRuntimeRefresh`, `restoreEditorAfterRender`; `flushPending()` (navigation away) and `flushOnUnload()` (pagehide / beforeunload); `renderPage()`, `renderWorkbench(selected)`, `getState()`.
- Stays in `app.js`: `select-agent-profile` (cross-page navigation from the neural shell, team panel and the page's own select; click and change, both await `flushPending()` first), `agentProfileById` / `mainAgentProfile` (sidebar, tasks), the chat-side Agent picker (`toggle-agent-selector`, `select-chat-agent`, `renderAgentSelector*`), TTS voice helpers, the settingsFormEditors instance and its non-Agent config.
- Styles: `agents.css` (moved Agent-only rules from styles.css) loads right after `memory.css`; `agentSettings.css` (page-scoped editor overrides) moved here too and keeps its last place in index.html.
- Known dead paths, kept unchanged: `scheduleAgentChannelAutosave` / `scheduleAgentMarkdownAutosave` have had no callers since saves became explicit (2026-10-17), so the pending snapshots stay empty and the flush hooks send nothing in practice; no rendered markup emits import-agent-preset, select-agent-editor-tab or the toggle-agent-tool / -skill / -connector / -mcp-server and reset-*-whitelist actions any more. Removing them is a separate, tested change.

## Shared app state the features still reach (read-only, through the context)

| uiState field | Used by | How |
| --- | --- | --- |
| `bootstrap` (projects, artifacts, chats, activeProject, projectArtifacts, settings.activeView, customize.agents) | projects | `getBootstrap()`, `activeProject()`, `activeProjectChats()`, `activeProjectArtifacts()` |
| `bootstrap.activeProject`, `bootstrap.settings.activeView` | memory | `activeProject()`; `onBootstrap(uiState.bootstrap)` after every bootstrap lands (applyBootstrap, applyBootstrapPreservingDrafts, loadBootstrap) |
| `activeChatAgentId`, `newChatModel`, … (chat creation) | projects | only inside app.js's `startProjectSession` callback |
| `bootstrap` (customize.agents / agentPresets / agentTools / mcpAuthSurface / connectors, settings.selectedAgentId / selectedAgentScope / activeView / selectedCustomizeSection / config, syncPendingPersonas, activeProject) | agents | `getBootstrap()`, `agentProfileById()`, `activeProject()` |
| `bootstrap`, `error` (written) | agents | only through app.js callbacks: `applyBootstrap*`, `patchSettings`, `storeBootstrap` (Markdown autosave) |
| `searchQuery` | agents | only inside app.js's `refreshBootstrap` callback (4 s Discord runtime poll) |

No feature writes `uiState`. Bootstrap updates still go through app.js (`applyBootstrap*`, `patchSettings`, and for agents `storeBootstrap` / `refreshBootstrap`).

## Shared request layer

`app.js` `api()` is the one request helper every feature uses. It decodes bootstrap patches and, since P2a, settles P1 committed saves: a `{ ok: true, receipt, bootstrapError }` answer (project / Agent save committed, page data not rebuilt) is never applied as page data — `api()` re-fetches `GET /api/bootstrap` (keeping `receipt.agentExportWarning`); if that also fails it returns the current page data and shows "已保存 · …" so a committed create is not retried. See `bootstrapPatch.js` `settleCommittedSave` and `committedSave.test.js`.
