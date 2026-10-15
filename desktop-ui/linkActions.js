import { t, ui } from './i18n.js';
export function renderCopyLinkButton(url, escapeHtml) {
  if (!/^https?:\/\//i.test(String(url || ''))) return '';
  return ui`<button type="button" class="copy-link-button" data-copy-link="${escapeHtml(url)}" aria-label="复制链接" title="复制链接">复制链接</button>`;
}

export async function copyLinkText(text, { clipboard = globalThis.navigator?.clipboard, document = globalThis.document } = {}) {
  try {
    if (clipboard?.writeText) { await clipboard.writeText(text); return; }
  } catch { /* WKWebView can deny the async clipboard API. */ }
  const active = document.activeElement;
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('aria-label', t("复制链接"));
  input.style.cssText = 'position:fixed;left:-10000px;top:0';
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally {
    input.remove();
    active?.focus({ preventScroll: true });
  }
}
