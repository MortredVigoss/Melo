import { AGENT_LOOP_CONTRACT } from '../../../shared/agent/loopContract.js';
// Customize page — handlers, loaders and the actions / forms registered with app.js
// (architecture B3 step 1, 2026-10-20). Byte-for-byte move out of
// desktop-ui/app.js: function bodies and their comments are unchanged; case
// bodies of app.js's click / submit dispatchers became the action and form
// handlers below (one indentation level less, top-level `break;` → `return;`,
// equivalent because nothing followed the switch inside its try block).
// app.js names they read come from ./context.js (transitional, live bindings).
import { pickConnectorField } from '../../connectorDraft.js';
import { allChatAgentProfiles, api, applyBootstrap, applyBootstrapPreservingDrafts, bgRender, getBootstrap, minimaxTtsConfigPatchForVoice, modelSetupDraft, patchSettings, refreshBootstrap, render, resolveActiveMinimaxVoiceId, setError, setTtsVoice, notify, ttsVoice } from './context.js';
import { customizeState } from './state.js';

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
  const maxIterations = Number.isFinite(iterN) && iterN >= 1 && iterN <= AGENT_LOOP_CONTRACT.skillLimits.maxIterations ? Math.floor(iterN) : AGENT_LOOP_CONTRACT.skillLimits.iterations;
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
  if (customizeState.skillRunStats.loading) return;
  customizeState.skillRunStats.loading = true;
  customizeState.skillRunStats.error = null;
  bgRender();
  try {
    const response = await api('/api/skills/runs/stats');
    customizeState.skillRunStats.skills = Array.isArray(response?.skills) ? response.skills : [];
    customizeState.skillRunStats.loaded = true;
  } catch (err) {
    customizeState.skillRunStats.error = err?.message || 'Failed to load skill runs';
  } finally {
    customizeState.skillRunStats.loading = false;
    bgRender();
  }
}

async function handleReloadMcpServers() {
  try {
    const resp = await api('/api/mcp/reload', { method: 'POST' });
    customizeState.advanced.cliServers = Array.isArray(resp?.servers) ? resp.servers : [];
    notify({level:'success',text:`Reloaded ${customizeState.advanced.cliServers.length} MCP server(s).`});
    render();
  } catch (err) {
    notify({level:'error',text:`MCP reload failed: ${err?.message || err}`});
  }
}

async function handleDisconnectMcpServer(name) {
  if (!name) return;
  try {
    await api('/api/mcp/disconnect', { method: 'POST', body: { name } });
    // Refresh the list so the UI reflects the new state.
    await refreshAdvancedStatus();
  } catch (err) {
    notify({level:'error',text:`Disconnect failed: ${err?.message || err}`});
  }
}

async function refreshSafetyAllowlist() {
  if (customizeState.safetyAllowlist.loading) return;
  customizeState.safetyAllowlist.loading = true;
  customizeState.safetyAllowlist.error = null;
  bgRender();
  try {
    const [response, tools, audit] = await Promise.all([api('/api/safety/file-allowlist'), api('/api/tools/permission-rules'), api('/api/permissions/audit')]);
    customizeState.safetyAllowlist.audit = audit.events || [];
    customizeState.safetyAllowlist.rules = [...(response.rules || []), ...(tools.rules || []).map(r => ({ ...r, id: `tool:${r.id || r.toolId}`, toolId: r.toolId, operation: r.action, scope: 'tool', realPath: r.toolId })), ...(audit.commands || []).map(r=>({...r,id:`command:${r.id}`,commandRuleId:r.id,operation:'bash',scope:'command',realPath:`${r.template.command} · ${r.template.cwd}`}))];
    customizeState.safetyAllowlist.loaded = true;
  } catch (err) {
    customizeState.safetyAllowlist.error = err?.message || 'Failed to load safety rules';
  } finally {
    customizeState.safetyAllowlist.loading = false;
    bgRender();
  }
}

async function removeSafetyAllowlistRule(id) {
  if (!id || customizeState.safetyAllowlist.pendingRemoveId === id) return;
  customizeState.safetyAllowlist.pendingRemoveId = id;
  bgRender();
  try {
    const selectedRule = customizeState.safetyAllowlist.rules.find(r => r.id === id);
    if (selectedRule?.commandRuleId) { await api('/api/permissions/command/remove',{method:'POST',body:{id:selectedRule.commandRuleId}}); await refreshSafetyAllowlist(); return; }
    const toolId = selectedRule?.toolId;
    await api(toolId ? '/api/tools/permission-rules/remove' : '/api/safety/file-allowlist/remove', {
      method: 'POST', body: toolId ? { toolId, id:selectedRule.id.startsWith('tool:') && selectedRule.permissionScope ? selectedRule.id.slice(5) : undefined } : { id },
    });
    await refreshSafetyAllowlist();
  } catch (err) {
    customizeState.safetyAllowlist.error = err?.message || 'Failed to revoke rule';
  } finally {
    customizeState.safetyAllowlist.pendingRemoveId = null;
    render();
  }
}

async function refreshDomainCookies() {
  if (customizeState.domainCookies.loading) return;
  customizeState.domainCookies.loading = true;
  customizeState.domainCookies.error = null;
  bgRender();
  try {
    const response = await api('/api/settings/domain-cookies');
    customizeState.domainCookies.hosts = Array.isArray(response.hosts) ? response.hosts : [];
    customizeState.domainCookies.loaded = true;
  } catch (err) {
    customizeState.domainCookies.error = err?.message || 'Failed to load cookies';
  } finally {
    customizeState.domainCookies.loading = false;
    bgRender();
  }
}

async function upsertDomainCookie() {
  if (customizeState.domainCookies.addInFlight) return;
  const host = String(customizeState.domainCookies.addHost || '').trim();
  const cookieString = String(customizeState.domainCookies.addCookie || '').trim();
  if (!host) {
    customizeState.domainCookies.addError = 'Host is required.';
    bgRender();
    return;
  }
  if (!cookieString) {
    customizeState.domainCookies.addError = 'Cookie string is required.';
    bgRender();
    return;
  }
  customizeState.domainCookies.addInFlight = true;
  customizeState.domainCookies.addError = '';
  render();
  try {
    await api('/api/settings/domain-cookies/upsert', {
      method: 'POST',
      body: { host, cookieString },
    });
    customizeState.domainCookies.addHost = '';
    customizeState.domainCookies.addCookie = '';
    customizeState.domainCookies.loaded = false;
    await refreshDomainCookies();
  } catch (err) {
    customizeState.domainCookies.addError = err?.message || 'Failed to save cookie';
  } finally {
    customizeState.domainCookies.addInFlight = false;
    render();
  }
}

async function removeDomainCookie(host) {
  if (!host || customizeState.domainCookies.pendingRemoveHost === host) return;
  customizeState.domainCookies.pendingRemoveHost = host;
  render();
  try {
    await api('/api/settings/domain-cookies/remove', {
      method: 'POST',
      body: { host },
    });
    customizeState.domainCookies.loaded = false;
    await refreshDomainCookies();
  } catch (err) {
    customizeState.domainCookies.error = err?.message || 'Failed to remove cookie';
  } finally {
    customizeState.domainCookies.pendingRemoveHost = null;
    render();
  }
}

async function refreshSkillMarkdown(skillId) {
  const current = customizeState.skillMarkdown[skillId] || {};
  if (current.loading) return;
  customizeState.skillMarkdown[skillId] = { ...current, loading: true, error: null };
  bgRender();
  try {
    const response = await api(`/api/skills/export?id=${encodeURIComponent(skillId)}`);
    customizeState.skillMarkdown[skillId] = {
      loading: false,
      markdown: response?.markdown || '',
      error: null,
      copyToast: null,
    };
  } catch (err) {
    customizeState.skillMarkdown[skillId] = {
      loading: false,
      markdown: '',
      error: err?.message || 'Failed to load SKILL.md',
    };
  } finally {
    bgRender();
  }
}

// Moved from app.js (B3 step 2): the Tools & Tasks status cache is feature state.
async function refreshAdvancedStatus() {
  if (customizeState.advanced.loading) return;
  customizeState.advanced.loading = true;
  customizeState.advanced.error = null;
  bgRender();
  try {
    // Fan out — three independent endpoints, none of which block the
    // others, so a slow one doesn't gate the rest.
    const [serversResp, pluginsResp, tasksResp, diagnosticsResp, retainedResp] = await Promise.all([
      api('/api/mcp/servers').catch(err => ({ _error: err?.message || 'mcp/servers failed' })),
      api('/api/plugins').catch(err => ({ _error: err?.message || 'plugins failed' })),
      api('/api/background-tasks/list').catch(err => ({ _error: err?.message || 'background-tasks/list failed' })),
      api('/api/diagnostics?storage=1').catch(err => ({ _error: err?.message || 'diagnostics failed' })),
      api('/api/workspace/retained').catch(err=>({_error:err.message})),
    ]);
    const errors = [serversResp, pluginsResp, tasksResp, diagnosticsResp, retainedResp]
      .filter(r => r && r._error)
      .map(r => r._error);
    if (errors.length === 5) {
      customizeState.advanced.error = errors.join(' · ');
    } else {
      customizeState.advanced.cliServers = Array.isArray(serversResp?.servers) ? serversResp.servers : [];
      customizeState.advanced.plugins = Array.isArray(pluginsResp?.plugins) ? pluginsResp.plugins : [];
      customizeState.advanced.tasks = Array.isArray(tasksResp?.runs) ? tasksResp.runs : [];
      customizeState.advanced.diagnostics = diagnosticsResp?._error ? null : diagnosticsResp;
      customizeState.advanced.retainedFiles = retainedResp?._error ? null : retainedResp;
      customizeState.advanced.loaded = true;
      // Surface partial errors without blanking the panel.
      if (errors.length > 0) {
        customizeState.advanced.error = `Partial load: ${errors.join(' · ')}`;
      }
    }
  } catch (err) {
    customizeState.advanced.error = err?.message || 'Failed to load advanced status';
  } finally {
    customizeState.advanced.loading = false;
    render();
  }
}

// app.js's 'input' listener branches for this page, at their old positions:
// the skills search box, then the domain-cookie host / cookie inputs.
// Returns true when it handled the event.
export function handleInput(target) {
  if (target.dataset?.action === 'set-skill-filter-query') {
    customizeState.skillFilter.query = target.value;
    render();
    return true;
  }
  // Phase 4 — domain cookie form. Sync to state so render() doesn't
  // wipe user input mid-typing. No render() call here: the typing
  // guard above defers re-renders, and the form value already lives
  // in DOM, so the next render-from-elsewhere will reflect the same
  // value through `${escapeHtml(addHost/addCookie)}`.
  if (target.dataset.domainCookieHost !== undefined) {
    customizeState.domainCookies.addHost = target.value;
    return true;
  }
  if (target.dataset.domainCookieString !== undefined) {
    customizeState.domainCookies.addCookie = target.value;
    return true;
  }
  return false;
}

// app.js's 'change' listener branches, at their old positions: the safety
// allowlist filter selects (before the image / LLM-connection editors) and,
// inside the try block, the skill state filter select.
export function handleChange(target) {
  if (target.dataset.permissionFilter) { customizeState.safetyAllowlist.filters ||= {}; customizeState.safetyAllowlist.filters[target.dataset.permissionFilter] = target.value; render(); return true; }
  return false;
}
export function handleSkillFilterStateChange(target) {
  // Phase 3.3.2 — skill state filter select.
  if (target.dataset.action === 'set-skill-filter-state') {
    const allowed = new Set(['all', 'enabled', 'disabled', 'builtin', 'custom', 'disk']);
    customizeState.skillFilter.state = allowed.has(target.value) ? target.value : 'all';
    render();
    return true;
  }
  return false;
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
      customizeState.safetyAllowlist.loaded = false;
      await refreshSafetyAllowlist();
      return;
  },
  'safety-allowlist-remove': async ({ action, trigger, event }) => {
      await removeSafetyAllowlistRule(trigger.dataset.ruleId);
      return;
  },
  'refresh-domain-cookies': async ({ action, trigger, event }) => {
      customizeState.domainCookies.loaded = false;
      await refreshDomainCookies();
      return;
  },
  'domain-cookie-save': async ({ action, trigger, event }) => {
      // Pull the current input values into state right before save —
      // input listeners only sync on the next keystroke, so reading
      // the DOM directly here ensures we don't miss the last char.
      const hostInput = document.querySelector('[data-domain-cookie-host]');
      const cookieInput = document.querySelector('[data-domain-cookie-string]');
      if (hostInput) customizeState.domainCookies.addHost = hostInput.value || '';
      if (cookieInput) customizeState.domainCookies.addCookie = cookieInput.value || '';
      await upsertDomainCookie();
      return;
  },
  'domain-cookie-remove': async ({ action, trigger, event }) => {
      await removeDomainCookie(trigger.dataset.host);
      return;
  },
  'skill-detail-tab': async ({ action, trigger, event }) => {
      customizeState.skillDetailTab = trigger.dataset.tab || 'overview';
      render();
      if (customizeState.skillDetailTab === 'markdown') {
        const id = trigger.dataset.skillId;
        if (id && !customizeState.skillMarkdown[id]?.markdown) {
          refreshSkillMarkdown(id);
        }
      }
      return;
  },
  'copy-skill-markdown': async ({ action, trigger, event }) => {
      const id = trigger.dataset.skillId;
      const cached = id ? customizeState.skillMarkdown[id]?.markdown : null;
      if (cached && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(cached);
          customizeState.skillMarkdown[id] = { ...customizeState.skillMarkdown[id], copyToast: 'Copied' };
          render();
          setTimeout(() => {
            if (customizeState.skillMarkdown[id]) {
              customizeState.skillMarkdown[id] = { ...customizeState.skillMarkdown[id], copyToast: null };
              bgRender();
            }
          }, 1500);
        } catch (err) {
          customizeState.skillMarkdown[id] = { ...customizeState.skillMarkdown[id], copyToast: 'Copy failed' };
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
        customizeState.advanced = { ...customizeState.advanced, loaded: false };
        await refreshBootstrap();
        await refreshAdvancedStatus();
      } catch (err) {
        setError(`Toggle failed: ${err?.message || err}`);
        render();
        setTimeout(() => { setError(null); render(); }, 4000);
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
      customizeState.skillFilter.tag = nextTag ? nextTag : null;
      render();
      return;
  },
  'reset-skill-filter': async ({ action, trigger, event }) => {
      customizeState.skillFilter = { query: '', tag: null, state: 'all' };
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
      if (getBootstrap()?.customize?.skillProposals) {
        getBootstrap().customize.skillProposals =
          getBootstrap().customize.skillProposals.filter(
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
      const proposal = (getBootstrap()?.customize?.skillProposals || []).find(
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
        getBootstrap().customize.skillProposals =
          getBootstrap().customize.skillProposals.filter(p => p.seedId !== seedId);
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
      const draft = modelSetupDraft() || {};
      const apiKey  = pickConnectorField(draft, fd, 'minimaxApiKey');
      const groupId = pickConnectorField(draft, fd, 'minimaxGroupId');
      const voiceId = pickConnectorField(draft, fd, 'minimaxVoiceId');
      // Pre-flight: at least one path (form or saved) must yield a key
      // and a voice id. The server re-checks both via getResolvedConfig
      // so the UI message stays advisory.
      const savedKey   = Boolean(getBootstrap()?.settings?.config?.hasMinimaxKey);
      const savedVoice = Boolean(getBootstrap()?.settings?.config?.minimaxVoiceId);
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
      const savedDefault = getBootstrap()?.settings?.config?.minimaxVoiceId || '';
      const { voiceId, droppedStaleCache } = resolveActiveMinimaxVoiceId({
        cachedId: ttsVoice().customVoiceId,
        agentVoiceIds,
        savedDefault,
      });

      // If the cache no longer matches any valid voice, drop it now —
      // both in-memory and in localStorage — so a future activation
      // doesn't see the stale value again.
      if (droppedStaleCache) {
        setTtsVoice({ customVoiceId: '' });
        localStorage.removeItem('melo-tts-custom-voice-id');
      }

      if (!voiceId) {
        notify({level:'error',text:'Configure a MiniMax voice first — set a Default Voice ID in Settings → Connector or bind one to an agent.'});
        return;
      }

      setTtsVoice({ engine: 'api' });
      localStorage.setItem('melo-tts-engine', 'api');
      if (ttsVoice().customVoiceId !== voiceId) {
        setTtsVoice({ customVoiceId: voiceId });
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

export { handleCreateCustomSkill, handleDisconnectMcpServer, handlePingExternalConnector, handleReloadMcpServers, handleRemoveCustomSkill, handleUpdateCustomSkill, normalizeSkillFormBody, parseSkillCsvList, refreshAdvancedStatus, refreshDomainCookies, refreshSafetyAllowlist, refreshSkillMarkdown, refreshSkillRunStats, removeDomainCookie, removeSafetyAllowlistRule, upsertDomainCookie };
