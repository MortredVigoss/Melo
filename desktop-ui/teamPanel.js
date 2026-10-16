// One team panel for the chat composer, task cards and project defaults.
// Members are chosen by name from the lead Agent's delegation targets — the
// same list the server enforces — so the panel never offers a team it would refuse.
import { ui } from './i18n.js';

export const TEAM_TEMPLATE_IDS = Object.freeze(['research-build-review', 'parallel-research', 'review-loop']);

export function teamLeadState(lead, agents = []) {
  if (!lead) return { ready: false, reason: 'no-agent' };
  if (lead.capabilities?.delegate !== true || lead.collaboration?.canDelegate !== true) return { ready: false, reason: 'delegate-off' };
  const members = (lead.collaboration.delegateTargets || []).map(id => agents.find(agent => agent.id === id)).filter(Boolean);
  return members.length ? { ready: true, members } : { ready: false, reason: 'no-targets' };
}

function templateOptions(selected) {
  const option = (id, label) => `<option value="${id}" ${selected === id ? 'selected' : ''}>${label}</option>`;
  return [
    option('research-build-review', ui`调研 → 实施 → 复核`),
    option('parallel-research', ui`并行调研后复核`),
    option('review-loop', ui`实施 / 复核循环`),
  ].join('');
}

// scope: 'chat' | 'task' | 'project'; target: task or project id when relevant.
export function renderTeamPanel({ scope, target = '', lead, agents, plan = null, disabled = false, escapeHtml, open = false }) {
  const state = teamLeadState(lead, agents);
  const leadName = escapeHtml(lead?.name || lead?.id || '');
  const attrs = `data-team-scope="${scope}" data-team-target="${escapeHtml(target)}"`;
  const settingsButton = lead ? ui`<button type="button" class="small-button" data-action="select-agent-profile" data-agent-id="${escapeHtml(lead.id)}">打开 Agent 设置</button>` : '';
  let body;
  if (state.reason === 'no-agent') body = ui`<p>请先为这个对话选择 Agent。</p>`;
  else if (state.reason === 'delegate-off') body = ui`<p>「${leadName}」未开启委派。在 Agent 设置的“能力范围与协作”里开启“委派”，并勾选可以协作的 Agent。</p>${settingsButton}`;
  else if (state.reason === 'no-targets') body = ui`<p>「${leadName}」还没有可协作的 Agent。在 Agent 设置的“委派对象”里勾选后再来。</p>${settingsButton}`;
  else {
    const chosen = Array.isArray(plan?.members) && plan.members.length ? new Set(plan.members) : new Set(state.members.map(member => member.id));
    const members = state.members.map(member => `<label class="checkbox-row"><input type="checkbox" name="team-member" value="${escapeHtml(member.id)}" ${chosen.has(member.id) ? 'checked' : ''}>${escapeHtml(member.name || member.id)}</label>`).join('');
    const action = scope === 'chat' ? ui`<button type="button" class="small-button" data-action="run-chat-team" ${disabled ? 'disabled' : ''}>执行输入框中的团队任务</button>`
      : scope === 'task' ? ui`<button type="button" class="small-button" data-action="run-task-team" data-task-id="${escapeHtml(target)}" ${disabled ? 'disabled' : ''}>按此分工执行</button>`
      : ui`<button type="button" class="small-button" data-action="save-project-team" data-project-id="${escapeHtml(target)}" ${disabled ? 'disabled' : ''}>保存为项目默认团队</button>`;
    body = ui`<p>由「${leadName}」发起并汇总结果。成员按列表顺序接力；并行模式下最后一位负责复核；循环模式需要正好两位：先实施，后复核。</p>
      <div class="agent-capability-flags">${members}</div>
      <select class="config-select" data-team-template aria-label="协作方式">${templateOptions(plan?.templateId || 'research-build-review')}</select>
      <p>每个成员都会独立调用模型；整个团队有总时间和总用量上限，超出后不再启动新成员。停止对话会取消所有成员。</p>${action}`;
  }
  return ui`<details class="conversation-context team-panel" ${attrs} ${open ? 'open' : ''}><summary>多 Agent 协作</summary>${body}</details>`;
}

// Reads the panel the user acted in. Member order follows the list, which is
// the lead's delegation order, so the reviewer position is predictable.
export function collectTeamPlan(panel) {
  if (!panel) return { error: '协作面板不可用。' };
  const members = [...panel.querySelectorAll('input[name="team-member"]')].filter(input => input.checked).map(input => input.value);
  const templateId = panel.querySelector('[data-team-template]')?.value || 'research-build-review';
  if (!members.length) return { error: '请至少勾选一位成员。' };
  if (templateId === 'review-loop' && members.length !== 2) return { error: '实施 / 复核循环需要正好勾选两位成员。' };
  return { plan: { templateId, members } };
}
