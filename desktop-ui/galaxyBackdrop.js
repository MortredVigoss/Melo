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

// Points of a two-armed logarithmic spiral with a bright core and a faint
// scattered halo, in unit coordinates (-1…1). Pure: no DOM.
export function galaxyParticles({ seed = 20261021, count = 5200, arms = 2, twist = 2.6 } = {}) {
  const random = seeded(seed);
  const gauss = () => (random() + random() + random() - 1.5) / 1.5;
  const points = [];
  for (let index = 0; index < count; index += 1) {
    const kind = random();
    let x, y, radius;
    if (kind < 0.16) {
      // Core: dense, warm.
      radius = Math.abs(gauss()) * 0.16;
      const angle = random() * Math.PI * 2;
      x = Math.cos(angle) * radius; y = Math.sin(angle) * radius * 0.82;
    } else if (kind < 0.84) {
      // Arms: logarithmic spiral with spread growing outward.
      radius = 0.08 + Math.pow(random(), 0.8) * 0.9;
      const arm = Math.floor(random() * arms);
      const angle = arm * (Math.PI * 2 / arms) + Math.log(1 + radius * 6) * twist + gauss() * (0.16 + radius * 0.22);
      x = Math.cos(angle) * radius; y = Math.sin(angle) * radius * 0.82;
    } else {
      // Halo: sparse field stars.
      radius = Math.sqrt(random());
      const angle = random() * Math.PI * 2;
      x = Math.cos(angle) * radius; y = Math.sin(angle) * radius;
    }
    const near = Math.max(0, 1 - radius);
    const tone = radius < 0.2 ? (random() < 0.7 ? 0 : 1) : 1 + Math.floor(random() * (PALETTE.length - 1));
    points.push({ x, y, size: 0.35 + random() * (kind < 0.84 ? 1.1 : 0.7) + near * 0.4, alpha: 0.18 + random() * 0.5 + near * 0.25, color: PALETTE[tone] });
  }
  return points;
}

// Draws the galaxy into a square canvas and returns a data URL (browser only).
export function drawGalaxy(documentRef = document, size = 1400) {
  const canvas = documentRef.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const center = size / 2;
  // Soft core glow and arm dust under the stars.
  const glow = context.createRadialGradient(center, center, 0, center, center, size * 0.42);
  glow.addColorStop(0, 'rgba(255,232,196,0.34)');
  glow.addColorStop(0.08, 'rgba(214,170,110,0.18)');
  glow.addColorStop(0.3, 'rgba(150,120,190,0.06)');
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
