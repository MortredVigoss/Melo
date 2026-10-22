import { t } from './i18n.js';
// Approval stays visible until the server acknowledges the decision.
export function isFileSafetyConfirmStage(entry) {
  return entry?.kind === 'file_safety' && entry.operation === 'delete' && entry.payload?.stage === 'confirm';
}
export function decideFileSafetyPreflight() { return { action: 'noop' }; }
export function decideFileSafetyResponseAction({ response = null, error = null }) {
  if (error) return { action: 'mark_error', message: error.message || '提交失败，请重试。' };
  if (response?.ok === true) return { action: 'remove' };
  if (response?.reason === 'CONFIRMATION_MISMATCH') return { action: 'mark_error', message: t('输入不匹配，请输入「{expected}」。', { expected: response.expected || '' }) };
  return { action: 'mark_error', message: response?.reason || '未收到确认，请重试。' };
}
