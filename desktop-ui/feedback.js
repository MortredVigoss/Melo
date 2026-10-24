import { t } from './i18n.js';

export function showFlashToast(message, { ms=2000, kind='status' } = {}) {
  document.querySelector('#flash-toast')?.remove();
  const toast = document.createElement('div');
  toast.id = 'flash-toast';
  toast.className = 'flash-toast' + (kind === 'error' ? ' is-error' : '');
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  toast.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  const text = document.createElement('span');
  text.textContent = String(message ?? '');
  toast.append(text);
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'small-button';
  close.textContent = t('关闭'); close.onclick = () => toast.remove();
  toast.append(close);
  document.body.append(toast);
  if (ms > 0) setTimeout(() => toast.remove(), ms);
}

let pendingDialog = null;
export function requestText({ title, value='', validate=()=>'', confirmLabel=t('添加链接') }) {
  pendingDialog?.();
  return new Promise(resolve => {
    const previous = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'input-dialog';
    const form = document.createElement('form');
    const heading = document.createElement('h2');
    heading.id = 'input-dialog-title'; heading.textContent = title;
    dialog.setAttribute('aria-labelledby', heading.id);
    const input = document.createElement('input');
    input.className = 'config-input'; input.value = value; input.autocomplete = 'off';
    input.setAttribute('aria-label', title);
    const status = document.createElement('p');
    status.id = 'input-dialog-error'; status.setAttribute('role','status');
    status.setAttribute('aria-live','polite'); input.setAttribute('aria-describedby',status.id);
    const actions = document.createElement('div'); actions.className = 'inline-actions';
    const submit = document.createElement('button');
    submit.type = 'submit'; submit.className = 'small-button is-primary'; submit.textContent = confirmLabel;
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'small-button'; cancel.textContent = t('取消');
    let settled = false;
    const finish = result => {
      if (settled) return; settled = true; pendingDialog = null;
      dialog.remove(); if (previous?.isConnected) previous.focus(); resolve(result);
    };
    pendingDialog = () => finish(null);
    cancel.onclick = () => finish(null);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    dialog.addEventListener('close', () => finish(null));
    form.addEventListener('submit', event => {
      event.preventDefault();
      const error = validate(input.value);
      status.textContent = error;
      if (error) { input.setAttribute('aria-invalid','true'); input.focus(); return; }
      finish(input.value);
    });
    input.addEventListener('input', () => { status.textContent = ''; input.removeAttribute('aria-invalid'); });
    actions.append(submit,cancel); form.append(heading,input,status,actions);
    dialog.append(form); document.body.append(dialog); dialog.showModal(); input.focus(); input.select();
  });
}
