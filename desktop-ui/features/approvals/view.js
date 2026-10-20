// Capability elevation surfaces (2026-10-20): the prompt card a reply stream
// raises (same look as the tool permission dialog) and the «临时授权» list
// shown in Agent settings and Customize → Safety. The Chinese strings are the
// shared contract's source texts (shared/protocol/agent-loop.json
// capabilityElevation); the catalog translates them.
import { t, ui, currentLanguage } from '../../i18n.js';
import { approvalsState } from './state.js';
import { getBootstrap, escapeHtml, icon } from './context.js';
import { ensureGrants } from './controller.js';

const BOOLEAN_LABELS = {
  readFiles: () => t('读取文件'), writeFiles: () => t('修改文件'), runCommands: () => t('运行命令'), network: () => t('联网'),
  knowledgeMemory: () => t('知识与记忆'), generateMedia: () => t('生成媒体'), delegate: () => t('委派'),
};
const LIST_LABELS = {
  mcpServers: id => t('MCP 服务「{id}」', { id }),
  skills: id => t('技能「{id}」', { id }),
  connectors: id => t('连接器「{id}」', { id }),
};

export function atomLabel(atom) {
  const text = String(atom || '');
  if (BOOLEAN_LABELS[text]) return BOOLEAN_LABELS[text]();
  const separator = text.indexOf(':');
  const list = LIST_LABELS[text.slice(0, separator)];
  return separator > 0 && list ? list(text.slice(separator + 1)) : text;
}
export const atomsLabel = atoms => (Array.isArray(atoms) ? atoms : []).map(atomLabel).join(t('、'));

const agentName = id => getBootstrap()?.customize?.agents?.find(agent => agent.id === id)?.name || id || 'Agent';

const OPTION_LABELS = {
  'elevate-beyond-parent': { run: () => t('仅本次任务'), project: scope => (scope === 'chat' ? t('本对话 24 小时') : t('本项目 24 小时')), deny: () => t('拒绝') },
  'enable-own': { run: () => t('仅本次'), always: () => t('一直开启'), deny: () => t('拒绝') },
};
export function optionLabel(decision, option, projectOptionScope) {
  return OPTION_LABELS[decision]?.[option]?.(projectOptionScope) || option;
}

export function promptText(entry) {
  const capability = atomsLabel(entry.capabilities);
  const agent = entry.agentName || agentName(entry.agentId);
  return entry.decision === 'elevate-beyond-parent'
    ? t('{agent} 需要『{capability}』，{parent} 没有这个能力', { agent, capability, parent: entry.parentName || agentName(entry.parentAgentId) })
    : t('此 Agent（{agent}）需要『{capability}』', { agent, capability });
}

/** The prompt card for one queued `capability_request` (kind 'capability'). */
export function renderCapabilityPrompt(entry) {
  const beyond = entry.decision === 'elevate-beyond-parent';
  const options = (Array.isArray(entry.options) ? entry.options : []).map(option => (typeof option === 'string' ? option : option?.id)).filter(Boolean);
  const titleId = `capability-prompt-title-${escapeHtml(entry.requestId)}`;
  const bodyId = `capability-prompt-body-${escapeHtml(entry.requestId)}`;
  const capability = atomsLabel(entry.capabilities);
  return ui`
    <div class="tool-permission-backdrop capability-prompt-backdrop" role="dialog" aria-modal="true" aria-labelledby="${titleId}" aria-describedby="${bodyId}">
      <div class="tool-permission-shell capability-prompt-shell" data-capability-request="${escapeHtml(entry.requestId)}">
        <div class="tool-permission-header">
          <span class="tool-permission-icon">${icon.chip}</span>
          <div>
            <div class="tool-permission-title" id="${titleId}">${beyond ? t('需要临时授权') : t('需要开启能力')}</div>
            <div class="tool-permission-subtitle">${beyond ? t('超出发起者的能力，仍在这个 Agent 自己的设置范围内') : t('这个 Agent 自己的设置没有开启这个能力')}</div>
          </div>
        </div>
        <div class="tool-permission-body" id="${bodyId}">
          <div class="tool-permission-tool-name">${escapeHtml(promptText(entry))}</div>
          <p class="page-kicker-tip">${escapeHtml(t('用于工具 {tool}', { tool: entry.toolId || '' }))}</p>
          ${entry.note || (!beyond && !options.includes('always')) ? `<p class="file-safety-warn capability-prompt-note">${escapeHtml(t('全局设置没有开启『{capability}』，项目设置不能单独开启；可以选择仅本次。', { capability }))}</p>` : ''}
          <p class="page-kicker-tip">${escapeHtml(beyond
            ? t('授权只对这个 Agent 有效，可在 Agent 设置或「权限与隐私」里随时撤销；撤销从下一次工具调用起生效。')
            : entry.settingsScope === 'project'
              ? t('「一直开启」会修改这个 Agent 在本项目的设置；「仅本次」只在这次任务中有效。')
              : t('「一直开启」会修改这个 Agent 的全局设置；「仅本次」只在这次任务中有效。'))}</p>
          ${entry.error ? `<div class="file-safety-warn" role="alert">${escapeHtml(entry.error)}</div>` : ''}
        </div>
        <div class="tool-permission-footer">
          <fieldset class="inline-actions permission-actions" ${entry.submitting ? 'disabled aria-busy="true"' : ''}>
            <legend class="capability-sr-only">${t('选择授权范围')}</legend>
            ${options.map((option, index) => `<button type="button" class="small-button${index === 0 && option !== 'deny' ? ' is-primary' : ''}" data-action="capability-request-respond" data-request-id="${escapeHtml(entry.requestId)}" data-decision="${escapeHtml(option)}">${escapeHtml(optionLabel(entry.decision, option, entry.projectOptionScope))}</button>`).join('')}
          </fieldset>
        </div>
      </div>
    </div>
  `;
}

function formatTime(ms) {
  if (!Number.isFinite(ms)) return '';
  try { return new Intl.DateTimeFormat(currentLanguage(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ms)); }
  catch { return new Date(ms).toLocaleString(); }
}

function grantScopeText(grant) {
  if (grant.scope === 'run') return grant.kind === 'enable-own' ? t('仅本次') : t('仅本次任务');
  return grant.scope === 'chat' ? t('本对话 24 小时') : t('本项目 24 小时');
}

/** «临时授权»: active grants, all Agents (Customize → Safety) or one Agent (its settings page). */
export function renderGrantList({ agentId = null } = {}) {
  ensureGrants();
  const grants = approvalsState.grants.filter(grant => !agentId || grant.agentId === agentId);
  const titleId = `capability-grants-title-${escapeHtml(agentId || 'all')}`;
  const rows = grants.map(grant => {
    const name = agentName(grant.agentId);
    const capability = atomsLabel(grant.atoms);
    const busy = Boolean(approvalsState.revoking[grant.id]);
    const expiry = grant.scope === 'run' ? t('任务结束时失效') : t('到期 {time}', { time: formatTime(grant.expiresAt) });
    const kind = grant.kind === 'enable-own' ? t('超出自身设置') : t('超出发起者');
    return `<li class="safety-rule-row capability-grant-row" data-grant-id="${escapeHtml(grant.id)}">
      <div class="safety-rule-main">
        <div class="safety-rule-op">${escapeHtml(name)} · ${escapeHtml(capability)}</div>
        <div class="list-row-meta">${escapeHtml(grantScopeText(grant))} · ${escapeHtml(expiry)} · ${escapeHtml(kind)}</div>
      </div>
      <button type="button" class="small-button is-danger" data-action="capability-grant-revoke" data-grant-id="${escapeHtml(grant.id)}" aria-label="${escapeHtml(t('撤销 {agent} 的『{capability}』临时授权', { agent: name, capability }))}" ${busy ? 'disabled aria-busy="true"' : ''}>${escapeHtml(busy ? t('撤销中…') : t('撤销'))}</button>
    </li>`;
  }).join('');
  return ui`
    <section class="capability-grants" aria-labelledby="${titleId}" aria-live="polite">
      <div class="header-row capability-grants-header">
        <h3 class="capability-grants-title" id="${titleId}">临时授权</h3>
        <button type="button" class="small-button" data-action="capability-grants-refresh" ${approvalsState.grantsLoading ? 'disabled aria-busy="true"' : ''}>刷新</button>
      </div>
      <p class="page-kicker-tip">对话中临时允许的能力。任务结束、到期或撤销后失效；撤销从下一次工具调用起生效。</p>
      ${approvalsState.grantsError ? `<div class="alert compact-alert" role="alert">${escapeHtml(approvalsState.grantsError)}</div>` : ''}
      ${grants.length
        ? `<ul class="safety-rule-list capability-grant-list">${rows}</ul>`
        : `<p class="empty-state compact">${escapeHtml(agentId ? t('这个 Agent 目前没有临时授权。') : t('目前没有临时授权。'))}</p>`}
    </section>
  `;
}
