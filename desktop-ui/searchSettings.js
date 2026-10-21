const state = { editing: false, busy: false, draft: null, message: '' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function renderSearchSettings(config) {
  if (!state.editing) state.draft = { ...(config.agentRuntime?.search || {}), apiKey: '', clearKey: false };
  const draft = state.draft || {}, disabled = !state.editing || state.busy ? 'disabled' : '';
  return `<section class="surface-card search-settings" data-search-settings>
    <h2 class="pane-title">Web Search</h2><p class="page-kicker">公开信息优先通过已验证的 Hosted Search 或 Search API 检索。没有可用服务时提示不可用，不自动启动浏览器。</p>
    <div class="config-form">
    <div class="inline-actions">
      <button type="button" class="small-button" data-action="search-settings-edit" ${state.busy ? 'disabled' : ''}>编辑</button>
      <button type="button" class="small-button" data-action="search-settings-save" ${disabled}>保存 Search 设置</button>
      <button type="button" class="small-button" data-action="search-settings-cancel" ${disabled}>取消</button>
    </div>
    <fieldset class="settings-connection-fields" ${disabled}>
      <label class="list-row-meta"><input type="checkbox" name="enabled" ${draft.backend === 'http' ? 'checked' : ''}> 启用 HTTP Search</label>
      <label class="label">Search Provider<select class="config-select" name="provider"><option value="custom" ${draft.provider !== 'brave' ? 'selected' : ''}>兼容 HTTP</option><option value="brave" ${draft.provider === 'brave' ? 'selected' : ''}>Brave Search API</option></select></label>
      <label class="label">Search 地址（Brave 留空使用默认地址）<input class="config-input" name="endpoint" value="${escape(draft.endpoint)}"></label>
      <label class="list-row-meta"><input type="checkbox" name="usesKey" ${draft.credentialRef || draft.provider === 'brave' ? 'checked' : ''}> 使用本机 Search 凭证</label>
      <label class="label">新的 Search API Key<input class="config-input" name="apiKey" type="password" autocomplete="off" value="${escape(draft.apiKey)}" placeholder="留空保留这个地址原有的密钥"></label>
      <label class="list-row-meta"><input type="checkbox" name="clearKey" ${draft.clearKey ? 'checked' : ''}> 清除此地址已保存的 Search Key</label>
      <label class="list-row-meta"><input type="checkbox" name="browserFallback" ${draft.browserFallback ? 'checked' : ''}> 允许浏览器检索（Legacy，默认关闭）</label>
    </fieldset>
    <p class="list-row-meta">Search 凭证仅保存于本机，并绑定该地址。保存配置不会发送搜索请求，也不代表服务已验证。</p>
    <p role="status">${escape(state.message)}</p>
    </div>
  </section>`;
}

export function editSearchSettings(target) {
  if (!target.closest?.('[data-search-settings]')) return false;
  if (!state.editing || !target.name) return true;
  const value = target.type === 'checkbox' ? target.checked : target.value;
  if (target.name === 'enabled') state.draft.backend = value ? 'http' : 'none';
  else if (target.name === 'usesKey') state.draft.credentialRef = value ? 'search' : '';
  else { state.draft[target.name] = value; if (target.name === 'provider') state.draft.endpoint = ''; }
  return true;
}

export async function handleSearchSettings(action, { api, render, refresh }) {
  if (!action?.startsWith('search-settings-')) return false;
  if (state.busy) return true;
  if (action === 'search-settings-edit') { state.editing = true; state.message = ''; render(); return true; }
  if (action === 'search-settings-cancel') { state.editing = false; state.message = '修改已取消'; render(); return true; }
  if (action !== 'search-settings-save' || !state.editing) return true;
  const draft = { ...state.draft };
  state.busy = true; render();
  try {
    await api('/api/settings/model', { method: 'POST', body: { agentRuntime: { version: 1, search: {
      backend: draft.backend || 'none', provider: draft.provider || 'custom', endpoint: draft.endpoint || '',
      credentialRef: draft.credentialRef || '', browserFallback: draft.browserFallback === true,
    } }, searchApiKey: draft.apiKey, clearSearchKey: draft.clearKey === true } });
    state.editing = false; state.message = 'Search 配置已保存，尚未验证真实服务。';
    state.draft.apiKey = ''; await refresh();
  } catch (error) { state.message = error.message || '保存失败，输入已保留'; }
  finally { state.busy = false; render(); }
  return true;
}
