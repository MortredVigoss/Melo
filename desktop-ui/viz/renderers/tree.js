import { escapeHtml } from '../../i18n.js';
// Tree renderer — SVG hierarchical layout with expand/collapse.
//
// Input spec shape (validated upstream in vizSpec.js):
//   {
//     kind: 'tree',
//     renderer: 'tree',
//     title?: string,
//     nodes: [{ id, label, children?: [ids], note?: string }, ...]
//   }

const LEVEL_GAP = 36;        // vertical distance between parent and child row
const SIBLING_GAP = 12;      // horizontal padding between siblings
const NODE_H = 32;
const MIN_NODE_W = 72;
const CHAR_W = 7;            // rough char width for auto-sizing node boxes
const MAX_NODE_W = 220;
const PADDING_X = 16;
const PADDING_Y = 12;

function buildLookup(nodes) {
  const byId = new Map();
  nodes.forEach(n => byId.set(n.id, { ...n, children: [...(n.children || [])] }));
  // Identify root: first node not referenced as a child of any other.
  const referenced = new Set();
  byId.forEach(n => n.children.forEach(childId => referenced.add(childId)));
  let rootId = null;
  for (const n of byId.values()) {
    if (!referenced.has(n.id)) {
      rootId = n.id;
      break;
    }
  }
  if (!rootId && byId.size) rootId = nodes[0].id;
  return { byId, rootId };
}

function measureLabel(label) {
  const text = String(label || '');
  const raw = MIN_NODE_W + text.length * CHAR_W;
  return Math.min(MAX_NODE_W, Math.max(MIN_NODE_W, raw));
}

function layout(byId, rootId, collapsed) {
  // Post-order walk that assigns each subtree a width (sum of child widths
  // + gaps) and each node an (x, y) centered over its subtree.
  const layoutById = new Map();
  let nextX = PADDING_X;

  function walk(id, depth) {
    const node = byId.get(id);
    if (!node) return null;
    const width = measureLabel(node.label);
    const isCollapsed = collapsed.has(id);
    const childIds = !isCollapsed ? node.children.filter(cid => byId.has(cid)) : [];
    if (!childIds.length) {
      const x = nextX + width / 2;
      nextX += width + SIBLING_GAP;
      const entry = {
        id,
        label: node.label,
        note: node.note,
        x,
        y: PADDING_Y + depth * (NODE_H + LEVEL_GAP) + NODE_H / 2,
        width,
        height: NODE_H,
        hasChildren: Boolean(node.children.length),
        collapsed: isCollapsed,
        depth,
      };
      layoutById.set(id, entry);
      return entry;
    }
    const childEntries = childIds.map(cid => walk(cid, depth + 1)).filter(Boolean);
    const first = childEntries[0];
    const last = childEntries[childEntries.length - 1];
    const centerX = (first.x + last.x) / 2;
    const entry = {
      id,
      label: node.label,
      note: node.note,
      x: centerX,
      y: PADDING_Y + depth * (NODE_H + LEVEL_GAP) + NODE_H / 2,
      width,
      height: NODE_H,
      hasChildren: true,
      collapsed: false,
      depth,
      childIds,
    };
    layoutById.set(id, entry);
    return entry;
  }

  if (rootId) walk(rootId, 0);
  // Compute overall bounding box.
  let maxX = 0;
  let maxY = 0;
  layoutById.forEach(entry => {
    maxX = Math.max(maxX, entry.x + entry.width / 2);
    maxY = Math.max(maxY, entry.y + entry.height / 2);
  });
  const svgW = maxX + PADDING_X;
  const svgH = maxY + PADDING_Y;
  return { layoutById, svgW, svgH };
}

function renderTreeSvg(byId, rootId, collapsed) {
  const { layoutById, svgW, svgH } = layout(byId, rootId, collapsed);
  const edges = [];
  layoutById.forEach(entry => {
    if (!entry.childIds) return;
    entry.childIds.forEach(cid => {
      const child = layoutById.get(cid);
      if (!child) return;
      const y1 = entry.y + entry.height / 2;
      const y2 = child.y - child.height / 2;
      const midY = (y1 + y2) / 2;
      const d = `M ${entry.x} ${y1} C ${entry.x} ${midY} ${child.x} ${midY} ${child.x} ${y2}`;
      edges.push(`<path class="viz-tree-edge" d="${d}" fill="none" />`);
    });
  });

  const nodes = [];
  layoutById.forEach(entry => {
    const x = entry.x - entry.width / 2;
    const y = entry.y - entry.height / 2;
    const isRoot = entry.depth === 0;
    const toggle =
      entry.hasChildren
        ? `<g class="viz-tree-toggle" data-toggle-id="${escapeHtml(entry.id)}"
             transform="translate(${entry.x}, ${y + entry.height + 6})">
             <circle r="7" />
             <text text-anchor="middle" dominant-baseline="central" dy="1">${entry.collapsed ? '+' : '−'}</text>
           </g>`
        : '';
    nodes.push(`
      <g class="viz-tree-node ${isRoot ? 'is-root' : ''}" data-node-id="${escapeHtml(entry.id)}">
        <rect x="${x}" y="${y}" rx="8" ry="8" width="${entry.width}" height="${entry.height}" />
        <text x="${entry.x}" y="${entry.y}" text-anchor="middle" dominant-baseline="central">
          ${escapeHtml(entry.label)}
        </text>
        ${toggle}
      </g>
    `);
  });

  return `
    <svg class="viz-tree-svg" viewBox="0 0 ${svgW} ${svgH}" width="100%" height="${svgH}">
      <g class="viz-tree-edges">${edges.join('')}</g>
      <g class="viz-tree-nodes">${nodes.join('')}</g>
    </svg>
  `;
}

function mountTree(host, spec) {
  const { byId, rootId } = buildLookup(spec.nodes || []);
  const collapsed = new Set();

  host.classList.add('viz-card', 'viz-tree-card');

  function paint() {
    host.innerHTML = `
      ${spec.title ? `<div class="viz-title">${escapeHtml(spec.title)}</div>` : ''}
      <div class="viz-tree-scroll">
        ${renderTreeSvg(byId, rootId, collapsed)}
      </div>
    `;

    host.querySelectorAll('[data-toggle-id]').forEach(node => {
      node.addEventListener('click', event => {
        event.stopPropagation();
        const id = event.currentTarget.dataset.toggleId;
        if (!id) return;
        if (collapsed.has(id)) collapsed.delete(id);
        else collapsed.add(id);
        paint();
      });
    });

    host.querySelectorAll('[data-node-id]').forEach(nodeEl => {
      const id = nodeEl.dataset.nodeId;
      const node = byId.get(id);
      if (!node || !node.note) return;
      nodeEl.addEventListener('mouseenter', () => {
        nodeEl.setAttribute('data-hovering', 'true');
      });
      nodeEl.addEventListener('mouseleave', () => {
        nodeEl.removeAttribute('data-hovering');
      });
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = node.note;
      nodeEl.appendChild(title);
    });
  }

  paint();

  return {
    dispose() {
      // No RAF, nothing to stop.
    },
  };
}


export default mountTree;
