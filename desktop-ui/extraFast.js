import { t, ui } from './i18n.js';
import { EditSession, renderEditActions, paintEditActions } from './settingsEdit.js';

const session = new EditSession();
let draft = null, busy = false, message = '', conflict = false;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const valueOf = config => config.extraFast || { enabled: false, revision: 0, assignments: {} };

export function editExtraFast(target) {
  const root = target.closest?.('[data-extra-fast]');
  if (!root || target.name !== 'extraFastEnabled') return false;
  if (session.editing && !busy) {
    draft.enabled = target.checked;
    session.change(); message = '';
    paintEditActions(root.querySelector('.settings-edit-toolbar'), session, { prefix: 'extra-fast', saveDisabled: conflict });
  }
  return true;
}

export function renderExtraFast(config) {
  const saved = valueOf(config);
  if (!session.editing && session.status !== 'saving') draft = { enabled: saved.enabled, revision: saved.revision };
  const rows = [['intent', '意图判断'], ['addressal', '群聊回复判断']].map(([task, title]) => {
    const chosen = saved.assignments?.[task];
    const detail = !saved.enabled ? t('沿用原有路径') : !chosen ? t('暂无可用连接，使用保守规则') :
      `${chosen.name} · ${chosen.model} · ${chosen.basis === 'measured' ? t('最近短请求 {ms} ms', { ms: chosen.latencyMs }) : t('按模型类型优先选择，尚未实测')}`;
    return `<p class="list-row-meta">${escape(t(title))}：${escape(detail)}${chosen?.reportedModel ? `<br>${escape(t('服务返回模型：{model}', { model: chosen.reportedModel }))}` : ''}</p>`;
  }).join('');
  return ui`<section class="surface-card extra-fast-settings" data-extra-fast>
    <div class="header-row"><h2 class="pane-title">额外快速</h2><span class="chip">${saved.enabled ? t('当前已开启') : t('默认关闭')}</span></div>
    <p class="page-kicker">自动从已保存连接的模型中分配短判断任务。正式回答仍用对话选择的模型；记忆检索仍在本机完成。</p>
    ${renderEditActions(session, { prefix: 'extra-fast', disabled: busy, saveDisabled: conflict })}
    ${conflict ? ui`<button type="button" class="small-button" data-action="extra-fast-rebase">载入最新版本并保留我的选择</button>` : ''}
    <label class="list-row-meta"><input name="extraFastEnabled" type="checkbox" ${draft?.enabled ? 'checked' : ''} ${!session.editing || busy ? 'disabled' : ''}> 开启额外快速，允许已配置的模型处理意图和群聊回复判断</label>
    <p class="list-row-meta">开启后自动检测最多 3 个不同模型，共最多 6 次短请求，会消耗对应 API 或订阅额度。判断内容可能发送给这些已配置的平台；不自动启用额外收费的加速档位。</p>
    ${rows}
    <p class="list-row-meta">规则能判断时不请求模型；单次判断最多等待 4 秒，失败后使用保守规则。按有效实测耗时分配，未测模型只作候选。短请求检测不代表完整分类精度评测，也不保证整段回答更快。</p>
    <button type="button" class="small-button" data-action="extra-fast-test" ${busy || session.editing || !saved.enabled ? 'disabled' : ''}>重新检测并分配</button>
    <p role="status" aria-live="polite">${escape(message)}</p>
  </section>`;
}

export async function handleExtraFast(action, { config, api, render, refresh }) {
  if (!action?.startsWith('extra-fast-')) return false;
  if (busy) return true;
  if (action === 'extra-fast-edit') {
    const saved = valueOf(config); draft = { enabled: saved.enabled, revision: saved.revision };
    session.begin(); conflict = false; message = ''; render(); return true;
  }
  if (action === 'extra-fast-cancel') { session.cancel(); draft = null; conflict = false; message = t('已取消修改'); render(); return true; }
  if (action === 'extra-fast-rebase' && conflict) {
    busy = true; render();
    try {
      const latest = (await api('/api/bootstrap')).settings.config.extraFast;
      config.extraFast = latest; draft.revision = latest.revision;
      conflict = false; session.begin(); session.change(); message = t('已保留你的选择，请确认后保存。');
    } catch { message = t('读取失败，选择仍保留，请重试。'); }
    finally { busy = false; render(); }
    return true;
  }
  if (action !== 'extra-fast-save' && action !== 'extra-fast-test') return true;
  if (action === 'extra-fast-save' && (conflict || !session.start())) return true;
  if (action === 'extra-fast-test' && (session.editing || !valueOf(config).enabled)) return true;
  const pending = { ...draft };
  busy = true; message = action === 'extra-fast-save' ? t('正在保存…') : t('正在检测已配置的模型…'); render();
  try {
    if (action === 'extra-fast-save') {
      const saved = await api('/api/settings/extra-fast', { method: 'POST', body: pending });
      config.extraFast = saved; session.saved(); message = t('已保存'); render();
    }
    if (action === 'extra-fast-test' || pending.enabled) {
      message = t('设置已保存，正在用短请求检测并分配…'); render();
      try {
        config.extraFast = await api('/api/settings/extra-fast/test', { method: 'POST', body: {} });
        message = Object.values(config.extraFast.assignments || {}).some(choice => choice?.basis === 'measured')
          ? t('检测完成，按有效实测结果自动分配。') : t('尚无通过检测的模型；未测连接仍可作为候选，请检查连接后重试。');
      } catch { message = t('设置已保存；检测未完成，可点击“重新检测并分配”。'); }
    }
    try { await refresh(); } catch { message += ' ' + t('页面刷新失败，保存结果已保留。'); }
  } catch (error) {
    if (action === 'extra-fast-save') { session.failed(error); conflict = /加速设置已被更新/.test(error.message); }
    message = error.message || t('操作失败，草稿保留');
  } finally { busy = false; render(); }
  return true;
}
