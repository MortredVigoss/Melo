// Agent settings feature controller (architecture plan P2b, 2026-10-19): the
// Agent page / Customize → Agents editor — selection and scope, per-Agent
// drafts, save and create flows, project overrides, Markdown import/export,
// avatar preview, channel test, capability/collaboration toggles, the
// (Markdown / channel) autosave timers with their flush and unload paths, and
// the editor scroll/caret capture that app.js's render() calls.
// Step 1 is a byte-for-byte move out of desktop-ui/app.js: every function body
// below is unchanged; only the action/form registration tables and the
// input/change/toggle/scroll entry points are new wiring (their bodies are the
// old `case` / listener branches). See features/README.md.
import { t } from '../../i18n.js';
import { readAgentAvatar } from '../../agentAvatar.js';
import { buildAgentProfilePatch } from './agentProfilePatch.js';
import { agentDocumentWithPreset, agentDraftFromProfile, normalizeChannelsForDraft } from './agentDraft.js';
import { decideAgentMcpAuthAction } from './agentMcpAuthorise.js';
import { uiState, app, api, render, bgRender, showError, showFlashToast, patchSettings, applyBootstrap, applyBootstrapPreservingDrafts, loadBootstrap, activeProject, agentProfileById, minimaxTtsConfigPatchForVoice, settingsFormEditors, nativeSettings, isAgentChannelAvailable } from './context.js';

let agentMarkdownAutosaveTimer = 0;
let agentMarkdownAutosaveSequence = 0;
let pendingAgentMarkdownAutosave = null;
let agentMarkdownLastInteractionAt = 0;
let agentChannelAutosaveTimer = 0;
let agentChannelAutosaveSequence = 0;
let pendingAgentChannelAutosave = null;
let agentRuntimeRefreshTimer = 0;
const AGENT_MARKDOWN_AUTOSAVE_IDLE_MS = 900;

function selectedAgentProfile() {
  return agentProfileById(uiState.bootstrap?.settings?.selectedAgentId || 'main');
}

function selectedAgentScope() {
  const scope = uiState.bootstrap?.settings?.selectedAgentScope;
  const project = activeProject();
  return scope === 'project' && project ? 'project' : 'global';
}

function agentDraftKey(agentId, scope = selectedAgentScope(), projectId = activeProject()?.id || 'global') {
  return `${scope}:${scope === 'project' ? projectId : 'global'}:${agentId}`;
}

function agentSaveKey(
  agentId,
  scope = selectedAgentScope(),
  projectId = activeProject()?.id || 'global',
) {
  return `${scope}:${scope === 'project' ? projectId : 'global'}:${agentId}`;
}

function agentSecretVisibilityKey(agentId, channelId) {
  return `${agentId}:${channelId}`;
}

// Server returns agent.channels as an ARRAY ([{id:'telegram',...},{id:'discord',...}])
// via summarizeAgentProfile, but the server's normalizeAgentChannels on the
// write path (updateAgentProfile) expects channels as an OBJECT keyed by
// channel.id. If we clone the array into the draft and then assign
// `draft.channels.telegram = { ... }`, JSON.stringify drops those string
// properties on serialization (arrays only serialize numeric indices) and
// every edit the user makes is silently thrown away — the user sees the
// checkbox bounce back, the bot token disappear, etc. Normalize to an object
// at the draft boundary so all downstream code (render, autosave POST, test
// connection) operates on a plain object.
function agentDraftFor(agent) {
  if (!agent) return null;
  const key = agentDraftKey(agent.id);
  // The cached uiState.agentDrafts entry wins so the user's in-progress
  // edits aren't blown away on every render. When there isn't a cache
  // hit, agentDraftFromProfile() (lifted to ./agentDraft.js for unit-
  // testability) builds a fresh draft from the profile — including
  // `enabledMcpServerIds`, which the previous inline copy forgot to
  // thread through. Codex 2026-04-28 audit caught that omission
  // silently dropping the per-agent MCP whitelist on save: the
  // chip-row read draft.enabledMcpServerIds (undefined → empty Set →
  // no chip is "selected"), the hidden form input submitted '', and
  // /api/agents/update happily wrote `enabledMcpServerIds: []` over
  // whatever the profile had.
  return uiState.agentDrafts[key] || agentDraftFromProfile(agent);
}

function mergeAgentDraft(agentId, patch) {
  const draftKey = agentDraftKey(agentId);
  const currentDraft = {
    ...(uiState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
  };
  uiState.agentDrafts[draftKey] = {
    ...currentDraft,
    ...patch,
  };
  return uiState.agentDrafts[draftKey];
}

function updateAgentChannelDraft(agentId, channelId, patch) {
  const currentDraft = mergeAgentDraft(agentId, {});
  // Defensive: if channels is still an array (e.g. draft was hydrated before
  // normalizeChannelsForDraft was in place, or a server payload shape change
  // slips through), coerce to object keyed by channel.id. Writing into an
  // array with a string key silently drops the edit on JSON.stringify.
  const channels = normalizeChannelsForDraft(currentDraft.channels);
  channels[channelId] = {
    ...(channels[channelId] || { id: channelId }),
    ...patch,
  };
  return mergeAgentDraft(agentId, { channels });
}

function currentAgentScrollKey() {
  if (uiState.bootstrap?.settings?.activeView !== 'agent' && !(uiState.bootstrap?.settings?.activeView === 'customize' && uiState.bootstrap?.settings?.selectedCustomizeSection === 'agents')) {
    return null;
  }

  const selected = selectedAgentProfile();
  if (!selected) {
    return null;
  }

  return `${selectedAgentScope()}:${activeProject()?.id || 'global'}:${selected.id}`;
}

function currentAgentEditorStateKey() {
  if (uiState.bootstrap?.settings?.activeView !== 'agent' && !(uiState.bootstrap?.settings?.activeView === 'customize' && uiState.bootstrap?.settings?.selectedCustomizeSection === 'agents')) {
    return null;
  }

  const selected = selectedAgentProfile();
  if (!selected) {
    return null;
  }

  const scope = selectedAgentScope();
  const projectId = scope === 'project' ? activeProject()?.id || 'global' : 'global';
  return `${scope}:${projectId}:${selected.id}:${uiState.agentEditorTab}`;
}

function captureAgentEditorState() {
  if (uiState.bootstrap?.settings?.activeView !== 'agent' && !(uiState.bootstrap?.settings?.activeView === 'customize' && uiState.bootstrap?.settings?.selectedCustomizeSection === 'agents')) {
    return;
  }

  const editor = document.querySelector('.agent-content-editor');
  const stateKey = currentAgentEditorStateKey();
  if (!(editor instanceof HTMLTextAreaElement) || !stateKey) {
    return;
  }

  uiState.agentEditorStates[stateKey] = {
    scrollTop: editor.scrollTop,
    selectionStart: editor.selectionStart,
    selectionEnd: editor.selectionEnd,
    focused: document.activeElement === editor,
  };
}

function captureAgentScrollState() {
  if (uiState.bootstrap?.settings?.activeView !== 'agent' && !(uiState.bootstrap?.settings?.activeView === 'customize' && uiState.bootstrap?.settings?.selectedCustomizeSection === 'agents')) {
    return;
  }

  const listPane = document.querySelector('.agent-list-pane');
  if (listPane instanceof HTMLElement) {
    uiState.agentListScrollTop = listPane.scrollTop;
  }

  const detailPane = document.querySelector('.agent-detail-column');
  const scrollKey = currentAgentScrollKey();
  if (detailPane instanceof HTMLElement && scrollKey) {
    uiState.agentDetailScrollTops[scrollKey] = detailPane.scrollTop;
  }
}

function restoreAgentScrollState() {
  if (uiState.bootstrap?.settings?.activeView !== 'agent' && !(uiState.bootstrap?.settings?.activeView === 'customize' && uiState.bootstrap?.settings?.selectedCustomizeSection === 'agents')) {
    return;
  }

  const listPane = document.querySelector('.agent-list-pane');
  if (listPane instanceof HTMLElement) {
    listPane.scrollTop = uiState.agentListScrollTop || 0;
  }

  const detailPane = document.querySelector('.agent-detail-column');
  const scrollKey = currentAgentScrollKey();
  if (detailPane instanceof HTMLElement && scrollKey) {
    detailPane.scrollTop = uiState.agentDetailScrollTops[scrollKey] || 0;
  }
}

function restoreAgentEditorState() {
  if (uiState.bootstrap?.settings?.activeView !== 'agent') {
    return;
  }

  const stateKey = currentAgentEditorStateKey();
  if (!stateKey) {
    return;
  }

  const editorState = uiState.agentEditorStates[stateKey];
  if (!editorState && !uiState.shouldFocusAgentEditor) {
    return;
  }

  window.requestAnimationFrame(() => {
    const editor = document.querySelector('.agent-content-editor');
    if (!(editor instanceof HTMLTextAreaElement) || stateKey !== currentAgentEditorStateKey()) {
      return;
    }
    // A user may focus/select text between render and this animation frame.
    // Never replace that newer selection with the previous render's caret.
    if (document.activeElement === editor) return;

    if (editorState?.focused) {
      // CRITICAL: in WKWebView, calling textarea.setSelectionRange(...) has
      // the side-effect of implicitly focusing the textarea — even though
      // we're only trying to "remember" where the caret was. That means the
      // anotherFieldFocused guard below used to be too late: by the time we
      // checked document.activeElement, setSelectionRange had already
      // stolen focus from the user's currently-typed input (e.g. the
      // Discord/Telegram Bot token, Group ID, or Channel ID field that
      // lives in the same form as IDENTITY.md). We now gate the whole
      // scroll + setSelectionRange + focus restore behind the same guard,
      // so a background re-render landing mid-typing doesn't touch the
      // IDENTITY.md editor at all. The editor's selection will be
      // re-applied the next time it actually gets focus.
      const active = document.activeElement;
      const anotherFieldFocused =
        active !== editor &&
        (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement);

      if (!anotherFieldFocused) {
        editor.scrollTop = editorState.scrollTop || 0;
        const maxPosition = editor.value.length;
        const selectionStart = Math.min(editorState.selectionStart ?? maxPosition, maxPosition);
        const selectionEnd = Math.min(editorState.selectionEnd ?? selectionStart, maxPosition);
        try {
          editor.setSelectionRange(selectionStart, selectionEnd);
        } catch {}

        if (editorState.focused) {
          editor.focus({ preventScroll: true });
        }
      }
    }

    if (uiState.shouldFocusAgentEditor) {
      editor.focus({ preventScroll: true });
      editor.selectionStart = editor.selectionEnd = editor.value.length;
      uiState.shouldFocusAgentEditor = false;
    }
  });
}

function agentPresetById(presetId) {
  return uiState.bootstrap?.customize?.agentPresets?.find(preset => preset.id === presetId) || null;
}

function agentToolOptions() {
  return uiState.bootstrap?.customize?.agentTools || [];
}

function selectedAgentNeedsRuntimeRefresh() {
  if (uiState.bootstrap?.settings?.activeView !== 'agent') {
    return false;
  }

  const selected = selectedAgentProfile();
  if (!selected) {
    return false;
  }

  const discordChannel =
    selected.channels?.find?.(channel => channel.id === 'discord') ||
    selected.channels?.discord;

  return Boolean(discordChannel?.enabled);
}

function syncAgentRuntimeRefresh() {
  window.clearTimeout(agentRuntimeRefreshTimer);

  if (!selectedAgentNeedsRuntimeRefresh()) {
    return;
  }

  agentRuntimeRefreshTimer = window.setTimeout(async () => {
    if (!selectedAgentNeedsRuntimeRefresh()) {
      return;
    }

    try {
      await loadBootstrap(uiState.searchQuery, { quiet: true });
    } catch {}
  }, 4000);
}

async function handleCreateCustomAgent() {
  if (uiState.agentCreating) return;
  uiState.agentCreating = true;
  render();
  try {
    const payload = await api('/api/agents/create-custom', { method: 'POST', body: {} });
    applyBootstrap(payload);
    const form = app.querySelector('form[data-form="agent-profile-update"]');
    if (form) settingsFormEditors.begin(form);
    render();
    app.querySelector('form[data-form="agent-profile-update"] [name="name"]')?.select();
  } finally {
    uiState.agentCreating = false;
    const button = app.querySelector('[data-action="create-custom-agent"]');
    if (button) { button.disabled = false; button.textContent = t('新增 Agent'); }
  }
}

async function handleUpdateAgentProfile(form) {
  const formData = new FormData(form);
  const project = activeProject();
  const scope = selectedAgentScope();
  const projectId = scope === 'project' ? project?.id || 'global' : 'global';
  const saveKey = agentSaveKey(form.dataset.agentId, scope, projectId);
  const draftKey = agentDraftKey(form.dataset.agentId, scope, project?.id || 'global');
  const patch = buildAgentProfilePatch(form, formData);
  const avatarDraft = agentDraftFor(agentProfileById(form.dataset.agentId));
  if (Object.hasOwn(avatarDraft || {}, 'avatarData')) patch.avatarData=avatarDraft.avatarData;

  const minimumVisibleMs = 100;
  const waitForMinimumVisibleState = new Promise(resolve => setTimeout(resolve, minimumVisibleMs));

  uiState.agentSaveStates[saveKey] = true;
  bgRender();

  try {
    const payload = await api('/api/agents/update', {
      method: 'POST',
      body: {
        agentId: form.dataset.agentId,
        scope,
        projectId: scope === 'project' ? project?.id : null,
        activeView: uiState.bootstrap?.settings?.activeView || 'customize',
        patch,
      },
    });
    await waitForMinimumVisibleState;
    delete uiState.agentDrafts[draftKey];
    applyBootstrap(payload);
    if (payload.agentExportWarning) showError(payload.agentExportWarning);
    const activeTtsConfig = uiState.bootstrap?.settings?.config || {};
    const savedVoiceId = String(patch.minimaxVoiceId || '').trim();
    if (
      activeTtsConfig.ttsProvider === 'minimax' &&
      savedVoiceId &&
      activeTtsConfig.minimaxVoiceId === savedVoiceId
    ) {
      api('/api/settings/model', {
        method: 'POST',
        body: minimaxTtsConfigPatchForVoice(savedVoiceId),
      }).then(nextPayload => applyBootstrapPreservingDrafts(nextPayload)).catch(() => {});
    }
  } finally {
    await waitForMinimumVisibleState;
    delete uiState.agentSaveStates[saveKey];
    render();
  }
}

async function handleTestAgentChannel(trigger) {
  const form = trigger.closest('form');
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  // Test the persisted channel. Drafts are committed only by Save.
  const channelId = trigger.dataset.channelId;
  const project = activeProject();
  const scope = selectedAgentScope();
  const patch = {};

  const payload = await api('/api/agents/channel/test', {
    method: 'POST',
    body: {
      agentId: form.dataset.agentId,
      channelId,
      scope,
      projectId: scope === 'project' ? project?.id : null,
      patch,
    },
  });
  applyBootstrap(payload);
}

async function saveAgentMarkdownSnapshot(snapshot) {
  if (!snapshot?.agentId) {
    return;
  }

  const requestSequence = ++agentMarkdownAutosaveSequence;
  const payload = await api('/api/agents/update', {
    method: 'POST',
    body: {
      agentId: snapshot.agentId,
      scope: snapshot.scope,
      projectId: snapshot.scope === 'project' ? snapshot.projectId : null,
      activeView: uiState.bootstrap?.settings?.activeView || 'agent',
      patch: {
        identity: String(snapshot.identity || '').trim(),
        'soul.md': String(snapshot.soulMd || '').trim(),
      },
    },
  });

  if (requestSequence !== agentMarkdownAutosaveSequence) {
    return;
  }

  uiState.bootstrap = payload;
  uiState.error = '';
}

async function saveAgentChannelSnapshot(snapshot) {
  if (!snapshot?.agentId || !snapshot?.channels) {
    return;
  }

  const saveKey = agentSaveKey(
    snapshot.agentId,
    snapshot.scope,
    snapshot.scope === 'project' ? snapshot.projectId || 'global' : 'global',
  );
  const minimumVisibleMs = 100;
  const waitForMinimumVisibleState = new Promise(resolve => setTimeout(resolve, minimumVisibleMs));
  const requestSequence = ++agentChannelAutosaveSequence;
  // Mark the save-in-progress flag, but do NOT render here. A render() in the
  // middle of the save pipeline blows away document.activeElement and the
  // input caret position, which is exactly what caused "光标会自动跳到最上面
  // 输入金冬天id的那个输入框" — the user's caret was yanked out of the Discord
  // Group ID input the moment the 3-second idle timer fired. Any UI that
  // depends on agentSaveStates (the "Saving…" button label) will pick up the
  // new flag on the next render triggered by an actual DOM event (keystroke,
  // scroll, focus), which is visually indistinguishable at human timescales.
  uiState.agentSaveStates[saveKey] = true;

  // Channel autosave also carries the three voice settings edited on the
  // channel voice section (voiceReplyMode, edgeTtsVoice, voicePersonality). They are
  // agent-level, not nested under channels, but they share the same autosave
  // trigger so the user never has to hit a separate save button. Only include
  // them when they are present on the snapshot to avoid overwriting a saved
  // value with undefined on unrelated autosaves.
  const patch = { channels: snapshot.channels };
  if (typeof snapshot.voiceReplyMode === 'string') {
    patch.voiceReplyMode = snapshot.voiceReplyMode;
  }
  if (typeof snapshot.edgeTtsVoice === 'string') {
    patch.edgeTtsVoice = snapshot.edgeTtsVoice;
  }
  if (typeof snapshot.voicePersonality === 'string') {
    patch.voicePersonality = snapshot.voicePersonality;
  }

  try {
    const payload = await api('/api/agents/update', {
      method: 'POST',
      body: {
        agentId: snapshot.agentId,
        scope: snapshot.scope,
        projectId: snapshot.scope === 'project' ? snapshot.projectId : null,
        activeView: uiState.bootstrap?.settings?.activeView || 'agent',
        patch,
      },
    });

    if (requestSequence !== agentChannelAutosaveSequence) {
      return;
    }

    await waitForMinimumVisibleState;
    // Use the preserving variant so the user's still-typing draft isn't
    // discarded when this autosave response lands. Without this, every
    // 3-second autosave rebuilt the agent form from server-side state and
    // silently dropped any chars typed during the round-trip.
    applyBootstrapPreservingDrafts(payload, { background: true });
  } finally {
    await waitForMinimumVisibleState;
    if (requestSequence === agentChannelAutosaveSequence) {
      delete uiState.agentSaveStates[saveKey];
      // Background-render: if the user is still typing, the typing guard in
      // render() will defer until they go idle. Prevents the autosave landing
      // from yanking the caret out of whatever input they're still editing.
      render({ background: true });
    }
  }
}

function scheduleAgentChannelAutosave(agentId) {
  const agent = agentProfileById(agentId);
  const draft = agentDraftFor(agent);
  if (!agent || !draft) {
    return;
  }

  // Capture the current draft including agent-level voice fields edited on the
  // channel voice section so saveAgentChannelSnapshot can forward them. Using draft
  // values (not DOM reads) avoids losing in-flight edits when the autosave
  // timer fires after the user has moved focus.
  pendingAgentChannelAutosave = {
    agentId,
    scope: selectedAgentScope(),
    projectId: activeProject()?.id || null,
    // normalizeChannelsForDraft defends against the server→client array shape
    // leaking into the POST body. Server expects {telegram:{...}, discord:{...}},
    // not [{id:'telegram',...}].
    channels: normalizeChannelsForDraft(draft.channels),
    voiceReplyMode:
      typeof draft.voiceReplyMode === 'string' ? draft.voiceReplyMode : undefined,
    edgeTtsVoice:
      typeof draft.edgeTtsVoice === 'string' ? draft.edgeTtsVoice : undefined,
    voicePersonality:
      typeof draft.voicePersonality === 'string' ? draft.voicePersonality : undefined,
  };

  window.clearTimeout(agentChannelAutosaveTimer);
  // 3-second idle debounce. The user explicitly asked for "输入了一半三秒没动作
  // 就自动保存一下已经输入的内容" — fire only after the user has stopped typing
  // for 3 full seconds. The old 350ms threshold triggered mid-typing, which
  // combined with the full-DOM re-render on save response caused caret jumps
  // and focus loss between keystrokes.
  agentChannelAutosaveTimer = window.setTimeout(async () => {
    const snapshot = pendingAgentChannelAutosave;
    pendingAgentChannelAutosave = null;
    try {
      await saveAgentChannelSnapshot(snapshot);
    } catch (error) {
      showError(error.message);
    }
  }, 3000);
}

function scheduleAgentMarkdownAutosave(agentId) {
  const agent = agentProfileById(agentId);
  const draft = agentDraftFor(agent);
  if (!agent || !draft) {
    return;
  }

  pendingAgentMarkdownAutosave = {
    agentId,
    scope: selectedAgentScope(),
    projectId: activeProject()?.id || null,
    identity: draft.identity || draft.identify || '',
    soulMd: draft['soul.md'] || '',
  };

  agentMarkdownLastInteractionAt = Date.now();

  window.clearTimeout(agentMarkdownAutosaveTimer);
  const runWhenIdle = async () => {
    const remainingIdleMs =
      AGENT_MARKDOWN_AUTOSAVE_IDLE_MS - (Date.now() - agentMarkdownLastInteractionAt);
    if (remainingIdleMs > 24) {
      agentMarkdownAutosaveTimer = window.setTimeout(runWhenIdle, remainingIdleMs);
      return;
    }

    const snapshot = pendingAgentMarkdownAutosave;
    pendingAgentMarkdownAutosave = null;
    try {
      await saveAgentMarkdownSnapshot(snapshot);
    } catch (error) {
      showError(error.message);
    }
  };

  agentMarkdownAutosaveTimer = window.setTimeout(runWhenIdle, AGENT_MARKDOWN_AUTOSAVE_IDLE_MS);
}

async function flushPendingAgentMarkdownAutosave() {
  if (!pendingAgentMarkdownAutosave) {
    return;
  }

  window.clearTimeout(agentMarkdownAutosaveTimer);
  const snapshot = pendingAgentMarkdownAutosave;
  pendingAgentMarkdownAutosave = null;
  await saveAgentMarkdownSnapshot(snapshot);
}

// Counterpart to flushPendingAgentMarkdownAutosave for the channel (Discord /
// Telegram token + guildId + channelId + voiceReply + voiceReplyMode +
// edgeTtsVoice + voicePersonality) autosave pipeline. Without this, any edit
// the user made in the Discord Bot token / Guild ID / Channel ID inputs
// during the 3-second idle window was silently dropped when they switched
// agents, switched scopes, quit the app, or closed the window — matching the
// recurring "我昨天就配置好了这些参数，为什么今天打开这些东西又没了" report.
// See feedback_preserve_user_config.md.
async function flushPendingAgentChannelAutosave() {
  if (!pendingAgentChannelAutosave) {
    return;
  }

  window.clearTimeout(agentChannelAutosaveTimer);
  const snapshot = pendingAgentChannelAutosave;
  pendingAgentChannelAutosave = null;
  await saveAgentChannelSnapshot(snapshot);
}

// Best-effort, synchronous flush used on page unload. Uses navigator.sendBeacon
// when possible so the POST makes it to the server even after the window is
// closed and the event loop stops ticking. sendBeacon is fire-and-forget and
// cannot surface a response, so we do not update bootstrap here — the next
// session will load the freshly-persisted state from state.json anyway.
function flushPendingAgentAutosavesOnUnload() {
  const channelSnapshot = pendingAgentChannelAutosave;
  const markdownSnapshot = pendingAgentMarkdownAutosave;
  pendingAgentChannelAutosave = null;
  pendingAgentMarkdownAutosave = null;

  if (channelSnapshot?.agentId && channelSnapshot?.channels) {
    const patch = { channels: channelSnapshot.channels };
    if (typeof channelSnapshot.voiceReplyMode === 'string') {
      patch.voiceReplyMode = channelSnapshot.voiceReplyMode;
    }
    if (typeof channelSnapshot.edgeTtsVoice === 'string') {
      patch.edgeTtsVoice = channelSnapshot.edgeTtsVoice;
    }
    if (typeof channelSnapshot.voicePersonality === 'string') {
      patch.voicePersonality = channelSnapshot.voicePersonality;
    }
    const body = JSON.stringify({
      agentId: channelSnapshot.agentId,
      scope: channelSnapshot.scope,
      projectId: channelSnapshot.scope === 'project' ? channelSnapshot.projectId : null,
      activeView: uiState.bootstrap?.settings?.activeView || 'agent',
      patch,
    });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          '/api/agents/update',
          new Blob([body], { type: 'application/json' }),
        );
      } else {
        fetch('/api/agents/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch {}
  }

  if (markdownSnapshot?.agentId) {
    const body = JSON.stringify({
      agentId: markdownSnapshot.agentId,
      scope: markdownSnapshot.scope,
      projectId: markdownSnapshot.scope === 'project' ? markdownSnapshot.projectId : null,
      activeView: uiState.bootstrap?.settings?.activeView || 'agent',
      patch: {
        identity: String(markdownSnapshot.identity || '').trim(),
        'soul.md': String(markdownSnapshot.soulMd || '').trim(),
      },
    });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          '/api/agents/update',
          new Blob([body], { type: 'application/json' }),
        );
      } else {
        fetch('/api/agents/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch {}
  }
}

async function handleImportAgentPreset(agentId, presetId) {
  const preset = agentPresetById(presetId);
  if (!preset) {
    showError('Preset not found.');
    return;
  }

  const previous = agentDraftFor(agentProfileById(agentId));
  const instructions = agentDocumentWithPreset(previous?.instructions, preset);
  mergeAgentDraft(agentId, {
    instructions,
    identity: preset.identity || preset.identify,
    'soul.md': preset.soulMd,
  });
  render();
}

async function handleResetProjectAgentOverride(agentId) {
  const project = activeProject();
  if (!project) {
    showError('Choose a project before resetting an override.');
    return;
  }

  const payload = await api('/api/agents/update', {
    method: 'POST',
    body: {
      agentId,
      scope: 'project',
      projectId: project.id,
      activeView: uiState.bootstrap?.settings?.activeView || 'customize',
      clearProjectOverride: true,
    },
  });
  delete uiState.agentDrafts[agentDraftKey(agentId, 'project', project.id)];
  applyBootstrap(payload);
}

// Click actions (formerly `case` branches of app.js's click dispatch),
// registered once by app.js through the feature registry.
export const agentsActions = {
  'create-custom-agent': async () => {
    await handleCreateCustomAgent();
  },
  'switch-agent-scope': async ({ trigger }) => {
    await flushPendingAgentMarkdownAutosave();
    await flushPendingAgentChannelAutosave();
    await patchSettings({
      activeView:
        uiState.bootstrap.settings.activeView === 'agent' ? 'agent' : 'customize',
      selectedCustomizeSection: 'agents',
      selectedAgentScope: trigger.dataset.scope === 'project' ? 'project' : 'global',
    });
  },
  'export-agent-document': async ({ trigger }) => {
    const draft = agentDraftFor(agentProfileById(trigger.dataset.agentId));
    const text = draft?.instructions ?? '';
    if (window.webkit?.messageHandlers?.meloVoice) {
      const result = await nativeSettings('savePortableArchive', {text, name:'AGENT.md'});
      showFlashToast(result.cancelled ? t('已取消导出。') : t('已导出 Markdown。'));
      return;
    }
    const url = URL.createObjectURL(new Blob([text], {type:'text/markdown;charset=utf-8'}));
    const link = document.createElement('a'); link.href=url; link.download='AGENT.md'; link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    return;
  },
  'select-agent-editor-tab': async ({ trigger }) => {
    await flushPendingAgentMarkdownAutosave();
    await flushPendingAgentChannelAutosave();
    uiState.agentEditorTab = trigger.dataset.tab === 'soul' ? 'soul' : 'identity';
    uiState.shouldFocusAgentEditor = true;
    render();
  },
  'import-agent-preset': async ({ trigger }) => {
    await handleImportAgentPreset(trigger.dataset.agentId, trigger.dataset.presetId);
  },
  'reset-agent-draft': ({ trigger }) => {
    const agentId = trigger.dataset.agentId;
    if (agentId) {
      delete uiState.agentDrafts[agentDraftKey(agentId)];
      render();
    }
  },
  'reset-project-agent-override': async ({ trigger }) => {
    await handleResetProjectAgentOverride(trigger.dataset.agentId);
  },
  'toggle-agent-tool': ({ trigger }) => {
    const agentId = trigger.dataset.agentId;
    const toolId = trigger.dataset.toolId;
    const draftKey = agentDraftKey(agentId);
    const currentDraft = {
      ...(uiState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
    };
    const nextTools = new Set(currentDraft.tools || []);
    if (nextTools.has(toolId)) {
      nextTools.delete(toolId);
    } else {
      nextTools.add(toolId);
    }
    currentDraft.tools = [...nextTools];
    uiState.agentDrafts[draftKey] = currentDraft;
    render();
  },
  'toggle-agent-skill': ({ trigger }) => {
    // Toggle a specific skill ID in the per-agent skill whitelist.
    // null draft value means "no restriction" — first toggle initialises it to [skillId].
    const agentId = trigger.dataset.agentId;
    const skillId = trigger.dataset.skillId;
    const draftKey = agentDraftKey(agentId);
    const currentDraft = {
      ...(uiState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
    };
    const currentIds = Array.isArray(currentDraft.enabledSkillIds)
      ? new Set(currentDraft.enabledSkillIds)
      : new Set(); // null → treat as empty set so first click adds the skill
    if (currentIds.has(skillId)) {
      currentIds.delete(skillId);
    } else {
      currentIds.add(skillId);
    }
    currentDraft.enabledSkillIds = [...currentIds];
    uiState.agentDrafts[draftKey] = currentDraft;
    render();
  },
  'reset-agent-skill-whitelist': ({ trigger }) => {
    // Reset to "no restriction" (null = all skills allowed)
    const agentId = trigger.dataset.agentId;
    const draftKey = agentDraftKey(agentId);
    const currentDraft = {
      ...(uiState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
    };
    currentDraft.enabledSkillIds = null;
    uiState.agentDrafts[draftKey] = currentDraft;
    render();
  },
  'toggle-agent-connector': ({ trigger }) => {
    // Toggle a specific external connector ID in the per-agent connector whitelist.
    const agentId = trigger.dataset.agentId;
    const connectorId = trigger.dataset.connectorId;
    const draftKey = agentDraftKey(agentId);
    const currentDraft = {
      ...(uiState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
    };
    const currentIds = Array.isArray(currentDraft.enabledConnectorIds)
      ? new Set(currentDraft.enabledConnectorIds)
      : new Set();
    if (currentIds.has(connectorId)) {
      currentIds.delete(connectorId);
    } else {
      currentIds.add(connectorId);
    }
    currentDraft.enabledConnectorIds = [...currentIds];
    uiState.agentDrafts[draftKey] = currentDraft;
    render();
  },
  'reset-agent-connector-whitelist': ({ trigger }) => {
    const agentId = trigger.dataset.agentId;
    const draftKey = agentDraftKey(agentId);
    const currentDraft = {
      ...(uiState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
    };
    currentDraft.enabledConnectorIds = null;
    uiState.agentDrafts[draftKey] = currentDraft;
    render();
  },
  'toggle-agent-mcp-server': ({ trigger }) => {
    // Toggle a specific stdio MCP server id in the per-agent whitelist.
    // No "All servers" sentinel here — MCP defaults to deny-all, the
    // user has to add each server explicitly.
    //
    // Rules:
    //   - Removing (whitelist already contains the id) is always
    //     allowed, even when the server is globally disabled. This
    //     lets the user revoke stale authorisations after toggling
    //     a server off in Advanced (without it, a re-enable later
    //     would silently grant the old access back — Codex 🔵
    //     2026-04-28 audit).
    //   - Adding a new authorisation for a globally-disabled
    //     server is refused with a flash-toast pointing the user
    //     at Advanced. Better than failing silently.
    const agentId = trigger.dataset.agentId;
    const mcpServerId = trigger.dataset.mcpServerId;
    const presetEnabled = trigger.dataset.presetEnabled === '1';
    const presetUnpinned = trigger.dataset.presetUnpinned === '1';
    const draftKey = agentDraftKey(agentId);
    const currentDraft = {
      ...(uiState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
    };
    // Decision lives in `desktop-ui/agentMcpAuthorise.js` so node:test
    // can pin the remove-always-allowed / add-refused-on-disabled-or-
    // unpinned table without simulating click events.
    const decision = decideAgentMcpAuthAction({
      currentIds: currentDraft.enabledMcpServerIds,
      serverId: mcpServerId,
      presetEnabled,
      presetUnpinned,
    });
    if (decision.action.startsWith('refused-') || decision.action === 'refused-invalid') {
      if (decision.toast) showFlashToast(decision.toast);
      return;
    }
    currentDraft.enabledMcpServerIds = decision.nextIds;
    uiState.agentDrafts[draftKey] = currentDraft;
    render();
  },
  'toggle-agent-secret': ({ trigger }) => {
    const agentId = trigger.dataset.agentId;
    const channelId = trigger.dataset.channelId;
    if (agentId && channelId) {
      const key = agentSecretVisibilityKey(agentId, channelId);
      uiState.agentSecretVisibility[key] = !uiState.agentSecretVisibility[key];
      render();
    }
  },
  'switch-agent-channel-tab': async ({ trigger }) => {
    const agentId = trigger.dataset.agentId;
    const channelId = trigger.dataset.channelId;
    const VALID_TABS = ['telegram', 'discord'].filter(id => isAgentChannelAvailable(id));
    if (agentId && VALID_TABS.includes(channelId)) {
      // Flush any pending debounced autosave before switching tabs so
      // in-flight edits (e.g. a bot token typed <350ms ago) are not lost
      // when the re-render discards the draft.
      if (pendingAgentChannelAutosave && pendingAgentChannelAutosave.agentId === agentId) {
        if (agentChannelAutosaveTimer) {
          window.clearTimeout(agentChannelAutosaveTimer);
          agentChannelAutosaveTimer = null;
        }
        const snapshot = pendingAgentChannelAutosave;
        pendingAgentChannelAutosave = null;
        try {
          await saveAgentChannelSnapshot(snapshot);
        } catch (error) {
          showError(error.message);
          return;
        }
      }
      uiState.agentChannelTab[agentId] = channelId;
      render();
    }
  },
  'test-agent-channel': async ({ trigger }) => {
    await handleTestAgentChannel(trigger);
  },
  'confirm-agent-settings': async ({ trigger }) => {
    await api('/api/agent-settings-sync/confirm',{method:'POST',body:{id:trigger.dataset.id,expected:trigger.dataset.expected,accept:trigger.dataset.accept==='true'}});
    applyBootstrap(await api('/api/bootstrap'));
  },
  'clear-agent-avatar': ({ trigger }) => {
    mergeAgentDraft(trigger.dataset.agentId,{avatarData:''});
    render();
  },
};

// Form submits (formerly `case` branches of app.js's submit listener).
export const agentsForms = {
  'agent-profile-update': async ({ form }) => {
    await handleUpdateAgentProfile(form);
  },
};

// Formerly part of app.js's capture-phase 'toggle' listener: remembers which
// Agent sections (capabilities / channels) the user opened.
export function handleAgentSectionToggle(event) {
  const key = event.target.dataset?.agentSection;
  if (key) uiState.agentOpenSections[key] = event.target.open;
}

// Last branch of app.js's 'input' listener. Returns true when it handled the event.
export function handleAgentProfileInput(target) {
  if (target.form?.dataset.form === 'agent-profile-update') {
    const agentId = target.form.dataset.agentId;
    if (['telegramBotToken', 'telegramChatId', 'discordBotToken', 'discordGuildId', 'discordChannelId'].includes(target.name)) {
      const channelId = target.name.startsWith('telegram') ? 'telegram' : 'discord';
      const fieldName =
        target.name === 'telegramBotToken' || target.name === 'discordBotToken'
          ? 'botToken'
          : target.name === 'telegramChatId'
            ? 'chatId'
            : target.name === 'discordGuildId'
              ? 'guildId'
              : 'channelId';
      updateAgentChannelDraft(agentId, channelId, {
        [fieldName]: target.value,
      });
      // Schedule autosave on every keystroke so the token isn't lost if the
      // user switches tabs or hits the Test button before the field blurs.
      // Debounced inside scheduleAgentChannelAutosave (350ms).
      // Settings are committed only by the explicit Save action.
      return true;
    }

    // voiceReplyMode / edgeTtsVoice / voicePersonality are agent-level fields
    // edited on the Telegram panel. Persist them through the same channel
    // autosave pipeline so they don't get lost when applyBootstrap() clears
    // agent drafts.
    if (['voiceReplyMode', 'edgeTtsVoice', 'voicePersonality'].includes(target.name)) {
      mergeAgentDraft(agentId, {
        [target.name]: target.hasAttribute('data-capability-choice') ? new FormData(target.form).getAll(target.name) : target.type === 'checkbox' ? (target.checked ? 'on' : '') : target.value,
      });
      // Settings are committed only by the explicit Save action.
      return true;
    }

    const nextDraft = mergeAgentDraft(agentId, {
      [target.name]: target.hasAttribute('data-capability-choice') ? new FormData(target.form).getAll(target.name) : target.type === 'checkbox' ? (target.checked ? 'on' : '') : target.value,
    });
    if (target.name === 'identity') {
      nextDraft.identify = target.value;
      captureAgentEditorState();
      // Settings are committed only by the explicit Save action.
    } else if (target.name === 'soul.md' || target.name === 'instructions') {
      captureAgentEditorState();
      // Settings are committed only by the explicit Save action.
    }
    return true;
  }
  return false;
}

// app.js's capture-phase 'scroll' listener body.
export function handleAgentEditorScroll(event) {
  const target = event.target;
  if (target instanceof HTMLTextAreaElement && target.classList.contains('agent-content-editor')) {
    captureAgentEditorState();
    if (pendingAgentMarkdownAutosave) {
      agentMarkdownLastInteractionAt = Date.now();
    }
    return;
  }

  if (target instanceof HTMLElement && target.classList.contains('agent-detail-column')) {
    captureAgentScrollState();
    if (pendingAgentMarkdownAutosave) {
      agentMarkdownLastInteractionAt = Date.now();
    }
  }
}

// 'change' listener branches for the Markdown import and avatar file inputs,
// at their original position. Synchronous unless it handles the event:
// returns false (not ours) or the pending import, which the listener awaits.
export function handleAgentFileChange(target) {
  if (target instanceof HTMLInputElement && target.dataset.agentDocument) return importAgentDocument(target);
  if (target instanceof HTMLInputElement && target.dataset.agentAvatar) return previewAgentAvatar(target);
  return false;
}

async function importAgentDocument(target) {
    const agentId = target.dataset.agentDocument;
    const editIsCurrent = settingsFormEditors.editToken(target.form);
    const key = agentDraftKey(agentId);
    try {
      const file=target.files?.[0]; if(!file) return;
      if(file.size > 1000000) throw new Error('Markdown 文件过大，请控制在 1 MB 内。');
      const instructions=await file.text();
      if(instructions.length > 200100) throw new Error('Agent 人设文档超过 200100 字符。');
      if(!editIsCurrent()) return;
      uiState.agentDrafts[key]={...agentDraftFor(agentProfileById(agentId)),instructions};
      render();
    } catch(error) { showError(error.message); }
}

async function previewAgentAvatar(target) {
    const isCurrentEdit=settingsFormEditors.editToken(target.form);
    const draftKey=agentDraftKey(target.dataset.agentAvatar);
    const originalDraft=agentDraftFor(agentProfileById(target.dataset.agentAvatar));
    try {
      const avatarData = await readAgentAvatar(target.files?.[0]);
      if(!isCurrentEdit()) return;
      uiState.agentDrafts[draftKey]={...originalDraft,...uiState.agentDrafts[draftKey],avatarData};
      render();
    }
    catch (error) { showError(error.message); }
}

// Last branch inside the 'change' listener's try (agent-profile-update form
// fields). Synchronous; returns true when it handled the event.
export function handleAgentProfileChange(target) {
  if (target.form?.dataset.form === 'agent-profile-update') {
    const agentId = target.form.dataset.agentId;
    if (['telegramEnabled', 'discordEnabled'].includes(target.name)) {
      const channelId = target.name === 'telegramEnabled' ? 'telegram' : 'discord';
      updateAgentChannelDraft(agentId, channelId, {
        enabled: target.checked,
      });
      // Settings are committed only by the explicit Save action.
      render();
      return true;
    }

    // Send voice reply checkbox: belongs to the Telegram channel (voiceReply),
    // not to a top-level agent field. Before this was routed through the
    // fallthrough below and got written to draft[target.name] as the string
    // "on" — which made render() read back the stale channels.telegram.voiceReply
    // and visibly bounce the checkbox back to unchecked.
    if (target.name === 'telegramVoiceReply' || target.name === 'discordVoiceReply') {
      const channelId = target.name === 'telegramVoiceReply' ? 'telegram' : 'discord';
      updateAgentChannelDraft(agentId, channelId, {
        voiceReply: target.checked,
      });
      // Settings are committed only by the explicit Save action.
      render();
      return true;
    }

    if (['telegramBotToken', 'telegramChatId', 'discordBotToken', 'discordGuildId', 'discordChannelId'].includes(target.name)) {
      const channelId = target.name.startsWith('telegram') ? 'telegram' : 'discord';
      const fieldName =
        target.name === 'telegramBotToken' || target.name === 'discordBotToken'
          ? 'botToken'
          : target.name === 'telegramChatId'
            ? 'chatId'
            : target.name === 'discordGuildId'
              ? 'guildId'
              : 'channelId';
      updateAgentChannelDraft(agentId, channelId, {
        [fieldName]: target.value,
      });
      // Settings are committed only by the explicit Save action.
      return true;
    }

    // voiceReplyMode / edgeTtsVoice / voicePersonality are agent-level (not
    // channel-level) but the user edits them on the Telegram panel next to
    // the channel toggles. Route them through the channel autosave so they
    // persist on change without requiring the user to hit a separate save
    // button.
    if (['voiceReplyMode', 'edgeTtsVoice', 'voicePersonality'].includes(target.name)) {
      mergeAgentDraft(agentId, {
        [target.name]: target.hasAttribute('data-capability-choice') ? new FormData(target.form).getAll(target.name) : target.type === 'checkbox' ? (target.checked ? 'on' : '') : target.value,
      });
      // Settings are committed only by the explicit Save action.
      // Same rule as the generic branch below (2026-10-17): a text field's
      // blur fires `change` on the pointerdown of the Save click; a full
      // render here replaced the button mid-click and swallowed the save.
      // Only the <select> needs an immediate repaint.
      if (target instanceof HTMLSelectElement) render();
      return true;
    }

    const nextDraft = mergeAgentDraft(agentId, {
      [target.name]: target.hasAttribute('data-capability-choice') ? new FormData(target.form).getAll(target.name) : target.type === 'checkbox' ? (target.checked ? 'on' : '') : target.value,
    });
    if (target.name === 'identity') {
      nextDraft.identify = target.value;
    }
    // Text/number blur precedes the Save click. Replacing the form here
    // detaches that button mid-click and can also reset its input value.
    if (target instanceof HTMLSelectElement || ['checkbox', 'radio'].includes(target.type)) {
      render();
    }
    return true;
  }
  return false;
}

export { selectedAgentProfile, selectedAgentScope, agentDraftKey, agentSaveKey, agentSecretVisibilityKey, agentDraftFor, mergeAgentDraft, updateAgentChannelDraft, currentAgentScrollKey, currentAgentEditorStateKey, captureAgentEditorState, captureAgentScrollState, restoreAgentScrollState, restoreAgentEditorState, agentPresetById, agentToolOptions, selectedAgentNeedsRuntimeRefresh, syncAgentRuntimeRefresh, handleCreateCustomAgent, handleUpdateAgentProfile, handleTestAgentChannel, saveAgentMarkdownSnapshot, saveAgentChannelSnapshot, scheduleAgentChannelAutosave, scheduleAgentMarkdownAutosave, flushPendingAgentMarkdownAutosave, flushPendingAgentChannelAutosave, flushPendingAgentAutosavesOnUnload, handleImportAgentPreset, handleResetProjectAgentOverride };
