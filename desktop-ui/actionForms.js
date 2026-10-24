import { t } from './i18n.js';
const pending = new Map();
const keyFor = form => [form.dataset.form,form.dataset.agentId,form.dataset.projectId,form.dataset.templateId].join(':');
export function decorateActionForms(root) {
  for (const form of root.querySelectorAll('form[data-form]')) {
    if (form.dataset.form === 'composer') continue;
    const busy = pending.has(keyFor(form));
    form.toggleAttribute('inert',busy); form.setAttribute('aria-busy',String(busy));
    let status = form.querySelector('[data-submit-status]');
    if (busy && !status) {
      status = form.ownerDocument.createElement('p');
      status.dataset.submitStatus='';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
      form.append(status);
    }
    if (status) { status.textContent=busy?t('正在提交，请稍候…'):''; status.hidden=!busy; }
  }
}
export function beginFormSubmission(form) {
  // Streaming chat owns its pending state: stop and supplements stay usable.
  if (form.dataset.form === 'composer') return () => {};
  const key=keyFor(form);
  if(pending.has(key))return null;
  pending.set(key,true);decorateActionForms(form.ownerDocument);
  let done=false;
  return ()=>{if(done)return;done=true;pending.delete(key);decorateActionForms(form.ownerDocument);};
}
