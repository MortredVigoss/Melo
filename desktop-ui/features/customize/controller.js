// Customize page — handlers, loaders and the actions / forms registered with app.js
// (architecture B3 step 1, 2026-10-20). Byte-for-byte move out of
// desktop-ui/app.js: function bodies and their comments are unchanged; case
// bodies of app.js's click / submit dispatchers became the action and form
// handlers below (one indentation level less, top-level `break;` → `return;`,
// equivalent because nothing followed the switch inside its try block).
// app.js names they read come from ./context.js (transitional, live bindings).
import { resolveActiveMinimaxVoiceId } from '/shared/minimaxVoiceResolver.js';
import { pickConnectorField } from '../../connectorDraft.js';
import { allChatAgentProfiles, api, applyBootstrap, applyBootstrapPreservingDrafts, bgRender, loadBootstrap, minimaxTtsConfigPatchForVoice, patchSettings, refreshAdvancedStatus, render, showError, uiState } from './context.js';

// Parse the comma-separated skill form fields (folders, allowedAgentIds,
// toolWhitelist). Pulled out so create + update share the same
// interpretation and tests can pin the behavior in one place.
function parseSkillCsvList(raw) {
  return String(raw || '').split(',').map(v => v.trim()).filter(Boolean);
}

function normalizeSkillFormBody(formData) {
  const folders = parseSkillCsvList(formData.get('folders'));
  const allowedAgentRaw = parseSkillCsvList(formData.get('allowedAgentIds'));
  const toolWhitelistRaw = parseSkillCsvList(formData.get('toolWhitelist'));
  const rawType = String(formData.get('type') || '').trim().toLowerCase();
  const type = rawType === 'prompt' ? 'prompt' : 'executable';
  const iterN = Number(formData.get('maxIterations'));
  const maxIterations = Number.isFinite(iterN) && iterN >= 1 && iterN <= 16 ? Math.floor(iterN) : 6;
  return {
    name: String(formData.get('name') || '').trim(),
    description: String(formData.get('description') || '').trim(),
    addedBy: String(formData.get('addedBy') || '').trim(),
    invokedBy: String(formData.get('invokedBy') || '').trim(),
    systemPrompt: String(formData.get('systemPrompt') || '').trim(),
    folders,
    type,
    maxIterations,
    // null means "any agent" — respect the UI's "All agents" chip state by
    // emitting null rather than an empty array (empty array would be
    // interpreted as "no agents can see this skill").
    allowedAgentIds: allowedAgentRaw.length > 0 ? allowedAgentRaw : null,
    toolWhitelist: toolWhitelistRaw.length > 0 ? toolWhitelistRaw : null,
  };
}

async function handleCreateCustomSkill(form) {
  const formData = new FormData(form);
  const patch = normalizeSkillFormBody(formData);
  const payload = await api('/api/skills/custom', {
    method: 'POST',
    body: {
      skill: {
        id: String(formData.get('id') || '').trim(),
        ...patch,
      },
    },
  });
  form.reset();
  applyBootstrap(payload);
}

async function handleUpdateCustomSkill(form) {
  const formData = new FormData(form);
  const payload = await api('/api/skills/custom/update', {
    method: 'POST',
    body: {
      skillId: form.dataset.skillId,
      patch: normalizeSkillFormBody(formData),
    },
  });
  applyBootstrap(payload);
}

// Expose for unit tests (Node doesn't export window, so we attach through
// globalThis for a non-invasive testing hook).
if (typeof globalThis !== 'undefined') {
  globalThis.__meloUiInternals__ = Object.assign(globalThis.__meloUiInternals__ || {}, {
    parseSkillCsvList,
    normalizeSkillFormBody,
  });
}

async function handleRemoveCustomSkill(skillId) {
  const payload = await api('/api/skills/custom/remove', {
    method: 'POST',
    body: { skillId },
  });
  applyBootstrap(payload);
}

async function handlePingExternalConnector(connectorId) {
  const payload = await api('/api/connectors/external/ping', {
    method: 'POST',
    body: { connectorId },
  });
  applyBootstrap(payload);
}

// Render the "skill proposals" panel on top of the skills list — a thin UI
// surface for the Phase 3D background clusterer. Each proposal is one click
// to either dismiss or promote into the /save-as-skill flow.
/**
 * Phase 3.3.4 — Skill health panel. Summarises per-skill run counts,
 * success rate, P50 duration, and the most recent errors. Fetched
 * lazily on first render; a refresh button re-queries.
 */
async function refreshSkillRunStats() {
  if (uiState.skillRunStats.loading) return;
  uiState.skillRunStats.loading = true;
  uiState.skillRunStats.error = null;
  bgRender();
  try {
    const response = await api('/api/skills/runs/stats');
    uiState.skillRunStats.skills = Array.isArray(response?.skills) ? response.skills : [];
    uiState.skillRunStats.loaded = true;
  } catch (err) {
    uiState.skillRunStats.error = err?.message || 'Failed to load skill runs';
  } finally {
    uiState.skillRunStats.loading = false;
    bgRender();
  }
}

async function handleReloadMcpServers() {
  try {
    const resp = await api('/api/mcp/reload', { method: 'POST' });
    uiState.advanced.cliServers = Array.isArray(resp?.servers) ? resp.servers : [];
    showError(`Reloaded ${uiState.advanced.cliServers.length} MCP server(s).`);
    render();
  } catch (err) {
    showError(`MCP reload failed: ${err?.message || err}`);
  }
}

async function handleDisconnectMcpServer(name) {
  if (!name) return;
  try {
    await api('/api/mcp/disconnect', { method: 'POST', body: { name } });
    // Refresh the list so the UI reflects the new state.
    await refreshAdvancedStatus();
  } catch (err) {
    showError(`Disconnect failed: ${err?.message || err}`);
  }
}

async function refreshSafetyAllowlist() {
  if (uiState.safetyAllowlist.loading) return;
  uiState.safetyAllowlist.loading = true;
  uiState.safetyAllowlist.error = null;
  bgRender();
  try {
    const [response, tools, audit] = await Promise.all([api('/api/safety/file-allowlist'), api('/api/tools/permission-rules'), api('/api/permissions/audit')]);
    uiState.safetyAllowlist.audit = audit.events || [];
    uiState.safetyAllowlist.rules = [...(response.rules || []), ...(tools.rules || []).map(r => ({ ...r, id: `tool:${r.id || r.toolId}`, toolId: r.toolId, operation: r.action, scope: 'tool', realPath: r.toolId })), ...(audit.commands || []).map(r=>({...r,id:`command:${r.id}`,commandRuleId:r.id,operation:'bash',scope:'command',realPath:`${r.template.command} · ${r.template.cwd}`}))];
    uiState.safetyAllowlist.loaded = true;
  } catch (err) {
    uiState.safetyAllowlist.error = err?.message || 'Failed to load safety rules';
  } finally {
    uiState.safetyAllowlist.loading = false;
    bgRender();
  }
}

async function removeSafetyAllowlistRule(id) {
  if (!id || uiState.safetyAllowlist.pendingRemoveId === id) return;
  uiState.safetyAllowlist.pendingRemoveId = id;
  bgRender();
  try {
    const selectedRule = uiState.safetyAllowlist.rules.find(r => r.id === id);
    if (selectedRule?.commandRuleId) { await api('/api/permissions/command/remove',{method:'POST',body:{id:selectedRule.commandRuleId}}); await refreshSafetyAllowlist(); return; }
    const toolId = selectedRule?.toolId;
    await api(toolId ? '/api/tools/permission-rules/remove' : '/api/safety/file-allowlist/remove', {
      method: 'POST', body: toolId ? { toolId, id:selectedRule.id.startsWith('tool:') && selectedRule.permissionScope ? selectedRule.id.slice(5) : undefined } : { id },
    });
    await refreshSafetyAllowlist();
  } catch (err) {
    uiState.safetyAllowlist.error = err?.message || 'Failed to revoke rule';
  } finally {
    uiState.safetyAllowlist.pendingRemoveId = null;
    render();
  }
}

async function refreshDomainCookies() {
  if (uiState.domainCookies.loading) return;
  uiState.domainCookies.loading = true;
  uiState.domainCookies.error = null;
  bgRender();
  try {
    const response = await api('/api/settings/domain-cookies');
    uiState.domainCookies.hosts = Array.isArray(response.hosts) ? response.hosts : [];
    uiState.domainCookies.loaded = true;
  } catch (err) {
    uiState.domainCookies.error = err?.message || 'Failed to load cookies';
  } finally {
    uiState.domainCookies.loading = false;
    bgRender();
  }
}

async function upsertDomainCookie() {
  if (uiState.domainCookies.addInFlight) return;
  const host = String(uiState.domainCookies.addHost || '').trim();
  const cookieString = String(uiState.domainCookies.addCookie || '').trim();
  if (!host) {
    uiState.domainCookies.addError = 'Host is required.';
    bgRender();
    return;
  }
  if (!cookieString) {
    uiState.domainCookies.addError = 'Cookie string is required.';
    bgRender();
    return;
  }
  uiState.domainCookies.addInFlight = true;
  uiState.domainCookies.addError = '';
  render();
  try {
    await api('/api/settings/domain-cookies/upsert', {
      method: 'POST',
      body: { host, cookieString },
    });
    uiState.domainCookies.addHost = '';
    uiState.domainCookies.addCookie = '';
    uiState.domainCookies.loaded = false;
    await refreshDomainCookies();
  } catch (err) {
    uiState.domainCookies.addError = err?.message || 'Failed to save cookie';
  } finally {
    uiState.domainCookies.addInFlight = false;
    render();
  }
}

async function removeDomainCookie(host) {
  if (!host || uiState.domainCookies.pendingRemoveHost === host) return;
  uiState.domainCookies.pendingRemoveHost = host;
  render();
  try {
    await api('/api/settings/domain-cookies/remove', {
      method: 'POST',
      body: { host },
    });
    uiState.domainCookies.loaded = false;
    await refreshDomainCookies();
  } catch (err) {
    uiState.domainCookies.error = err?.message || 'Failed to remove cookie';
  } finally {
    uiState.domainCookies.pendingRemoveHost = null;
    render();
  }
}

async function refreshSkillMarkdown(skillId) {
  const current = uiState.skillMarkdown[skillId] || {};
  if (current.loading) return;
  uiState.skillMarkdown[skillId] = { ...current, loading: true, error: null };
  bgRender();
  try {
    const response = await api(`/api/skills/export?id=${encodeURIComponent(skillId)}`);
    uiState.skillMarkdown[skillId] = {
      loading: false,
      markdown: response?.markdown || '',
      error: null,
      copyToast: null,
    };
  } catch (err) {
    uiState.skillMarkdown[skillId] = {
      loading: false,
      markdown: '',
      error: err?.message || 'Failed to load SKILL.md',
    };
  } finally {
    bgRender();
  }
}

export const customizeActions = {
  'open-customize-section': async ({ action, trigger, event }) => {
      await patchSettings({
        activeView: 'customize',
        selectedCustomizeSection: trigger.dataset.section,
      });
      return;
  },
  'refresh-safety-allowlist': async ({ action, trigger, event }) => {
      uiState.safetyAllowlist.loaded = false;
      await refreshSafetyAllowlist();
      return;
  },
  'safety-allowlist-remove': async ({ action, trigger, event }) => {
      await removeSafetyAllowlistRule(trigger.dataset.ruleId);
      return;
  },
  'refresh-domain-cookies': async ({ action, trigger, event }) => {
      uiState.domainCookies.loaded = false;
      await refreshDomainCookies();
      return;
  },
  'domain-cookie-save': async ({ action, trigger, event }) => {
      // Pull the current input values into state right before save —
      // input listeners only sync on the next keystroke, so reading
      // the DOM directly here ensures we don't miss the last char.
      const hostInput = document.querySelector('[data-domain-cookie-host]');
      const cookieInput = document.querySelector('[data-domain-cookie-string]');
      if (hostInput) uiState.domainCookies.addHost = hostInput.value || '';
      if (cookieInput) uiState.domainCookies.addCookie = cookieInput.value || '';
      await upsertDomainCookie();
      return;
  },
  'domain-cookie-remove': async ({ action, trigger, event }) => {
      await removeDomainCookie(trigger.dataset.host);
      return;
  },
  'skill-detail-tab': async ({ action, trigger, event }) => {
      uiState.skillDetailTab = trigger.dataset.tab || 'overview';
      render();
      if (uiState.skillDetailTab === 'markdown') {
        const id = trigger.dataset.skillId;
        if (id && !uiState.skillMarkdown[id]?.markdown) {
          refreshSkillMarkdown(id);
        }
      }
      return;
  },
  'copy-skill-markdown': async ({ action, trigger, event }) => {
      const id = trigger.dataset.skillId;
      const cached = id ? uiState.skillMarkdown[id]?.markdown : null;
      if (cached && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(cached);
          uiState.skillMarkdown[id] = { ...uiState.skillMarkdown[id], copyToast: 'Copied' };
          render();
          setTimeout(() => {
            if (uiState.skillMarkdown[id]) {
              uiState.skillMarkdown[id] = { ...uiState.skillMarkdown[id], copyToast: null };
              bgRender();
            }
          }, 1500);
        } catch (err) {
          uiState.skillMarkdown[id] = { ...uiState.skillMarkdown[id], copyToast: 'Copy failed' };
          render();
        }
      }
      return;
  },
  'toggle-mcp-preset': async ({ action, trigger, event }) => {
      // Advanced page MCP toggle — flip the corresponding `enable*Mcp`
      // config flag and re-bootstrap the MCP servers so the change
      // takes effect immediately.  Server-side validates that the flag
      // is one of the whitelisted built-ins.
      const flag = trigger.dataset.presetFlag;
      const nextEnabled = trigger.dataset.nextEnabled === '1';
      if (!flag) return;
      try {
        await api('/api/mcp/preset-toggle', {
          method: 'POST',
          body: { flag, enabled: nextEnabled },
        });
        // Refresh the bootstrap so mcpPresets[].enabled reflects the new
        // flag values; also clear the Advanced cache so the connected-
        // tools count updates on the next render.
        uiState.advanced = { ...uiState.advanced, loaded: false };
        await loadBootstrap(uiState.searchQuery, { quiet: true });
        await refreshAdvancedStatus();
      } catch (err) {
        uiState.error = `Toggle failed: ${err?.message || err}`;
        render();
        setTimeout(() => { uiState.error = null; render(); }, 4000);
      }
      return;
  },
  'select-customize-item': async ({ action, trigger, event }) => {
      if (trigger.dataset.section === 'skills') {
        await patchSettings({
          activeView: 'customize',
          selectedCustomizeSection: 'skills',
          selectedSkillId: trigger.dataset.id,
        });
      } else if (trigger.dataset.section === 'agents') {
        await patchSettings({
          activeView: 'customize',
          selectedCustomizeSection: 'agents',
          selectedAgentId: trigger.dataset.id,
        });
      } else {
        await patchSettings({
          activeView: 'customize',
          selectedCustomizeSection: 'connectors',
          selectedConnectorId: trigger.dataset.id,
        });
      }
      return;
  },
  'toggle-skill': async ({ action, trigger, event }) => {
      applyBootstrapPreservingDrafts(
        await api('/api/customize/skill-toggle', {
          method: 'POST',
          body: { skillId: trigger.dataset.skillId },
        }),
      );
      return;
  },
  'set-skill-filter-tag': async ({ action, trigger, event }) => {
      // Phase 3.3.2 — empty string ("All tags" chip) clears the tag filter.
      const nextTag = trigger.dataset.tag || '';
      uiState.skillFilter.tag = nextTag ? nextTag : null;
      render();
      return;
  },
  'reset-skill-filter': async ({ action, trigger, event }) => {
      uiState.skillFilter = { query: '', tag: null, state: 'all' };
      render();
      return;
  },
  'refresh-skill-runs': async ({ action, trigger, event }) => {
      refreshSkillRunStats();
      return;
  },
  'dismiss-skill-proposal': async ({ action, trigger, event }) => {
      await api('/api/skill-proposals/dismiss', {
        method: 'POST',
        body: { seedId: trigger.dataset.seedId },
      });
      // Drop the proposal from the in-memory bootstrap immediately so the
      // user sees it vanish without waiting for a full refresh.
      if (uiState.bootstrap?.customize?.skillProposals) {
        uiState.bootstrap.customize.skillProposals =
          uiState.bootstrap.customize.skillProposals.filter(
            p => p.seedId !== trigger.dataset.seedId,
          );
        render();
      }
      return;
  },
  'promote-skill-proposal': async ({ action, trigger, event }) => {
      // Jump the user to the custom-skill create card with the
      // proposal's summary pre-filled. The actual LLM-backed drafting
      // still goes through /save-as-skill on the CLI or Telegram side —
      // the UI path is a "seed the form" shortcut so the user finishes
      // the wording themselves.
      const seedId = trigger.dataset.seedId;
      const proposal = (uiState.bootstrap?.customize?.skillProposals || []).find(
        p => p.seedId === seedId,
      );
      await patchSettings({
        activeView: 'customize',
        selectedCustomizeSection: 'skills',
      });
      if (proposal) {
        // Drop the proposal once the user engages with it so the panel
        // doesn't keep re-offering it on every render.
        await api('/api/skill-proposals/dismiss', {
          method: 'POST',
          body: { seedId },
        });
        uiState.bootstrap.customize.skillProposals =
          uiState.bootstrap.customize.skillProposals.filter(p => p.seedId !== seedId);
        // Populate the create-skill form with a starting point.
        setTimeout(() => {
          const form = document.querySelector('[data-form="skill-custom-create"]');
          if (!form) return;
          form.elements.description && (form.elements.description.value = proposal.summary || '');
          form.elements.systemPrompt
            && (form.elements.systemPrompt.value =
              `Reusable workflow auto-suggested from ${proposal.occurrences || 1}× repetition.`);
          form.elements.id?.focus();
        }, 0);
      }
      return;
  },
  'toggle-connector': async ({ action, trigger, event }) => {
      applyBootstrapPreservingDrafts(
        await api('/api/customize/connector-toggle', {
          method: 'POST',
          body: { connectorId: trigger.dataset.connectorId },
        }),
      );
      return;
  },
  'ping-connector': async ({ action, trigger, event }) => {
      await handlePingExternalConnector(trigger.dataset.connectorId);
      return;
  },
  'reload-mcp-servers': async ({ action, trigger, event }) => {
      await handleReloadMcpServers();
      return;
  },
  'disconnect-mcp-server': async ({ action, trigger, event }) => {
      await handleDisconnectMcpServer(trigger.dataset.serverName);
      return;
  },
  'remove-custom-skill': async ({ action, trigger, event }) => {
      await handleRemoveCustomSkill(trigger.dataset.skillId);
      return;
  },
  'test-minimax-tts': async ({ action, trigger, event }) => {
      // Send whatever the user has typed; the server falls back to the
      // saved config for any blank field (so the masked password input
      // doesn't force users to retype an already-saved key). Status
      // renders inline next to the button. Mirror handleSaveConnectorConfig:
      // the password input always renders empty, so prefer the shared
      // draft (kept up to date by the form input handler) before
      // falling back to FormData.
      const form = trigger.closest('form#connector-config-form');
      const status = form?.querySelector('[data-tts-test-status]');
      const fd = form ? new FormData(form) : null;
      const draft = uiState.modelSetupDraft || {};
      const apiKey  = pickConnectorField(draft, fd, 'minimaxApiKey');
      const groupId = pickConnectorField(draft, fd, 'minimaxGroupId');
      const voiceId = pickConnectorField(draft, fd, 'minimaxVoiceId');
      // Pre-flight: at least one path (form or saved) must yield a key
      // and a voice id. The server re-checks both via getResolvedConfig
      // so the UI message stays advisory.
      const savedKey   = Boolean(uiState.bootstrap?.settings?.config?.hasMinimaxKey);
      const savedVoice = Boolean(uiState.bootstrap?.settings?.config?.minimaxVoiceId);
      if (!apiKey && !savedKey) {
        if (status) status.textContent = 'Enter or save a MiniMax API key first';
        return;
      }
      if (!voiceId && !savedVoice) {
        if (status) status.textContent = 'Voice ID is required';
        return;
      }
      if (status) status.textContent = 'Synthesising…';
      try {
        const result = await api('/api/tts/test-minimax', {
          method: 'POST',
          body: {
            apiKey,
            groupId,
            voiceId,
            text: '你好，这是 MiniMax 测试朗读。Hello from MiniMax.',
          },
        });
        if (result?.ok) {
          if (status) status.textContent = `OK · ${result.bytes} bytes synthesised`;
        } else {
          if (status) status.textContent = result?.error || 'Test failed';
        }
      } catch (err) {
        if (status) status.textContent = err?.message || 'Test failed';
      }
      return;
  },
  'activate-minimax-voice': async ({ action, trigger, event }) => {
      // Delegate to the shared resolver (src/shared/minimaxVoiceResolver.js)
      // so the priority chain — cache valid / saved default / first
      // agent / nothing — is locked by node-side unit tests instead of
      // re-derived in browser logic. Fixes Codex C #14 (silent wipe)
      // and C #15 (stale cache wins over fresh save).
      const agentVoiceIds = allChatAgentProfiles()
        .map(a => a.minimaxVoiceId)
        .filter(Boolean);
      const savedDefault = uiState.bootstrap?.settings?.config?.minimaxVoiceId || '';
      const { voiceId, droppedStaleCache } = resolveActiveMinimaxVoiceId({
        cachedId: uiState.ttsCustomVoiceId,
        agentVoiceIds,
        savedDefault,
      });

      // If the cache no longer matches any valid voice, drop it now —
      // both in-memory and in localStorage — so a future activation
      // doesn't see the stale value again.
      if (droppedStaleCache) {
        uiState.ttsCustomVoiceId = '';
        localStorage.removeItem('melo-tts-custom-voice-id');
      }

      if (!voiceId) {
        showError('Configure a MiniMax voice first — set a Default Voice ID in Settings → Connector or bind one to an agent.');
        return;
      }

      uiState.ttsEngine = 'api';
      localStorage.setItem('melo-tts-engine', 'api');
      if (uiState.ttsCustomVoiceId !== voiceId) {
        uiState.ttsCustomVoiceId = voiceId;
        localStorage.setItem('melo-tts-custom-voice-id', voiceId);
      }
      api('/api/settings/model', {
        method: 'POST',
        body: {
          ttsProvider: 'minimax',
          ...minimaxTtsConfigPatchForVoice(voiceId),
        },
      }).then(payload => applyBootstrapPreservingDrafts(payload)).catch(() => {});
      render();
      return;
  },
};

export const customizeForms = {
  'skill-custom-create': async ({ form, event }) => {
      await handleCreateCustomSkill(form);
      return;
  },
  'skill-custom-update': async ({ form, event }) => {
      await handleUpdateCustomSkill(form);
      return;
  },
};

export { handleCreateCustomSkill, handleDisconnectMcpServer, handlePingExternalConnector, handleReloadMcpServers, handleRemoveCustomSkill, handleUpdateCustomSkill, normalizeSkillFormBody, parseSkillCsvList, refreshDomainCookies, refreshSafetyAllowlist, refreshSkillMarkdown, refreshSkillRunStats, removeDomainCookie, removeSafetyAllowlistRule, upsertDomainCookie };
