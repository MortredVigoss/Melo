// Agent settings feature state (architecture plan P2b, 2026-10-19). Owned by
// this feature: app.js neither reads nor writes it. Field names are the ones
// the moved code used on uiState, so `git log -L` / blame stay readable. Agent
// profiles themselves stay in the bootstrap (read through getBootstrap()).
export function createAgentsState() {
  return {
    // Editor tab of the legacy identity / soul editor (select-agent-editor-tab).
    agentEditorTab: 'identity',
    // Map of agentId → active channel tab ('telegram' | 'discord' | 'lark').
    // Defaults to 'telegram' on first read. Used by the channels section to
    // show one channel at a time filling the full panel width.
    agentChannelTab: {},
    // Unsaved edits per `${scope}:${projectId|'global'}:${agentId}`
    // (agentDraftKey): a global draft and each project override draft are
    // separate. Only save / cancel / reset discard one.
    agentDrafts: {},
    agentCreating: false,
    // `${agentId}:capabilities|channels` → whether the <details> is open.
    agentOpenSections: {},
    // Save-in-progress flags keyed like the drafts (agentSaveKey).
    agentSaveStates: {},
    // `${agentId}:${channelId}` → whether the bot token is shown in clear.
    agentSecretVisibility: {},
    // Scroll / caret positions captured before render() rebuilds the page and
    // restored after it (captureBeforeRender / restore*AfterRender).
    agentListScrollTop: 0,
    agentDetailScrollTops: {},
    agentEditorStates: {},
    shouldFocusAgentEditor: false,
  };
}

// Live binding: importers always see the current object.
export let agentsState = createAgentsState();

export function resetAgentsState() {
  agentsState = createAgentsState();
  return agentsState;
}
