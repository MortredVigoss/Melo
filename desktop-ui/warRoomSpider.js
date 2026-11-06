// Wireframe spider for the war room (layout A, 2026-11-06).
//
// Every agent looks the same: fine low-saturation purple linework (Melo's
// agents colour) over a dark under-stroke, small pale joints, and a soft glow
// inside the abdomen that breathes and brightens with every rake. The form
// follows the reference video's crawler: meshed head and abdomen, eight
// jointed legs with high knees, pedipalps and fangs.
//
// Motion, after the approach of github.com/majidmanzarpour/threejs-procedural-spider
// (MIT; re-implemented here, no code copied): feet are planted in world space
// and only step once the body has moved away from them, in two alternating
// groups of four, and the body rides up while a group swings. Where it stands
// on a web, `foothold` snaps each step onto the nearest strand, and `up` turns
// the body to the web's surface. The caller drives the lifecycle: `grow`
// while it climbs out of or into the core, `crouch` before a leap and on
// landing, `tuck` in flight. dig() runs a lean-in, four alternating rakes of
// the front claws and a final hook that lifts what was dug out.
import * as T from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const TAU = Math.PI * 2, UP = new T.Vector3(0, 1, 0), ZERO = new T.Vector3();
const HEAD = { c: [0, 0, 1.5], r: [2.6, 1.9, 3.0] };
const ABDOMEN = { at: [0, 1.7, -6.1], r: [4.3, 3.5, 5.3] };
// Per side, front to back: hip z on the head, rest angle from forward (deg), reach.
const LEGS = [[2.4, 32, 13.5], [1.6, 66, 11.5], [.8, 106, 11], [0, 146, 13.5]];
const GROUND = -4.6;
const EYES = [[-.5, 1.3, 3.75], [.5, 1.3, 3.75], [-1.05, 1.05, 3.35], [1.05, 1.05, 3.35]];
// Front-claw key poses while digging, in rig space (x mirrors per side).
const CLAW = { ready: [5, -2.2, 15], reach: [3.6, .6, 20.5], strike: [4, -4.2, 18.6], pull: [5.8, -4.4, 12], high: [3.8, 1.6, 19.6], lift: [4.6, 4.8, 15.2] };
// Dig timeline, as fractions of the dig: lean in, four rakes (left, right,
// left, right; each bites at BITE of its stroke), then the hook.
const LEAN = .1, RAKE = .17, RAKES = 4, HOOK = LEAN + RAKE * RAKES, BITE = .52;
// Rig units: how far a planted foot may lag its rest spot before it steps, and how high it lifts.
const STEP = 3.1, LIFT = 2.1;

const clamp01 = x => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const inOut = t => t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const outCubic = t => 1 - (1 - t) ** 3;

// Latitude rings and meridians of an ellipsoid, as line-segment pairs.
function wire(out, c, r, rings, meridians, steps) {
  const at = (v, a) => [c[0] + r[0] * Math.cos(v) * Math.cos(a), c[1] + r[1] * Math.sin(v), c[2] + r[2] * Math.cos(v) * Math.sin(a)];
  for (let i = 1; i <= rings; i++) { const v = -Math.PI / 2 + i * Math.PI / (rings + 1); for (let j = 0; j < steps; j++) out.push(...at(v, j / steps * TAU), ...at(v, (j + 1) / steps * TAU)); }
  const half = Math.round(steps / 2);
  for (let j = 0; j < meridians; j++) { const a = j / meridians * TAU; for (let i = 0; i < half; i++) out.push(...at(-Math.PI / 2 + i / half * Math.PI, a), ...at(-Math.PI / 2 + (i + 1) / half * Math.PI, a)); }
}
const headX = z => { const t = (z - HEAD.c[2]) / HEAD.r[2]; return HEAD.r[0] * Math.sqrt(Math.max(0, 1 - t * t)); };

export function createSpider({ color, glow, shadow, scale = 1, seed = 0, sprite, foothold = null, onStep = null }) {
  const group = new T.Group(), rig = new T.Group(); rig.scale.setScalar(scale); group.add(rig);
  // Drawn after the regions (render order) as plain, non-additive lines over a
  // wider dark under-stroke, so it reads as crisp linework on a bright nebula.
  // The body mesh is drawn dimmer than the legs, or crossing lines bloom together.
  const ink = new LineMaterial({ color, linewidth: 1.3, transparent: true, depthWrite: false });
  const shellInk = new LineMaterial({ color: color.clone().multiplyScalar(.6), linewidth: 1, transparent: true, depthWrite: false });
  const under = new LineMaterial({ color: shadow, linewidth: 4, transparent: true, opacity: .6, depthWrite: false });
  const segments = (array, dynamic, material = ink) => {
    const geometry = new LineSegmentsGeometry(); geometry.setPositions(array instanceof Float32Array ? array : new Float32Array(array));
    const part = new T.Group(), back = new LineSegments2(geometry, under), line = new LineSegments2(geometry, material);
    back.renderOrder = 10; line.renderOrder = 11; if (dynamic) back.frustumCulled = line.frustumCulled = false;
    part.add(back, line); part.geometry = geometry; return part;
  };
  // Head with chelicerae (fangs); the abdomen is its own object so it can breathe.
  const head = []; wire(head, HEAD.c, HEAD.r, 1, 4, 12);
  for (const s of [-1, 1]) head.push(s * .45, -.8, 3.7, s * .3, -1.8, 4.25);
  rig.add(segments(head, false, shellInk));
  const shell = []; wire(shell, [0, 0, 0], ABDOMEN.r, 2, 6, 16);
  const abdomen = segments(shell, false, shellInk); abdomen.position.fromArray(ABDOMEN.at); rig.add(abdomen);
  // Legs (8 × 3 segments) and pedipalps (2 × 2), rewritten in place every frame.
  const limbArray = new Float32Array((8 * 3 + 2 * 2) * 6), limbs = segments(limbArray, true); rig.add(limbs);
  const limbBuffer = limbs.geometry.attributes.instanceStart.data;
  // Pale joints: knees, ankles, feet, palp tips and four eyes.
  const jointArray = new Float32Array((8 * 3 + 2 + EYES.length) * 3), jointGeometry = new T.BufferGeometry();
  jointGeometry.setAttribute('position', new T.BufferAttribute(jointArray, 3));
  const jointMaterial = new T.PointsMaterial({ color: glow, size: .75, map: sprite, transparent: true, depthWrite: false, blending: T.AdditiveBlending });
  const joints = new T.Points(jointGeometry, jointMaterial); joints.frustumCulled = false; joints.renderOrder = 12; rig.add(joints);
  // The glow inside the abdomen: a soft halo under the linework and a small
  // bright heart on top of it, like a lantern in the wire globe.
  const halo = new T.Sprite(new T.SpriteMaterial({ map: sprite, color: glow, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false }));
  const heart = new T.Sprite(halo.material.clone());
  halo.position.set(0, 1.5, -5); halo.scale.setScalar(13); halo.renderOrder = 9;
  heart.position.set(0, 1.6, -5.2); heart.scale.setScalar(4.4); heart.renderOrder = 12;
  rig.add(halo, heart);

  const legs = [];
  for (const s of [-1, 1]) LEGS.forEach(([hz, deg, reach], j) => {
    const a = deg * Math.PI / 180;
    legs.push({ s, j, front: j === 0, set: (j % 2 === 0) === (s < 0) ? 0 : 1,
      hip: new T.Vector3(s * headX(hz) * .92, -.25, hz), rest: new T.Vector3(s * Math.sin(a) * reach, GROUND, hz + Math.cos(a) * reach),
      femur: reach * .6, tibia: reach * .6, tarsus: reach * .17, plant: new T.Vector3(), swing: null, local: new T.Vector3() });
  });
  const claws = { [-1]: legs.find(L => L.front && L.s < 0), [1]: legs.find(L => L.front && L.s > 0) };

  let planted = false, idle = 0, lift = 0, pulse = 0, dig = null, placed = false;
  const lastPos = new T.Vector3(), velocity = new T.Vector3(), bodyUp = new T.Vector3(0, 1, 0);
  // A foot lands on the nearest strand when there is one within reach.
  const grip = p => { const q = foothold && foothold(p); return q ? p.copy(q) : p; };
  const q = new T.Quaternion(), m4 = new T.Matrix4(), v1 = new T.Vector3(), v2 = new T.Vector3(), v3 = new T.Vector3(), dir = new T.Vector3();
  const foot = new T.Vector3(), ankle = new T.Vector3(), knee = new T.Vector3(), outward = new T.Vector3(), pole = new T.Vector3(), tucked = new T.Vector3();
  const base = new T.Vector3(), mid = new T.Vector3(), tip = new T.Vector3(), hint = new T.Vector3();
  let si = 0, ji = 0;
  const seg = (a, b) => { limbArray[si++] = a.x; limbArray[si++] = a.y; limbArray[si++] = a.z; limbArray[si++] = b.x; limbArray[si++] = b.y; limbArray[si++] = b.z; };
  const dot = p => { jointArray[ji++] = p.x; jointArray[ji++] = p.y; jointArray[ji++] = p.z; };

  // Two-bone IK: places the knee so hip→knee→target keeps both bone lengths,
  // bending toward the pole (up and outward, the way spider knees stand high).
  function solve(hip, target, a, b, hint, out) {
    v1.subVectors(target, hip); let length = v1.length();
    const longest = (a + b) * .995, shortest = Math.abs(a - b) + .01;
    if (length > longest) { v1.multiplyScalar(longest / length); target.copy(hip).add(v1); length = longest; }
    length = Math.max(length, shortest); dir.copy(v1).divideScalar(length);
    const along = (a * a - b * b + length * length) / (2 * length), height = Math.sqrt(Math.max(0, a * a - along * along));
    pole.copy(hint).addScaledVector(dir, -hint.dot(dir)).normalize();
    out.copy(hip).addScaledVector(dir, along).addScaledVector(pole, height);
  }
  // Where a foot rests when the body is neutral, in world space.
  const homeOf = (L, out) => group.localToWorld(out.copy(L.rest).multiplyScalar(scale));
  // A planted foot, or one mid-step: an arc from where it stood to its new foothold.
  function footAt(L, out) {
    if (!L.swing) return out.copy(L.plant);
    const s = L.swing, t = clamp01(s.t);
    return out.copy(s.from).lerp(s.to, inOut(t)).addScaledVector(bodyUp, LIFT * scale * Math.sin(Math.PI * t));
  }
  // Two alternating groups: once the group that lags most is past the step
  // distance (or, standing still, still a little off), all of it steps.
  function gait(dt, digging) {
    let swinging = false;
    for (const L of legs) if (L.swing) {
      L.swing.t += dt / L.swing.length;
      if (L.swing.t >= 1) { L.plant.copy(L.swing.to); L.swing = null; onStep?.(L.plant); } else swinging = true;
    }
    const speed = velocity.length(); idle = speed < .5 ? idle + dt : 0;
    if (swinging) return;
    const reach = STEP * scale; let best = -1, need = 0;
    for (const set of [0, 1]) {
      let n = 0; for (const L of legs) if (L.set === set && !(digging && L.front)) n = Math.max(n, L.plant.distanceTo(homeOf(L, v2)));
      if (n > need) { need = n; best = set; }
    }
    if (best < 0 || !(need > reach || (idle > .45 && need > reach * .3))) return;
    const length = Math.max(.16, Math.min(.27, .3 - speed * .005));
    for (const L of legs) if (L.set === best && !(digging && L.front) && L.plant.distanceTo(homeOf(L, v2)) > reach * .12) L.swing = { from: L.plant.clone(), to: grip(homeOf(L, new T.Vector3()).addScaledVector(velocity, length * .5)), t: 0, length };
  }
  // Folded legs in flight; while it climbs out of the core the front claws
  // reach out first and the rest unfold after them.
  function airPose(L, tuck, g, out) {
    tucked.set(L.hip.x + L.s * 3.2, -1.2, L.hip.z + (L.rest.z - L.hip.z) * .3);
    if (g < 1) {
      const e = L.front ? smooth(.05, .5, g) : smooth(.3, 1, g);
      out.copy(L.rest); if (L.front) out.z += 3 * (1 - smooth(.7, 1, g));
      return out.lerp(tucked, 1 - e);
    }
    return out.copy(L.rest).lerp(tucked, Math.min(1, tuck * 1.2));
  }
  const P = (L, name, out) => out.set(L.s * CLAW[name][0], CLAW[name][1], CLAW[name][2]);
  // One rake: reach high into the region, strike down (the bite), drag back low, return.
  function rake(L, u, out) {
    if (u < .38) return P(L, 'ready', out).lerp(P(L, 'reach', v3), outCubic(u / .38));
    if (u < BITE) return P(L, 'reach', out).lerp(P(L, 'strike', v3), ((u - .38) / (BITE - .38)) ** 2);
    if (u < .82) return P(L, 'strike', out).lerp(P(L, 'pull', v3), inOut((u - BITE) / (.82 - BITE)));
    return P(L, 'pull', out).lerp(P(L, 'ready', v3), inOut((u - .82) / .18));
  }
  function clawPose(L, d, out) {
    if (d < LEAN) {
      if (planted) rig.worldToLocal(v2.copy(L.plant)); else v2.copy(L.rest);
      return out.copy(v2).lerp(P(L, 'ready', v3), smooth(0, LEAN, d));
    }
    if (d < HOOK) {
      const x = (d - LEAN) / RAKE, k = Math.min(RAKES - 1, Math.floor(x)), u = x - k;
      // Left on the even rakes, right on the odd ones; the other claw waits raised, twitching.
      if ((k % 2 === 1) !== (L.s > 0)) { P(L, 'ready', out); out.y += .15 * Math.sin(d * 55 + L.s); return out; }
      return rake(L, u, out);
    }
    // The hook: the right claw reaches in once more and lifts the find; the left one sets down.
    const h = (d - HOOK) / (1 - HOOK);
    if (L.s > 0) return h < .4 ? P(L, 'ready', out).lerp(P(L, 'high', v3), outCubic(h / .4)) : P(L, 'high', out).lerp(P(L, 'lift', v3), inOut((h - .4) / .6));
    return P(L, 'ready', out).lerp(v3.copy(L.rest), inOut(h));
  }
  const claw = (side, out = new T.Vector3()) => rig.localToWorld(out.copy(claws[side > 0 ? 1 : -1].local));
  const pullOf = (side, out) => { const L = claws[side > 0 ? 1 : -1]; return rig.localToWorld(out.copy(L.hip)).sub(claw(side, v1)).normalize(); };

  function update(dt, { time = 0, face = null, up = UP, tuck = 0, crouch = 0, grow = 1, cameraDistance = 600 } = {}) {
    if (placed && dt > 0) velocity.lerp(v1.subVectors(group.position, lastPos).divideScalar(dt), 1 - Math.exp(-dt * 8));
    lastPos.copy(group.position); placed = true;
    // Turn toward where it is heading (or what it digs into), its back to `up`.
    if (face && face.lengthSq() > 1e-6) {
      v1.copy(face).addScaledVector(up, -face.dot(up));
      if (v1.lengthSq() > 1e-6) { m4.lookAt(v1.normalize(), ZERO, up); q.setFromRotationMatrix(m4); group.quaternion.slerp(q, dt > 0 ? 1 - Math.exp(-dt * 5) : 1); }
    }
    bodyUp.set(0, 1, 0).applyQuaternion(group.quaternion);
    const g = clamp01(grow), fade = smooth(0, .3, g);
    group.scale.setScalar(.3 + .7 * outCubic(g));
    let finishing = false;
    if (dig) { dig.t = Math.min(1, dig.t + dt / dig.length); finishing = dig.t >= 1; }
    const digging = !!dig, d = digging ? dig.t : 1;
    const lean = digging ? smooth(0, LEAN, d) * (1 - smooth(.9, 1, d)) : 0;
    // Body: rides up while a group swings, breathes, crouches, leans into a dig.
    let swingLift = 0; for (const L of legs) if (L.swing) swingLift = Math.max(swingLift, Math.sin(Math.PI * clamp01(L.swing.t)));
    lift += (swingLift - lift) * (dt > 0 ? 1 - Math.exp(-dt * 12) : 1);
    rig.position.y = .1 * Math.sin(time * 2.1 + seed) + .32 * lift - 1.9 * crouch - .75 * lean;
    rig.rotation.x = .22 * lean + .1 * crouch;
    abdomen.scale.setScalar(1 + .035 * Math.sin(time * 2.3 + seed)); abdomen.rotation.x = -.06 + .05 * Math.sin(time * 1.7 + seed) - .08 * crouch;
    group.updateMatrixWorld(true);
    // Feet stay planted in the world while it stands; folded in flight and while it climbs.
    const grounded = tuck < .04 && g >= 1;
    if (!grounded) { planted = false; for (const L of legs) L.swing = null; }
    else if (!planted) { for (const L of legs) grip(homeOf(L, L.plant)); planted = true; idle = 0; }
    if (planted && dt > 0) gait(dt, digging);
    si = 0; ji = 0;
    for (const L of legs) {
      if (digging && L.front) clawPose(L, d, foot);
      else if (!grounded) airPose(L, tuck, g, foot);
      else rig.worldToLocal(footAt(L, foot));
      outward.set(foot.x - L.hip.x, 0, foot.z - L.hip.z).normalize();
      ankle.copy(foot).addScaledVector(outward, -L.tarsus * .35); ankle.y += L.tarsus * .85;
      solve(L.hip, ankle, L.femur, L.tibia, hint.set(outward.x * .45, 1, outward.z * .45), knee);
      foot.copy(ankle).addScaledVector(outward, L.tarsus * .35); foot.y -= L.tarsus * .85;
      L.local.copy(foot);
      seg(L.hip, knee); seg(knee, ankle); seg(ankle, foot); dot(knee); dot(ankle); dot(foot);
    }
    // Pedipalps: short feelers in front of the fangs, raking fast while digging.
    const palp = digging ? .5 - .5 * Math.cos(TAU * 3 * d) : 0;
    for (const s of [-1, 1]) {
      base.set(s * .75, -.5, 3.8);
      tip.set(s * (1.2 - .6 * palp), -1.9 - .8 * lean + 1.1 * palp, 6.1 + 2.2 * lean - 3.0 * palp);
      mid.copy(base).lerp(tip, .5); mid.y += 1.1; mid.x += s * .5;
      seg(base, mid); seg(mid, tip); dot(tip);
    }
    for (const e of EYES) dot(v1.fromArray(e));
    limbBuffer.needsUpdate = true; jointGeometry.attributes.position.needsUpdate = true;
    // Glow: breathes, flares on each bite, stays up while the claw holds the find.
    pulse = Math.max(0, pulse - dt * 3);
    const holding = digging ? smooth(HOOK, HOOK + .1, d) * (1 - smooth(.96, 1, d)) : 0, breath = Math.sin(time * 1.6 + seed);
    halo.material.opacity = fade * (.14 + .04 * breath + .2 * pulse + .08 * holding);
    heart.material.opacity = fade * Math.min(1, .4 + .08 * breath + .5 * pulse + .25 * holding);
    heart.scale.setScalar(4.4 * (1 + .3 * pulse));
    // Crisp near the camera, finer far away, never a blob.
    const width = Math.max(.8, Math.min(1.9, 620 / Math.max(1, cameraDistance)));
    ink.linewidth = width; shellInk.linewidth = width * .8; under.linewidth = width * 3.2;
    ink.opacity = fade; shellInk.opacity = fade; under.opacity = .6 * fade; jointMaterial.opacity = fade;
    // Dig events fire after the pose, so the claw positions are this frame's.
    if (dig) {
      while (dig.rakes < RAKES && d >= LEAN + RAKE * (dig.rakes + BITE)) {
        const side = dig.rakes % 2 ? 1 : -1; pulse = 1; dig.rakes++;
        dig.hooks.onRake?.(side, claw(side), pullOf(side, new T.Vector3()));
      }
      if (!dig.hooked && d >= HOOK) { dig.hooked = true; dig.hooks.onHook?.(); }
      if (finishing) {
        const hooks = dig.hooks; dig = null;
        // Both claws step back down to where they stand.
        if (planted) for (const s of [-1, 1]) claws[s].swing = { from: claw(s), to: grip(homeOf(claws[s], new T.Vector3())), t: 0, length: .3 };
        hooks.onRelease?.();
      }
    }
  }

  return {
    group,
    update,
    /** Lean in, four alternating rakes, then hook the find; hooks: onRake(side, at, pull), onHook(), onRelease(). */
    dig(seconds = 1.45, hooks = {}) { dig = { t: 0, length: seconds, hooks, rakes: 0, hooked: false }; },
    get digging() { return !!dig; },
    /** World position of a front claw tip (side -1 left, 1 right) as of the last update. */
    claw,
    /** World positions of the feet that stand (not the front claws while they dig), as of the last update. */
    feet(out = []) { out.length = 0; for (const L of legs) if (!(dig && L.front)) out.push(rig.localToWorld(L.local.clone())); return out; },
    dispose() { group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); },
  };
}
