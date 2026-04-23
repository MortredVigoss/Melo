// Ohm's law interactive: V, I, R — move any two, the third updates.
// Spec params define the two free variables (e.g. V + R, or V + I).
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

const CANVAS_W = 420;
const CANVAS_H = 180;

const DEFAULTS = { V: 5, R: 100, I: 0.05 };

function computeDerived(V, R, I) {
  // Priority: if V and R are present, compute I = V/R. Otherwise V = IR.
  if (Number.isFinite(V) && Number.isFinite(R) && R > 0) {
    return { V, R, I: V / R };
  }
  if (Number.isFinite(I) && Number.isFinite(R)) {
    return { V: I * R, R, I };
  }
  if (Number.isFinite(V) && Number.isFinite(I) && I !== 0) {
    return { V, R: V / I, I };
  }
  return { V: V || DEFAULTS.V, R: R || DEFAULTS.R, I: I || DEFAULTS.I };
}

function drawCircuit(ctx, V, I) {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  const cx = CANVAS_W / 2;
  const cy = CANVAS_H / 2;
  const boxW = 260;
  const boxH = 80;
  const left = cx - boxW / 2;
  const top = cy - boxH / 2;

  // Wires.
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(left, top, boxW, boxH);

  // Battery on the left side.
  ctx.beginPath();
  ctx.moveTo(left + 10, top + boxH / 2 - 14);
  ctx.lineTo(left + 10, top + boxH / 2 + 14);
  ctx.moveTo(left + 16, top + boxH / 2 - 8);
  ctx.lineTo(left + 16, top + boxH / 2 + 8);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${V.toFixed(2)} V`, left + 13, top - 6);

  // Resistor on the right side (zigzag).
  const rx = left + boxW - 10;
  ctx.beginPath();
  ctx.moveTo(rx, top + boxH / 2 - 16);
  let sign = 1;
  for (let i = 0; i < 6; i += 1) {
    ctx.lineTo(rx - 6 * sign, top + boxH / 2 - 12 + i * 6);
    sign = -sign;
  }
  ctx.lineTo(rx, top + boxH / 2 + 16);
  ctx.stroke();
  ctx.fillText(`${I.toFixed(3)} A`, rx, top - 6);

  // Current arrows around the loop.
  const speed = Math.max(0.2, Math.min(3, Math.abs(I) * 20));
  const phase = (performance.now() / 1000) * speed;
  for (let i = 0; i < 4; i += 1) {
    const tRaw = (phase + i * 0.25) % 1;
    const pt = loopPoint(left, top, boxW, boxH, tRaw);
    ctx.fillStyle = 'rgba(246,90,96,0.9)';
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Parametric position along the rectangular loop, t in [0,1].
function loopPoint(left, top, w, h, t) {
  const perim = 2 * (w + h);
  const d = t * perim;
  if (d < w) return { x: left + d, y: top };
  if (d < w + h) return { x: left + w, y: top + (d - w) };
  if (d < 2 * w + h) return { x: left + w - (d - w - h), y: top + h };
  return { x: left, y: top + h - (d - 2 * w - h) };
}

export default function mountCircuitOhm(host, spec) {
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
    const derived = computeDerived(
      paramValue(params, 'V', NaN),
      paramValue(params, 'R', NaN),
      paramValue(params, 'I', NaN),
    );
    if (readout) {
      readout.textContent =
        `V = ${derived.V.toFixed(2)} V  ·  I = ${derived.I.toFixed(3)} A  ·  R = ${derived.R.toFixed(0)} Ω`;
    }
  }
  updateReadout();

  return startAnimationLoop(host, () => {
    const derived = computeDerived(
      paramValue(params, 'V', NaN),
      paramValue(params, 'R', NaN),
      paramValue(params, 'I', NaN),
    );
    const ctx = resizeCanvas(canvas, CANVAS_W, CANVAS_H);
    if (!ctx) return;
    drawCircuit(ctx, derived.V, derived.I);
  });
}
