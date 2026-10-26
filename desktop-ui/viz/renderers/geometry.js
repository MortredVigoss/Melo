import { sceneColor } from '../../../src/shared/visualTokens.js';
// Interactive geometry renderer. Supports two shapes:
//   - triangle: params a, b, c are side lengths → compute apex via law of cosines
//   - circle:   param r is radius, draws circle + radius line
// Spec: { shape: 'triangle' | 'circle', params: [...] }
import {
  bindParamSliders,
  escapeAttr,
  materializeParams,
  paramValue,
  renderCardFooter,
  renderCardHeader,
  renderParamsHtml,
} from '../vizCommon.js';

const WIDTH = 400;
const HEIGHT = 260;

function triangleCoords(a, b, c) {
  // Place side a along x-axis from (0,0) to (a,0).
  const p1 = { x: 0, y: 0 };
  const p2 = { x: a, y: 0 };
  // Law of cosines to place p3.
  const cosA = Math.max(-1, Math.min(1, (b * b + a * a - c * c) / (2 * a * b)));
  const theta = Math.acos(cosA);
  const p3 = { x: b * Math.cos(theta), y: b * Math.sin(theta) };
  return [p1, p2, p3];
}

function areaFromSides(a, b, c) {
  const s = (a + b + c) / 2;
  const aq = s * (s - a) * (s - b) * (s - c);
  return aq > 0 ? Math.sqrt(aq) : 0;
}

function fitPoints(points, targetW, targetH, padding) {
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const scale = Math.min((targetW - padding * 2) / (maxX - minX || 1), (targetH - padding * 2) / (maxY - minY || 1));
  const cx = targetW / 2;
  const cy = targetH / 2;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    points: points.map(p => ({
      x: cx + (p.x - centerX) * scale,
      y: cy - (p.y - centerY) * scale,
    })),
    scale,
    span,
  };
}

function renderTriangle(host, params, title, formula) {
  const a = Math.max(0.01, paramValue(params, 'a', 3));
  const b = Math.max(0.01, paramValue(params, 'b', 4));
  const c = Math.max(0.01, paramValue(params, 'c', 5));
  // Triangle inequality check.
  const valid = a + b > c && b + c > a && a + c > b;

  let content;
  if (!valid) {
    content = `<div class="viz-readout">Triangle inequality violated — adjust side lengths.</div>`;
  } else {
    const pts = triangleCoords(a, b, c);
    const { points } = fitPoints(pts, WIDTH, HEIGHT, 36);
    const pathD = points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ') + ' Z';
    const area = areaFromSides(a, b, c);
    const perim = a + b + c;
    content = `
      <svg viewBox="0 0 ${WIDTH} ${HEIGHT}" class="viz-geometry-svg">
        <path d="${pathD}" fill="rgba(246,90,96,0.18)" stroke="rgba(255,180,140,0.8)" stroke-width="1.8" />
        ${points
          .map(
            (p, i) => `
              <circle cx="${p.x}" cy="${p.y}" r="4" fill="${sceneColor('diagram-point')}" />
              <text x="${p.x + 7}" y="${p.y - 7}" font-size="11" fill="rgba(255,255,255,0.75)">${escapeAttr(
              ['A', 'B', 'C'][i],
            )}</text>
            `,
          )
          .join('')}
      </svg>
      <div class="viz-readout">Area = ${area.toFixed(2)} · Perimeter = ${perim.toFixed(2)}</div>
    `;
  }

  host.innerHTML = `
    ${title ? `<div class="viz-title">${escapeAttr(title)}</div>` : ''}
    ${content}
    ${renderParamsHtml(params)}
    ${formula ? `<div class="viz-formula">${escapeAttr(formula)}</div>` : ''}
  `;
}

function renderCircle(host, params, title, formula) {
  const r = Math.max(0.01, paramValue(params, 'r', 3));
  const area = Math.PI * r * r;
  const circ = 2 * Math.PI * r;
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const drawR = Math.min(WIDTH, HEIGHT) / 2 - 24;
  const visR = drawR * (r / Math.max(r, 1));
  host.innerHTML = `
    ${title ? `<div class="viz-title">${escapeAttr(title)}</div>` : ''}
    <svg viewBox="0 0 ${WIDTH} ${HEIGHT}" class="viz-geometry-svg">
      <circle cx="${cx}" cy="${cy}" r="${visR}" fill="rgba(246,90,96,0.15)" stroke="rgba(255,180,140,0.8)" stroke-width="1.8" />
      <line x1="${cx}" y1="${cy}" x2="${cx + visR}" y2="${cy}" stroke="rgba(255,255,255,0.7)" stroke-width="1.5" />
      <circle cx="${cx}" cy="${cy}" r="3" fill="${sceneColor('diagram-point')}" />
      <text x="${cx + visR / 2}" y="${cy - 6}" font-size="11" fill="rgba(255,255,255,0.8)" text-anchor="middle">r = ${r.toFixed(2)}</text>
    </svg>
    <div class="viz-readout">Area = π·r² = ${area.toFixed(2)}  ·  Circumference = 2π·r = ${circ.toFixed(2)}</div>
    ${renderParamsHtml(params)}
    ${formula ? `<div class="viz-formula">${escapeAttr(formula)}</div>` : ''}
  `;
}

export default function mountGeometry(host, spec) {
  const shape = spec.shape === 'circle' ? 'circle' : 'triangle';
  const params = materializeParams(spec.params);
  host.classList.add('viz-card');

  function repaint() {
    if (shape === 'circle') renderCircle(host, params, spec.title, spec.formula);
    else renderTriangle(host, params, spec.title, spec.formula);
    bindParamSliders(host, params, repaint);
  }
  repaint();

  return { dispose() {} };
}
