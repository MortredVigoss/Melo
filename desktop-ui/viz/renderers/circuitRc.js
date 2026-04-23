// RC circuit charge/discharge curve.
// Params: V (voltage), R (Ω), C (F), mode toggled via `decay` param (0=charge,1=discharge)
import {
  bindParamSliders,
  materializeParams,
  paramValue,
  renderCardFooter,
  renderCardHeader,
  renderParamsHtml,
  resizeCanvas,
  startAnimationLoop,
} from '../vizCommon.js';

const CANVAS_W = 480;
const CANVAS_H = 240;
const PADDING = 28;

const DEFAULTS = { V: 5, R: 1000, C: 0.001, decay: 0 };

export default function mountCircuitRc(host, spec) {
  const params = materializeParams(spec.params);
  host.classList.add('viz-card');
  host.innerHTML = `
    ${renderCardHeader(spec)}
    <canvas class="viz-canvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
    <div class="viz-readout" data-role="viz-readout"></div>
    ${renderParamsHtml(params)}
    ${renderCardFooter(spec)}
  `;
  const canvas = host.querySelector('canvas.viz-canvas');
  const readout = host.querySelector('[data-role="viz-readout"]');
  bindParamSliders(host, params, updateReadout);

  function updateReadout() {
    const R = paramValue(params, 'R', DEFAULTS.R);
    const C = paramValue(params, 'C', DEFAULTS.C);
    const tau = R * C;
    if (readout) readout.textContent = `τ = RC = ${tau.toFixed(3)} s · 5τ ≈ ${(5 * tau).toFixed(2)} s`;
  }
  updateReadout();

  return startAnimationLoop(host, (_now, elapsedMs) => {
    const V = paramValue(params, 'V', DEFAULTS.V);
    const R = paramValue(params, 'R', DEFAULTS.R);
    const C = paramValue(params, 'C', DEFAULTS.C);
    const decay = paramValue(params, 'decay', DEFAULTS.decay) >= 0.5;
    const tau = Math.max(R * C, 1e-6);
    const tWindow = Math.min(tau * 5, 6);
    const tNow = (elapsedMs / 1000) % tWindow;

    const ctx = resizeCanvas(canvas, CANVAS_W, CANVAS_H);
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    const plotW = CANVAS_W - PADDING * 2;
    const plotH = CANVAS_H - PADDING * 2;
    const toX = t => PADDING + (t / tWindow) * plotW;
    const toY = v => CANVAS_H - PADDING - (v / Math.max(V, 0.001)) * plotH;

    // Axes.
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(PADDING, CANVAS_H - PADDING);
    ctx.lineTo(CANVAS_W - PADDING, CANVAS_H - PADDING);
    ctx.moveTo(PADDING, PADDING);
    ctx.lineTo(PADDING, CANVAS_H - PADDING);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '10px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${V.toFixed(1)} V`, PADDING - 2, PADDING + 8);
    ctx.textAlign = 'left';
    ctx.fillText(`${tWindow.toFixed(2)} s`, CANVAS_W - PADDING - 32, CANVAS_H - PADDING - 4);

    // Curve.
    ctx.strokeStyle = decay ? 'rgba(120,200,255,0.95)' : 'rgba(246,90,96,0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const N = 200;
    for (let i = 0; i <= N; i += 1) {
      const t = (tWindow * i) / N;
      const v = decay ? V * Math.exp(-t / tau) : V * (1 - Math.exp(-t / tau));
      const px = toX(t);
      const py = toY(v);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Running indicator.
    const vNow = decay ? V * Math.exp(-tNow / tau) : V * (1 - Math.exp(-tNow / tau));
    ctx.fillStyle = '#fff7f3';
    ctx.shadowColor = decay ? 'rgba(120,200,255,0.7)' : 'rgba(246,90,96,0.7)';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(toX(tNow), toY(vNow), 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  });
}
