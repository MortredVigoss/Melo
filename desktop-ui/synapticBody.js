import * as T from 'three';

// The actor uses the same open network language as the surrounding scene:
// thin violet connections and small glowing junctions, without a solid surface.
const dendrites = [
  { angle: -.18, length: 54, bend: .22, depth: 6 },
  { angle: .72, length: 40, bend: -.20, depth: -9 },
  { angle: 1.65, length: 53, bend: .18, depth: 11 },
  { angle: 2.52, length: 43, bend: -.24, depth: -5 },
  { angle: 3.27, length: 50, bend: .21, depth: 8 },
  { angle: 4.16, length: 37, bend: -.26, depth: 12 },
  { angle: 5.25, length: 49, bend: .16, depth: -10 },
];
const clamp = T.MathUtils.clamp;
const mainPoint = (branch, t) => {
  const radius = 9 + (branch.length - 9) * t;
  const angle = branch.angle + branch.bend * Math.sin(t * 2.5);
  return new T.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, branch.depth * t);
};
const paths = dendrites.flatMap((branch, arm) => {
  const main = Array.from({ length: 13 }, (_, i) => mainPoint(branch, i / 12));
  const branches = [-1, 1].map((direction, index) => {
    const start = mainPoint(branch, .67);
    const end = mainPoint(branch, .91);
    const angle = branch.angle + direction * (.35 + (arm % 3) * .06);
    end.add(new T.Vector3(Math.cos(angle) * 13, Math.sin(angle) * 13, direction * 5));
    const side = new T.Vector3(-Math.sin(branch.angle), Math.cos(branch.angle), .16);
    end.addScaledVector(side, direction * (11 + arm % 2 * 3));
    const control = start.clone().lerp(end, .48).addScaledVector(side, direction * 4);
    const curve = new T.QuadraticBezierCurve3(start, control, end);
    return { arm, fork: true, points: curve.getPoints(8), tip: index };
  });
  // Some dendrites end in a bifurcation, others retain a third short terminal.
  return [{ arm, fork: false, points: arm % 2 ? main.slice(0, 11) : main }, ...branches];
});
// Deterministic central junctions connect to the dendrites in real 3D space.
const junctions = Array.from({ length: 30 }, (_, i) => {
  const angle = i * 2.399963, z = 1 - 2 * (i + .5) / 30;
  const radius = 8 + (i * 7 % 11) * .8;
  const ring = Math.sqrt(1 - z * z);
  return new T.Vector3(Math.cos(angle) * radius * ring, Math.sin(angle) * radius * ring * .82, z * radius * .65);
});
const threads = [], branches = [], nodes = [];
const segment = (array, a, b) => array.push(...a.toArray(), ...b.toArray());
junctions.forEach((point, i) => {
  nodes.push(...point.toArray());
  junctions.map((other, j) => ({ other, j, distance: point.distanceToSquared(other) }))
    .filter(item => item.j > i).sort((a, b) => a.distance - b.distance).slice(0, 2)
    .forEach(({ other }) => segment(threads, point, other));
});
for (const path of paths) {
  const points = path.points;
  for (let i = 0; i < points.length - 1; i++) segment(branches, points[i], points[i + 1]);
  if (!path.fork) {
    const nearest = [...junctions].sort((a, b) => a.distanceToSquared(points[0]) - b.distanceToSquared(points[0]))[0];
    segment(branches, nearest, points[0]);
    // A faint neighboring strand gives depth without turning a branch into a tube.
    const strand = points.map((point, i) => point.clone().add(new T.Vector3(
      Math.sin(i * .9 + path.arm) * 1.8, Math.cos(i * .7 + path.arm) * 1.4, 1.8)));
    for (let i = 0; i < strand.length - 1; i++) segment(threads, strand[i], strand[i + 1]);
    for (const i of [4, 8]) nodes.push(...points[i].toArray());
  }
  nodes.push(...points.at(-1).toArray());
}
function makeWeights(positions) {
  const weights = new Float32Array(positions.length / 3 * 2);
  for (let i = 0; i < positions.length; i += 3) {
    const theta = Math.atan2(positions[i + 1], positions[i]);
    let arm = 0, best = Infinity;
    dendrites.forEach((branch, j) => {
      const distance = Math.abs(Math.atan2(Math.sin(theta - branch.angle), Math.cos(theta - branch.angle)));
      if (distance < best) { best = distance; arm = j; }
    });
    weights[i / 3 * 2] = arm;
    weights[i / 3 * 2 + 1] = clamp((Math.hypot(positions[i], positions[i + 1]) - 12) / 40, 0, 1);
  }
  return weights;
}
// A slow lift and return travels through non-adjacent arms. Successive strokes
// overlap briefly, so only one or two fingertips move while the body rests.
export function synapticStrokes(time) {
  const order = [0, 3, 6, 2, 5, 1, 4], step = 3.6, duration = 4.7, period = step * order.length;
  const strokes = new Array(dendrites.length).fill(0);
  order.forEach((arm, index) => {
    const age = ((time - index * step) % period + period) % period;
    if (age < duration) strokes[arm] = Math.sin(Math.PI * age / duration) ** 2;
  });
  return strokes;
}
function warp(rest, weights, output, motion, strokes) {
  for (let i = 0; i < rest.length; i += 3) {
    const arm = weights[i / 3 * 2], reach = weights[i / 3 * 2 + 1];
    const m = motion[arm];
    // Keep roots and central junctions anchored; curl only the distal branch.
    const tip = clamp((reach - .28) / .72, 0, 1) ** 2;
    const stroke = strokes[arm] * tip;
    const angle = m.bend * reach * reach + stroke * .105;
    const scale = 1 + m.stretch * reach - stroke * .035;
    const c = Math.cos(angle), s = Math.sin(angle);
    output[i] = (rest[i] * c - rest[i + 1] * s) * scale;
    output[i + 1] = (rest[i] * s + rest[i + 1] * c) * scale;
    output[i + 2] = rest[i + 2] + m.lift * reach * reach + stroke * 14;
  }
}
function executionMotion(phase) {
  return dendrites.map((_, i) => ({
    stretch: Math.sin(phase * 1.45 + i * 1.77) * .105,
    bend: Math.sin(phase * 1.1 + i * 2.2) * .12,
    lift: Math.max(0, Math.sin(phase * 1.45 + i * 1.77)) * 5,
  }));
}

export function createSynapticBody() {
  const body = new T.Group(), layers = [];
  function geometryFor(rest) {
    const geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.Float32BufferAttribute(rest, 3).setUsage(T.DynamicDrawUsage));
    geometry.boundingSphere = new T.Sphere(new T.Vector3(), 90);
    layers.push({ geometry, rest, weights: makeWeights(rest) });
    return geometry;
  }
  const threadMaterial = new T.LineBasicMaterial({ color: '#76419d', transparent: true, opacity: .38,
    depthWrite: false, blending: T.AdditiveBlending });
  const branchMaterial = new T.LineBasicMaterial({ color: '#9a65d3', transparent: true, opacity: .82,
    depthWrite: false, blending: T.AdditiveBlending });
  body.add(new T.LineSegments(geometryFor(threads), threadMaterial));
  body.add(new T.LineSegments(geometryFor(branches), branchMaterial));
  // Soft point falloff creates local violet light without a filled body or a
  // full-scene bloom pass. The low-alpha halo leaves background threads visible.
  const glowMaterial = new T.ShaderMaterial({
    uniforms: { tint: { value: new T.Color('#a66ad7') }, intensity: { value: .7 } },
    transparent: true, depthWrite: false, blending: T.AdditiveBlending,
    vertexShader: `
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewPosition;
        gl_PointSize = clamp(9.0 * (300.0 / -viewPosition.z), 2.0, 14.0);
      }`,
    fragmentShader: `
      uniform vec3 tint;
      uniform float intensity;
      void main() {
        float radius = length(gl_PointCoord - vec2(0.5)) * 2.0;
        float light = exp(-radius * radius * 9.0) * 0.42 + exp(-radius * radius * 40.0) * 0.58;
        gl_FragColor = vec4(tint, light * intensity * (1.0 - smoothstep(0.65, 1.0, radius)));
      }`,
  });
  body.add(new T.Points(geometryFor(nodes), glowMaterial));
  let lastPhase = NaN, lastAmbientTime = NaN, posturePhase = NaN, wasActive = false;
  function update(phase, ambientTime = 0, active = false) {
    // Execution still owns travel and the overall pose. A separate ambient
    // clock strokes one/two tips even after arrival or completion; a paused
    // clock (hidden/reduced motion) does not upload new geometry.
    // Hold the branch posture during a stay in this region. Execution can move
    // the whole actor, but must not make every arm wave together while dwelling.
    if (!active || !wasActive || !Number.isFinite(posturePhase)) posturePhase = phase;
    wasActive = active;
    if (posturePhase !== lastPhase || ambientTime !== lastAmbientTime) {
      lastPhase = posturePhase; lastAmbientTime = ambientTime;
      const motion = executionMotion(posturePhase), strokes = synapticStrokes(ambientTime);
      for (const { geometry, rest, weights } of layers) {
        warp(rest, weights, geometry.attributes.position.array, motion, strokes);
        geometry.attributes.position.needsUpdate = true;
      }
    }
    const pulse = .5 + .5 * Math.sin(ambientTime * (active ? 2.7 : .8));
    branchMaterial.opacity = (active ? .85 : .66) + pulse * .12;
    threadMaterial.opacity = (active ? .39 : .27) + pulse * .09;
    glowMaterial.uniforms.intensity.value = (active ? .78 : .54) + pulse * .16;
  }
  update(0);
  return { body, update, dispose() {
    for (const { geometry } of layers) geometry.dispose();
    for (const material of [threadMaterial, branchMaterial, glowMaterial]) material.dispose();
  } };
}
