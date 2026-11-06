// Particle bodies for the war room (layout A, 2026-11-06): the core (the lead agent) and
// the background sky, plus the particle material and cloud builder the
// regions' dust uses (cluster.js). Everything animates on the GPU:
// differential rotation, light flowing along threads, slow drift, with
// per-particle size, colour and twinkle. Colours come from Melo tokens.
//
// Density: `lod` multiplies the particle counts and setLook() sets how fine
// and bright the points are. Each cloud stores its few landmark points first
// and shuffles the rest, so a draw range can thin it evenly on a slow device.
import * as T from 'three';

export const TAU = Math.PI * 2;
export function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const gauss = r => (r() + r() + r() + r() - 2) / .577;
const C = (hex, k = 1) => new T.Color(hex).multiplyScalar(k);
const LOOK = { size: 1, light: 1 };
/** Point size and brightness for the regions and the core built after this call. */
export function setLook({ size = 1, light = 1 } = {}) { LOOK.size = size; LOOK.light = light; }

const VERT = /* glsl */`
uniform float uTime;
uniform float uPixel;
uniform float uActivity;
attribute vec3 aColor;
attribute float aSize;
attribute float aSeed;
attribute vec4 aMotion; // x spin (rad/s about local Y), y flow frequency, z expansion speed, w drift
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec3 p = position;
  float alpha = 1.0;
  if (aMotion.z > 0.0) {
    float k = fract(uTime * aMotion.z + aSeed * 7.13);
    p = position * (0.3 + 0.95 * k);
    alpha = smoothstep(0.0, 0.12, k) * (1.0 - smoothstep(0.62, 1.0, k));
  }
  float ang = uTime * aMotion.x * (1.0 + uActivity * 1.4);
  float c = cos(ang), s = sin(ang);
  p.xz = vec2(c * p.x - s * p.z, s * p.x + c * p.z);
  if (aMotion.w > 0.0) p += aMotion.w * vec3(sin(uTime * 0.37 + aSeed * 41.0), cos(uTime * 0.29 + aSeed * 23.0), sin(uTime * 0.33 + aSeed * 13.0));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float twinkle = 0.72 + 0.28 * sin(uTime * (0.8 + fract(aSeed * 13.7) * 2.6) + aSeed * 61.0);
  float flow = 1.0;
  if (aMotion.y > 0.0) flow = 0.32 + 1.35 * pow(0.5 + 0.5 * sin(aSeed * aMotion.y - uTime * (1.8 + uActivity * 2.6)), 8.0);
  float dist = max(1.0, -mv.z);
  // A point smaller than a few pixels still rasterises as whole pixels, so
  // drawn as is it would come out many times too bright (and brighter the
  // lower the screen's pixel density). Draw it at least 2.5 px and dim it by
  // the area it gained: its light stays the same at any distance or density.
  float size = aSize * uPixel * (430.0 / dist) * (0.8 + 0.35 * twinkle);
  float drawn = clamp(size, 2.5, 70.0 * uPixel);
  gl_PointSize = drawn;
  vColor = aColor * twinkle * flow * (1.0 + uActivity * 0.55);
  vAlpha = alpha * clamp(1.0 - (dist - 2800.0) / 2400.0, 0.0, 1.0) * min(1.0, (size * size) / (drawn * drawn));
}`;
const FRAG = /* glsl */`
uniform float uOpacity;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = dot(q, q);
  if (d > 1.0) discard;
  float a = exp(-d * 4.5) * 0.5 + exp(-d * 24.0) * 0.95;
  gl_FragColor = vec4(vColor, a * vAlpha * uOpacity);
}`;
export function particleMaterial(opacity = 1) {
  return new T.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uPixel: { value: 1 }, uActivity: { value: 0 }, uOpacity: { value: opacity } },
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: T.AdditiveBlending });
}

export class Cloud {
  constructor(look = LOOK) { this.look = look; this.pos = []; this.col = []; this.size = []; this.seed = []; this.motion = []; this.kept = []; this.landmark = false; }
  add(x, y, z, color, size, seed, spin = 0, flow = 0, expand = 0, drift = 0) {
    if (this.landmark) this.kept.push(this.size.length);
    const k = this.look.light;
    this.pos.push(x, y, z); this.col.push(color.r * k, color.g * k, color.b * k); this.size.push(size * this.look.size); this.seed.push(seed); this.motion.push(spin, flow, expand, drift);
  }
  /** Points added inside `fn` are never thinned away (white dwarfs, bright knots, hearts). */
  landmarks(fn) { this.landmark = true; fn(); this.landmark = false; }
  build(material) {
    const n = this.size.length, kept = new Set(this.kept), rest = [];
    for (let i = 0; i < n; i++) if (!kept.has(i)) rest.push(i);
    const r = rng(n * 31 + 7);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)), s = rest[i]; rest[i] = rest[j]; rest[j] = s; }
    const order = [...this.kept, ...rest];
    const take = (src, w) => { const out = new Float32Array(n * w); for (let to = 0; to < n; to++) { const from = order[to] * w; for (let c = 0; c < w; c++) out[to * w + c] = src[from + c]; } return out; };
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(take(this.pos, 3), 3));
    g.setAttribute('aColor', new T.BufferAttribute(take(this.col, 3), 3));
    g.setAttribute('aSize', new T.BufferAttribute(take(this.size, 1), 1));
    g.setAttribute('aSeed', new T.BufferAttribute(take(this.seed, 1), 1));
    g.setAttribute('aMotion', new T.BufferAttribute(take(this.motion, 4), 4));
    const points = new T.Points(g, material); points.frustumCulled = false;
    points.userData.kept = this.kept.length; points.userData.total = n; return points;
  }
  get count() { return this.size.length; }
}
const region = (group, materials, radius) => ({ group, materials, radius, spinners: [] });

// 星核 — the lead agent: luminous ribbons on torus-knot paths, each turning on
// its own axis with light flowing along it, around a white-gold heart.
export function leadCore(t, lod) {
  const r = rng(606), m = particleMaterial(), g = new T.Group(), out = region(g, [m], 120);
  const hot = C(t.hot), gold = C(t.goldBright);
  const knots = [[2, 3], [3, 2], [2, 5], [3, 4], [1, 4], [3, 5], [2, 7], [4, 3]];
  for (let k = 0; k < 16; k++) {
    const [p, q] = knots[k % knots.length], R = 62 + r() * 26, rr = 12 + r() * 16, ribbon = new Cloud(), n = Math.round(900 * lod);
    for (let j = 0; j < n; j++) {
      const s = j / n, f = s * TAU, x = (R + rr * Math.cos(q * f)) * Math.cos(p * f), y = rr * Math.sin(q * f), z = (R + rr * Math.cos(q * f)) * Math.sin(p * f);
      ribbon.add(x + gauss(r), y + gauss(r), z + gauss(r), hot.clone().lerp(gold, r() * .4).multiplyScalar(.6 + r() * .45), 1 + r() * .8, s, 0, TAU * 4);
    }
    const points = ribbon.build(m); points.rotation.set(r() * Math.PI, r() * Math.PI, r() * Math.PI); g.add(points);
    out.spinners.push({ object: points, axis: new T.Vector3(gauss(r), gauss(r), gauss(r)).normalize(), speed: (.05 + r() * .12) * (k % 2 ? 1 : -1) });
  }
  const heart = new Cloud();
  for (let i = 0; i < 1800 * lod; i++) { const rad = Math.abs(gauss(r)) * 9, a = r() * TAU, u = r() * 2 - 1, s = Math.sqrt(1 - u * u); heart.add(rad * s * Math.cos(a), rad * u, rad * s * Math.sin(a), hot.clone().lerp(gold, .2).multiplyScalar(Math.max(.2, .8 - rad / 50)), 1.2 + r() * 1.1, r(), .25); }
  heart.landmarks(() => heart.add(0, 0, 0, hot.clone().multiplyScalar(1.5), 20, .3));
  g.add(heart.build(m));
  return out;
}

// Background: far stars and near dust for parallax, at their own fixed look.
export function deepSpace(t, lod, softSprite) {
  const r = rng(707), g = new T.Group(), plain = { size: 1, light: 1 }, far = new Cloud(plain), dust = new Cloud(plain), m = particleMaterial(), md = particleMaterial(.9);
  const palette = [C(t.hot, 1.3), C(t.blue, 1.4), C(t.goldBright, 1.2), C(t.hot, 1.7)];
  // Pure black sky: small sharp stars (a few brighter), and dust so faint it
  // only shows as parallax when the camera moves. No coloured haze.
  for (let i = 0; i < 5200 * lod; i++) { const d = new T.Vector3(gauss(r), gauss(r), gauss(r)).normalize().multiplyScalar(2500 + r() * 800), bright = r() < .06; far.add(d.x, d.y, d.z, palette[Math.floor(r() * palette.length)].clone().multiplyScalar(bright ? .9 : .25 + r() * .35), bright ? 9 + r() * 6 : 3 + r() * 4, r()); }
  for (let i = 0; i < 1500 * lod; i++) dust.add((r() - .5) * 2400, (r() - .5) * 1600, (r() - .5) * 2400, C(t.hot, .05), .8 + r() * .5, r(), 0, 0, 0, 6);
  g.add(far.build(m), dust.build(md));
  return region(g, [m, md], 0);
}
