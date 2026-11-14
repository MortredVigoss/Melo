// Agent settings feature state (architecture plan P2b, 2026-10-19). Owned by
// this feature: app.js neither reads nor writes it. Field names are the ones
// the moved code used on uiState, so `git log -L` / blame stay readable. Agent
// profiles themselves stay in the bootstrap (read through getBootstrap()).
function createAgentsState() {
  return {
    // Map of agentId → active channel tab ('telegram' | 'discord' | 'lark').
    // Defaults to 'telegram' on first read. Used by the channels section to
    // show one channel at a time filling the full panel width.
    agentChannelTab: {},
    // Unsaved edits per `${scope}:${projectId|'global'}:${agentId}`
    // (agentDraftKey): a global draft and each project override draft are
    // separate. Only save / cancel / reset discard one.
    agentDrafts: {},
    agentCreating: false,
    // Create flow (capability elevation rule 6): '' = the full base starter set,
    // otherwise the Agent id whose settings the new Agent copies; the persona
    // (instructions, description, mood, voice) is copied only when ticked.
    agentCreateBase: '',
    agentCreateCopyPersona: false,
    // `${agentId}:capabilities|channels` → whether the <details> is open.
    agentOpenSections: {},
    // `${agentId}:${channelId}` → whether the bot token is shown in clear.
    agentSecretVisibility: {},
    // Scroll / caret positions captured before render() rebuilds the page and
    // restored after it (captureBeforeRender / restore*AfterRender).
    agentDetailScrollTops: {},
    agentEditorStates: {},
  };
}

// Live binding: importers always see the current object.
export let agentsState = createAgentsState();

export function resetAgentsState() {
  agentsState = createAgentsState();
  return agentsState;
}
