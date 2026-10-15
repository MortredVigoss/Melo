import { LANGUAGES, currentLanguage, t } from './i18n.js';
import { hasUnsavedSettings } from './settingsEdit.js';
let busy = false, error = '';
export function renderLanguageControl() {
  const selected = LANGUAGES.find(value => value.id === currentLanguage());
  return `<details class="language-switcher" data-neural-key="language-switcher"><summary aria-label="${t('切换语言')}" title="${t('界面语言')}"><span aria-hidden="true">◎</span><span>${selected.short}</span><span aria-hidden="true">⌃</span></summary><div class="language-menu" role="group" aria-label="${t('界面语言')}">${LANGUAGES.map(value => `<button type="button" data-interface-language="${value.id}" lang="${value.id}" aria-pressed="${value.id===selected.id}" ${busy?'disabled':''}><span>${value.name}</span><span aria-hidden="true">${value.id===selected.id?'✓':''}</span></button>`).join('')}${error?`<p role="alert">${t(error)}</p>`:''}</div></details>`;
}
export function installLanguageControls({ api, applyBootstrap, render }) {
  document.addEventListener('click', async event => {
    const control = event.target.closest('[data-interface-language]');
    if (!control) {
      if (!event.target.closest('.language-switcher')) document.querySelector('.language-switcher')?.removeAttribute('open');
      return;
    }
    event.preventDefault();
    if (busy || control.dataset.interfaceLanguage === currentLanguage()) return;
    if (hasUnsavedSettings()) { error = '请先保存或取消当前设置修改。'; render(); document.querySelector('.language-switcher')?.setAttribute('open',''); return; }
    busy = true; error = ''; render();
    try {
      const result = await api('/api/settings/local',{method:'POST',body:{preferences:{interfaceLanguage:control.dataset.interfaceLanguage}}});
      applyBootstrap(result);
    } catch { error = '语言切换失败，请重试。'; }
    finally {
      busy = false; render();
      const picker = document.querySelector('.language-switcher');
      if (error) picker?.setAttribute('open',''); else picker?.removeAttribute('open');
      picker?.querySelector('summary')?.focus({preventScroll:true});
    }
  });
  document.addEventListener('keydown',event => {
    if (event.key !== 'Escape') return;
    const picker = document.querySelector('.language-switcher[open]');
    if (picker) { event.preventDefault(); picker.removeAttribute('open'); picker.querySelector('summary')?.focus({preventScroll:true}); }
  });
}
