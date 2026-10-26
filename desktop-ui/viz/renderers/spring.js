import { sceneColor } from '../../../src/shared/visualTokens.js';
// Spring-mass oscillator renderer.
// Params: k (spring constant N/m), m (mass kg), x0 (initial displacement m)
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
const CANVAS_H = 180;
const WALL_X = 40;
const CENTER_Y = CANVAS_H / 2;
const PX_PER_M = 140;
const BOX_W = 38;
const BOX_H = 40;
const COILS = 10;

const DEFAULTS = { k: 20, m: 1, x0: 0.4 };

function drawSpring(ctx, x1, x2, y, amplitude) {
  const span = x2 - x1;
  const step = span / (COILS * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x1, y);
  for (let i = 1; i <= COILS * 2; i += 1) {
    const x = x1 + step * i;
    const dy = (i % 2 === 0 ? 0 : (i % 4 === 1 ? -1 : 1)) * amplitude;
    ctx.lineTo(x, y + dy);
  }
  ctx.lineTo(x2, y);
  ctx.stroke();
}

export default function mountSpring(host, spec) {
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
    const k = paramValue(params, 'k', DEFAULTS.k);
    const m = paramValue(params, 'm', DEFAULTS.m);
    const omega = Math.sqrt(k / Math.max(m, 0.01));
    const T = (2 * Math.PI) / omega;
    if (readout) readout.textContent = `ω = ${omega.toFixed(2)} rad/s · T = ${T.toFixed(2)} s`;
  }
  updateReadout();

  return startAnimationLoop(host, (_now, elapsedMs) => {
    const k = paramValue(params, 'k', DEFAULTS.k);
    const m = paramValue(params, 'm', DEFAULTS.m);
    const x0 = paramValue(params, 'x0', DEFAULTS.x0);
    const omega = Math.sqrt(k / Math.max(m, 0.01));
    const t = elapsedMs / 1000;
    const x = x0 * Math.cos(omega * t);

    const ctx = resizeCanvas(canvas, CANVAS_W, CANVAS_H);
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Baseline / floor.
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.moveTo(WALL_X, CENTER_Y + BOX_H / 2 + 2);
    ctx.lineTo(CANVAS_W - 20, CENTER_Y + BOX_H / 2 + 2);
    ctx.stroke();

    // Wall.
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(WALL_X - 14, CENTER_Y - 50, 4, 100);

    const restEnd = WALL_X + 200;
    const boxX = restEnd + x * PX_PER_M;
    drawSpring(ctx, WALL_X, boxX, CENTER_Y, 8);

    // Mass box.
    ctx.fillStyle = sceneColor('diagram-point');
    ctx.shadowColor = 'rgba(246,90,96,0.6)';
    ctx.shadowBlur = 12;
    ctx.fillRect(boxX, CENTER_Y - BOX_H / 2, BOX_W, BOX_H);
    ctx.shadowBlur = 0;

    // Axis ticks at rest position.
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(restEnd, CENTER_Y - 40);
    ctx.lineTo(restEnd, CENTER_Y + 40);
    ctx.stroke();
    ctx.setLineDash([]);
  });
}
