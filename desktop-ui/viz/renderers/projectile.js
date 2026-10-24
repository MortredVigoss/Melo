import { escapeHtml as encodeHtml } from '../../html.js';
// Projectile motion renderer — canvas + slider params.
//
// Input spec shape (already validated upstream in vizSpec.js):
//   {
//     kind: 'interactive',
//     renderer: 'projectile',
//     title?: string,
//     formula?: string,
//     params: [{ id, label, min, max, default, step?, unit? }, ...]
//   }
//
// Supported param ids (all optional — renderer falls back to defaults):
//   - v0     : initial speed (m/s)
//   - theta  : launch angle (degrees)
//   - g      : gravitational acceleration (m/s^2)
//   - h0     : initial height (m)
//
// The renderer is intentionally self-contained — no external deps, no DOM
// outside the host element. State lives on the host via ._vizState so
// re-rendering the same host does not lose slider values.

const DEFAULTS = {
  v0: 20,
  theta: 45,
  g: 9.81,
  h0: 0,
};

const CANVAS_W = 480;
const CANVAS_H = 240;
const PADDING = 20;

function getParamValue(params, id, fallback) {
  const param = params.find(p => p.id === id);
  if (!param) return fallback;
  const n = Number(param.value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function simulate({ v0, theta, g, h0 }) {
  const rad = (theta * Math.PI) / 180;
  const vx = v0 * Math.cos(rad);
  const vy = v0 * Math.sin(rad);
  // Solve h0 + vy*t - 0.5 g t^2 = 0 for t_end (take positive root).
  const disc = vy * vy + 2 * g * h0;
  const tEnd = disc > 0 ? (vy + Math.sqrt(disc)) / g : 0;
  const range = vx * tEnd;
  const maxY = h0 + (vy * vy) / (2 * g);
  const points = [];
  const steps = 80;
  for (let i = 0; i <= steps; i += 1) {
    const t = (tEnd * i) / steps;
    const x = vx * t;
    const y = h0 + vy * t - 0.5 * g * t * t;
    points.push({ x, y, t });
  }
  return { points, range, maxY, tEnd, vx, vy };
}

function drawProjectile(canvas, state) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  if (canvas.width !== CANVAS_W * dpr) {
    canvas.width = CANVAS_W * dpr;
    canvas.height = CANVAS_H * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  const { points, range, maxY, tEnd } = state.sim;

  const xMax = Math.max(range, 1) * 1.05;
  const yMax = Math.max(maxY, 1) * 1.15;

  const plotW = CANVAS_W - PADDING * 2;
  const plotH = CANVAS_H - PADDING * 2;
  const toX = x => PADDING + (x / xMax) * plotW;
  const toY = y => CANVAS_H - PADDING - (y / yMax) * plotH;

  // Ground.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PADDING, CANVAS_H - PADDING);
  ctx.lineTo(CANVAS_W - PADDING, CANVAS_H - PADDING);
  ctx.stroke();

  // Axis ticks.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.font = '10px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`${yMax.toFixed(1)} m`, PADDING - 2, PADDING + 8);
  ctx.textAlign = 'left';
  ctx.fillText(`${xMax.toFixed(1)} m`, CANVAS_W - PADDING - 30, CANVAS_H - PADDING - 4);

  // Trajectory curve.
  const grad = ctx.createLinearGradient(0, 0, CANVAS_W, 0);
  grad.addColorStop(0, 'rgba(246, 90, 96, 0.95)');
  grad.addColorStop(1, 'rgba(255, 176, 120, 0.95)');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((pt, i) => {
    const px = toX(pt.x);
    const py = toY(pt.y);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // Animated ball — cycles over tEnd seconds using wall clock.
  if (tEnd > 0 && points.length > 1) {
    const periodMs = Math.max(800, Math.min(4000, tEnd * 1000));
    const phase = ((performance.now() - state.startedAt) % periodMs) / periodMs;
    const idxF = phase * (points.length - 1);
    const i0 = Math.floor(idxF);
    const i1 = Math.min(points.length - 1, i0 + 1);
    const frac = idxF - i0;
    const x = points[i0].x + (points[i1].x - points[i0].x) * frac;
    const y = points[i0].y + (points[i1].y - points[i0].y) * frac;
    ctx.fillStyle = '#fff7f3';
    ctx.shadowColor = 'rgba(246, 90, 96, 0.7)';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(toX(x), toY(y), 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function mountProjectile(host, spec) {
  const params = (spec.params || []).map(p => ({
    ...p,
    value: p.default,
  }));

  const state = {
    params,
    sim: null,
    startedAt: performance.now(),
    rafId: 0,
  };

  const recompute = () => {
    const values = {
      v0: getParamValue(state.params, 'v0', DEFAULTS.v0),
      theta: getParamValue(state.params, 'theta', DEFAULTS.theta),
      g: getParamValue(state.params, 'g', DEFAULTS.g),
      h0: getParamValue(state.params, 'h0', DEFAULTS.h0),
    };
    state.sim = simulate(values);
    state.values = values;
  };
  recompute();

  host.classList.add('viz-card');
  host.innerHTML = `
    ${spec.title ? `<div class="viz-title">${escape(spec.title)}</div>` : ''}
    <canvas class="viz-canvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
    <div class="viz-readout" data-role="viz-readout"></div>
    <div class="viz-params">
      ${state.params
        .map(
          p => `
          <label class="viz-param-row" data-param-id="${escape(p.id)}">
            <span class="viz-param-label">${escape(p.label || p.id)}</span>
            <input
              class="viz-param-slider"
              type="range"
              min="${p.min}"
              max="${p.max}"
              step="${p.step || ((p.max - p.min) / 100)}"
              value="${p.value}"
              data-param-id="${escape(p.id)}"
            />
            <span class="viz-param-value" data-param-value-for="${escape(p.id)}">${formatValue(p.value, p.unit)}</span>
          </label>
        `,
        )
        .join('')}
    </div>
    ${spec.formula ? `<div class="viz-formula">${escape(spec.formula)}</div>` : ''}
  `;

  const canvas = host.querySelector('canvas.viz-canvas');
  const readout = host.querySelector('[data-role="viz-readout"]');

  function updateReadout() {
    if (!readout || !state.sim) return;
    const { range, maxY, tEnd } = state.sim;
    readout.textContent =
      `Range ${range.toFixed(1)} m · Peak ${maxY.toFixed(1)} m · Flight ${tEnd.toFixed(2)} s`;
  }
  updateReadout();

  host.querySelectorAll('input.viz-param-slider').forEach(input => {
    input.addEventListener('input', event => {
      const target = event.currentTarget;
      const id = target.dataset.paramId;
      const next = Number(target.value);
      const param = state.params.find(p => p.id === id);
      if (!param) return;
      param.value = next;
      const label = host.querySelector(`[data-param-value-for="${CSS.escape(id)}"]`);
      if (label) label.textContent = formatValue(next, param.unit);
      recompute();
      updateReadout();
    });
  });

  function frame() {
    if (!host.isConnected) return;
    drawProjectile(canvas, state);
    state.rafId = window.requestAnimationFrame(frame);
  }
  state.rafId = window.requestAnimationFrame(frame);

  return {
    dispose() {
      if (state.rafId) window.cancelAnimationFrame(state.rafId);
    },
  };
}

function escape(str) {
  return encodeHtml(str || '');
}

function formatValue(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const rounded = Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2);
  return unit ? `${rounded} ${unit}` : String(rounded);
}

export default mountProjectile;
