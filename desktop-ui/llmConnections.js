import { EditSession, renderEditActions, paintEditActions } from './settingsEdit.js';
import { copyLinkText } from './linkActions.js';
import { connectionModelOptions, modelLabel } from './modelPresentation.js';

const editSession = new EditSession();
const state = { selected: '', draft: null, busy: false, message: '', oauth: null, conflict: false };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const connections = config => config.llmConnections || { providers: [], profiles: [], activeId: '' };
function draftFor(config) {
  if (state.draft && (editSession.editing || editSession.status === 'saving' || state.busy)) return state.draft;
  const data = connections(config);
  state.selected ||= data.activeId || (config.authMode === 'codex' ? 'chatgpt' : 'custom');
  const saved = data.profiles.find(p => p.id === state.selected);
  const provider = data.providers.find(p => p.id === (saved?.providerId || state.selected)) || data.providers[0];
  const legacy = !saved && !data.activeId && provider?.authMode === config.authMode &&
    (config.authMode === 'codex' || provider?.baseUrl === config.baseUrl);
  return state.draft = { ...provider, ...(legacy ? {model: config.model || provider.model} : {}), ...saved, id: state.selected, providerId: provider?.id, apiKey: '', revision: saved?.revision || 0 };
}
export function editLlmConnection(target, config) {
  if (!target.closest?.('[data-llm-connections]')) return false;
  if (target.dataset.action === 'llm-select') { if(editSession.editing || editSession.status==='saving'){state.message='请先保存或取消修改，再切换连接。';target.value=state.selected;return true;} editSession.cancel(); state.selected = target.value; state.draft = null; state.message = ''; return true; }
  if (!editSession.editing) return true;
  if (target.dataset.action === 'llm-pick-model') {
    if (!target.value) { target.closest('[data-llm-connections]').querySelector('[name=model]')?.focus(); return true; }
    const input = target.closest('[data-llm-connections]').querySelector('[name=model]');
    input.value = target.value;
    return editLlmConnection(input, config);
  }
  if (target.name) { editSession.change(); draftFor(config)[target.name] = target.type === 'checkbox' ? target.checked : target.value; state.message = '有未保存的修改'; const bar=target.closest('[data-llm-connections]').querySelector('.settings-edit-toolbar');paintEditActions(bar,editSession,{prefix:'llm',disabled:state.busy,saveDisabled:state.conflict}); }
  return true;
}

export function renderLlmConnections(config) {
  const data = connections(config);
  if (!data.providers.length) return '';
  const draft = draftFor(config);
  const saved = data.profiles.find(p => p.id === draft.id);
  const provider = data.providers.find(p => p.id === draft.providerId);
  const options = [...data.profiles.map(p => ({ id: p.id, name: `${p.name}${p.id === data.activeId ? ' · 当前使用' : ' · 已保存'}` })),
    ...data.providers.filter(p => !data.profiles.some(s => s.id === p.id)).map(p => ({ id: p.id, name: p.name }))];
  const disabled = state.busy ? 'disabled' : '';
  const fieldsDisabled = state.busy || !editSession.editing ? 'disabled' : '';
  const actionDisabled = state.busy || editSession.editing || !saved ? 'disabled' : '';
  const test = saved?.test;
  return `<section class="surface-card llm-connections" data-llm-connections>
    <div class="header-row"><h2 class="pane-title">模型提供方</h2><span class="chip">Melo 负责记忆与工具执行</span></div>
    <p class="page-kicker">各平台的地址、密钥和模型独立保存。连接测试会发送一次简短请求，计入对应账号用量。</p>
    <div class="config-form">
      <label class="label">选择连接<select class="config-select" data-action="llm-select" ${disabled}>${options.map(p => `<option value="${escape(p.id)}" ${p.id === draft.id ? 'selected' : ''}>${escape(p.name)}</option>`).join('')}</select></label>
      ${renderEditActions(editSession,{prefix:'llm',disabled:state.busy,saveDisabled:state.conflict})}
      ${state.conflict ? '<p role="alert">此连接已在其他位置更新，当前草稿仍保留。请先载入最新配置，再重新编辑。</p><button type="button" class="small-button" data-action="llm-reload">放弃此草稿并载入最新配置</button>' : ''}
      <fieldset class="settings-connection-fields" ${fieldsDisabled}><label class="label">服务地址<input class="config-input" name="baseUrl" value="${escape(draft.baseUrl)}" ${provider.authMode === 'codex' ? 'readonly' : ''} ${disabled}></label>
      ${provider.id === 'custom' ? `<label class="label">接口格式<select class="config-select" name="apiProtocol" ${disabled}><option value="chat-completions" ${!['anthropic','responses'].includes(draft.apiProtocol) ? 'selected' : ''}>OpenAI Chat Completions</option><option value="responses" ${draft.apiProtocol === 'responses' ? 'selected' : ''}>OpenAI Responses</option><option value="anthropic" ${draft.apiProtocol === 'anthropic' ? 'selected' : ''}>Anthropic Messages</option></select></label>` : ''}
      <label class="label">选择模型<select class="config-select" data-action="llm-pick-model">${connectionModelOptions(config, draft).map(m => `<option value="${escape(m)}" ${m === draft.model ? 'selected' : ''}>${escape(modelLabel(m))} · ${escape(m)}</option>`).join('')}<option value="" ${!draft.model ? 'selected' : ''}>手动填写模型 ID</option></select></label>
      <label class="label">模型 ID（可手动填写）<input class="config-input" name="model" value="${escape(draft.model)}" placeholder="${escape(provider.modelHint || '填写模型 ID，或读取模型列表')}" ${disabled}></label>
      ${provider.authMode !== 'codex' ? `<label class="label">API Key${provider.authMode === 'local' ? '（可选）' : ''}<input class="config-input" name="apiKey" type="password" autocomplete="off" value="${escape(draft.apiKey)}" placeholder="${saved?.hasKey ? '已保存；留空保留此连接的密钥' : '只保存到本机'}" ${disabled}></label><label class="list-row-meta"><input type="checkbox" name="clearKey" ${draft.clearKey ? 'checked' : ''} ${disabled}> 清除此连接的已保存密钥</label>` : `<p class="list-row-meta">${config.codexAuth?.loggedIn ? 'ChatGPT 已登录' : '需要先完成 ChatGPT 登录'}；模型请求由 Melo 直接发送。</p>`}
      </fieldset><div class="inline-actions">
        <button type="button" class="small-button" data-action="llm-models" ${actionDisabled}>读取模型列表</button>
        <button type="button" class="small-button" data-action="llm-test" ${actionDisabled}>测试实际请求</button>
        <button type="button" class="small-button" data-action="llm-vision" ${actionDisabled}>测试图片识别</button>
        <button type="button" class="small-button" data-action="llm-search" ${actionDisabled} ${provider.authMode !== 'codex' && draft.apiProtocol !== 'responses' ? 'disabled' : ''}>验证 Hosted Search</button>
        <button type="button" class="small-button is-primary" data-action="llm-activate" ${actionDisabled}>设为当前模型</button>
        ${provider.oauth ? `<button type="button" class="small-button" data-action="llm-oauth" ${actionDisabled}>${provider.id === 'openrouter' ? '登录 OpenRouter' : '登录 ChatGPT'}</button>` : ''}
        ${saved && saved.id !== data.activeId ? `<button type="button" class="small-button" data-action="llm-remove" ${actionDisabled}>移除连接</button>` : ''}
      </div>
      ${provider.id === 'openrouter' ? '<p class="list-row-meta">登录授权使用 OpenRouter 额度，也可直接填写 Key。不会使用你的 ChatGPT 或 Claude 订阅额度。</p>' : ''}
      <p role="status" aria-live="polite" class="llm-connection-status">${escape(state.message || (test ? test.ok ? `请求成功 · ${test.latencyMs} ms · 请求模型：${test.requestedModel} · 返回模型：${test.reportedModel || '服务未提供'} · ${test.testedAt}` : `请求失败：${test.error} · ${test.guidance || ""}` : '尚未进行此连接的真实请求测试'))}</p>
      <p class="list-row-meta">图片识别：${saved?.visionTest ? saved.visionTest.ok ? `已实测 · ${escape(saved.visionTest.requestedModel)} · ${escape(saved.visionTest.testedAt)}` : `测试未通过 · ${escape(saved.visionTest.error)}` : '尚未实测；测试会发送一张本机生成的数字图，计入模型用量'}</p>
      <p class="list-row-meta">Hosted Search：${saved?.searchTest ? saved.searchTest.ok ? `上次验证通过 · ${escape(saved.searchTest.requestedModel)} · ${escape(saved.searchTest.testedAt)}` : `尚未验证通过 · ${escape(saved.searchTest.error)}` : '尚未验证；按钮会发送一次真实搜索请求，计入服务用量。验证绑定当前连接与凭证。'}</p>
      ${state.oauth ? `<div class="inline-actions"><button type="button" class="small-button" data-action="llm-open-oauth">打开授权页面</button><button type="button" class="small-button" data-action="llm-copy-oauth">复制授权链接</button><button type="button" class="small-button" data-action="llm-cancel-oauth">取消授权</button></div>` : ''}
      <details class="list-row-meta"><summary>平台能力说明</summary><p>这里连接模型接口。搜索、文件处理和其他工具仍由 Melo 调度；模型可用性以实际请求为准。Copilot、Gemini CLI、Kimi Code 的代理程序未作为模型通道接入。</p></details>
    </div>
  </section>`;
}

export async function handleLlmConnection(action, { config, api, render, refresh, openUrl, chatgptLogin }) {
  if (!action.startsWith('llm-')) return false;
  if (action === 'llm-open-oauth') { if (state.oauth) openUrl(state.oauth.url); return true; }
  if (action === 'llm-copy-oauth') { if (state.oauth) { try { await copyLinkText(state.oauth.url); state.message = '授权链接已复制'; } catch { state.message = '复制失败，请点击“打开授权页面”。'; } render(); } return true; }
  if (action === 'llm-cancel-oauth') {
    try {
      if (state.oauth) await api('/api/settings/llm/oauth/status', { method: 'POST', body: { id: state.oauth.id, cancel: true } });
      state.oauth = null; state.message = '授权已取消';
    } catch { state.message = '取消请求未送达，请重试；尚未完成的授权会自动过期。'; }
    render(); return true;
  }
  if (state.busy || action === 'llm-select') return true;
  if(action==='llm-edit'){draftFor(config);editSession.begin();state.conflict=false;if(!connections(config).profiles.some(p=>p.id===state.selected))editSession.change();state.message='';render();return true;}
  if(action==='llm-cancel'){state.conflict=false;editSession.cancel();state.draft=null;globalThis.document?.querySelector('.settings-connection-fields')?.remove();state.message='已取消修改';render();return true;}
  if(action==='llm-reload') {
    state.busy=true;render();
    try { await refresh();editSession.cancel();state.draft=null;state.conflict=false;state.message='已载入最新配置，请重新编辑。';globalThis.document?.querySelector('.settings-connection-fields')?.remove(); }
    catch(error){state.message=`读取失败，草稿保留：${error.message}`;}
    finally{state.busy=false;render();}
    return true;
  }
  if(action==='llm-save' && state.conflict)return true;
  if(action==='llm-save') { if(!editSession.start())return true; }
  else if(editSession.editing || !connections(config).profiles.some(p=>p.id===state.selected)) {state.message='请先点击编辑并保存连接，再执行此操作。';render();return true;}
  const draft = { ...draftFor(config) };
  state.busy = true; state.message = '正在处理…'; render();
  try {
    if (action === 'llm-remove') {
      await api('/api/settings/llm/remove', { method: 'POST', body: { id: draft.id } }); state.draft = null; state.selected = ''; state.message = '连接已移除';
    } else {
      if(action==='llm-save') {
        const saved = await api('/api/settings/llm/save', { method: 'POST', body: draft });
        const updated = saved.profiles.find(p => p.id === draft.id);
        state.draft = { ...draft, ...updated, apiKey: '', clearKey: false };
        editSession.saved();
      }
      if (action === 'llm-activate') {
        await api('/api/settings/llm/activate', { method: 'POST', body: { id: draft.id } }); state.message = '已设为默认回答模型；额外快速开启时，短判断按加速设置单独分配。Melo 的Agent指令与工具配置保留。';
      } else if (action === 'llm-test' || action === 'llm-vision' || action === 'llm-search' || action === 'llm-models') {
        state.message = action !== 'llm-models' ? '正在发送真实模型请求…' : '正在读取模型列表…'; render();
        const result = await api(`/api/settings/llm/${action === 'llm-models' ? 'models' : 'test'}`, { method: 'POST', body: { id: draft.id, modality: action === 'llm-search' ? 'search' : action === 'llm-vision' ? 'vision' : 'text' } });
        state.message = action === 'llm-models' ? `已读取 ${result.models.length} 个模型；选择或手填模型 ID 后可测试。` : result.ok ? `请求成功 · ${result.latencyMs} ms · 请求模型：${result.requestedModel} · 返回模型：${result.reportedModel || '服务未提供'} · 回答：${result.preview}` : `请求失败：${result.error} · ${result.guidance || ""}`;
      } else if (action === 'llm-oauth') {
        if (draft.providerId === 'chatgpt') await chatgptLogin();
        else {
          const flow = await api('/api/settings/llm/oauth', { method: 'POST', body: { id: draft.id } });
          state.oauth = flow; openUrl(flow.url); state.message = '请在浏览器完成授权。';
          const poll = async () => {
            if (state.oauth?.id !== flow.id) return;
            try {
              const status = await api('/api/settings/llm/oauth/status', { method: 'POST', body: { id: flow.id } });
              if (['pending', 'exchanging'].includes(status.status)) { setTimeout(poll, 2000); return; }
              state.oauth = null; state.message = status.status === 'completed' ? '授权已保存。选择模型后点击“测试实际请求”。' : status.error || `授权${status.status === 'cancelled' ? '已取消' : '已过期或失败'}，请重试。`;
              state.draft = null; await refresh(); render();
            } catch { state.oauth = null; state.message = '无法读取授权状态，请刷新后重试。'; render(); }
          };
          setTimeout(poll, 2000);
        }
      } else state.message = '连接已保存；设为当前模型后用于新的请求。';
    }
    await refresh();
  } catch (error) { if(action==='llm-save'&&editSession.status!=='saved'){editSession.failed(error);state.conflict=error.code==='LLM_PROFILE_CONFLICT'||/连接已发生变化/.test(error.message);} state.message = error.message || '连接操作失败'; }
  finally { state.busy = false; render(); }
  return true;
}
