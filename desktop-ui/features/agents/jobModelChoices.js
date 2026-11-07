// Per-job model connection selects for the Agent settings page (plan A phase
// A5-1, 2026-11-04): each internal routing job may follow the conversation's
// connection (empty) or run on one saved llm profile. Options come from the
// public connection list the bootstrap already carries; an id that no longer
// exists is kept selected and marked, exactly like allow-list choices.
import { t } from '../../i18n.js';

export const JOB_MODEL_ROLES = Object.freeze([['research', '检索成员'], ['social', '社交检索成员'], ['lookup', '资料读取成员'], ['calculate', '计算成员'], ['execute', '执行成员']]);

export function renderJobModelChoices(values = {}, profiles = [], esc) {
  const options = (Array.isArray(profiles) ? profiles : []).map(profile => ({ id: String(profile.id || ''), name: profile.nameKey ? t(profile.nameKey) : profile.name || profile.id, model: profile.model || '' })).filter(option => option.id);
  return JOB_MODEL_ROLES.map(([role, label]) => {
    const current = typeof values?.[role] === 'string' ? values[role] : '';
    const known = options.some(option => option.id === current);
    return `<label class="label">${esc(t(label))}<select class="config-input" name="jobModel_${role}">`
      + `<option value=""${current ? '' : ' selected'}>${esc(t('跟随对话'))}</option>`
      + options.map(option => `<option value="${esc(option.id)}"${option.id === current ? ' selected' : ''}>${esc(option.name)}${option.model ? ' · ' + esc(option.model) : ''}</option>`).join('')
      + (current && !known ? `<option value="${esc(current)}" selected>${esc(current)} · ${esc(t('当前不可用'))}</option>` : '')
      + '</select></label>';
  }).join('');
}

export function jobModelsFromForm(formData, hasField) {
  if (!hasField('jobModel_research')) return undefined;
  const out = {};
  for (const [role] of JOB_MODEL_ROLES) { const id = String(formData.get('jobModel_' + role) || '').trim(); if (id) out[role] = id; }
  return out;
}
