import { t } from './i18n.js';
// Continuous image-local zoom. Scaling changes a compositor transform, never
// the scroll container's layout; each gesture starts from the current view.
export function installImageZoom(stage, bitmap, button) {
  let scale = 1, x = 0, y = 0, width = 0, height = 0;
  let fitWidth = 0, fitHeight = 0, frame = 0, timer = 0, rawScale = 1;
  let pointers = new Map(), pinch, drag, safariStart;
  const listeners = [];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const elastic = value => value > 4 ? 4 + .3 * (1 - Math.exp(-(value - 4) / .3))
    : value < 1 ? 1 - .15 * (1 - Math.exp(-(1 - value) / .15)) : value;
  const local = e => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left - width / 2, y: e.clientY - r.top - height / 2 }; };
  const limits = s => ({ x: Math.max(0, (fitWidth * s - width) / 2), y: Math.max(0, (fitHeight * s - height) / 2) });
  const paint = () => {
    bitmap.style.transform = `translate3d(${x}px,${y}px,0) scale(${scale})`;
    stage.dataset.zoom = String(scale);
    stage.classList.toggle('is-zoomed', scale > 1.01);
    button.textContent = `${Math.round(scale * 100)}%`;
    const label = scale > 1.01 ? t('适合窗口') : t('原始尺寸');
    button.setAttribute('aria-label', label); button.title = label;
  };
  const stop = () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  const anchor = (next, at) => {
    const ratio = next / scale;
    x = at.x - (at.x - x) * ratio; y = at.y - (at.y - y) * ratio;
    scale = next; paint();
  };
  const settle = () => {
    stop();
    const targetScale = clamp(scale, 1, 4), bounds = limits(targetScale);
    const target = { scale: targetScale, x: clamp(x, -bounds.x, bounds.x), y: clamp(y, -bounds.y, bounds.y) };
    const start = { scale, x, y }, started = performance.now();
    const animate = now => {
      const progress = clamp((now - started) / 220, 0, 1), ease = 1 - (1 - progress) ** 3;
      scale = start.scale + (target.scale - start.scale) * ease;
      x = start.x + (target.x - start.x) * ease; y = start.y + (target.y - start.y) * ease;
      paint(); if (progress < 1) frame = requestAnimationFrame(animate); else rawScale = scale;
    };
    frame = requestAnimationFrame(animate);
  };
  const resize = () => {
    stop(); width = stage.clientWidth; height = stage.clientHeight;
    if (!width || !height || !bitmap.naturalWidth) return;
    const fit = Math.min((width - 24) / bitmap.naturalWidth, (height - 24) / bitmap.naturalHeight, 1);
    fitWidth = bitmap.naturalWidth * fit; fitHeight = bitmap.naturalHeight * fit;
    bitmap.style.width = `${fitWidth}px`; bitmap.style.height = `${fitHeight}px`;
    scale = clamp(scale, 1, 4); rawScale = scale;
    const bounds = limits(scale); x = clamp(x, -bounds.x, bounds.x); y = clamp(y, -bounds.y, bounds.y); paint();
  };
  const on = (target, type, fn, options) => { target.addEventListener(type, fn, options); listeners.push(() => target.removeEventListener(type, fn, options)); };
  on(stage, 'wheel', e => {
    e.preventDefault(); stop();
    if (e.ctrlKey || e.metaKey || !e.shiftKey) {
      if (!timer) rawScale = scale;
      rawScale = clamp(rawScale * Math.exp(-e.deltaY * (e.deltaMode === 1 ? .025 : .002)), .5, 6);
      anchor(elastic(rawScale), local(e));
    } else { x -= e.deltaY; y -= e.deltaX; paint(); }
    timer = setTimeout(() => { timer = 0; settle(); }, 120);
  }, { passive: false });
  const baseline = () => {
    const points = [...pointers.values()];
    pinch = points.length === 2 ? { distance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y), scale,
      center: { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 }, x, y } : null;
    drag = points.length === 1 ? { point: points[0], x, y } : null;
  };
  on(stage, 'pointerdown', e => {
    if (e.button !== 0) return;
    stop(); pointers.set(e.pointerId, local(e)); stage.setPointerCapture(e.pointerId); baseline();
  });
  on(stage, 'pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    const points = [...pointers.values()];
    if (pinch && points.length === 2 && pinch.distance > 0) {
      const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      scale = elastic(pinch.scale * Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) / pinch.distance);
      x = center.x - (pinch.center.x - pinch.x) * scale / pinch.scale;
      y = center.y - (pinch.center.y - pinch.y) * scale / pinch.scale;
    } else if (drag && scale > 1) {
      x = drag.x + points[0].x - drag.point.x; y = drag.y + points[0].y - drag.point.y;
    }
    paint();
  });
  const end = e => { if (!pointers.delete(e.pointerId)) return; baseline(); if (!pointers.size) settle(); };
  on(stage, 'pointerup', end); on(stage, 'pointercancel', end); on(stage, 'lostpointercapture', end);
  // WebKit sends gesture events for trackpad pinches instead of ctrl+wheel.
  on(stage, 'gesturestart', e => { e.preventDefault(); stop(); safariStart = scale; }, { passive: false });
  on(stage, 'gesturechange', e => { e.preventDefault(); if (safariStart) anchor(elastic(safariStart * e.scale), local(e)); }, { passive: false });
  on(stage, 'gestureend', e => { e.preventDefault(); safariStart = null; settle(); }, { passive: false });
  on(stage, 'dblclick', e => { stop(); anchor(scale > 1.01 ? 1 : 2, local(e)); settle(); });
  on(stage, 'keydown', e => {
    if (!['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault(); stop();
    if (e.key.startsWith('Arrow')) { x += e.key === 'ArrowLeft' ? 40 : e.key === 'ArrowRight' ? -40 : 0; y += e.key === 'ArrowUp' ? 40 : e.key === 'ArrowDown' ? -40 : 0; }
    else anchor(e.key === '0' ? 1 : clamp(scale * (e.key === '-' ? 1 / 1.25 : 1.25), 1, 4), { x: 0, y: 0 });
    paint(); settle();
  });
  button.onclick = () => {
    if (!fitWidth) return;
    stop(); const original = scale <= 1.01;
    anchor(original ? clamp(bitmap.naturalWidth / fitWidth, 1, 4) : 1, { x: 0, y: 0 });
    settle();
  };
  stage.tabIndex = 0; bitmap.draggable = false;
  on(bitmap, 'load', resize);
  const observer = new ResizeObserver(resize); observer.observe(stage); resize();
  return () => { stop(); observer.disconnect(); listeners.forEach(remove => remove()); };
}
