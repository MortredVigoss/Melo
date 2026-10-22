import { ui } from './i18n.js';
export function renderAtomicButton() {
  return ui`<button type="button" class="atomic-button" data-execution-action="toggle" aria-label="展开任务动画" title="任务动画 · 查看真实执行与来源" aria-expanded="false" aria-controls="execution-panel">
    <span class="atomic-field" aria-hidden="true"><span class="atomic-halo"></span><span class="atomic-nucleus"><i></i><i></i><i></i></span>${[0, 1, 2].map(i => `<span class="atomic-plane atomic-plane-${i}"><span class="atomic-track"></span><span class="atomic-orbit"><span class="atomic-electron"></span></span></span>`).join('')}</span>
  </button>`;
}
