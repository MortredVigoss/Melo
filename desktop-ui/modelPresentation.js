import { PROVIDER_DEFAULTS } from '../shared/agent/providerDefaults.js';
import { t, ui } from './i18n.js';
const routingLabels = { light:'轻', standard:'标准', strong:'强', high_risk:'高风险任务', deep_research:'深入研究', task_shape:'任务要求', simple:'简单任务', ambiguous:'默认标准档', judgment:'任务判断', requested_escalation:'模型请求升档', repeated_failure:'重复失败', tool_rounds:'工具轮次增加', side_effect:'有副作用的操作' };
const labels = PROVIDER_DEFAULTS.labels;

export function modelLabel(model) {
  return labels[model] || String(model || t("未配置"));
}

// Only the active connection may use its discovered catalog. Two providers
// sharing an auth mode (e.g. API key) do not necessarily offer the same models.
export function connectionModelOptions(config, profile = null) {
  const activeId = config.llmConnections?.activeId || '';
  const active = !profile || (activeId ? profile.id === activeId : profile.authMode === config.authMode &&
    (profile.authMode === 'codex' || profile.baseUrl === config.baseUrl));
  const mode = profile?.authMode || config.authMode;
  return [...new Set([
    ...(active || mode === 'codex' ? config.modelCatalogs?.[mode] || [] : []),
    ...(active ? config.availableModels || [] : []),
    ...(profile?.models || []),
    profile?.model,
    ...(active ? [config.model] : []),
  ].map(value => String(value || '').trim()).filter(Boolean))];
}

export function renderDefaultModelSettings(config, escape) {
  return ui`<section class="surface-card default-model-settings">
    <h2 class="pane-title">默认回答模型</h2>
    <p class="page-kicker">沿用当前连接的账号与密钥。未单独指定模型的对话使用这里的选择；Agent或对话已指定的模型保留。</p>
    <form class="config-form" data-form="default-model-config">
      <label class="label">选择模型<select class="config-select" name="model" required aria-label="系统默认回答模型">
        ${connectionModelOptions(config).map(model => ui`<option value="${escape(model)}" ${model === config.model ? 'selected' : ''}>${escape(modelLabel(model))} · ${escape(model)}</option>`).join('')}
      </select></label>
      <p class="list-row-meta">点击编辑后选择，保存后生效。其他平台或自定义模型 ID 可在下方“模型提供方”配置；可用性以实际请求为准。</p>
    </form>
  </section>`;
}

export function modelPanelPosition(anchor, panel, viewport) {
  const above = anchor.top - panel.height - 12;
  return {
    left: Math.max(16, Math.min(viewport.width - panel.width - 16, anchor.right - panel.width)),
    top: Math.max(16, Math.min(viewport.height - panel.height - 16, above >= 16 ? above : anchor.bottom + 12)),
  };
}

export function conversationAgents(data, { overview = false, newProjectId = null } = {}) {
  const projectId = overview ? newProjectId : data.activeChat?.projectId;
  // Project data may contain only overrides. Keep the default and custom
  // roles, then apply overrides by ID instead of replacing the whole list.
  const base = data.conversationProfiles?.global || data.customize?.agents || [];
  const merged = new Map(base.filter(a=>a?.id).map(a=>[a.id,a]));
  for(const agent of data.conversationProfiles?.projects?.[projectId] || []) if(agent?.id) merged.set(agent.id,{...merged.get(agent.id),...agent});
  return [...merged.values()].sort((a,b)=>(a.id==='main'?-1:b.id==='main'?1:0));
}

export function conversationAgent(data, { overview = false, newAgentId = 'main', newProjectId = null } = {}) {
  const id = (!overview && data.activeChat?.agentId) || newAgentId;
  const agents = conversationAgents(data, {overview, newProjectId});
  return agents.find(agent => agent.id === id) || agents.find(agent => agent.id === 'main') || null;
}

export function renderModelPicker({ config, models, agent, selection, open, saving }, escape) {
  const smart = selection?.mode === 'smart' || (!selection && config.smartRouting?.defaultMode === 'smart');
  const current = smart ? agent?.model || t('智能（自动）') : selection?.model || agent?.model || config.model;
  const profiles = config.llmConnections?.profiles || [];
  const activeID = config.llmConnections?.activeId || '';
  const choices = [{id:activeID,name:t("当前连接"),models}, ...profiles.filter(p=>p.id!==activeID).map(p=>({id:p.id,name:p.name,models:connectionModelOptions(config,p)}))];
  return ui`<div class="model-picker-anchor">
    <button type="button" class="model-picker-trigger" data-action="toggle-model-picker" aria-label="选择对话模型" aria-expanded="${open}" aria-controls="model-picker-panel" ${saving ? 'disabled' : ''} title="本对话：${escape(current || '')}">
      <span class="model-picker-dot" aria-hidden="true"></span><span>${escape(modelLabel(current))}</span><small>${selection?t("本对话"):t("默认")}</small><span aria-hidden="true">⌄</span>
    </button>
    ${open ? ui`<section id="model-picker-panel" class="model-picker-panel" popover="manual" aria-label="对话模型选择">
      <header><div><small>MODEL / CONNECTION</small><h3 class="subsection-title">选择本对话的模型</h3></div></header>
      <p class="model-picker-context">${agent?.model ? `${escape(agent.name)} 单独指定了 ${escape(modelLabel(agent.model))}。` : t("未单独选择时沿用默认模型。")} 更改只影响本对话之后的请求。</p>
      <p class="model-picker-context">这里选择文字对话模型；图片理解与生成可在系统中另行配置。网页搜索、文件及电脑工具由 Melo 按 Agent 权限执行，网页搜索无需额外配置。</p>
      <div class="model-picker-options" role="group" aria-label="可选模型">
        <button type="button" class="model-picker-option ${!selection?'is-selected':''}" data-action="pick-default-model" data-model="" aria-pressed="${!selection}" ${saving?'disabled':''}>沿用Agent / 系统默认</button>
        <button type="button" class="model-picker-option ${selection?.mode==='smart'?'is-selected':''}" data-action="pick-default-model" data-model-mode="smart" data-profile-id="${escape(selection?.profileId || activeID)}" aria-pressed="${selection?.mode==='smart'}" ${saving||agent?.model?'disabled':''}>智能（自动）</button>
        ${choices.map(profile=>ui`<small>${escape(profile.name)}</small>${profile.models.map(model=>ui`<button type="button" class="model-picker-option ${selection?.mode!=='smart'&&selection?.model===model&&selection?.profileId===profile.id?'is-selected':''}" data-action="pick-default-model" data-model="${escape(model)}" data-profile-id="${escape(profile.id)}" aria-pressed="${selection?.mode!=='smart'&&selection?.model===model&&selection?.profileId===profile.id}" ${saving?'disabled':''}><span><strong>${escape(modelLabel(model))}</strong><small>${escape(model)}</small></span></button>`).join('')}`).join('')}
      </div><footer><span>${saving?t("正在保存…"):'其他对话和系统默认不变；实际返回模型仍在每条回复下记录。'}</span><button type="button" data-action="open-view" data-view="model">管理连接 ↗</button></footer>
    </section>` : ''}
  </div>`;
}

export function renderModelReceipt(message, escape) {
  if (message.role !== 'assistant') return '';
  const receipts = (Array.isArray(message.metadata?.modelResponses) ? message.metadata.modelResponses : []).filter(row => row && typeof row === 'object');
  if (!receipts.length) return '';
  const names = [...new Set(receipts.map(row => row.reportedModel).filter(Boolean))];
  const simulated = receipts.some(row => row.simulated);
  const summary = simulated ? t("模拟回复") : names.length === 1 ? modelLabel(names[0]) : names.length > 1 ? t('{count} 个模型', { count: names.length }) : t("服务端未返回标识");
  return ui`<details class="model-receipt" data-neural-key="model-receipt-${escape(message.id)}">
    <summary><span aria-hidden="true">◇</span> 模型记录 <span>${escape(summary)}</span></summary>
    <div class="model-receipt-body"><p>以下是这条回复的调用记录，当前默认模型不会改写历史记录。</p>
      ${receipts.map((row, index) => ui`<div class="model-receipt-row">
        <span class="model-receipt-index">${String(index + 1).padStart(2, '0')}</span>
        <dl>${row.routing ? ui`<div><dt>智能选模</dt><dd>${escape(t(routingLabels[row.routing.tier] || '智能模式'))} · ${escape(t(routingLabels[row.routing.reason] || '智能模式'))}${row.routing.equivalentFixed ? ` · ${t("等同固定模型")}` : ""}</dd></div>` : ""}${row.purpose === "routing-judge" ? ui`<div><dt>用途</dt><dd>智能模式判断</dd></div>` : ""}${row.purpose === "intent-judge" ? ui`<div><dt>用途</dt><dd>意图判断</dd></div>` : ""}<div><dt>请求模型</dt><dd>${escape(row.requestedModel || t("未记录"))}</dd></div><div><dt>服务端返回</dt><dd>${escape(row.reportedModel || t("未提供模型标识"))}</dd></div></dl>
        <span class="model-receipt-state">${row.simulated ? t("模拟 · 未验证真实模型") : !row.reportedModel ? t("未验证") : row.reportedModel === row.requestedModel ? t("返回一致") : t("返回不同模型")}</span>
      </div>`).join('')}
      ${message.metadata?.runId ? ui`<small class="model-receipt-run">运行编号 ${escape(message.metadata.runId)}</small>` : ''}
    </div>
  </details>`;
}

export function conversationConnectionReady(config, selection) {
  if (selection?.portable) {
    const p = selection.portable;
    const base = value => String(value || '').replace(/\/(?:chat\/completions|messages)\/?$/, '').replace(/\/+$/, '');
    const matches = (config.llmConnections?.profiles || []).filter(profile => profile.authMode === p.authMode && (p.authMode === 'codex' || base(profile.baseUrl) === base(p.baseURL)) && (profile.apiProtocol || 'chat-completions') === p.apiProtocol);
    const profile = matches.find(row => row.id === p.connectionID) || (matches.length === 1 ? matches[0] : null);
    if (profile) selection = {...selection, profileId:profile.id};
    else if (config.authMode === p.authMode && (p.authMode === 'codex' || base(config.baseUrl) === base(p.baseURL)) && (config.apiProtocol || 'chat-completions') === p.apiProtocol) selection = {...selection,profileId:''};
    else return false;
  }
  if (!selection?.profileId) return Boolean(config.hasCredentials);
  const profile = (config.llmConnections?.profiles || []).find(p=>p.id===selection.profileId);
  if (!profile) return false;
  if (profile.authMode === 'codex') return Boolean(config.codexAuth?.loggedIn);
  if (profile.authMode === 'local') return Boolean(profile.baseUrl && selection.model);
  return Boolean(profile.hasKey);
}
