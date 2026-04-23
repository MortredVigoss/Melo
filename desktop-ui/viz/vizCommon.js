// Shared helpers for viz renderers — escape, parameter row HTML, slider
// binding, canvas setup. Keeps each renderer focused on its own physics
// / geometry instead of re-implementing the boilerplate.

export function escapeAttr(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

export function formatValue(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const rounded = Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2);
  return unit ? `${rounded} ${unit}` : String(rounded);
}

// Normalize the spec params into `{ id, label, min, max, step, unit, value }`
// rows so every renderer starts from the same shape.
export function materializeParams(specParams) {
  return (specParams || []).map(p => ({
    ...p,
    value: Number.isFinite(Number(p.default)) ? Number(p.default) : 0,
    step: Number(p.step) || (p.max - p.min) / 100,
  }));
}

export function paramValue(params, id, fallback) {
  const p = params.find(row => row.id === id);
  if (!p) return fallback;
  const n = Number(p.value);
  return Number.isFinite(n) ? n : fallback;
}

// Render a `<div class="viz-params">` block from the normalized params.
// Pair with bindParamSliders() to wire up `input` events.
export function renderParamsHtml(params) {
  if (!params.length) return '';
  return `
    <div class="viz-params">
      ${params
        .map(
          p => `
          <label class="viz-param-row" data-param-id="${escapeAttr(p.id)}">
            <span class="viz-param-label">${escapeAttr(p.label || p.id)}</span>
            <input
              class="viz-param-slider"
              type="range"
              min="${p.min}"
              max="${p.max}"
              step="${p.step}"
              value="${p.value}"
              data-param-id="${escapeAttr(p.id)}"
            />
            <span class="viz-param-value" data-param-value-for="${escapeAttr(p.id)}">${formatValue(p.value, p.unit)}</span>
          </label>
        `,
        )
        .join('')}
    </div>
  `;
}

export function bindParamSliders(host, params, onChange) {
  host.querySelectorAll('input.viz-param-slider').forEach(input => {
    input.addEventListener('input', event => {
      const target = event.currentTarget;
      const id = target.dataset.paramId;
      const next = Number(target.value);
      const param = params.find(p => p.id === id);
      if (!param) return;
      param.value = next;
      const label = host.querySelector(`[data-param-value-for="${CSS.escape(id)}"]`);
      if (label) label.textContent = formatValue(next, param.unit);
      if (typeof onChange === 'function') onChange(id, next);
    });
  });
}

// DPR-aware canvas sizer. Call on every frame; no-ops if the canvas is
// already the right size.
export function resizeCanvas(canvas, cssW, cssH) {
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const targetW = Math.round(cssW * dpr);
  const targetH = Math.round(cssH * dpr);
  if (canvas.width !== targetW) canvas.width = targetW;
  if (canvas.height !== targetH) canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function startAnimationLoop(host, tick) {
  let rafId = 0;
  const startedAt = performance.now();
  function frame() {
    if (!host.isConnected) return;
    const now = performance.now();
    try {
      tick(now, now - startedAt);
    } catch {
      // Never let a renderer bug take down the host app — swallow and wait.
    }
    rafId = window.requestAnimationFrame(frame);
  }
  rafId = window.requestAnimationFrame(frame);
  return {
    dispose() {
      if (rafId) window.cancelAnimationFrame(rafId);
    },
  };
}

export function renderCardHeader(spec) {
  return spec.title ? `<div class="viz-title">${escapeAttr(spec.title)}</div>` : '';
}

export function renderCardFooter(spec) {
  return spec.formula ? `<div class="viz-formula">${escapeAttr(spec.formula)}</div>` : '';
}
