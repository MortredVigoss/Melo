// War room 3D scene (layout A, 2026-11-06). The core is the lead agent. The
// five regions are Melo's module webs. Every agent at work is a wireframe
// spider: a member's spider climbs out of the core when the member starts,
// leaps to the region of the call it is actually making, stands on that web
// and digs while the call runs; when the call finishes its claw hooks the
// result (the war room flies it to the call's row in the log), and when the
// member hands off the spider leaps back and climbs into the core. The lead's
// own calls get a spider of their own. Only recorded calls move a spider.
//
// While the war room is closed or motion is reduced nothing is animated: the
// scene is kept as a still snapshot of where everyone is, and calls that
// finish meanwhile are not replayed later.
import * as T from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { visualColor, sceneColor } from '../src/shared/visualTokens.js';
import { EXECUTION_MODULES, sceneFinished } from '/shared/executionScene.js';
import { sceneEvaluation } from '/shared/executionBoard.js';
import { sceneActors, deliveryGate } from '/shared/warRoom.js';
import { createSpider } from './warRoomSpider.js';
import { neuralCluster } from './warRoomCluster.js';
import { leadCore, deepSpace, setLook } from './warRoomParticles.js';
import { SIZE, LAYOUT, WEB, layoutFor, outline, placeLocal, frameStage } from './warRoomLayout.js';

const UP = new T.Vector3(0, 1, 0), ORIGIN = new T.Vector3();
const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const clamp01 = x => clamp(x, 0, 1);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const inOut = t => t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const quadInOut = t => t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
// Where the regions sit, how each is tilted and how the global view frames
// them live in warRoomLayout.js (pure, tested without WebGL).
const CORE_SIZE = 1.25;
// The body rides this far above what its feet grip; along a web it walks
// WALK units a second; a dig lasts DIG seconds (shorter when calls queue up).
const STAND = 4.6 * 1.5, WALK = 55, DIG = 1.35, QUICK_DIG = .8, MIN_ZOOM = .55, MAX_ZOOM = 2.8;
export const WAR_ROOM_VIEWS = Object.freeze(['global', 'follow', 'free']);

export function createWarRoomScene(host, { onProject, onSelectRegion, onHook, onRelease, onFailure, onInteract, onViewChange } = {}) {
  const phone = innerWidth < 700, reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const canvas = document.createElement('canvas'); canvas.setAttribute('aria-hidden', 'true'); canvas.className = 'war-room-canvas';
  const renderer = new T.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  const pixel = Math.min(devicePixelRatio || 1, 1.75);
  // Black sky: through the bloom chain a tinted clear colour is encoded twice.
  renderer.setPixelRatio(pixel); renderer.setClearColor(0x000000, 1);
  renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
  const world = new T.Scene(), camera = new T.PerspectiveCamera(42, 1, 1, 9000);
  const composer = new EffectComposer(renderer); composer.addPass(new RenderPass(world, camera));
  composer.addPass(new UnrealBloomPass(new T.Vector2(512, 512), .8, .42, .24)); composer.addPass(new OutputPass());
  let seed = 7;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const gauss = () => (rand() + rand() + rand() - 1.5) / 1.5;
  const sprite = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); const r = g.createRadialGradient(64, 64, 0, 64, 64, 64); r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(.25, 'rgba(255,255,255,.45)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, 128, 128); return new T.CanvasTexture(c); })();
  const white = sceneColor('atom-h'), gold = sceneColor('neural-light');
  setLook({ size: phone ? .85 : .66, light: 1.5 });
  const TOK = { hot: visualColor('scene-ffe4a3'), goldBright: gold, blue: visualColor('knowledge-light'), white };
  const space = deepSpace(TOK, phone ? .6 : 1, sprite); world.add(space.group);
  const coreRegion = leadCore(TOK, phone ? 2 : 6), core = coreRegion.group; core.scale.setScalar(CORE_SIZE); world.add(core);
  const CORE_R = coreRegion.radius * CORE_SIZE, SURFACE = 96 * CORE_SIZE, INSIDE = 26 * CORE_SIZE;
  const halo = new T.Sprite(new T.SpriteMaterial({ map: sprite, color: gold, transparent: true, opacity: .1, blending: T.AdditiveBlending, depthWrite: false })); halo.scale.setScalar(300); core.add(halo);
  const regions = EXECUTION_MODULES.map(module => {
    const web = WEB[module.id], cluster = neuralCluster({ color: visualColor(`execution-${module.id}`), seed: web.seed, ganglia: web.ganglia, sprite, nodes: phone ? 560 : 1000, dust: phone ? 2400 : 6000 });
    cluster.group.scale.setScalar(SIZE); cluster.group.rotation.set(...web.tilt); world.add(cluster.group);
    // Its outermost nodes as placed (tilted, scaled, about its centre): the
    // global view frames these and labels sit just outside them.
    const hull = outline(cluster.positions.map(p => placeLocal([p.x, p.y, p.z], web.tilt, SIZE)));
    return { id: module.id, cluster, group: cluster.group, center: new T.Vector3(), home: new T.Vector3(), body: cluster.radius * SIZE * .9, hull, activity: 0, flash: 0 };
  });
  const regionOf = id => regions.find(r => r.id === id) || null;
  const materials = [...space.materials, ...coreRegion.materials, ...regions.flatMap(r => r.cluster.materials)];
  // Thinning for slow devices: landmark points kept, the rest drawn in part.
  const thinnable = []; for (const r of [coreRegion, ...regions.map(r => ({ group: r.group }))]) r.group.traverse(o => { if (o.isPoints && o.userData.total) thinnable.push(o); });
  const setDensity = k => { for (const p of thinnable) p.geometry.setDrawRange(0, p.userData.kept + Math.round((p.userData.total - p.userData.kept) * k)); };
  let layoutKey = '', settle = true;
  function placeRegions(instant) {
    const key = layoutFor(camera.aspect); if (key === layoutKey) return; layoutKey = key;
    for (const r of regions) { r.home.fromArray(LAYOUT[key][r.id]); if (instant) { r.center.copy(r.home); r.group.position.copy(r.center); } }
  }

  // ── Effects: a gold ring from the core when the gate opens and on delivery;
  // a wisp of a web's own colour wherever a claw bites.
  const waves = [], wisps = [], scatter = new T.Vector3();
  function shockwave() {
    if (reduced.matches || still) return;
    const n = 480, geometry = new T.BufferGeometry(); geometry.setAttribute('position', new T.BufferAttribute(new Float32Array(n * 3), 3));
    const points = new T.Points(geometry, new T.PointsMaterial({ size: 3.4, map: sprite, color: gold, transparent: true, opacity: 1, blending: T.AdditiveBlending, depthWrite: false }));
    points.rotation.x = .35; world.add(points); waves.push({ points, age: 0, n });
  }
  function wisp(at, pull, hex) {
    const n = 48, position = new Float32Array(n * 3), color = new Float32Array(n * 3), velocity = [], tint = new T.Color(hex).lerp(new T.Color(white), .6);
    for (let i = 0; i < n; i++) {
      position.set([at.x + gauss() * 1.8, at.y + gauss() * 1.8, at.z + gauss() * 1.8], i * 3);
      velocity.push(pull.clone().multiplyScalar(20 + rand() * 22).add(new T.Vector3(gauss(), gauss(), gauss()).multiplyScalar(5)).addScaledVector(UP, 3 + rand() * 5));
      const k = .8 + rand() * .7; color.set([tint.r * k, tint.g * k, tint.b * k], i * 3);
    }
    const geometry = new T.BufferGeometry(); geometry.setAttribute('position', new T.BufferAttribute(position, 3)); geometry.setAttribute('color', new T.BufferAttribute(color, 3));
    const points = new T.Points(geometry, new T.PointsMaterial({ size: 2.3, map: sprite, vertexColors: true, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false }));
    points.renderOrder = 8; points.frustumCulled = false; world.add(points); wisps.push({ points, velocity, age: 0 });
  }
  function stepEffects(dt) {
    for (let i = waves.length - 1; i >= 0; i--) {
      const w = waves[i]; w.age += dt; const t = Math.min(1, w.age / 1.8), radius = 70 + (1 - (1 - t) ** 2) * 470, pos = w.points.geometry.attributes.position;
      for (let j = 0; j < w.n; j++) { const a = j / w.n * Math.PI * 2; pos.setXYZ(j, Math.cos(a) * radius, Math.sin(a * 5 + w.age * 3) * 5, Math.sin(a) * radius); }
      pos.needsUpdate = true; w.points.material.opacity = (1 - t) ** 1.5;
      if (t >= 1) { world.remove(w.points); w.points.geometry.dispose(); w.points.material.dispose(); waves.splice(i, 1); }
    }
    for (let i = wisps.length - 1; i >= 0; i--) {
      const w = wisps[i]; w.age += dt; const t = w.age / .95, pos = w.points.geometry.attributes.position;
      w.velocity.forEach((v, j) => { v.multiplyScalar(Math.exp(-dt * 2.8)); if (w.age > .3) v.add(scatter.set(gauss(), gauss(), gauss()).multiplyScalar(dt * 10)); pos.setXYZ(j, pos.getX(j) + v.x * dt, pos.getY(j) + v.y * dt, pos.getZ(j) + v.z * dt); });
      pos.needsUpdate = true; w.points.material.opacity = smooth(0, .06, t) * (1 - clamp01(t)) ** 1.4;
      if (t >= 1) { world.remove(w.points); w.points.geometry.dispose(); w.points.material.dispose(); wisps.splice(i, 1); }
    }
  }

  // ── Spiders ───────────────────────────────────────────────────────────
  // Melo's agents purple, a third of the way to the scene's silver; the glow
  // is the same purple lightened. Every spider looks the same.
  const INK = new T.Color(visualColor('agents-light')).lerp(new T.Color(sceneColor('neural-silver')), .3), GLOW = new T.Color(visualColor('agents-light')).lerp(new T.Color(white), .45), SHADOW = new T.Color(visualColor('scene-060a10'));
  const actors = new Map(), seen = new Map(), footing = [];
  const scratch = new T.Vector3(), aside = new T.Vector3(), lift = new T.Vector3(), probe = new T.Vector3(), webPoint = new T.Vector3(), webNormal = new T.Vector3(), turnAxis = new T.Vector3(), other = new T.Vector3();
  let clock = 0, runId = null, still = false, open = false, coreFlash = 0, coreActivity = 0, coreTarget = 0, gateWasOpen = false, finishedSeen = false, primed = false;
  const setState = (a, state, length = 1) => { a.state = state; a.t = 0; a.length = length; };
  const onWeb = a => !a.homeward && a.region && (a.state === 'work' || a.state === 'land');
  function standAt(a, direction, position, up) {
    a.region.cluster.surface(direction, .88, webPoint, webNormal);
    position.copy(webPoint).addScaledVector(webNormal, STAND); up.copy(webNormal).lerp(UP, .4).normalize();
  }
  function nearby(around, spread) {
    aside.crossVectors(around, Math.abs(around.y) < .9 ? UP : other.set(1, 0, 0)).normalize(); lift.crossVectors(around, aside);
    return new T.Vector3().copy(around).addScaledVector(aside, (rand() * 2 - 1) * spread).addScaledVector(lift, (rand() * 2 - 1) * spread * .6).normalize();
  }
  function pickNode(a, swing = 0) {
    const forward = scratch.copy(a.face).addScaledVector(a.up, -a.face.dot(a.up));
    if (forward.lengthSq() < 1e-6) forward.copy(a.region.center).sub(a.pos);
    forward.normalize().applyAxisAngle(a.up, swing);
    return a.region.cluster.nearestNode(probe.copy(a.pos).addScaledVector(forward, 16).addScaledVector(a.up, -(STAND + 6)));
  }
  function spawn(p, animate) {
    let a = null;
    const spider = createSpider({ color: INK, glow: GLOW, shadow: SHADOW, scale: 1.5, seed: (p.index ?? 9) * 1.7, sprite,
      foothold: q => a && onWeb(a) ? a.region.cluster.nearestOnWeb(q, 10) : null, onStep: q => { if (a && onWeb(a) && !still) a.region.cluster.pluck(q); } });
    world.add(spider.group);
    const angle = (p.index ?? 0) * 2.4 + .6;
    a = { id: p.id, kind: p.kind, spider, pos: spider.group.position, dir: new T.Vector3(Math.cos(angle) * .7, .55, Math.sin(angle) * .7).normalize(), face: new T.Vector3(), up: UP.clone(),
      region: null, state: '', t: 0, length: 1, grow: 0, tuck: 0, crouch: 0, homeward: false, dest: new T.Vector3(), destUp: new T.Vector3(), curve: null,
      base: new T.Vector3(), at: new T.Vector3(), goal: new T.Vector3(), target: -1, turnUntil: 0, idleAt: 0, ready: false, dug: 0, jobs: [], digging: false, retire: false, hold: 0, gone: false, hooked: null };
    a.face.copy(a.dir); actors.set(p.id, a);
    if (animate) { a.pos.copy(a.dir).multiplyScalar(INSIDE); setState(a, 'emerge', .75); }
    else { a.grow = 1; placeAt(a, p.module); }
    return a;
  }
  // Without animation a spider simply is where the record says.
  function placeAt(a, module) {
    const region = regionOf(module);
    if (!region) { a.region = null; a.pos.copy(a.dir).multiplyScalar(SURFACE); a.face.copy(a.dir); a.up.copy(UP); setState(a, 'wait'); return; }
    a.region = region; region.cluster.localDirection(scratch.copy(region.center).negate().normalize().multiplyScalar(.6).addScaledVector(UP, .8), a.base);
    a.at.copy(a.base); a.goal.copy(a.base); standAt(a, a.at, a.pos, a.up); a.face.copy(region.center).sub(a.pos); setState(a, 'work');
  }
  function leapTo(a, module) {
    a.homeward = !module; a.ready = false; a.target = -1;
    if (!module) { a.dir.copy(a.pos).normalize(); a.dest.copy(a.dir).multiplyScalar(SURFACE); a.region = null; }
    else { a.region = regionOf(module); a.region.cluster.localDirection(scratch.copy(a.region.center).negate().normalize().multiplyScalar(.6).addScaledVector(UP, .8), a.base); a.at.copy(a.base); a.goal.copy(a.base); standAt(a, a.base, a.dest, a.destUp); }
    setState(a, 'crouch', .22);
  }
  function startLeap(a) {
    const from = a.pos.clone(), to = a.dest.clone(), distance = from.distanceTo(to);
    a.curve = new T.QuadraticBezierCurve3(from, from.clone().lerp(to, .5).addScaledVector(UP, Math.max(60, distance * .3)), to);
    setState(a, 'leap', .8 + distance / 1500);
  }
  function removeActor(a) { world.remove(a.spider.group); a.spider.dispose(); actors.delete(a.id); a.gone = true; if (a.hooked) onRelease?.({ actorId: a.id, operationId: a.hooked, lost: true }); }
  function startDig(a, job) {
    const region = a.region; a.digging = true; a.hooked = null;
    a.spider.dig(a.jobs.length > 2 ? QUICK_DIG : DIG, {
      onRake: (side, at, pull) => { region.cluster.touch([at], 1.6); region.cluster.flare(region.cluster.nearestNode(at, 26), 1.7); wisp(at, pull, visualColor(`execution-${region.id}`)); region.flash = Math.max(region.flash, .25); },
      // The claw lifts the result only once the call has really finished.
      onHook: () => { if (!job.done) return; const at = a.spider.claw(1, probe); region.cluster.touch([at], 1.4); region.cluster.flare(region.cluster.nearestNode(at, 26), 1.2); a.hooked = job.id; onHook?.({ actorId: a.id, operationId: job.id }); },
      onRelease: () => { a.digging = false; a.hold = .2; if (a.hooked === job.id) { a.jobs.shift(); a.hooked = null; onRelease?.({ actorId: a.id, operationId: job.id }); } },
    });
  }
  // Climb out → (wait on the core until the first call) → crouch → leap →
  // land → work on the web; and back: crouch → leap → land → climb in.
  function stepActor(a, dt) {
    if (a.state !== 'work' && a.state !== 'wait') a.t = Math.min(1, a.t + dt / a.length);
    const t = a.t, job = a.jobs[0];
    const wanted = job ? job.module : a.wanted;
    if (a.state === 'emerge') {
      a.grow = t; a.pos.copy(a.dir).multiplyScalar(INSIDE + (SURFACE - INSIDE) * inOut(t)); a.face.copy(a.dir); a.up.copy(UP);
      if (t >= 1) { a.grow = 1; if (wanted) leapTo(a, wanted); else setState(a, 'wait'); }
    } else if (a.state === 'wait') {
      a.pos.copy(a.dir).multiplyScalar(SURFACE); a.face.copy(a.dir); a.up.copy(UP);
      if (wanted) leapTo(a, wanted); else if (a.retire) { a.dir.copy(a.pos).normalize(); setState(a, 'merge', .65); }
    } else if (a.state === 'crouch') {
      a.crouch = .9 * inOut(t); a.face.copy(a.dest).sub(a.pos);
      if (t >= 1) startLeap(a);
    } else if (a.state === 'leap') {
      const e = quadInOut(t); a.curve.getPoint(e, a.pos); a.curve.getTangent(Math.min(.98, Math.max(.02, e)), a.face); a.up.copy(UP);
      a.tuck = smooth(0, .16, t) * (1 - smooth(.74, .95, t)); a.crouch = .9 * (1 - smooth(0, .1, t));
      if (t >= 1) { a.tuck = 0; setState(a, 'land', .3); }
    } else if (a.state === 'land') {
      a.crouch = .7 * (1 - inOut(t));
      if (a.homeward) { a.face.copy(a.pos).negate(); a.up.copy(UP); } else { a.face.copy(a.region.center).sub(a.pos); a.up.copy(a.destUp); }
      if (t >= 1) { a.crouch = 0; if (a.homeward) { a.dir.copy(a.pos).normalize(); setState(a, 'merge', .65); } else setState(a, 'work'); }
    } else if (a.state === 'work') {
      const cluster = a.region.cluster; a.hold = Math.max(0, a.hold - dt);
      if (!a.digging && wanted !== a.region.id) { if (wanted || (a.retire && !job)) { leapTo(a, wanted || null); return; } }
      const gap = a.at.angleTo(a.goal), moving = gap > .003 && !a.digging;
      if (moving) { turnAxis.crossVectors(a.at, a.goal); if (turnAxis.lengthSq() > 1e-12) a.at.applyAxisAngle(turnAxis.normalize(), Math.min(gap, dt * WALK / (SIZE * 72))).normalize(); else a.at.copy(a.goal); }
      standAt(a, a.at, a.pos, a.up);
      if (moving) { standAt(a, a.goal, probe, lift); a.face.copy(probe).sub(a.pos); }
      else if (a.target >= 0) a.face.copy(cluster.nodeWorld(a.target, probe)).sub(a.pos);
      // A call: a few steps to a fresh spot, a turn to a node, then the rakes.
      if (!a.digging && job && a.hold <= 0) {
        if (!a.ready) { a.goal.copy(a.dug ? nearby(a.base, .17) : a.at); a.ready = true; a.target = -1; }
        else if (!moving) {
          if (a.target < 0) { a.target = pickNode(a, a.dug % 2 ? .5 : -.5); a.turnUntil = clock + .3; }
          else if (clock >= a.turnUntil) { a.ready = false; a.dug++; startDig(a, job); }
        }
      }
      // Between calls it does not freeze: a short shuffle along the web, or a turn.
      if (!a.digging && !job && !moving && !a.retire && clock >= a.idleAt) {
        a.idleAt = clock + 1.6 + rand() * 2;
        if (rand() < .55) a.goal.copy(nearby(a.at, .12)); else a.target = pickNode(a, (rand() - .5) * 2.4);
      }
    } else if (a.state === 'merge') {
      a.grow = 1 - t; a.pos.copy(a.dir).multiplyScalar(SURFACE - (SURFACE - INSIDE) * inOut(t)); a.face.copy(a.dir).negate(); a.up.copy(UP);
      if (t >= 1) { removeActor(a); coreFlash = Math.max(coreFlash, .7); }
    }
  }

  // ── Data → spiders ─────────────────────────────────────────────────────
  // The first look at a run (or the first after reopening) primes: what has
  // finished is only noted, spiders stand where the record says, running
  // calls are dug. After that every call that starts or finishes animates,
  // including a quick one whose spider was not out yet.
  let scene = null;
  function update(next) {
    const animate = open && !still && !reduced.matches;
    if (next?.runId !== runId) { for (const a of [...actors.values()]) removeActor(a); seen.clear(); runId = next?.runId || null; primed = false; gateWasOpen = false; finishedSeen = sceneFinished(next); waves.splice(0).forEach(w => { world.remove(w.points); w.points.geometry.dispose(); w.points.material.dispose(); }); }
    scene = next;
    const operations = new Map((next?.operations || []).map(op => [op.id, op])), projected = sceneActors(next), priming = !animate || !primed;
    for (const p of projected) {
      let a = actors.get(p.id);
      const jobs = [];
      for (const id of p.operations) {
        const op = operations.get(id), terminal = TERMINAL.includes(op.status), was = seen.get(id);
        if (was === 'shown' || was === 'done') continue;
        if (priming) {
          if (terminal) seen.set(id, 'shown');
          else { seen.set(id, 'running'); if (animate && !a?.jobs.some(job => job.id === id)) jobs.push({ id, module: op.module, done: false }); }
          continue;
        }
        if (!was) { seen.set(id, terminal ? 'done' : 'running'); jobs.push({ id, module: op.module, done: terminal }); }
        else if (terminal) { seen.set(id, 'done'); const job = a?.jobs.find(j => j.id === id); if (job) job.done = true; else jobs.push({ id, module: op.module, done: true }); }
      }
      if (!a && (p.out || jobs.length)) a = spawn(p, animate && !priming);
      if (!a) continue;
      a.jobs.push(...jobs); a.wanted = p.module; a.retire = !p.out;
      if (!animate) { a.jobs = []; if (!p.out) removeActor(a); else if (!['work', 'wait'].includes(a.state) || (a.region?.id || null) !== (p.module || null)) placeAt(a, p.module); }
    }
    // A spider whose assignment is gone goes home once it has nothing left to report.
    for (const a of actors.values()) if (!projected.some(p => p.id === a.id)) a.retire = true;
    primed = animate;
    const snapshot = sceneEvaluation(next).snapshot, gate = deliveryGate(snapshot), finished = sceneFinished(next);
    if (animate && !priming && gate?.open && !gateWasOpen) shockwave();
    if (animate && !priming && finished && !finishedSeen) shockwave();
    gateWasOpen = !!gate?.open; finishedSeen = finished;
    coreTarget = (!finished && actors.size ? .45 : 0) + (gate?.open ? .55 : 0);
    for (const r of regions) r.target = (next?.operations || []).some(op => op.module === r.id && op.status === 'running') ? 1 : 0;
    requestFrame();
  }

  // ── Camera ────────────────────────────────────────────────────────────
  const view = { mode: 'global', yaw: 0, pitch: .14, zoom: 1, followId: null, region: null, dragYaw: 0, dragPitch: 0 };
  const orbit = { yaw: .35, pitch: .2, distance: 1400 }, goal = { yaw: 0, pitch: .14, distance: 1400 };
  const aim = new T.Vector3(), aimGoal = new T.Vector3(), viewDir = new T.Vector3(), offset = new T.Vector3();
  const wrap = a => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
  const dirFrom = (yaw, pitch, out) => out.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  // Every region's outermost nodes and the core inside the stage, less the
  // room its labels need (see warRoomLayout.js).
  function frameAll(target, dir) {
    if (!width || !height) return goal.distance;
    const points = []; for (const r of regions) for (const h of r.hull) points.push([r.center.x + h[0], r.center.y + h[1], r.center.z + h[2]]);
    const fit = frameStage({ points, spheres: [{ c: [0, 0, 0], r: CORE_R }], dir: [dir.x, dir.y, dir.z], fov: camera.fov, width, height });
    target.fromArray(fit.target); return fit.distance;
  }
  const followed = () => { const a = actors.get(view.followId); if (a && !a.gone) return a; return [...actors.values()].filter(x => !x.retire).at(-1) || [...actors.values()].at(-1) || null; };
  function cameraGoal() {
    const portrait = Math.max(1, .95 / Math.max(.3, camera.aspect));
    let yaw, pitch, distance;
    const region = regionOf(view.region);
    if (region) {
      aimGoal.copy(region.center); distance = region.body * 2.6 * portrait / view.zoom;
      yaw = Math.atan2(region.center.x, region.center.z) + .5 + view.dragYaw; pitch = clamp(.22 + view.dragPitch, -1, 1);
    } else if (view.mode === 'follow') {
      const a = followed();
      if (a) {
        const atCore = !a.region || a.homeward || a.state === 'emerge' || a.state === 'wait', center = atCore ? ORIGIN : a.region.center;
        aimGoal.copy(a.pos).lerp(center, (atCore ? .22 : .36) / Math.max(1, view.zoom));
        distance = (atCore ? 560 : a.region.body * 1.8) * portrait;
        const side = atCore ? a.dir : viewDir.copy(a.pos).sub(a.region.center); yaw = Math.atan2(side.x, side.z) + (atCore ? .95 : 1.1) + .12 * Math.sin(clock * .07); pitch = .22;
      } else { aimGoal.set(0, 8, 0); distance = 600 * portrait; yaw = .35 + clock * .05; pitch = .2; }
      yaw += view.dragYaw; pitch = clamp(pitch + view.dragPitch, -1, 1); distance /= view.zoom;
    } else {
      const sway = view.mode === 'global' && !dragging && !still && !reduced.matches;
      yaw = view.yaw + (sway ? Math.sin(clock * .06) * .18 : 0); pitch = clamp(view.pitch + (sway ? Math.sin(clock * .035) * .06 : 0), -1, 1);
      distance = frameAll(aimGoal, dirFrom(yaw, pitch, viewDir)) / view.zoom;
    }
    goal.yaw = yaw; goal.pitch = pitch; goal.distance = distance;
  }
  function setView(mode, { followId = null } = {}) {
    if (!WAR_ROOM_VIEWS.includes(mode)) return;
    if (mode === 'free' && view.mode === 'global') view.yaw += Math.sin(clock * .06) * .18;
    view.mode = mode; view.region = null; view.dragYaw = view.dragPitch = 0;
    if (mode === 'global') { view.yaw = 0; view.pitch = .14; view.zoom = 1; }
    if (mode === 'follow') { view.zoom = 1; view.followId = followId; }
    onViewChange?.({ mode: view.mode, followId: view.followId, region: null }); requestFrame();
  }
  function focusRegion(id) { view.region = regionOf(id) ? id : null; view.dragYaw = view.dragPitch = 0; view.zoom = 1; onViewChange?.({ mode: view.mode, followId: view.followId, region: view.region }); requestFrame(); }
  function zoomBy(factor) { view.zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM); onInteract?.(); requestFrame(); }

  // ── Gestures: drag rotates, wheel / pinch zoom; a tap picks a region. ──
  const pointers = new Map(); let dragging = false, press = null, pinch = null;
  const rotate = (dx, dy) => {
    if (view.mode === 'follow' || view.region) { view.dragYaw -= dx; view.dragPitch = clamp(view.dragPitch + dy, -.9, .9); }
    else { if (view.mode === 'global') setView('free'); view.yaw -= dx; view.pitch = clamp(view.pitch + dy, -1, 1); }
    onInteract?.(); requestFrame();
  };
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) press = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY };
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: view.zoom }; press = null; dragging = false; }
    try { canvas.setPointerCapture?.(e.pointerId); } catch { /* a pointer the browser no longer tracks */ }
  });
  canvas.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) { const [a, b] = [...pointers.values()]; view.zoom = clamp(pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance, MIN_ZOOM, MAX_ZOOM); onInteract?.(); requestFrame(); return; }
    if (!press || e.pointerId !== press.id) return;
    if (!dragging && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) { dragging = true; canvas.classList.add('is-dragging'); }
    if (!dragging) return;
    rotate((e.clientX - press.lx) / canvas.clientWidth * Math.PI * .8, (e.clientY - press.ly) / canvas.clientHeight * Math.PI * .6);
    press.lx = e.clientX; press.ly = e.clientY;
  });
  const lift_ = e => {
    const tap = press && press.id === e.pointerId && !dragging && !pinch;
    pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null;
    if (tap && e.type === 'pointerup') pick(e.clientX, e.clientY);
    if (!pointers.size) { press = null; dragging = false; canvas.classList.remove('is-dragging'); }
  };
  canvas.addEventListener('pointerup', lift_); canvas.addEventListener('pointercancel', lift_);
  canvas.addEventListener('wheel', e => { e.preventDefault(); zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .0016))); }, { passive: false });
  function pick(x, y) {
    const rect = canvas.getBoundingClientRect(); let best = null, bestD = Infinity;
    for (const a of actors.values()) { const p = project(a.pos); if (!p.visible) continue; const d = Math.hypot(rect.left + p.x - x, rect.top + p.y - y); if (d < 34 && d < bestD) { best = { actor: a.id }; bestD = d; } }
    if (!best) for (const r of regions) { const p = project(r.center), q = project(scratch.copy(r.center).addScaledVector(rightAxis(), r.body)); if (!p.visible) continue; const d = Math.hypot(rect.left + p.x - x, rect.top + p.y - y), radius = Math.hypot(q.x - p.x, q.y - p.y); if (d < radius && d / radius < bestD) { best = { region: r.id }; bestD = d / radius; } }
    if (best?.actor) setView('follow', { followId: best.actor });
    else if (best?.region) onSelectRegion?.(best.region);
  }
  const rightAxis = () => other.setFromMatrixColumn(camera.matrixWorld, 0);

  // ── Frame loop ────────────────────────────────────────────────────────
  const projected = new T.Vector3();
  function project(v) { projected.copy(v).project(camera); return { x: (projected.x + 1) / 2 * width, y: (1 - projected.y) / 2 * height, visible: projected.z < 1 && projected.z > -1, depth: projected.z }; }
  let width = 1, height = 1, raf = 0, last = 0, visible = true, dead = false;
  const perf = { level: 1, samples: [], done: false, since: 0 };
  function perfSample(ms) {
    if (perf.done || clock - perf.since < 1.8 || document.hidden) return;
    perf.samples.push(ms); if (perf.samples.length < 120) return;
    const sorted = perf.samples.sort((a, b) => a - b), median = sorted[sorted.length >> 1]; perf.samples = [];
    if (median > 21 && perf.level > .5) { perf.level = perf.level > .8 ? .7 : .5; setDensity(perf.level); } else perf.done = true;
  }
  function frame(now) {
    raf = 0; if (dead || !open || !visible || document.hidden) return;
    const dt = Math.min(.05, (now - (last || now)) / 1000), motion = !still && !reduced.matches, sim = motion ? dt : 0; perfSample(now - last); last = now; clock += sim;
    for (const r of regions) { r.center.lerp(r.home, motion ? 1 - Math.exp(-dt * 2.5) : 1); r.group.position.copy(r.center); }
    cameraGoal();
    if (settle) { aim.copy(aimGoal); orbit.yaw = goal.yaw; orbit.pitch = goal.pitch; orbit.distance = goal.distance; settle = false; }
    const k = motion ? 1 - Math.exp(-dt * (view.mode === 'follow' ? 3.2 : 4)) : 1, turn = dragging && view.mode !== 'follow' ? 1 : k;
    aim.lerp(aimGoal, k); orbit.yaw += wrap(goal.yaw - orbit.yaw) * turn; orbit.pitch += (goal.pitch - orbit.pitch) * turn; orbit.distance += (goal.distance - orbit.distance) * k;
    camera.position.copy(dirFrom(orbit.yaw, orbit.pitch, viewDir)).multiplyScalar(orbit.distance).add(aim);
    for (const [center, min] of [[ORIGIN, CORE_R * 1.05], ...regions.map(r => [r.center, r.body * 1.05])]) { offset.copy(camera.position).sub(center); if (offset.length() < min) camera.position.copy(center).add(offset.setLength(min)); }
    camera.lookAt(aim); camera.updateMatrixWorld();
    const time = motion ? clock : 0;
    for (const m of materials) { if (m.uniforms?.uTime) m.uniforms.uTime.value = time; if (m.uniforms?.uPixel) m.uniforms.uPixel.value = pixel; }
    for (const r of regions) {
      r.activity += ((r.target || 0) - r.activity) * Math.min(1, dt * 1.6); r.flash = Math.max(0, r.flash - dt * 1.4);
      for (const m of r.cluster.materials) m.uniforms.uActivity.value = r.activity * .7 + r.flash;
      r.cluster.update(sim, r.activity * .7 + r.flash);
    }
    coreActivity += (coreTarget - coreActivity) * Math.min(1, dt * 1.4); coreFlash = Math.max(0, coreFlash - dt * 1.2);
    for (const m of coreRegion.materials) m.uniforms.uActivity.value = coreActivity + coreFlash;
    if (motion) { for (const s of coreRegion.spinners) s.object.rotateOnAxis(s.axis, sim * s.speed * (1 + coreActivity * 1.6)); core.rotation.y += sim * .03; space.group.rotation.y += sim * .003; }
    halo.material.opacity = .08 + coreActivity * .1 + coreFlash * .14;
    stepEffects(sim);
    for (const a of [...actors.values()]) {
      if (motion) stepActor(a, sim);
      if (a.gone) continue;
      a.spider.update(sim, { time, face: a.face, up: a.up, tuck: a.tuck, crouch: a.crouch, grow: a.grow, cameraDistance: camera.position.distanceTo(a.pos) });
      if (onWeb(a)) a.region.cluster.touch(a.spider.feet(footing), .9);
    }
    composer.render();
    const up = new T.Vector3().setFromMatrixColumn(camera.matrixWorld, 1), right = rightAxis().clone();
    const rects = new Map(); let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const r of regions) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const h of r.hull) { const p = project(scratch.set(r.center.x + h[0], r.center.y + h[1], r.center.z + h[2])); if (!p.visible) continue; x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
      if (x0 <= x1) { rects.set(r.id, { x0, y0, x1, y1 }); bx0 = Math.min(bx0, x0); by0 = Math.min(by0, y0); bx1 = Math.max(bx1, x1); by1 = Math.max(by1, y1); }
    }
    onProject?.({
      regions: regions.map(r => { const p = project(r.center), q = project(scratch.copy(r.center).addScaledVector(up, r.body)); return { id: r.id, ...p, radius: Math.hypot(q.x - p.x, q.y - p.y), rect: rects.get(r.id) || null, far: (view.mode !== 'global' || !!view.region) && r.center.distanceTo(camera.position) > camera.position.distanceTo(aim) + 90 }; }),
      core: { ...project(scratch.set(0, -CORE_R * 1.2, 0)), center: project(ORIGIN) },
      actors: [...actors.values()].filter(a => a.grow > .85 && a.state !== 'merge').map(a => ({ id: a.id, kind: a.kind, ...project(scratch.copy(a.pos).addScaledVector(UP, 26)), body: project(a.pos), radius: Math.max(14, Math.hypot(project(other.copy(a.pos).addScaledVector(right, 26)).x - project(a.pos).x, 0)), holding: !!a.hooked })),
    }, { width, height });
    host.dataset.frames = String((Number(host.dataset.frames) || 0) + 1);
    host.dataset.spiders = String(actors.size); host.dataset.view = view.region ? `region:${view.region}` : view.mode; host.dataset.zoom = view.zoom.toFixed(3);
    host.dataset.camera = camera.position.toArray().map(n => n.toFixed(0)).join(',');
    // The global view's promise, readable by tests: where the regions' outlines land on this stage.
    if (view.mode === 'global' && !view.region && bx0 <= bx1) host.dataset.bounds = [bx0, by0, bx1, by1, width, height].map(n => n.toFixed(0)).join(','); else delete host.dataset.bounds;
    if (motion) raf = requestAnimationFrame(frame);
  }
  function requestFrame() { if (!raf && !dead && open && visible && !document.hidden) raf = requestAnimationFrame(frame); }
  // A new stage size re-frames at once: the camera never trails the window.
  function resize() { width = host.clientWidth; height = host.clientHeight; if (!width || !height) return; renderer.setSize(width, height, false); composer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); placeRegions(!layoutKey); settle = true; requestFrame(); }
  const observer = new ResizeObserver(resize);
  const intersection = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting !== false; requestFrame(); });
  const visibility = () => requestFrame();
  const lost = event => { event.preventDefault(); cancelAnimationFrame(raf); raf = 0; onFailure?.(); };
  canvas.addEventListener('webglcontextlost', lost); document.addEventListener('visibilitychange', visibility);
  host.prepend(canvas); observer.observe(host); intersection.observe(host); resize();
  return {
    update, setView, focusRegion, zoomBy, requestFrame, rotateBy: (dx, dy) => rotate(dx, dy),
    get view() { return { ...view }; },
    resetView() { setView('global'); },
    setOpen(value) { open = value; last = 0; primed = false; if (open) { settle = true; resize(); if (scene) update(scene); requestFrame(); } else { cancelAnimationFrame(raf); raf = 0; } },
    setStill(value) { if (still === !!value) return; still = !!value; primed = false; if (scene) update(scene); requestFrame(); },
    /** Page coordinates of a spider's right claw (what it hooks), or null. */
    clawPoint(actorId) { const a = actors.get(actorId); if (!a || a.gone) return null; const rect = canvas.getBoundingClientRect(), p = project(a.spider.claw(1, probe)); return p.visible ? { x: rect.left + p.x, y: rect.top + p.y } : null; },
    /** Page coordinates of the core, where the lead's verdicts surface. */
    corePoint() { const rect = canvas.getBoundingClientRect(), p = project(ORIGIN); return { x: rect.left + p.x, y: rect.top + p.y, visible: p.visible }; },
    dispose() {
      dead = true; cancelAnimationFrame(raf); observer.disconnect(); intersection.disconnect(); document.removeEventListener('visibilitychange', visibility);
      for (const a of [...actors.values()]) removeActor(a);
      world.traverse(o => { o.geometry?.dispose?.(); if (Array.isArray(o.material)) o.material.forEach(m => m.dispose()); else o.material?.dispose?.(); });
      sprite.dispose(); composer.dispose?.(); renderer.dispose(); canvas.remove();
    },
  };
}
