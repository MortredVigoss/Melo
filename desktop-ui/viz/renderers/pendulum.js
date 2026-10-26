import { sceneColor } from '../../../src/shared/visualTokens.js';
// Simple pendulum renderer — small-angle approximation.
// Params: L (length, m), g (gravity, m/s²), theta0 (amplitude, degrees)
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

const CANVAS_W = 360;
const CANVAS_H = 260;
const PIVOT_Y = 40;
const PX_PER_M = 120;
const BOB_R = 12;

const DEFAULTS = { L: 1, g: 9.81, theta0: 30 };

export default function mountPendulum(host, spec) {
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

  bindParamSliders(host, params, () => updateReadout());

  function updateReadout() {
    const L = paramValue(params, 'L', DEFAULTS.L);
    const g = paramValue(params, 'g', DEFAULTS.g);
    const period = 2 * Math.PI * Math.sqrt(L / g);
    if (readout) readout.textContent = `Period T ≈ ${period.toFixed(2)} s`;
  }
  updateReadout();

  return startAnimationLoop(host, (_now, elapsedMs) => {
    const L = paramValue(params, 'L', DEFAULTS.L);
    const g = paramValue(params, 'g', DEFAULTS.g);
    const theta0 = (paramValue(params, 'theta0', DEFAULTS.theta0) * Math.PI) / 180;
    const omega = Math.sqrt(g / Math.max(L, 0.01));
    const t = elapsedMs / 1000;
    const theta = theta0 * Math.cos(omega * t);

    const ctx = resizeCanvas(canvas, CANVAS_W, CANVAS_H);
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    const pivotX = CANVAS_W / 2;
    const armLen = Math.min(L * PX_PER_M, CANVAS_H - PIVOT_Y - BOB_R - 10);
    const bobX = pivotX + armLen * Math.sin(theta);
    const bobY = PIVOT_Y + armLen * Math.cos(theta);

    // Ceiling.
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pivotX - 30, PIVOT_Y);
    ctx.lineTo(pivotX + 30, PIVOT_Y);
    ctx.stroke();

    // Arm.
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pivotX, PIVOT_Y);
    ctx.lineTo(bobX, bobY);
    ctx.stroke();

    // Bob.
    ctx.fillStyle = sceneColor('diagram-point');
    ctx.shadowColor = 'rgba(246,90,96,0.7)';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(bobX, bobY, BOB_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Angle indicator (small arc).
    ctx.strokeStyle = 'rgba(246,90,96,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(pivotX, PIVOT_Y, 22, Math.PI / 2, Math.PI / 2 + theta, theta < 0);
    ctx.stroke();
  });
}
