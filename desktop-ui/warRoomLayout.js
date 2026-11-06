// War-room layout and global framing (layout A, 2026-11-06). Pure math on
// plain [x, y, z] arrays, shared by the scene and its tests: where the five
// regions sit around the core, how each is tilted, and the global camera that
// keeps every region's outermost nodes on the stage with room left for their
// labels. Framing real outlines, not a nominal sphere, is the point: a region
// tilted half a radian shows about 40% wider than that sphere and was cut at
// the stage edge.

// Regions are modelled at ~100 units and shown SIZE×; the five sit close
// around the core in a layout shaped like the stage, wide or tall.
export const SIZE = 2.5;
export const LAYOUT = Object.freeze({
  wide: Object.freeze({ search: [-980, 55, 20], files: [0, 280, -370], compute: [-470, -210, 170], tools: [1010, 70, -20], create: [490, -200, 130] }),
  tall: Object.freeze({ search: [-430, 260, 40], files: [0, 720, -300], compute: [-290, -560, 130], tools: [430, 270, -40], create: [290, -550, 110] }),
});
export const WEB = Object.freeze({
  search: Object.freeze({ seed: 11, ganglia: 7, tilt: [.12, .35, 0] }), files: Object.freeze({ seed: 23, ganglia: 6, tilt: [-.1, -.3, .08] }),
  compute: Object.freeze({ seed: 37, ganglia: 8, tilt: [.18, .1, -.12] }), tools: Object.freeze({ seed: 41, ganglia: 6, tilt: [0, .5, .08] }),
  create: Object.freeze({ seed: 53, ganglia: 7, tilt: [-.12, -.2, 0] }),
});
export const layoutFor = aspect => aspect >= 1.1 ? 'wide' : 'tall';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// A region's node as placed in the world, relative to the region's centre:
// rotated by the region's tilt (three's default 'XYZ' Euler order, so the
// rotation is Rx·Ry·Rz) and scaled.
export function placeLocal([x, y, z], [ax, ay, az], scale = 1) {
  const cz = Math.cos(az), sz = Math.sin(az), cy = Math.cos(ay), sy = Math.sin(ay), cx = Math.cos(ax), sx = Math.sin(ax);
  const x1 = x * cz - y * sz, y1 = x * sz + y * cz;
  const x2 = x1 * cy + z * sy, z2 = -x1 * sy + z * cy;
  return [x2 * scale, (y1 * cx - z2 * sx) * scale, (y1 * sx + z2 * cx) * scale];
}

// The nodes that bound a region from every side, pushed out a little so the
// set encloses the whole cloud: for each of `count` evenly spread directions
// the node furthest along it, scaled by `pad` about the region's centre.
// Sampling alone can miss a lone outlying node by a few percent (256
// directions: under 4% on the regions drawn here); the pad covers that.
export function outline(points, { count = 256, pad = 1.05 } = {}) {
  const chosen = new Set(), golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const dy = 1 - (i + .5) * 2 / count, ring = Math.sqrt(1 - dy * dy), dx = Math.cos(i * golden) * ring, dz = Math.sin(i * golden) * ring;
    let best = 0, most = -Infinity;
    for (let j = 0; j < points.length; j++) { const p = points[j], along = p[0] * dx + p[1] * dy + p[2] * dz; if (along > most) { most = along; best = j; } }
    chosen.add(best);
  }
  return [...chosen].map(j => points[j].map(v => v * pad));
}

// Room kept clear on every side of the stage, in pixels, for the labels set
// just outside the outer regions: a share of the stage within fixed bounds.
export const stageMargin = (width, height) => ({ x: clamp(width * .055, 12, 80), y: clamp(height * .07, 10, 44) });

// The global camera. Looking from direction `dir` (unit, aim → eye) with a
// vertical field of view `fov` (degrees), returns the aim and the distance at
// which every point and sphere lies inside the stage less its margin, the
// whole centred on the stage. Larger distances than 9000 are not searched.
export function frameStage({ points, spheres = [], dir, fov, width, height, margin = stageMargin(width, height) }) {
  const tv = Math.tan(fov * Math.PI / 360), th = tv * width / height;
  const limX = Math.max(.2, 1 - 2 * margin.x / width), limY = Math.max(.2, 1 - 2 * margin.y / height);
  // Camera basis as three's lookAt builds it with world up (0, 1, 0).
  const fx = -dir[0], fy = -dir[1], fz = -dir[2], flat = Math.hypot(fx, fz) || 1;
  const rx = -fz / flat, rz = fx / flat, ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  const n = points.length + spheres.length, px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n), pr = new Float64Array(n);
  points.forEach((p, i) => { px[i] = p[0]; py[i] = p[1]; pz[i] = p[2]; });
  spheres.forEach((s, k) => { const i = points.length + k; px[i] = s.c[0]; py[i] = s.c[1]; pz[i] = s.c[2]; pr[i] = s.r; });
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) { x0 = Math.min(x0, px[i] - pr[i]); x1 = Math.max(x1, px[i] + pr[i]); y0 = Math.min(y0, py[i] - pr[i]); y1 = Math.max(y1, py[i] + pr[i]); z0 = Math.min(z0, pz[i] - pr[i]); z1 = Math.max(z1, pz[i] + pr[i]); }
  let tx = n ? (x0 + x1) / 2 : 0, ty = n ? (y0 + y1) / 2 : 0, tz = n ? (z0 + z1) / 2 : 0;
  const fits = d => {
    const ex = tx + dir[0] * d, ey = ty + dir[1] * d, ez = tz + dir[2] * d;
    for (let i = 0; i < n; i++) {
      const vx = px[i] - ex, vy = py[i] - ey, vz = pz[i] - ez, z = vx * fx + vy * fy + vz * fz;
      if (z - pr[i] < 30) return false;
      if ((Math.abs(vx * rx + vz * rz) + pr[i]) / (z * th) > limX || (Math.abs(vx * ux + vy * uy + vz * uz) + pr[i]) / (z * tv) > limY) return false;
    }
    return true;
  };
  const fit = () => { let lo = 150, hi = 9000; for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; } return hi; };
  for (let pass = 0; pass < 3; pass++) {
    const d = fit(), ex = tx + dir[0] * d, ey = ty + dir[1] * d, ez = tz + dir[2] * d;
    let a = Infinity, b = -Infinity, c = Infinity, e = -Infinity;
    for (let i = 0; i < n; i++) {
      const vx = px[i] - ex, vy = py[i] - ey, vz = pz[i] - ez, z = vx * fx + vy * fy + vz * fz;
      const x = (vx * rx + vz * rz) / (z * th), y = (vx * ux + vy * uy + vz * uz) / (z * tv), sx = pr[i] / (z * th), sy = pr[i] / (z * tv);
      a = Math.min(a, x - sx); b = Math.max(b, x + sx); c = Math.min(c, y - sy); e = Math.max(e, y + sy);
    }
    const shiftX = (a + b) / 2 * d * th, shiftY = (c + e) / 2 * d * tv;
    tx += rx * shiftX + ux * shiftY; ty += uy * shiftY; tz += rz * shiftX + uz * shiftY;
  }
  return { target: [tx, ty, tz], distance: fit() };
}

// Where points land on the stage, in pixels, seen from `target` + `dir` ×
// `distance` (the same perspective three's camera applies).
export function projectToStage(points, { target, dir, distance, fov, width, height }) {
  const tv = Math.tan(fov * Math.PI / 360), th = tv * width / height;
  const fx = -dir[0], fy = -dir[1], fz = -dir[2], flat = Math.hypot(fx, fz) || 1;
  const rx = -fz / flat, rz = fx / flat, ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  const ex = target[0] + dir[0] * distance, ey = target[1] + dir[1] * distance, ez = target[2] + dir[2] * distance;
  return points.map(p => {
    const vx = p[0] - ex, vy = p[1] - ey, vz = p[2] - ez, z = vx * fx + vy * fy + vz * fz;
    return [((vx * rx + vz * rz) / (z * th) + 1) / 2 * width, (1 - (vx * ux + vy * uy + vz * uz) / (z * tv)) / 2 * height];
  });
}
