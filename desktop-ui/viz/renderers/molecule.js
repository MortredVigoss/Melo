// Minimal 2D molecule renderer — atoms at (x, y) positions, bonds as
// single/double/triple lines. No force layout; the spec provides
// absolute coordinates in arbitrary units, which are normalized to fit
// the canvas.
//
// Spec shape:
//   atoms: [{ id, element, x, y, charge? }]
//   bonds: [{ from, to, order?: 1|2|3 }]
import {
  escapeAttr,
  renderCardFooter,
  renderCardHeader,
} from '../vizCommon.js';

const ELEMENT_COLORS = {
  H: '#f0f0f0', C: '#c4c4c4', N: '#6bb0ff', O: '#ff8080',
  F: '#ffe06b', Cl: '#9be88a', Br: '#d8a272', I: '#c18aff',
  P: '#ffaa66', S: '#ffe066', Na: '#c0c0ff', K: '#c0c0ff',
  Fe: '#ff9a66', Mg: '#a3ff9e', Ca: '#d0d0d0',
};

function colorFor(element) {
  return ELEMENT_COLORS[element] || '#d0d0d0';
}

function normalizePositions(atoms, width, height, padding) {
  let xs = atoms.map(a => Number(a.x) || 0);
  let ys = atoms.map(a => Number(a.y) || 0);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min(
    (width - padding * 2) / spanX,
    (height - padding * 2) / spanY,
  );
  const cx = width / 2;
  const cy = height / 2;
  return atoms.map((a, i) => ({
    ...a,
    px: cx + (xs[i] - (minX + maxX) / 2) * scale,
    py: cy + (ys[i] - (minY + maxY) / 2) * scale,
  }));
}

function renderBonds(bonds, atomsByPosition) {
  return bonds
    .map(bond => {
      const a = atomsByPosition.get(bond.from);
      const b = atomsByPosition.get(bond.to);
      if (!a || !b) return '';
      const order = Number(bond.order) === 2 || Number(bond.order) === 3 ? Number(bond.order) : 1;
      const dx = b.px - a.px;
      const dy = b.py - a.py;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const offset = order === 1 ? [0] : order === 2 ? [-3, 3] : [-5, 0, 5];
      return offset
        .map(o => `
          <line
            class="viz-molecule-bond"
            x1="${a.px + nx * o}"
            y1="${a.py + ny * o}"
            x2="${b.px + nx * o}"
            y2="${b.py + ny * o}"
          />
        `)
        .join('');
    })
    .join('');
}

function renderAtoms(atoms) {
  return atoms
    .map(
      atom => `
        <g class="viz-molecule-atom" transform="translate(${atom.px}, ${atom.py})">
          <circle r="14" fill="${colorFor(atom.element)}" />
          <text text-anchor="middle" dominant-baseline="central">${escapeAttr(atom.element)}</text>
          ${atom.charge ? `<text class="viz-molecule-charge" x="14" y="-10">${escapeAttr(atom.charge)}</text>` : ''}
        </g>
      `,
    )
    .join('');
}

export default function mountMolecule(host, spec) {
  const atomsIn = Array.isArray(spec.atoms) ? spec.atoms : [];
  const bondsIn = Array.isArray(spec.bonds) ? spec.bonds : [];
  const WIDTH = 420;
  const HEIGHT = 260;
  const PADDING = 30;
  const atoms = normalizePositions(atomsIn, WIDTH, HEIGHT, PADDING);
  const atomsByPosition = new Map(atoms.map(a => [a.id, a]));

  host.classList.add('viz-card', 'viz-molecule-card');
  host.innerHTML = `
    ${renderCardHeader(spec)}
    <div class="viz-molecule-wrap">
      <svg viewBox="0 0 ${WIDTH} ${HEIGHT}" class="viz-molecule-svg">
        <g class="viz-molecule-bonds">${renderBonds(bondsIn, atomsByPosition)}</g>
        <g class="viz-molecule-atoms">${renderAtoms(atoms)}</g>
      </svg>
    </div>
    ${spec.smiles ? `<div class="viz-readout">SMILES: ${escapeAttr(spec.smiles)}</div>` : ''}
    ${renderCardFooter(spec)}
  `;

  return { dispose() {} };
}
