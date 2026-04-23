// Function plotter — evaluates a sandboxed math expression of one
// variable `x` plus any spec-defined parameters.
//
// Safety: only characters in SAFE_EXPR_PATTERN are allowed. `x` and the
// param ids (sanitized) are the only identifiers in scope; everything
// else in the expression must be a member of `Math` (added by prefixing
// in `buildEvaluator`). No `eval`, no access to window/globals.
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

const CANVAS_W = 480;
const CANVAS_H = 260;
const PADDING = 28;
const SAFE_EXPR_PATTERN = /^[0-9a-zA-Z_+\-*/().,\s]+$/;
const SAFE_ID_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MATH_KEYS = new Set([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh',
  'exp', 'log', 'log2', 'log10', 'sqrt', 'cbrt', 'pow', 'abs', 'min', 'max',
  'floor', 'ceil', 'round', 'sign', 'hypot', 'PI', 'E',
]);

function sanitizeExpression(expr, paramIds) {
  if (typeof expr !== 'string') return null;
  if (!SAFE_EXPR_PATTERN.test(expr)) return null;
  if (expr.length > 120) return null;
  // Replace Math-whitelisted identifiers with `M.<name>`; fail if any
  // other identifier is encountered that isn't the var `x` or a param id.
  const allowed = new Set(['x', ...paramIds]);
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[a-zA-Z0-9_]/.test(expr[j])) j += 1;
      const ident = expr.slice(i, j);
      if (allowed.has(ident)) {
        out += ident;
      } else if (MATH_KEYS.has(ident)) {
        out += `M.${ident}`;
      } else {
        return null;
      }
      i = j;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function buildEvaluator(expr, paramIds) {
  const safe = sanitizeExpression(expr, paramIds);
  if (!safe) return null;
  try {
    // eslint-disable-next-line no-new-func
    return new Function('M', 'x', ...paramIds, `return (${safe});`);
  } catch {
    return null;
  }
}

export default function mountFunctionPlot(host, spec) {
  const params = materializeParams(spec.params).filter(p => SAFE_ID_PATTERN.test(p.id));
  const paramIds = params.map(p => p.id);
  const fn = buildEvaluator(spec.expression || 'a*x + b', paramIds);
  const xMin = Number.isFinite(Number(spec.xMin)) ? Number(spec.xMin) : -5;
  const xMax = Number.isFinite(Number(spec.xMax)) ? Number(spec.xMax) : 5;

  host.classList.add('viz-card');
  host.innerHTML = `
    ${renderCardHeader(spec)}
    <div class="viz-fn-expr">y = ${escapeAttr(spec.expression || 'a·x + b')}  ·  x ∈ [${xMin}, ${xMax}]</div>
    <canvas class="viz-canvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
    ${renderParamsHtml(params)}
    ${renderCardFooter(spec)}
  `;
  const canvas = host.querySelector('canvas.viz-canvas');

  if (!fn) {
    const note = document.createElement('div');
    note.className = 'viz-readout';
    note.textContent = 'Expression could not be safely evaluated.';
    host.appendChild(note);
  }

  bindParamSliders(host, params, () => {});

  return startAnimationLoop(host, () => {
    const ctx = resizeCanvas(canvas, CANVAS_W, CANVAS_H);
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    if (!fn) return;
    // Sample.
    const N = 240;
    const points = new Array(N + 1);
    let yMin = Infinity;
    let yMax = -Infinity;
    const args = paramIds.map(id => paramValue(params, id, 0));
    for (let i = 0; i <= N; i += 1) {
      const x = xMin + ((xMax - xMin) * i) / N;
      let y;
      try {
        y = fn(Math, x, ...args);
        if (!Number.isFinite(y)) y = NaN;
      } catch {
        y = NaN;
      }
      points[i] = { x, y };
      if (Number.isFinite(y)) {
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
    if (!Number.isFinite(yMin)) {
      yMin = -1;
      yMax = 1;
    } else if (yMin === yMax) {
      yMin -= 1;
      yMax += 1;
    } else {
      const pad = (yMax - yMin) * 0.1;
      yMin -= pad;
      yMax += pad;
    }

    const plotW = CANVAS_W - PADDING * 2;
    const plotH = CANVAS_H - PADDING * 2;
    const toX = v => PADDING + ((v - xMin) / (xMax - xMin)) * plotW;
    const toY = v => CANVAS_H - PADDING - ((v - yMin) / (yMax - yMin)) * plotH;

    // Axes.
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PADDING, CANVAS_H - PADDING);
    ctx.lineTo(CANVAS_W - PADDING, CANVAS_H - PADDING);
    ctx.stroke();
    if (xMin <= 0 && xMax >= 0) {
      ctx.beginPath();
      ctx.moveTo(toX(0), PADDING);
      ctx.lineTo(toX(0), CANVAS_H - PADDING);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '10px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(yMax.toFixed(2), PADDING - 2, PADDING + 8);
    ctx.fillText(yMin.toFixed(2), PADDING - 2, CANVAS_H - PADDING - 2);

    // Curve.
    const grad = ctx.createLinearGradient(0, 0, CANVAS_W, 0);
    grad.addColorStop(0, 'rgba(246,90,96,0.95)');
    grad.addColorStop(1, 'rgba(255,176,120,0.95)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let inStroke = false;
    for (const pt of points) {
      if (!Number.isFinite(pt.y)) {
        inStroke = false;
        continue;
      }
      const px = toX(pt.x);
      const py = toY(pt.y);
      if (!inStroke) {
        ctx.moveTo(px, py);
        inStroke = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  });
}
