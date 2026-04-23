// Flowchart renderer — sequential steps with arrows.
// Shape: nodes: [{id, label, shape?: 'rect'|'diamond'|'ellipse'}], edges: [{from, to, label?}]
// Layout: simple topological sort → stacked rows, one step per row.
// If the graph has cycles, falls back to insertion order.
import { escapeAttr, renderCardFooter, renderCardHeader } from '../vizCommon.js';

const NODE_H = 40;
const ROW_GAP = 28;
const PADDING_X = 30;
const PADDING_Y = 20;
const MIN_NODE_W = 100;
const MAX_NODE_W = 260;
const CHAR_W = 7;

function layoutNodes(nodes, edges) {
  const byId = new Map(nodes.map(n => [n.id, { ...n, level: 0 }]));
  const inbound = new Map(nodes.map(n => [n.id, 0]));
  edges.forEach(e => {
    if (byId.has(e.to)) inbound.set(e.to, (inbound.get(e.to) || 0) + 1);
  });
  // Topological-ish: level = max parent level + 1.
  const adj = new Map(nodes.map(n => [n.id, []]));
  edges.forEach(e => {
    if (adj.has(e.from)) adj.get(e.from).push(e.to);
  });
  const queue = nodes.filter(n => (inbound.get(n.id) || 0) === 0).map(n => n.id);
  const seen = new Set(queue);
  while (queue.length) {
    const id = queue.shift();
    const node = byId.get(id);
    for (const nextId of adj.get(id) || []) {
      const next = byId.get(nextId);
      if (!next) continue;
      next.level = Math.max(next.level, node.level + 1);
      if (!seen.has(nextId)) {
        seen.add(nextId);
        queue.push(nextId);
      }
    }
  }
  // Nodes not in any edge fall back to insertion order at the end.
  let fallback = 0;
  byId.forEach(node => {
    if (!seen.has(node.id)) {
      node.level = (nodes.length - 1 - fallback);
      fallback += 1;
    }
  });
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
  const rawEdges = Array.isArray(spec.edges) ? spec.edges : [];
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
    let x = PADDING_X + (maxW - rowW) / 2; // center relative to widest row so far
    row.forEach(node => {
      node.x = x;
      node.y = y;
      node.cx = x + node.width / 2;
      node.cy = y + NODE_H / 2;
      x += node.width + 12;
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
