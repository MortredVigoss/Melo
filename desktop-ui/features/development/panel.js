import { t, ui } from '../../i18n.js';

const state = { jobs: [], detail: null, loaded: false, loading: false, busy: false, error: '', draft: { repository: '', goal: '', agentId: '', reviewerId: '', commands: '[["npm","test"]]', image: 'melo-development:local' } };
const labels = { preparing: '准备中', created: '待开始', implementing: '实施中', testing: '验证中', reviewing: '审查中', awaiting_review: '待人工核对', awaiting_merge: '待合并', blocked: '受阻', cancelled: '已停止', interrupted: '已中断' };
let timer;
function capture() {
  const form = globalThis.document?.querySelector('[data-development-form]');
  if (form) for (const key of Object.keys(state.draft)) state.draft[key] = form.querySelector(`[name="${key}"]`)?.value ?? state.draft[key];
}
export async function refreshDevelopment({ api, render }) {
  if (state.loading) return;
  capture(); state.loading = true;
  try {
    const result = await api('/api/development/jobs'); state.jobs = result.jobs; state.loaded = true;
    if (state.detail) state.detail = await api(`/api/development/job?id=${encodeURIComponent(state.detail.job.id)}`);
    state.error = '';
  } catch (error) { state.error = error.message; }
  finally {
    state.loading = false; render(); clearTimeout(timer);
    if (state.jobs.some(job => ['implementing', 'testing', 'reviewing'].includes(job.status))) timer = setTimeout(() => {
      if (globalThis.document?.querySelector('[data-development-panel]')) refreshDevelopment({ api, render });
    }, 2500);
  }
}
export function renderDevelopmentPanel({ profiles = [], escapeHtml: escape, api, render }) {
  capture();
  if (!state.loaded && !state.loading && !state.error) { state.loading = true; queueMicrotask(() => { state.loading = false; refreshDevelopment({ api, render }); }); }
  const options = key => profiles.map(profile => `<option value="${escape(profile.id)}" ${state.draft[key] === profile.id ? 'selected' : ''}>${escape(profile.name || profile.id)}</option>`).join('');
  const detail = state.detail, job = detail?.job;
  return ui`<section class="surface-card" data-development-panel>
    <div class="header-row"><h2 class="pane-title">隔离开发</h2><button class="small-button" type="button" data-action="development-refresh" ${state.loading ? 'disabled' : ''}>刷新</button></div>
    <p class="muted">在独立容器中修改和验证候选代码。通过后等待合并，不自动推送或安装。</p>
    <details><summary>新建开发作业</summary><div class="config-form" data-development-form>
      <label>仓库根目录<input name="repository" value="${escape(state.draft.repository)}" /></label>
      <label>开发目标<textarea name="goal">${escape(state.draft.goal)}</textarea></label>
      <label>实施 Agent<select name="agentId"><option value="">${t('请选择')}</option>${options('agentId')}</select></label>
      <label>审查 Agent<select name="reviewerId"><option value="">${t('请选择')}</option>${options('reviewerId')}</select></label>
      <label>容器镜像<input name="image" value="${escape(state.draft.image)}" /></label>
      <label>必需验证命令（JSON 参数数组）<textarea name="commands">${escape(state.draft.commands)}</textarea></label>
      <p class="muted">只复制已提交的基线。现有未提交改动保留；容器默认断网，需使用已准备好依赖的镜像。原生平台验收另行执行。</p>
      <button class="primary-button" type="button" data-action="development-create" ${state.busy ? 'disabled' : ''}>创建隔离副本</button>
    </div></details>
    ${state.error ? `<p role="alert">${escape(state.error)}</p>` : ''}
    ${!state.jobs.length ? ui`<p class="empty-state compact">暂无开发作业</p>` : state.jobs.map(item => `<div class="list-row"><button type="button" class="small-button" data-action="development-open" data-id="${item.id}">${escape(item.goal)}</button><span class="chip">${escape(t(labels[item.status] || item.status))}</span></div>`).join('')}
    ${job ? ui`<section class="quality-details"><h3 class="subsection-title">${escape(job.goal)}</h3>
      <p>${escape(t(labels[job.status] || job.status))} · ${escape(job.id)}</p>
      <p>${t('基线')} <code>${escape(job.baseSha)}</code><br>${t('候选')} <code>${escape(job.headSha || '—')}</code></p>
      <p>${t('工作目录')} <code>${escape(job.workspace)}</code></p>
      <p>${t('验证')} ${job.tests.filter(test => test.status === 'passed').length}/${job.commands.length} · ${t('审查')} ${escape(job.review?.verdict || '—')}</p>
      ${job.error ? `<p role="alert">${escape(job.error)}</p>` : ''}
      <div class="inline-actions">
        <button class="small-button" type="button" data-action="development-start" data-id="${job.id}" ${state.busy || ['implementing', 'testing', 'reviewing'].includes(job.status) ? 'disabled' : ''}>开始 / 继续</button>
        <button class="small-button" type="button" data-action="development-stop" data-id="${job.id}" ${state.busy || !['implementing', 'testing', 'reviewing'].includes(job.status) ? 'disabled' : ''}>停止</button>
        <button class="small-button" type="button" data-action="development-recover" data-id="${job.id}" ${state.busy ? 'disabled' : ''}>核对中断状态</button>
      </div>
      <details><summary>候选改动</summary><pre>${escape(detail.diff || '—')}</pre></details>
      ${detail.runs.map(run => `<details><summary>${escape(run.argv.join(' '))} · ${escape(run.status)} · ${escape(String(run.exitCode ?? '—'))}</summary><pre>${escape(run.log)}</pre>${run.truncated ? `<p>${t('仅显示日志末尾，完整日志保留在本机。')}</p>` : ''}</details>`).join('')}
      ${job.review ? `<details open><summary>${t('审查记录')}</summary><p>${escape(job.review.summary)}</p></details>` : ''}
      ${job.status === 'awaiting_review' ? ui`<p>测试、执行或权限相关文件有改动，请核对完整 diff 与验证范围后确认。</p><p>${escape(job.sensitiveFiles.join(', '))}</p><button class="small-button" type="button" data-action="development-approve" data-id="${job.id}" data-head="${job.headSha}" ${state.busy ? 'disabled' : ''}>已核对此版本</button>` : ''}
      ${job.status === 'awaiting_merge' ? ui`<p>候选已通过本作业配置的 Linux 验证和审查。尚未合并；导出时会重新核对版本和证据。</p><button class="small-button" type="button" data-action="development-export" data-id="${job.id}" ${state.busy ? 'disabled' : ''}>导出候选包</button>` : ''}
      ${state.bundle ? ui`<details><summary>候选包已保存</summary><p>${escape(state.bundle.id)} · ${escape(state.bundle.patchHash)}</p><p>完整补丁和验收证据已保存在该作业目录的 candidate-bundle.json。</p></details>` : ''}
    </section>` : ''}
  </section>`;
}
export async function handleDevelopment(action, trigger, context) {
  if (!action?.startsWith('development-')) return false;
  if (state.busy) return true;
  capture(); state.busy = true; state.error = '';
  try {
    const operation = action.slice('development-'.length), id = trigger.dataset.id;
    if (operation === 'open') { state.detail = await context.api(`/api/development/job?id=${encodeURIComponent(id)}`); state.bundle = null; }
    else if (operation === 'create') {
      const job = await context.api('/api/development/create', { method: 'POST', body: { ...state.draft, commands: JSON.parse(state.draft.commands) } });
      state.detail = await context.api(`/api/development/job?id=${job.id}`);
    } else if (operation !== 'refresh') {
      if (!['start', 'stop', 'recover', 'approve', 'export'].includes(operation)) throw new Error('Unknown development action');
      const result = await context.api(`/api/development/${operation}`, { method: 'POST', body: { id, headSha: trigger.dataset.head } });
      state.bundle = operation === 'export' ? result : null;
      if (operation === 'export' && globalThis.window) {
        const text = JSON.stringify(result, null, 2), name = `${id}-candidate.json`;
        if (window.webkit?.messageHandlers?.meloVoice) {
          const { nativeSettings } = await import('../../localSettings.js');
          await nativeSettings('savePortableArchive', { text, name });
        }
        else {
          const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
          const link = document.createElement('a'); link.href = url; link.download = name; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      }
    }
    await refreshDevelopment(context);
  } catch (error) { state.error = error.message; }
  finally { state.busy = false; context.render(); }
  return true;
}
