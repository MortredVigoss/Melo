# desktop-ui feature modules

Architecture plan P2 (`docs/architecture-maintainability-plan-20261019.md` §3.2 and §8): page code moves out of `desktop-ui/app.js` one feature at a time. `app.js` keeps navigation, composition and the top-level lifecycle (`uiState`, `render()` with all its focus / caret / scroll / IME / neural-scene / Agent-editor / draft protections, the document listeners, bootstrap loading). A feature owns its state, actions, requests, renderers and styles.

Done: `memory/` and `projects/` (P2a, 2026-10-19). Next: Agent settings (P2b), chat state / events and the remaining CSS (P2c).

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

## Rules

- **Context, not uiState.** A feature receives named data accessors and callbacks (`checkFeatureContext` rejects a context that carries `uiState` or misses a name). Shared page data is read through accessors such as `getBootstrap()` or `activeProject()`, never written.
- **One registration per feature, no new `case`.** `app.js` calls `featureActions.register(feature.actions, '<name>')` and `featureForms.register(feature.forms, '<name>')` once. The click and submit listeners check `has(name)` synchronously and await `dispatch()` only for registered names, inside their existing `try` (errors still reach `showError`; form edit tickets still finish in `finally`). Never `await dispatch()` unconditionally: deferring every shell action by a microtask let the submit listener's queued `render()` run before the Agent form was read (caught by `agentSettings.browser.test.js`).
- **Listener entry points keep their positions.** Input / change / toggle branches become feature functions called where the branch used to be. Change handlers stay synchronous unless they handle the event: they return `false`, `true` or the pending promise, which the listener awaits.
- **Full re-render stays.** Features return HTML and call the `render` / `bgRender` they are given; partial rendering is a later, separate step. Do not move or bypass the protections in `render()`.
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

## Shared app state the features still reach (read-only, through the context)

| uiState field | Used by | How |
| --- | --- | --- |
| `bootstrap` (projects, artifacts, chats, activeProject, projectArtifacts, settings.activeView, customize.agents) | projects | `getBootstrap()`, `activeProject()`, `activeProjectChats()`, `activeProjectArtifacts()` |
| `bootstrap.activeProject`, `bootstrap.settings.activeView` | memory | `activeProject()`; `onBootstrap(uiState.bootstrap)` after every bootstrap lands (applyBootstrap, applyBootstrapPreservingDrafts, loadBootstrap) |
| `activeChatAgentId`, `newChatModel`, … (chat creation) | projects | only inside app.js's `startProjectSession` callback |

No feature writes `uiState`. Bootstrap updates still go through app.js (`applyBootstrap*`, `patchSettings`).

## Shared request layer

`app.js` `api()` is the one request helper every feature uses. It decodes bootstrap patches and, since P2a, settles P1 committed saves: a `{ ok: true, receipt, bootstrapError }` answer (project / Agent save committed, page data not rebuilt) is never applied as page data — `api()` re-fetches `GET /api/bootstrap` (keeping `receipt.agentExportWarning`); if that also fails it returns the current page data and shows "已保存 · …" so a committed create is not retried. See `bootstrapPatch.js` `settleCommittedSave` and `committedSave.test.js`.
