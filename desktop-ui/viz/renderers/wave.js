// Sinusoidal wave renderer — y = A · sin(2π(x/λ − f·t) + φ).
// Params: amplitude, wavelength, frequency, phase.
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
const CANVAS_H = 200;
const PADDING = 20;

const DEFAULTS = { amplitude: 60, wavelength: 160, frequency: 0.6, phase: 0 };

export default function mountWave(host, spec) {
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
    const amplitude = paramValue(params, 'amplitude', DEFAULTS.amplitude);
    const wavelength = paramValue(params, 'wavelength', DEFAULTS.wavelength);
    const frequency = paramValue(params, 'frequency', DEFAULTS.frequency);
    const v = wavelength * frequency;
    if (readout) {
      readout.textContent =
        `A=${amplitude.toFixed(0)}  λ=${wavelength.toFixed(0)}  f=${frequency.toFixed(2)}  v=λf=${v.toFixed(1)}`;
    }
  }
  updateReadout();

  return startAnimationLoop(host, (_now, elapsedMs) => {
    const A = paramValue(params, 'amplitude', DEFAULTS.amplitude);
    const lambda = Math.max(paramValue(params, 'wavelength', DEFAULTS.wavelength), 4);
    const f = paramValue(params, 'frequency', DEFAULTS.frequency);
    const phi = paramValue(params, 'phase', DEFAULTS.phase);
    const t = elapsedMs / 1000;

    const ctx = resizeCanvas(canvas, CANVAS_W, CANVAS_H);
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Axis.
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PADDING, CANVAS_H / 2);
    ctx.lineTo(CANVAS_W - PADDING, CANVAS_H / 2);
    ctx.stroke();

    // Wave.
    const grad = ctx.createLinearGradient(0, 0, CANVAS_W, 0);
    grad.addColorStop(0, 'rgba(246,90,96,0.95)');
    grad.addColorStop(1, 'rgba(255,176,120,0.95)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const maxAmp = (CANVAS_H - PADDING * 2) / 2;
    const amp = Math.min(maxAmp, Math.max(2, A));
    for (let px = PADDING; px <= CANVAS_W - PADDING; px += 1) {
      const x = px - PADDING;
      const y = amp * Math.sin(2 * Math.PI * (x / lambda - f * t) + phi);
      const py = CANVAS_H / 2 - y;
      if (px === PADDING) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  });
}
