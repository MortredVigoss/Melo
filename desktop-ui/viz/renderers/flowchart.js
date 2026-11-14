// Flowchart renderer — sequential steps with arrows.
// Shape: nodes: [{id, label, children?: [ids], shape?: 'rect'|'diamond'|'ellipse'}], edges?: [{from, to, label?}]
// A stored flowchart is a `tree` spec (src/services/viz/vizSpec.js): it has
// `nodes[].children` and no `edges`. Until 2026-11-14 only `edges` was read,
// so stored flowcharts were drawn without arrows, all steps in one row.
// Layout: stacked rows by longest path from the start step (see layoutNodes).
import { escapeAttr, renderCardFooter, renderCardHeader } from '../vizCommon.js';

const NODE_H = 40;
const ROW_GAP = 28;
const PADDING_X = 30;
const PADDING_Y = 20;
const MIN_NODE_W = 100;
const MAX_NODE_W = 260;
const CHAR_W = 7;

// Row of each step: the longest path from a start step. A link that leads
// back to a step already on the current path (a loop such as "review → write")
// is drawn, but does not count for the rows; otherwise the loop would push the
// first step below the ones that follow it. Loops became reachable on
// 2026-11-14, when stored flowcharts started to get their links at all.
function layoutNodes(nodes, edges) {
  const byId = new Map(nodes.map(n => [n.id, { ...n, level: 0 }]));
  const next = new Map(nodes.map(n => [n.id, []]));
  const inbound = new Map(nodes.map(n => [n.id, 0]));
  edges.forEach(e => {
    if (!byId.has(e.from) || !byId.has(e.to)) return;
    next.get(e.from).push(e.to);
    inbound.set(e.to, inbound.get(e.to) + 1);
  });
  const state = new Map(); // id → 'open' (on the current path) | 'done'
  const visit = (id, level) => {
    const node = byId.get(id);
    if (state.get(id) === 'open') return;
    if (state.get(id) === 'done' && node.level >= level) return;
    node.level = Math.max(node.level, level);
    state.set(id, 'open');
    for (const nextId of next.get(id)) visit(nextId, node.level + 1);
    state.set(id, 'done');
  };
  // Start steps are those nothing points to; a chart that is one big loop
  // starts at its first step. Steps only a separate loop reaches come last,
  // in the order they were written.
  const starts = nodes.filter(n => inbound.get(n.id) === 0);
  for (const node of starts.length ? starts : nodes.slice(0, 1)) visit(node.id, 0);
  for (const node of nodes) if (!state.has(node.id)) visit(node.id, 0);
  return byId;
}

function measureWidth(label) {
  const n = String(label || '').length;
  return Math.min(MAX_NODE_W, Math.max(MIN_NODE_W, n * CHAR_W + 32));
}

function shapeFor(shape) {
  if (shape === 'diamond') return 'diamond';
  if (shape === 'ellipse') return 'ellipse';
  return 'rect';
}

function renderNodeShape(node, x, y, width) {
  const cx = x + width / 2;
  const cy = y + NODE_H / 2;
  if (node.shapeKind === 'diamond') {
    return `<polygon points="${cx},${y} ${x + width},${cy} ${cx},${y + NODE_H} ${x},${cy}" />`;
  }
  if (node.shapeKind === 'ellipse') {
    return `<ellipse cx="${cx}" cy="${cy}" rx="${width / 2}" ry="${NODE_H / 2}" />`;
  }
  return `<rect x="${x}" y="${y}" width="${width}" height="${NODE_H}" rx="10" ry="10" />`;
}

export default function mountFlowchart(host, spec) {
  const rawNodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  const rawEdges = Array.isArray(spec.edges) && spec.edges.length
    ? spec.edges
    : rawNodes.flatMap(node => (Array.isArray(node.children) ? node.children : []).map(to => ({ from: node.id, to })));
  const byId = layoutNodes(rawNodes, rawEdges);

  // Group nodes by level, then measure per-row width.
  const rows = [];
  byId.forEach(node => {
    const row = rows[node.level] || [];
    node.shapeKind = shapeFor(node.shape);
    node.width = measureWidth(node.label);
    row.push(node);
    rows[node.level] = row;
  });

  // Compute absolute positions.
  let y = PADDING_Y;
  let maxW = 0;
  rows.forEach(row => {
    let rowW = 0;
    row.forEach(n => {
      rowW += n.width + 12;
    });
    rowW -= 12;
    maxW = Math.max(maxW, rowW);
    row.forEach(node => {
      node.y = y;
      node.cy = y + NODE_H / 2;
    });
    y += NODE_H + ROW_GAP;
  });
  const svgW = PADDING_X * 2 + maxW;
  const svgH = y - ROW_GAP + PADDING_Y;

  // Re-center rows now that maxW is known.
  rows.forEach(row => {
    const rowW = row.reduce((a, n) => a + n.width + 12, -12);
    let x = PADDING_X + (svgW - PADDING_X * 2 - rowW) / 2;
    row.forEach(node => {
      node.x = x;
      node.cx = x + node.width / 2;
      x += node.width + 12;
    });
  });

  const nodeSvg = [];
  byId.forEach(node => {
    nodeSvg.push(`
      <g class="viz-flow-node ${node.shapeKind === 'diamond' ? 'is-decision' : ''} ${node.level === 0 ? 'is-start' : ''}">
        ${renderNodeShape(node, node.x, node.y, node.width)}
        <text x="${node.cx}" y="${node.cy}" text-anchor="middle" dominant-baseline="central">${escapeAttr(node.label)}</text>
      </g>
    `);
  });

  const edgeSvg = rawEdges
    .map(edge => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return '';
      const startY = from.y + NODE_H;
      const endY = to.y;
      const startX = from.cx;
      const endX = to.cx;
      const midY = (startY + endY) / 2;
      const d = `M ${startX} ${startY} C ${startX} ${midY} ${endX} ${midY} ${endX} ${endY}`;
      const labelEl = edge.label
        ? `<text x="${(startX + endX) / 2}" y="${midY - 2}" text-anchor="middle" class="viz-flow-edge-label">${escapeAttr(edge.label)}</text>`
        : '';
      return `
        <g class="viz-flow-edge-group">
          <path d="${d}" fill="none" class="viz-flow-edge" marker-end="url(#viz-flow-arrow)" />
          ${labelEl}
        </g>
      `;
    })
    .join('');

  host.classList.add('viz-card', 'viz-flow-card');
  host.innerHTML = `
    ${renderCardHeader(spec)}
    <div class="viz-flow-scroll">
      <svg viewBox="0 0 ${svgW} ${svgH}" class="viz-flow-svg" width="100%" height="${svgH}">
        <defs>
          <marker id="viz-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 Z" fill="rgba(255,255,255,0.45)" />
          </marker>
        </defs>
        <g class="viz-flow-edges">${edgeSvg}</g>
        <g class="viz-flow-nodes">${nodeSvg.join('')}</g>
      </svg>
    </div>
    ${renderCardFooter(spec)}
  `;
  return { dispose() {} };
}
