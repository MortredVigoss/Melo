import { t } from './i18n.js';

const documents = new WeakMap();
function stateFor(doc) {
  if (!documents.has(doc)) documents.set(doc, { scope: 'page', root: doc.body, notices: new Map(), timer: null });
  return documents.get(doc);
}
function noticeNode(doc, { level, text }, dismiss, toast = false) {
  const node = doc.createElement('div');
  node.className = toast ? 'flash-toast ui-notice' : 'ui-notice';
  node.dataset.level = level;
  node.setAttribute('role', level === 'error' ? 'alert' : 'status');
  node.setAttribute('aria-live', level === 'error' ? 'assertive' : 'polite');
  const content = doc.createElement('span');
  content.textContent = String(text ?? '');
  const close = doc.createElement('button');
  close.type = 'button'; close.className = 'button-ghost';
  close.textContent = t('关闭提示');
  close.onclick = dismiss;
  node.append(content, close);
  return node;
}
// Reattach persistent page feedback after a normal render; other pages keep
// their own notices until dismissed. Live execution/voice status is separate.
export function renderNotifications(root, { scope = 'page' } = {}) {
  if (!root) return;
  const doc = root.ownerDocument, state = stateFor(doc);
  state.root = root; state.scope = scope;
  root.querySelector('[data-page-notice]')?.remove();
  const notice = state.notices.get(scope);
  if (!notice) return;
  const dismiss = () => { state.notices.delete(scope); renderNotifications(state.root, { scope: state.scope }); };
  const node = noticeNode(doc, notice, dismiss);
  node.dataset.pageNotice = scope;
  (root.querySelector('.content-shell') || root).prepend(node);
}
// Errors persist in the page. Success/info use one timed toast. Callers may
// additionally request an error toast when the originating surface is hidden.
export function notify({ level = 'info', text, scope, toast = level !== 'error' } = {}) {
  if (typeof document === 'undefined') return;
  const doc = document, state = stateFor(doc), key = scope || state.scope;
  const notice = { level, text };
  if (level === 'error') state.notices.set(key, notice);
  else if (level === 'success') state.notices.delete(key);
  renderNotifications(state.root, { scope: state.scope });
  if (!toast) return;
  clearTimeout(state.timer);
  doc.querySelector('#flash-toast')?.remove();
  const node = noticeNode(doc, notice, () => node.remove(), true);
  node.id = 'flash-toast'; doc.body.append(node);
  // Persistent errors stay in the page after the optional toast expires.
  state.timer = setTimeout(() => node.remove(), 3000);
  state.timer.unref?.();
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
    submit.type = 'submit'; submit.className = 'button-primary'; submit.textContent = confirmLabel;
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'button-secondary'; cancel.textContent = t('取消');
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
