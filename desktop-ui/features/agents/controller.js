// Agent settings feature controller (architecture plan P2b, 2026-10-19): the
// Agent page / Customize → Agents editor — selection and scope, per-Agent
// drafts, save and create flows, project overrides, Markdown import/export,
// avatar preview, channel test, capability/collaboration toggles, and the
// editor scroll/caret capture that app.js's render() calls. Settings commit
// only through the explicit Save action (idle autosave removed 2026-10-20).
// Moved out of desktop-ui/app.js byte-for-byte first (commit 1/5); since then
// the bodies read the feature's own state (./state.js), the bootstrap through
// getBootstrap() and send requests through ./api.js (./context.js). app.js's
// render() keeps its full re-render and its generic protections and calls the
// hooks below at the positions the Agent calls used to have. See
// features/README.md.
import { t } from '../../i18n.js';
import { committedSaveReceipt } from '../../bootstrapPatch.js';
import { readAgentAvatar } from '../../agentAvatar.js';
import { buildAgentProfilePatch } from './agentProfilePatch.js';
import { agentDocumentWithPreset, agentDraftFromProfile, normalizeChannelsForDraft } from './agentDraft.js';
import { decideAgentMcpAuthAction } from './agentMcpAuthorise.js';
import { agentsState, resetAgentsState } from './state.js';
import { bindAgentsContext, agentsApi, getBootstrap, app, render, bgRender, showError, showFlashToast, patchSettings, applyBootstrap, applyBootstrapPreservingDrafts, refreshBootstrap, activeProject, agentProfileById, minimaxTtsConfigPatchForVoice, beginFormEdit, formEditToken, nativeSettings, isAgentChannelAvailable } from './context.js';

// Binds the narrow context and starts from fresh feature state and idle
// timers. app.js calls this once at startup (through ./index.js); tests call
// it per case.
export function installAgentsController(context) {
  bindAgentsContext(context);
  resetAgentsState();
  window.clearTimeout(agentRuntimeRefreshTimer);
  agentRuntimeRefreshTimer = 0;
}

let agentRuntimeRefreshTimer = 0;

function selectedAgentProfile() {
  return agentProfileById(getBootstrap()?.settings?.selectedAgentId || 'main');
}

function selectedAgentScope() {
  const scope = getBootstrap()?.settings?.selectedAgentScope;
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
  // The cached agentsState.agentDrafts entry wins so the user's in-progress
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
  return agentsState.agentDrafts[key] || agentDraftFromProfile(agent);
}

function mergeAgentDraft(agentId, patch) {
  const draftKey = agentDraftKey(agentId);
  const currentDraft = {
    ...(agentsState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
  };
  agentsState.agentDrafts[draftKey] = {
    ...currentDraft,
    ...patch,
  };
  return agentsState.agentDrafts[draftKey];
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
  if (getBootstrap()?.settings?.activeView !== 'agent' && !(getBootstrap()?.settings?.activeView === 'customize' && getBootstrap()?.settings?.selectedCustomizeSection === 'agents')) {
    return null;
  }

  const selected = selectedAgentProfile();
  if (!selected) {
    return null;
  }

  return `${selectedAgentScope()}:${activeProject()?.id || 'global'}:${selected.id}`;
}

function currentAgentEditorStateKey() {
  if (getBootstrap()?.settings?.activeView !== 'agent' && !(getBootstrap()?.settings?.activeView === 'customize' && getBootstrap()?.settings?.selectedCustomizeSection === 'agents')) {
    return null;
  }

  const selected = selectedAgentProfile();
  if (!selected) {
    return null;
  }

  const scope = selectedAgentScope();
  const projectId = scope === 'project' ? activeProject()?.id || 'global' : 'global';
  return `${scope}:${projectId}:${selected.id}:${agentsState.agentEditorTab}`;
}

function captureAgentEditorState() {
  if (getBootstrap()?.settings?.activeView !== 'agent' && !(getBootstrap()?.settings?.activeView === 'customize' && getBootstrap()?.settings?.selectedCustomizeSection === 'agents')) {
    return;
  }

  const editor = document.querySelector('.agent-content-editor');
  const stateKey = currentAgentEditorStateKey();
  if (!(editor instanceof HTMLTextAreaElement) || !stateKey) {
    return;
  }

  agentsState.agentEditorStates[stateKey] = {
    scrollTop: editor.scrollTop,
    selectionStart: editor.selectionStart,
    selectionEnd: editor.selectionEnd,
    focused: document.activeElement === editor,
  };
}

function captureAgentScrollState() {
  if (getBootstrap()?.settings?.activeView !== 'agent' && !(getBootstrap()?.settings?.activeView === 'customize' && getBootstrap()?.settings?.selectedCustomizeSection === 'agents')) {
    return;
  }

  const listPane = document.querySelector('.agent-list-pane');
  if (listPane instanceof HTMLElement) {
    agentsState.agentListScrollTop = listPane.scrollTop;
  }

  const detailPane = document.querySelector('.agent-detail-column');
  const scrollKey = currentAgentScrollKey();
  if (detailPane instanceof HTMLElement && scrollKey) {
    agentsState.agentDetailScrollTops[scrollKey] = detailPane.scrollTop;
  }
}

function restoreAgentScrollState() {
  if (getBootstrap()?.settings?.activeView !== 'agent' && !(getBootstrap()?.settings?.activeView === 'customize' && getBootstrap()?.settings?.selectedCustomizeSection === 'agents')) {
    return;
  }

  const listPane = document.querySelector('.agent-list-pane');
  if (listPane instanceof HTMLElement) {
    listPane.scrollTop = agentsState.agentListScrollTop || 0;
  }

  const detailPane = document.querySelector('.agent-detail-column');
  const scrollKey = currentAgentScrollKey();
  if (detailPane instanceof HTMLElement && scrollKey) {
    detailPane.scrollTop = agentsState.agentDetailScrollTops[scrollKey] || 0;
  }
}

function restoreAgentEditorState() {
  if (getBootstrap()?.settings?.activeView !== 'agent') {
    return;
  }

  const stateKey = currentAgentEditorStateKey();
  if (!stateKey) {
    return;
  }

  const editorState = agentsState.agentEditorStates[stateKey];
  if (!editorState && !agentsState.shouldFocusAgentEditor) {
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

    if (agentsState.shouldFocusAgentEditor) {
      editor.focus({ preventScroll: true });
      editor.selectionStart = editor.selectionEnd = editor.value.length;
      agentsState.shouldFocusAgentEditor = false;
    }
  });
}

function agentPresetById(presetId) {
  return getBootstrap()?.customize?.agentPresets?.find(preset => preset.id === presetId) || null;
}

function agentToolOptions() {
  return getBootstrap()?.customize?.agentTools || [];
}

function selectedAgentNeedsRuntimeRefresh() {
  if (getBootstrap()?.settings?.activeView !== 'agent') {
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
      await refreshBootstrap();
    } catch {}
  }, 4000);
}

async function handleCreateCustomAgent() {
  if (agentsState.agentCreating) return;
  agentsState.agentCreating = true;
  render();
  try {
    // Capability elevation rule 6: the full base starter set, or a copy of an
    // existing Agent's settings (persona only when ticked). The plain create
    // keeps its original empty body.
    const basedOn = agentsState.agentCreateBase || '';
    const payload = await agentsApi.createCustom(basedOn ? { basedOn, copyPersona: agentsState.agentCreateCopyPersona === true } : {});
    const createdId = committedSaveReceipt(payload)?.agentId || payload.settings?.selectedAgentId;
    applyBootstrap(payload);
    const form = app.querySelector('form[data-form="agent-profile-update"]');
    // A concurrent navigation or a newer bootstrap may have selected another
    // Agent. Only the record created by this command may be auto-edited.
    if (!createdId || !payload.customize?.agents?.some(agent => agent.id === createdId) ||
        form?.dataset.agentId !== createdId || selectedAgentScope() !== 'global') return;
    beginFormEdit(form);
    render();
    app.querySelector('form[data-form="agent-profile-update"] [name="name"]')?.select();
  } finally {
    agentsState.agentCreating = false;
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

  agentsState.agentSaveStates[saveKey] = true;
  bgRender();

  try {
    const payload = await agentsApi.update({
      agentId: form.dataset.agentId,
      scope,
      projectId: scope === 'project' ? project?.id : null,
      activeView: getBootstrap()?.settings?.activeView || 'customize',
      patch,
    });
    await waitForMinimumVisibleState;
    delete agentsState.agentDrafts[draftKey];
    applyBootstrap(payload);
    if (payload.agentExportWarning) showError(payload.agentExportWarning);
    const activeTtsConfig = getBootstrap()?.settings?.config || {};
    const savedVoiceId = String(patch.minimaxVoiceId || '').trim();
    if (
      activeTtsConfig.ttsProvider === 'minimax' &&
      savedVoiceId &&
      activeTtsConfig.minimaxVoiceId === savedVoiceId
    ) {
      agentsApi.saveModelSettings(minimaxTtsConfigPatchForVoice(savedVoiceId)).then(nextPayload => applyBootstrapPreservingDrafts(nextPayload)).catch(() => {});
    }
  } finally {
    await waitForMinimumVisibleState;
    delete agentsState.agentSaveStates[saveKey];
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

  const payload = await agentsApi.testChannel({
    agentId: form.dataset.agentId,
    channelId,
    scope,
    projectId: scope === 'project' ? project?.id : null,
    patch,
  });
  applyBootstrap(payload);
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

  const payload = await agentsApi.update({
    agentId,
    scope: 'project',
    projectId: project.id,
    activeView: getBootstrap()?.settings?.activeView || 'customize',
    clearProjectOverride: true,
  });
  delete agentsState.agentDrafts[agentDraftKey(agentId, 'project', project.id)];
  applyBootstrap(payload);
}

// Click actions (formerly `case` branches of app.js's click dispatch),
// registered once by app.js through the feature registry.
export const agentsActions = {
  'create-custom-agent': async () => {
    await handleCreateCustomAgent();
  },
  'switch-agent-scope': async ({ trigger }) => {
    await patchSettings({
      activeView:
        getBootstrap().settings.activeView === 'agent' ? 'agent' : 'customize',
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
    agentsState.agentEditorTab = trigger.dataset.tab === 'soul' ? 'soul' : 'identity';
    agentsState.shouldFocusAgentEditor = true;
    render();
  },
  'import-agent-preset': async ({ trigger }) => {
    await handleImportAgentPreset(trigger.dataset.agentId, trigger.dataset.presetId);
  },
  'reset-agent-draft': ({ trigger }) => {
    const agentId = trigger.dataset.agentId;
    if (agentId) {
      delete agentsState.agentDrafts[agentDraftKey(agentId)];
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
      ...(agentsState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
    };
    const nextTools = new Set(currentDraft.tools || []);
    if (nextTools.has(toolId)) {
      nextTools.delete(toolId);
    } else {
      nextTools.add(toolId);
    }
    currentDraft.tools = [...nextTools];
    agentsState.agentDrafts[draftKey] = currentDraft;
    render();
  },
  'toggle-agent-skill': ({ trigger }) => {
    // Toggle a specific skill ID in the per-agent skill whitelist.
    // null draft value means "no restriction" — first toggle initialises it to [skillId].
    const agentId = trigger.dataset.agentId;
    const skillId = trigger.dataset.skillId;
    const draftKey = agentDraftKey(agentId);
    const currentDraft = {
      ...(agentsState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
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
    agentsState.agentDrafts[draftKey] = currentDraft;
    render();
  },
  'reset-agent-skill-whitelist': ({ trigger }) => {
    // Reset to "no restriction" (null = all skills allowed)
    const agentId = trigger.dataset.agentId;
    const draftKey = agentDraftKey(agentId);
    const currentDraft = {
      ...(agentsState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
    };
    currentDraft.enabledSkillIds = null;
    agentsState.agentDrafts[draftKey] = currentDraft;
    render();
  },
  'toggle-agent-connector': ({ trigger }) => {
    // Toggle a specific external connector ID in the per-agent connector whitelist.
    const agentId = trigger.dataset.agentId;
    const connectorId = trigger.dataset.connectorId;
    const draftKey = agentDraftKey(agentId);
    const currentDraft = {
      ...(agentsState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
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
    agentsState.agentDrafts[draftKey] = currentDraft;
    render();
  },
  'reset-agent-connector-whitelist': ({ trigger }) => {
    const agentId = trigger.dataset.agentId;
    const draftKey = agentDraftKey(agentId);
    const currentDraft = {
      ...(agentsState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
    };
    currentDraft.enabledConnectorIds = null;
    agentsState.agentDrafts[draftKey] = currentDraft;
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
      ...(agentsState.agentDrafts[draftKey] || agentDraftFor(agentProfileById(agentId)) || {}),
    };
    // Decision lives in `./agentMcpAuthorise.js` so node:test
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
    agentsState.agentDrafts[draftKey] = currentDraft;
    render();
  },
  'toggle-agent-secret': ({ trigger }) => {
    const agentId = trigger.dataset.agentId;
    const channelId = trigger.dataset.channelId;
    if (agentId && channelId) {
      const key = agentSecretVisibilityKey(agentId, channelId);
      agentsState.agentSecretVisibility[key] = !agentsState.agentSecretVisibility[key];
      render();
    }
  },
  'switch-agent-channel-tab': async ({ trigger }) => {
    const agentId = trigger.dataset.agentId;
    const channelId = trigger.dataset.channelId;
    const VALID_TABS = ['telegram', 'discord'].filter(id => isAgentChannelAvailable(id));
    if (agentId && VALID_TABS.includes(channelId)) {
      agentsState.agentChannelTab[agentId] = channelId;
      render();
    }
  },
  'test-agent-channel': async ({ trigger }) => {
    await handleTestAgentChannel(trigger);
  },
  'confirm-agent-settings': async ({ trigger }) => {
    await agentsApi.confirmSettings({id:trigger.dataset.id,expected:trigger.dataset.expected,accept:trigger.dataset.accept==='true'});
    applyBootstrap(await agentsApi.bootstrap());
  },
  'clear-agent-avatar': ({ trigger }) => {
    mergeAgentDraft(trigger.dataset.agentId,{avatarData:''});
    render();
  },
  // 这台电脑上: device-local, saved at once like the phone's 这台手机上; never part of the synced profile.
  'toggle-agent-device-permission': async ({ trigger }) => {
    try {
      applyBootstrap(await agentsApi.updateLocalPreferences({ agentDevice: { [trigger.dataset.agentId]: { [trigger.dataset.permission]: trigger.checked === true } } }));
    } catch (error) {
      // The box flipped natively on the click; a failed save must not leave it showing a state the computer never saved.
      trigger.checked = !trigger.checked;
      throw error;
    }
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
  if (key) agentsState.agentOpenSections[key] = event.target.open;
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
      // Settings are committed only by the explicit Save action.
      return true;
    }

    // voiceReplyMode / edgeTtsVoice / voicePersonality are agent-level fields
    // edited on the Telegram panel; they stay on the draft until Save.
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
    return;
  }

  if (target instanceof HTMLElement && target.classList.contains('agent-detail-column')) {
    captureAgentScrollState();
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
  const editIsCurrent = formEditToken(target.form);
  const key = agentDraftKey(agentId);
  try {
    const file=target.files?.[0]; if(!file) return;
    if(file.size > 1000000) throw new Error('Markdown 文件过大，请控制在 1 MB 内。');
    const instructions=await file.text();
    if(instructions.length > 200100) throw new Error('Agent 人设文档超过 200100 字符。');
    if(!editIsCurrent()) return;
    agentsState.agentDrafts[key]={...agentDraftFor(agentProfileById(agentId)),instructions};
    render();
  } catch(error) { showError(error.message); }
}

async function previewAgentAvatar(target) {
  const isCurrentEdit=formEditToken(target.form);
  const draftKey=agentDraftKey(target.dataset.agentAvatar);
  const originalDraft=agentDraftFor(agentProfileById(target.dataset.agentAvatar));
  try {
    const avatarData = await readAgentAvatar(target.files?.[0]);
    if(!isCurrentEdit()) return;
    agentsState.agentDrafts[draftKey]={...originalDraft,...agentsState.agentDrafts[draftKey],avatarData};
    render();
  }
  catch (error) { showError(error.message); }
}

// Last branch inside the 'change' listener's try (agent-profile-update form
// fields). Synchronous; returns true when it handled the event.
export function handleAgentProfileChange(target) {
  // New-Agent starting point («基于已有 Agent») and the persona tick: page state only.
  if (target.matches?.('[data-agent-create-base]')) {
    agentsState.agentCreateBase = String(target.value || '');
    if (!agentsState.agentCreateBase) agentsState.agentCreateCopyPersona = false;
    render();
    return true;
  }
  if (target.matches?.('[data-agent-create-persona]')) {
    agentsState.agentCreateCopyPersona = target.checked === true;
    return true;
  }
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
    // the channel toggles; they stay on the draft until Save.
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

// ── Hooks app.js calls (architecture plan P2b) ──────────────────────────────
// render() keeps its full re-render and generic protections (typing / scroll
// guards, focused-input caret, nested scroll, textarea scroll, composer,
// neural regions); the Agent-specific steps run at the positions they had:
//   captureBeforeRender()       before the DOM update (list/detail scroll + editor caret)
//   restoreScrollAfterRender()  right after syncThreadViewport(), before the generic scroll restore
//   syncRuntimeRefresh()        after the textarea scroll restore (4 s Discord runtime poll)
//   restoreEditorAfterRender()  after the composer restore, before the focused-input restore
export function captureBeforeRender() {
  captureAgentScrollState();
  captureAgentEditorState();
}
export const restoreScrollAfterRender = () => restoreAgentScrollState();
export const syncRuntimeRefresh = () => syncAgentRuntimeRefresh();
export const restoreEditorAfterRender = () => restoreAgentEditorState();


// settingsFormEditors ownership of the agent-profile-update form: this
// feature keeps that form's draft (agentDrafts), scoped per Agent, scope and
// project; a cancelled edit discards only that draft.
export const ownsFormDraft = form => form.dataset.form === 'agent-profile-update';
export const formDraftScope = form => agentDraftKey(form.dataset.agentId);
export function discardFormDraft(form) {
  delete agentsState.agentDrafts[agentDraftKey(form.dataset.agentId)];
}

export { selectedAgentProfile, selectedAgentScope, agentDraftKey, agentSaveKey, agentSecretVisibilityKey, agentDraftFor, mergeAgentDraft, updateAgentChannelDraft, currentAgentScrollKey, currentAgentEditorStateKey, captureAgentEditorState, captureAgentScrollState, restoreAgentScrollState, restoreAgentEditorState, agentPresetById, agentToolOptions, selectedAgentNeedsRuntimeRefresh, syncAgentRuntimeRefresh, handleCreateCustomAgent, handleUpdateAgentProfile, handleTestAgentChannel, handleImportAgentPreset, handleResetProjectAgentOverride };
