// A slowly turning spiral galaxy behind the working panel (the right-hand
// .neural-dashboard.workspace), so the panel belongs to the same night sky as
// the neural field instead of sitting on it as a flat block. The galaxy is
// drawn once per launch into an image; galaxyBackdrop.css turns it with a
// compositor-only rotation and stops it in still mode / reduced motion.

// Palette of the neural field's module nodes (gold, rose, violet, teal) plus
// warm white, so the galaxy reads as part of the same sky.
const PALETTE = [[255, 238, 210], [214, 170, 110], [196, 120, 140], [169, 139, 217], [127, 179, 200]];

// Deterministic so the sky looks the same on every launch (and in tests).
function seeded(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A bright centre and one outer ring of stars (user request 2026-10-21), with
// a quiet gap between them and a sparse halo, in unit coordinates (-1…1).
// Pure: no DOM.
export const RING_RADIUS = 0.62;
export function galaxyParticles({ seed = 20261021, count = 19000 } = {}) {
  const random = seeded(seed);
  const gauss = () => (random() + random() + random() - 1.5) / 1.5;
  const points = [];
  for (let index = 0; index < count; index += 1) {
    const kind = random();
    const angle = random() * Math.PI * 2;
    let radius, part;
    if (kind < 0.26) {
      // Centre: dense and warm, thinning outward.
      radius = Math.abs(gauss()) * 0.17; part = 'core';
    } else if (kind < 0.72) {
      // Outer ring: a soft band, slightly uneven so it reads as stars, not a line.
      radius = RING_RADIUS + gauss() * (0.055 + 0.02 * Math.sin(angle * 3)); part = 'ring';
    } else {
      // Field: faint stars spread evenly over the whole disc, so the gap between
      // centre and ring and the space outside it are not empty.
      radius = Math.sqrt(random()); part = 'halo';
    }
    radius = Math.min(Math.abs(radius), 1);
    const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius * (part === 'halo' ? 1 : 0.9);
    const tone = part === 'core' ? (random() < 0.75 ? 0 : 1) : 1 + Math.floor(random() * (PALETTE.length - 1));
    const size = part === 'core' ? 0.3 + random() * 0.9 : part === 'ring' ? 0.3 + random() * 0.85 : 0.45 + random() * 0.75;
    const alpha = part === 'core' ? 0.2 + random() * 0.45 : part === 'ring' ? 0.14 + random() * 0.4 : 0.3 + random() * 0.45;
    points.push({ x, y, size, alpha, color: PALETTE[tone], part });
  }
  return points;
}

// Draws the galaxy (centre + ring) into a square canvas and returns a data URL (browser only).
export function drawGalaxy(documentRef = document, size = 1400) {
  const canvas = documentRef.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const center = size / 2;
  // Soft core glow and arm dust under the stars.
  const glow = context.createRadialGradient(center, center, 0, center, center, size * 0.5);
  glow.addColorStop(0, 'rgba(255,232,196,0.22)');
  glow.addColorStop(0.08, 'rgba(214,170,110,0.1)');
  glow.addColorStop(0.2, 'rgba(0,0,0,0)');
  glow.addColorStop(RING_RADIUS * 0.96 - 0.06, 'rgba(0,0,0,0)');
  glow.addColorStop(RING_RADIUS * 0.96, 'rgba(169,139,217,0.045)');
  glow.addColorStop(RING_RADIUS * 0.96 + 0.06, 'rgba(0,0,0,0)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, size, size);
  context.globalCompositeOperation = 'lighter';
  for (const point of galaxyParticles()) {
    const [r, g, b] = point.color;
    context.fillStyle = `rgba(${r},${g},${b},${Math.min(1, point.alpha).toFixed(3)})`;
    context.beginPath();
    context.arc(center + point.x * center * 0.96, center + point.y * center * 0.96, point.size, 0, Math.PI * 2);
    context.fill();
  }
  return canvas.toDataURL('image/png');
}

// Once per launch, off the critical path: the panel shows its plain surface
// until the image is ready, then the galaxy fades in (see the CSS).
export function installGalaxyBackdrop(documentRef = document) {
  const root = documentRef.documentElement;
  if (!root || root.style.getPropertyValue('--melo-galaxy')) return;
  const paint = () => {
    try {
      const url = drawGalaxy(documentRef);
      if (url) { root.style.setProperty('--melo-galaxy', `url("${url}")`); root.dataset.meloGalaxy = 'ready'; }
    } catch { /* Decoration only: the plain surface stays. */ }
  };
  const idle = globalThis.requestIdleCallback;
  if (typeof idle === 'function') idle(paint, { timeout: 1500 }); else setTimeout(paint, 300);
}

if (typeof document !== 'undefined') installGalaxyBackdrop(document);
