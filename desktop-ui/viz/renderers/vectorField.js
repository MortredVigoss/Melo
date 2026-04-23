// 2D vector field renderer. Uses a preset field type (safer than
// evaluating arbitrary expressions) chosen via `fieldType`.
//   - 'radial'  : outward from origin
//   - 'swirl'   : rotational around origin
//   - 'saddle'  : hyperbolic (saddle point at origin)
//   - 'sink'    : toward origin
//   - 'dipole'  : + source near top, sink near bottom
// Optional slider `strength` scales all vectors; sliders `cx`/`cy` move
// the origin.
import {
  bindParamSliders,
  escapeAttr,
  materializeParams,
  paramValue,
  renderCardFooter,
  renderCardHeader,
  renderParamsHtml,
  resizeCanvas,
  startAnimationLoop,
} from '../vizCommon.js';

const CANVAS_W = 400;
const CANVAS_H = 300;
const GRID = 14;

const FIELD_TYPES = new Set(['radial', 'swirl', 'saddle', 'sink', 'dipole']);

function sample(fieldType, x, y, strength) {
  switch (fieldType) {
    case 'swirl':
      return { u: -y * strength, v: x * strength };
    case 'saddle':
      return { u: x * strength, v: -y * strength };
    case 'sink':
      return { u: -x * strength, v: -y * strength };
    case 'dipole': {
      const d1 = Math.hypot(x, y - 1) + 0.2;
      const d2 = Math.hypot(x, y + 1) + 0.2;
      return {
        u: strength * (x / d1 ** 3 - x / d2 ** 3),
        v: strength * ((y - 1) / d1 ** 3 - (y + 1) / d2 ** 3),
      };
    }
    case 'radial':
    default:
      return { u: x * strength, v: y * strength };
  }
}

export default function mountVectorField(host, spec) {
  const params = materializeParams(spec.params);
  const fieldType = FIELD_TYPES.has(spec.fieldType) ? spec.fieldType : 'radial';
  host.classList.add('viz-card');
  host.innerHTML = `
    ${renderCardHeader(spec)}
    <canvas class="viz-canvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
    <div class="viz-readout">Field type: ${escapeAttr(fieldType)}</div>
    ${renderParamsHtml(params)}
    ${renderCardFooter(spec)}
  `;
  const canvas = host.querySelector('canvas.viz-canvas');
  bindParamSliders(host, params, () => {});

  return startAnimationLoop(host, () => {
    const strength = paramValue(params, 'strength', 0.5);
    const cx = paramValue(params, 'cx', 0);
    const cy = paramValue(params, 'cy', 0);

    const ctx = resizeCanvas(canvas, CANVAS_W, CANVAS_H);
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    const cellW = CANVAS_W / GRID;
    const cellH = CANVAS_H / GRID;
    const scale = 0.35 * Math.min(cellW, cellH);

    for (let gy = 0; gy < GRID; gy += 1) {
      for (let gx = 0; gx < GRID; gx += 1) {
        const px = (gx + 0.5) * cellW;
        const py = (gy + 0.5) * cellH;
        // Field coords in [-1, 1] range, then offset by origin sliders.
        const fx = (gx + 0.5) / GRID * 2 - 1 - cx;
        const fy = (gy + 0.5) / GRID * 2 - 1 - cy;
        const { u, v } = sample(fieldType, fx, fy, strength);
        const mag = Math.hypot(u, v) + 1e-6;
        const ux = u / mag;
        const uy = v / mag;
        const len = Math.min(1, mag) * scale;
        const tipX = px + ux * len;
        const tipY = py - uy * len;

        const hue = Math.min(1, mag / 2);
        ctx.strokeStyle = `rgba(${246 + hue * 9}, ${120 + hue * 80}, ${110 - hue * 20}, ${0.45 + hue * 0.4})`;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(tipX, tipY);
        ctx.stroke();

        // Arrow head.
        const angle = Math.atan2(-uy, ux);
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(
          tipX - Math.cos(angle - 0.4) * 4,
          tipY - Math.sin(angle - 0.4) * 4,
        );
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(
          tipX - Math.cos(angle + 0.4) * 4,
          tipY - Math.sin(angle + 0.4) * 4,
        );
        ctx.stroke();
      }
    }
  });
}
