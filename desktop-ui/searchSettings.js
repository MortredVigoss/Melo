import { escapeHtml } from './i18n.js';
import { t, ui } from './i18n.js';
import { EditSession, renderEditActions, paintEditActions } from './settingsEdit.js';

// Same read-only → Edit → Save / Cancel toolbar as the other settings blocks
// (audit 2026-10-22; this block used to carry its own three buttons).
const session = new EditSession();
const state = { busy: false, draft: null, message: '' };
const draftFrom = config => ({ ...(config.agentRuntime?.search || {}), apiKey: '', clearKey: false });

export function renderSearchSettings(config) {
  if (!session.editing && session.status !== 'saving') state.draft = draftFrom(config);
  const draft = state.draft || {}, disabled = !session.editing || state.busy ? 'disabled' : '';
  return ui`<section class="surface-card search-settings" data-search-settings>
    <h2 class="pane-title">联网搜索</h2><p class="page-kicker">公开信息优先通过已验证的 Hosted Search 或配置的 Search API 检索；两者都没有时使用内置网页检索（无需密钥，可在下方关闭）。</p>
    <div class="config-form">
    ${renderEditActions(session, { prefix: 'search-settings', disabled: state.busy })}
    <fieldset class="settings-connection-fields" ${disabled}>
      <label class="list-row-meta"><input type="checkbox" name="enabled" ${draft.backend === 'http' ? 'checked' : ''}> 启用 HTTP Search</label>
      <label class="label">搜索服务<select class="config-select" name="provider"><option value="custom" ${draft.provider !== 'brave' ? 'selected' : ''}>兼容 HTTP</option><option value="brave" ${draft.provider === 'brave' ? 'selected' : ''}>Brave Search API</option></select></label>
      <label class="label">Search 地址（Brave 留空使用默认地址）<input class="config-input" name="endpoint" value="${escapeHtml(draft.endpoint)}"></label>
      <label class="list-row-meta"><input type="checkbox" name="usesKey" ${draft.credentialRef || draft.provider === 'brave' ? 'checked' : ''}> 使用本机 Search 凭证</label>
      <label class="label">新的 Search API Key<input class="config-input" name="apiKey" type="password" autocomplete="off" value="${escapeHtml(draft.apiKey)}" placeholder="留空保留这个地址原有的密钥"></label>
      <label class="list-row-meta"><input type="checkbox" name="clearKey" ${draft.clearKey ? 'checked' : ''}> 清除此地址已保存的 Search Key</label>
      <label class="list-row-meta"><input type="checkbox" name="browserFallback" ${draft.browserFallback ? 'checked' : ''}> 允许内置网页检索（无需密钥，默认开启）</label>
      <label class="label">搜索条数上限<input class="config-input" type="number" name="maxResults" min="1" max="8" value="${escapeHtml(draft.maxResults || 8)}"></label>
      <label class="label">搜索超时（毫秒）<input class="config-input" type="number" name="timeoutMs" min="3000" max="120000" value="${escapeHtml(draft.timeoutMs || 20000)}"></label>
    </fieldset>
    <p class="list-row-meta">Search 凭证仅保存于本机，并绑定该地址。保存配置不会发送搜索请求，也不代表服务已验证。</p>
    <p role="status" aria-live="polite">${escapeHtml(state.message)}</p>
    </div>
  </section>`;
}

export function editSearchSettings(target) {
  const root = target.closest?.('[data-search-settings]');
  if (!root) return false;
  if (!session.editing || !target.name || state.busy) return true;
  const value = target.type === 'checkbox' ? target.checked : target.value;
  if (target.name === 'enabled') state.draft.backend = value ? 'http' : 'none';
  else if (target.name === 'usesKey') state.draft.credentialRef = value ? 'search' : '';
  else { state.draft[target.name] = value; if (target.name === 'provider') state.draft.endpoint = ''; }
  session.change(); state.message = '';
  paintEditActions(root.querySelector?.('.settings-edit-toolbar'), session, { prefix: 'search-settings', disabled: state.busy });
  return true;
}

export async function handleSearchSettings(action, { api, render, refresh }) {
  if (!action?.startsWith('search-settings-')) return false;
  if (state.busy) return true;
  if (action === 'search-settings-edit') { session.begin(); state.message = ''; render(); return true; }
  if (action === 'search-settings-cancel') { session.cancel(); state.draft = null; state.message = t('已取消修改'); render(); return true; }
  if (action !== 'search-settings-save' || !session.start()) return true;
  const draft = { ...state.draft };
  state.busy = true; render();
  try {
    await api('/api/settings/model', { method: 'POST', body: { agentRuntime: { version: 1, search: {
      backend: draft.backend || 'none', provider: draft.provider || 'custom', endpoint: draft.endpoint || '',
      credentialRef: draft.credentialRef || '', browserFallback: draft.browserFallback === true,
      maxResults: Number(draft.maxResults || 8), timeoutMs: Number(draft.timeoutMs || 20000),
    } }, searchApiKey: draft.apiKey, clearSearchKey: draft.clearKey === true } });
    session.saved(); state.message = t('Search 配置已保存，尚未验证真实服务。');
    state.draft.apiKey = ''; await refresh();
  } catch (error) { session.failed(error); state.message = error.message || t('保存失败，输入已保留'); }
  finally { state.busy = false; render(); }
  return true;
}
