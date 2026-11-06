// Neural clusters: the five regions drawn the way Melo's task space drew
// them before layout A (210 nodes per module) — nodes in a flattened ellipsoidal
// shell, each tied to its two nearest neighbours by faint strands, signals
// running along the strands, all in the module's own colour. Refined here:
// more nodes, ganglia that gather them into structure, now and then a third
// strand, a few of the best-connected nodes drawn as larger hubs, fine dust fills
// the volume, and the web answers what touches it: the strands under a
// spider's feet light up, every footfall plucks its strand and sends a pulse
// both ways along it, and a bite flares the node under the claw.
import * as T from 'three';
import { rng, Cloud, particleMaterial } from './warRoomParticles.js';

const TAU = Math.PI * 2;
const gauss = r => (r() + r() + r() + r() - 2) / .577;
const clamp01 = x => Math.min(1, Math.max(0, x));
// Melo's module shell: radius 26–83 about the depth axis, .77 as tall, 70 deep.
export const SHELL = new T.Vector3(83, 64, 70);

const NODE_VERT = /* glsl */`
uniform float uTime;
uniform float uPixel;
uniform float uActivity;
uniform vec3 uColor;
attribute float aSize;
attribute float aSeed;
attribute float aGlow;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float twinkle = 0.75 + 0.25 * sin(uTime * (0.7 + fract(aSeed * 13.7) * 2.2) + aSeed * 61.0);
  float dist = max(1.0, -mv.z);
  // Same rule as the particle clouds: never smaller than 2.5 px, dimmed by the area it gained.
  float size = aSize * uPixel * (430.0 / dist) * (0.85 + 0.3 * twinkle) * (1.0 + aGlow * 0.7);
  float drawn = clamp(size, 2.5, 60.0 * uPixel);
  gl_PointSize = drawn;
  vColor = mix(uColor, vec3(1.0), 0.12 + aGlow * 0.4) * (0.42 + 0.32 * twinkle + uActivity * 0.35 + aGlow * 1.5);
  vAlpha = min(1.0, (size * size) / (drawn * drawn)) * clamp(1.0 - (dist - 2800.0) / 2400.0, 0.0, 1.0);
}`;
const NODE_FRAG = /* glsl */`
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = dot(q, q);
  if (d > 1.0) discard;
  gl_FragColor = vec4(vColor, (exp(-d * 4.5) * 0.5 + exp(-d * 24.0) * 0.95) * vAlpha);
}`;

export function neuralCluster({ color, seed, nodes: N, dust: D, ganglia = 7, sprite }) {
  const r = rng(seed), group = new T.Group(), tint = new T.Color(color);
  // Ganglia: knots inside the shell that gather nodes around them.
  const knots = Array.from({ length: ganglia }, () => {
    const a = r() * TAU, u = r() * 1.6 - .8, s = Math.sqrt(1 - u * u), k = .45 + .4 * r();
    return new T.Vector3(Math.cos(a) * s * SHELL.x * k, Math.sin(a) * s * SHELL.y * k, u * SHELL.z * k);
  });
  const P = [];
  for (let i = 0; i < N; i++) {
    if (r() < .6) { const a = r() * TAU, z = r() * 2 - 1, rad = Math.sqrt(1 - z * z) * (26 + r() * 57); P.push(new T.Vector3(Math.cos(a) * rad, Math.sin(a) * rad * .77, z * 70)); }
    else { const k = knots[Math.floor(r() * knots.length)], s = 7 + r() * 9; P.push(new T.Vector3(k.x + gauss(r) * s, k.y + gauss(r) * s * .85, k.z + gauss(r) * s)); }
  }
  // Strands: as in Melo, each node to its two nearest within reach (40 among
  // 210 nodes; the reach shrinks with the cube root of the density), and to a
  // third now and then.
  const reach = 40 * Math.cbrt(210 / N) * 1.15, reach2 = reach * reach, seen = new Set(), edges = [];
  const link = (i, j) => { const a = Math.min(i, j), b = Math.max(i, j), key = a * N + b; if (a === b || seen.has(key)) return; seen.add(key); edges.push(a, b); };
  for (let i = 0; i < N; i++) {
    let d0 = 1e9, d1 = 1e9, d2 = 1e9, j0 = -1, j1 = -1, j2 = -1; const p = P[i];
    for (let j = 0; j < N; j++) {
      if (j === i) continue; const d = p.distanceToSquared(P[j]);
      if (d < d2) { if (d < d1) { if (d < d0) { d2 = d1; j2 = j1; d1 = d0; j1 = j0; d0 = d; j0 = j; } else { d2 = d1; j2 = j1; d1 = d; j1 = j; } } else { d2 = d; j2 = j; } }
    }
    if (d0 < reach2) link(i, j0); if (d1 < reach2) link(i, j1); if (d2 < reach2 && r() < .35) link(i, j2);
  }
  const nearestTo = v => { let b = 0, bd = 1e9; for (let i = 0; i < N; i++) { const d = P[i].distanceToSquared(v); if (d < bd) { bd = d; b = i; } } return b; };
  const hubs = knots.map(nearestTo);
  const E = edges.length / 2, adj = Array.from({ length: N }, () => []);
  for (let e = 0; e < E; e++) { adj[edges[2 * e]].push(e); adj[edges[2 * e + 1]].push(e); }
  const other = (e, n) => edges[2 * e] === n ? edges[2 * e + 1] : edges[2 * e];

  // Nodes: the ganglia's centres and the best-connected 2% are hubs, larger
  // and brighter; glow is written by touch(), pluck() and flare().
  const position = new Float32Array(N * 3), size = new Float32Array(N), seeds = new Float32Array(N), glow = new Float32Array(N), hub = new Uint8Array(N);
  hubs.forEach(i => { hub[i] = 1; });
  [...adj.keys()].sort((a, b) => adj[b].length - adj[a].length).slice(0, Math.round(N * .02)).forEach(i => { hub[i] = 1; });
  for (let i = 0; i < N; i++) { position.set([P[i].x, P[i].y, P[i].z], i * 3); size[i] = hub[i] ? 3.6 + r() * 1.8 : 1.3 + r() * 1.2; seeds[i] = r(); }
  const strandGlow = new Float32Array(E);
  const nodeGeometry = new T.BufferGeometry();
  nodeGeometry.setAttribute('position', new T.BufferAttribute(position, 3));
  nodeGeometry.setAttribute('aSize', new T.BufferAttribute(size, 1));
  nodeGeometry.setAttribute('aSeed', new T.BufferAttribute(seeds, 1));
  const glowAttribute = new T.BufferAttribute(glow, 1).setUsage(T.DynamicDrawUsage); nodeGeometry.setAttribute('aGlow', glowAttribute);
  const nodeMaterial = new T.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uPixel: { value: 1 }, uActivity: { value: 0 }, uColor: { value: tint.clone() } },
    vertexShader: NODE_VERT, fragmentShader: NODE_FRAG, transparent: true, depthWrite: false, blending: T.AdditiveBlending });
  const nodePoints = new T.Points(nodeGeometry, nodeMaterial); nodePoints.frustumCulled = false; group.add(nodePoints);

  // Strands: brightness per end, so light spreads along a strand from a lit node.
  const strandPosition = new Float32Array(E * 6), strandColor = new Float32Array(E * 6);
  for (let e = 0; e < E; e++) { const a = P[edges[2 * e]], b = P[edges[2 * e + 1]]; strandPosition.set([a.x, a.y, a.z, b.x, b.y, b.z], e * 6); }
  const strandGeometry = new T.BufferGeometry(); strandGeometry.setAttribute('position', new T.BufferAttribute(strandPosition, 3));
  const colorAttribute = new T.BufferAttribute(strandColor, 3).setUsage(T.DynamicDrawUsage); strandGeometry.setAttribute('color', colorAttribute);
  const strandMaterial = new T.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending });
  const strands = new T.LineSegments(strandGeometry, strandMaterial); strands.frustumCulled = false; group.add(strands);

  // Signals: points running strand to strand through the network.
  const SN = Math.max(24, Math.round(N / 16)), signalPosition = new Float32Array(SN * 3), signalColor = new Float32Array(SN * 3);
  const signals = Array.from({ length: SN }, () => { const e = Math.floor(r() * E); return { e, from: edges[2 * e], t: r(), speed: .6 + r() * .7, boost: 0 }; });
  const signalGeometry = new T.BufferGeometry();
  const signalPositionAttribute = new T.BufferAttribute(signalPosition, 3).setUsage(T.DynamicDrawUsage), signalColorAttribute = new T.BufferAttribute(signalColor, 3).setUsage(T.DynamicDrawUsage);
  signalGeometry.setAttribute('position', signalPositionAttribute); signalGeometry.setAttribute('color', signalColorAttribute);
  const signalMaterial = new T.PointsMaterial({ size: 6, map: sprite, vertexColors: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending });
  const signalPoints = new T.Points(signalGeometry, signalMaterial); signalPoints.frustumCulled = false; group.add(signalPoints);

  // Dust: fine points around the nodes, the volume between the strands.
  const dust = new Cloud();
  for (let i = 0; i < D; i++) { const v = P[Math.floor(r() * N)], s = 3 + r() * 7; dust.add(v.x + gauss(r) * s, v.y + gauss(r) * s * .85, v.z + gauss(r) * s, tint.clone().multiplyScalar(.1 + r() * .2), .8 + r() * .9, r(), 0, 0, 0, .5); }
  const dustMaterial = particleMaterial(); group.add(dust.build(dustMaterial));

  const inverse = new T.Matrix4(), local = new T.Vector3(), turn = new T.Quaternion();
  let lastActivity = -1, warm = true, spark = 0;
  function paint(activity) {
    const base = .085 + activity * .16;
    for (let e = 0; e < E; e++) { const own = strandGlow[e] * 1.1; for (let end = 0; end < 2; end++) {
      const k = base + Math.max(glow[edges[2 * e + end]] * 1.15, own), o = (e * 2 + end) * 3;
      strandColor[o] = tint.r * k; strandColor[o + 1] = tint.g * k; strandColor[o + 2] = tint.b * k;
    } }
    colorAttribute.needsUpdate = true; glowAttribute.needsUpdate = true;
  }
  function update(dt, activity) {
    let lit = false; const fade = Math.exp(-dt * 2.6);
    for (let i = 0; i < N; i++) if (glow[i] > .003) { glow[i] *= fade; lit = true; } else glow[i] = 0;
    for (let e = 0; e < E; e++) if (strandGlow[e] > .003) { strandGlow[e] *= fade; lit = true; } else strandGlow[e] = 0;
    if (lit || warm || Math.abs(activity - lastActivity) > .003) { paint(activity); lastActivity = activity; warm = lit; }
    const pace = .35 + activity * 1.7;
    signals.forEach((s, i) => {
      s.t += dt * s.speed * pace * (s.boost > 0 ? 2.4 : 1); s.boost = Math.max(0, s.boost - dt);
      while (s.t >= 1) { s.t -= 1; const at = other(s.e, s.from), next = adj[at].filter(e => e !== s.e); if (next.length) s.e = next[Math.floor(r() * next.length)]; s.from = at; }
      const a = P[s.from], b = P[other(s.e, s.from)], k = (.32 + activity * .55) * (1 + s.boost * 3.5);
      signalPosition[i * 3] = a.x + (b.x - a.x) * s.t; signalPosition[i * 3 + 1] = a.y + (b.y - a.y) * s.t; signalPosition[i * 3 + 2] = a.z + (b.z - a.z) * s.t;
      signalColor[i * 3] = (tint.r * .65 + .35) * k; signalColor[i * 3 + 1] = (tint.g * .65 + .35) * k; signalColor[i * 3 + 2] = (tint.b * .65 + .35) * k;
    });
    signalPositionAttribute.needsUpdate = true; signalColorAttribute.needsUpdate = true;
  }
  const toLocal = world => { group.updateMatrixWorld(); inverse.copy(group.matrixWorld).invert(); return local.copy(world).applyMatrix4(inverse); };
  // Distance from a local point to strand e, and where along it (0–1) the nearest point lies.
  let along = 0;
  const strandDistance2 = (e, p) => {
    const a = P[edges[2 * e]], b = P[edges[2 * e + 1]], abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z, len = abx * abx + aby * aby + abz * abz || 1;
    along = clamp01(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len);
    return (p.x - a.x - abx * along) ** 2 + (p.y - a.y - aby * along) ** 2 + (p.z - a.z - abz * along) ** 2;
  };
  return {
    group, materials: [nodeMaterial, dustMaterial], radius: Math.max(SHELL.x, SHELL.y, SHELL.z), update,
    /** The nodes in the cluster's own frame (read only): framing uses the outermost. */
    positions: P,
    /** Light the strands these world points rest on (a spider's feet, a claw), and the nodes beside them. */
    touch(points, strength = 1) {
      group.updateMatrixWorld(); inverse.copy(group.matrixWorld).invert(); const R = 4, R2 = R * R;
      for (const p of points) {
        local.copy(p).applyMatrix4(inverse);
        for (let e = 0; e < E; e++) { const d2 = strandDistance2(e, local); if (d2 < R2) { const k = (1 - Math.sqrt(d2) / R) * strength; if (k > strandGlow[e]) strandGlow[e] = k; } }
        for (let i = 0; i < N; i++) { const d2 = P[i].distanceToSquared(local); if (d2 < R2 * 2) { const k = (1 - Math.sqrt(d2 / 2) / R) * strength * .8; if (k > glow[i]) glow[i] = k; } }
      }
    },
    /** A footfall: the strand under it flashes and a pulse runs from the foot to both of its ends. */
    pluck(world, strength = 1.3) {
      const p = toLocal(world); let best = -1, bd = 36, t = 0;
      for (let e = 0; e < E; e++) { const d2 = strandDistance2(e, p); if (d2 < bd) { bd = d2; best = e; t = along; } }
      if (best < 0) return;
      strandGlow[best] = Math.max(strandGlow[best], strength);
      const a = signals[spark++ % SN], b = signals[spark++ % SN];
      Object.assign(a, { e: best, from: edges[2 * best], t, boost: .5 }); Object.assign(b, { e: best, from: edges[2 * best + 1], t: 1 - t, boost: .5 });
    },
    /** A bite: the node flares, its neighbours light, signals run out along its strands. */
    flare(i, strength = 1.8) {
      if (i < 0) return; glow[i] = Math.max(glow[i], strength);
      for (const e of adj[i]) { const j = other(e, i); glow[j] = Math.max(glow[j], strength * .45); }
      adj[i].slice(0, 4).forEach(e => { const s = signals[spark++ % SN]; s.e = e; s.from = i; s.t = 0; s.boost = .7; });
    },
    /** The nearest point on any strand within `max` (world units) of a world point, or null. */
    nearestOnWeb(world, max) {
      const p = toLocal(world), limit = (max / group.scale.x) ** 2; let best = limit, bx = 0, by = 0, bz = 0, found = false;
      for (let e = 0; e < E; e++) {
        const a = P[edges[2 * e]], b = P[edges[2 * e + 1]], abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z, len = abx * abx + aby * aby + abz * abz || 1;
        const t = clamp01(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len), cx = a.x + abx * t, cy = a.y + aby * t, cz = a.z + abz * t;
        const d2 = (p.x - cx) ** 2 + (p.y - cy) ** 2 + (p.z - cz) ** 2; if (d2 < best) { best = d2; bx = cx; by = cy; bz = cz; found = true; }
      }
      return found ? new T.Vector3(bx, by, bz).applyMatrix4(group.matrixWorld) : null;
    },
    /** The node nearest a world point, or -1 if none is within `max` world units. */
    nearestNode(world, max = Infinity) { const p = toLocal(world), limit = max === Infinity ? Infinity : (max / group.scale.x) ** 2; let b = -1, bd = limit; for (let i = 0; i < N; i++) { const d = P[i].distanceToSquared(p); if (d < bd) { bd = d; b = i; } } return b; },
    nodeWorld(i, out) { group.updateMatrixWorld(); return out.copy(P[i]).applyMatrix4(group.matrixWorld); },
    /** A world direction in the cluster's own frame. */
    localDirection(world, out) { return out.copy(world).applyQuaternion(turn.copy(group.quaternion).invert()).normalize(); },
    /** The point `depth` of the way out to the shell along a local direction, and the shell's outward normal there (world). */
    surface(direction, depth, point, normal) {
      const k = depth / Math.sqrt((direction.x / SHELL.x) ** 2 + (direction.y / SHELL.y) ** 2 + (direction.z / SHELL.z) ** 2);
      local.copy(direction).multiplyScalar(k);
      normal.set(local.x / SHELL.x ** 2, local.y / SHELL.y ** 2, local.z / SHELL.z ** 2).normalize().applyQuaternion(group.quaternion);
      group.updateMatrixWorld(); point.copy(local).applyMatrix4(group.matrixWorld);
    },
  };
}
