import { modelPanelPosition } from '../../modelPresentation.js';

const owners = new WeakMap();

// These menus remain children of their original controls/forms. The top layer
// changes only painting/hit testing, so existing delegated events and drafts
// keep their owner even when the reading surface clips its content.
export function installComposerOverlays(doc = globalThis.document) {
  if (!doc?.defaultView) return { sync() {} };
  if (owners.has(doc)) return owners.get(doc);
  const win = doc.defaultView, active = new Map();
  let scheduled = false;
  const position = (panel, anchor) => {
    const point = modelPanelPosition(anchor.getBoundingClientRect(),
      { width: panel.offsetWidth, height: panel.offsetHeight },
      { width: win.innerWidth, height: win.innerHeight });
    panel.style.left = `${point.left}px`;
    panel.style.top = `${point.top}px`;
  };
  const hide = panel => {
    if (panel.isConnected && panel.matches(':popover-open')) panel.hidePopover();
    active.delete(panel);
  };
  const layout = () => {
    scheduled = false;
    for (const [panel, { anchor, details }] of active) {
      if (!panel.isConnected || !anchor.isConnected || (details && !details.open)) hide(panel);
      else position(panel, anchor);
    }
  };
  const schedule = () => {
    if (!scheduled && active.size) { scheduled = true; win.requestAnimationFrame(layout); }
  };
  const observer = win.ResizeObserver ? new win.ResizeObserver(schedule) : null;
  const sync = () => {
    layout();
    observer?.disconnect();
    if (doc.querySelector('.palette-backdrop,.tool-permission-backdrop,dialog[open],#execution-war-room:not([hidden])')) {
      for (const panel of active.keys()) hide(panel);
      return;
    }
    const selectors = [
      ['.conversation-context[open] > .conversation-context-menu', panel => panel.parentElement.querySelector('summary')],
      ['.image-task-fields', panel => panel.parentElement.querySelector('[data-action="image-task-toggle"]')],
      ['.composer-attachment-menu', panel => panel.parentElement.querySelector('[data-action="toggle-composer-attachment-menu"]')],
      ['.tts-voice-panel', panel => panel.parentElement.querySelector('button')],
    ];
    for (const [selector, getAnchor] of selectors) for (const panel of doc.querySelectorAll(selector)) {
      const anchor = getAnchor(panel);
      if (!anchor || typeof panel.showPopover !== 'function') continue;
      panel.classList.add('composer-overlay');
      panel.setAttribute('popover', 'manual');
      if (!panel.matches(':popover-open')) panel.showPopover();
      active.set(panel, { anchor, details: panel.closest('.conversation-context') });
      position(panel, anchor);
      observer?.observe(panel); observer?.observe(anchor);
    }
  };
  doc.addEventListener('toggle', event => {
    if (event.target.matches?.('.conversation-context')) sync();
  }, true);
  doc.addEventListener('pointerdown', event => {
    if (event.target.closest?.('[data-execution-action=toggle]')) {
      for (const panel of active.keys()) hide(panel);
      return;
    }
    for (const [panel, { details, anchor }] of active) {
      if (details && !panel.contains(event.target) && !anchor.contains(event.target)) {
        details.open = false; hide(panel);
      }
    }
  }, true);
  doc.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !active.size) return;
    const [panel, { details, anchor }] = [...active].at(-1);
    if (!panel.isConnected) { hide(panel); return; }
    event.preventDefault(); event.stopPropagation();
    if (details) { details.open = false; hide(panel); }
    else anchor.click(); // Use the existing owner to close rendered menus.
    if (anchor.isConnected) anchor.focus({ preventScroll: true });
  }, true);
  win.addEventListener('resize', schedule);
  doc.addEventListener('scroll', schedule, true);
  const result = { sync };
  owners.set(doc, result);
  return result;
}
