import { RUNTIME_BEHAVIOR, normalizeBehavior } from '../shared/agent/runtimeBehavior.js';
import { t, ui } from './i18n.js';
import { escapeHtml } from './html.js';
import { EditSession, renderEditActions, paintEditActions } from './settingsEdit.js';
const session = new EditSession();
let draft = null, message = '', current = {};
export function renderBehaviorSettings(config = {}) {
  current = config;
  if (!session.editing && session.status !== 'saving') draft = { ...normalizeBehavior(config.behavior,config), toolCalling:config.toolCallingOverride ? ({'true':'native','1':'native','false':'legacy','0':'legacy'}[config.toolCallingOverride] || config.toolCallingOverride) : config.toolCalling || 'auto' };
  return ui`<section class="surface-card" data-behavior-settings data-neural-key="behavior-${session.revision}"><h2 class="pane-title">运行行为</h2>
    <p class="page-kicker">这些设置仅影响这台电脑，不会授予 Agent 权限。环境覆盖优先，修改从下一次操作生效。</p>
    ${renderEditActions(session,{prefix:'behavior-settings'})}
    <fieldset class="settings-connection-fields" ${session.editing ? '' : 'disabled'}>
    ${RUNTIME_BEHAVIOR.map(item => {
      const status = config.behaviorStatus?.[item.key], locked = status?.source === 'environment';
      return '<label class="list-row-meta"><input type="checkbox" name="' + item.key + '" ' + ((locked ? status.value : draft[item.key]) ? 'checked ' : '') + (locked ? 'disabled ' : '') + '>' + escapeHtml(t(item.label)) + (locked ? ' · ' + escapeHtml(t('环境覆盖')) + ' (' + item.env + ')' : '') + '</label>';
    }).join('')}
    <label class="label">工具协议<select class="config-select" name="toolCalling" ${config.toolCallingOverride ? 'disabled' : ''}>
      ${['auto','native','legacy'].map(mode=>'<option value="'+mode+'" '+(draft.toolCalling===mode?'selected':'')+'>'+escapeHtml(t({auto:'自动',native:'原生工具调用',legacy:'兼容文本工具'}[mode]))+'</option>').join('')}
    </select>${config.toolCallingOverride ? escapeHtml(t("环境覆盖")) : ""}</label></fieldset>
    <p class="list-row-meta">记忆离线只限制记忆提取、压缩和向量服务；聊天模型仍按所选连接运行。</p>
    <p role="status" aria-live="polite">${escapeHtml(message)}</p></section>`;
}
export function editBehaviorSettings(target) {
  const root = target.closest?.('[data-behavior-settings]');
  if (!root) return false;
  if (!session.editing || target.disabled || !Object.hasOwn(draft,target.name)) return true;
  draft[target.name] = target.type === 'checkbox' ? target.checked : target.value;
  session.change(); message = '';
  paintEditActions(root.querySelector('.settings-edit-toolbar'),session,{prefix:'behavior-settings'});
  return true;
}
export async function handleBehaviorSettings(action,{api,render,refresh}) {
  if (!action?.startsWith('behavior-settings-')) return false;
  if (session.status === 'saving') return true;
  if (action.endsWith('-edit')) { session.begin(); message=''; render(); return true; }
  if (action.endsWith('-cancel')) { session.cancel(); draft=null; message=t('已取消修改'); render(); return true; }
  if (!action.endsWith('-save') || !session.start()) return true;
  const { toolCalling: requestedMode, ...behavior } = draft;
  const toolCalling = current.toolCallingOverride ? current.toolCalling || 'auto' : requestedMode; render();
  try {
    await api('/api/settings/model',{method:'POST',body:{behavior,toolCalling}});
    session.saved(); message=t('已保存'); await refresh();
  } catch(error) { session.failed(error); message=error.message; }
  finally { render(); }
  return true;
}
