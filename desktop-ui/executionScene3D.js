import { visualColor } from '../src/shared/visualTokens.js';
import * as T from 'three';
import { EXECUTION_MODULES, moduleActivity, sceneFinished, sceneKey } from '/shared/executionScene.js';
import { sceneMembers, sceneEvaluation, sceneHasBoard, evaluationChanges, MEMBER_ROLE_MODULE } from '/shared/executionBoard.js';

import { createSynapticBody } from './synapticBody.js';
import { executionViewFrame, clampZoom, wideViewport, clampPitch, wrapYaw, viewMode, globalSway, bindExecutionOrbit, FOLLOW_PITCH } from './executionViewport.js';
import { createExecutionPicker, bindExecutionPicking } from './executionPicking.js';

// The lead (the chat's own agent) routes and evaluates from the core; the five
// clusters are where work happens. Plan C, 2026-11-05.
const CORE_POSITION = Object.freeze([10, 0, -30]);
const MAX_MEMBER_ACTORS = 3, ARC_SECONDS = .9, RETURN_SECONDS = 1, SPARK_SECONDS = 1.25;
const LEAD_STAGE = /^(job-\d+[:#]|internal:\d+$|routing:|task-evaluation:|goal-check:)/;
const roleColor = role => EXECUTION_MODULES.find(module => module.id === MEMBER_ROLE_MODULE[role])?.color || visualColor('scene-dabc84');

export function createExecutionScene3D(host, { onProject, onFailure, onSelect, onHover, onViewChange } = {}) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  const renderer = new T.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setClearColor(visualColor('scene-060a10'), 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = T.SRGBColorSpace;
  const world = new T.Scene();
  world.fog = new T.FogExp2(visualColor('scene-060a10'), .0007);
  const camera = new T.PerspectiveCamera(46, 1, 1, 3000);
  const target = new T.Vector3(0, 0, -40), aim = target.clone();
  camera.position.set(0, 55, 750);
  const cameraGoal = camera.position.clone();
  world.add(new T.AmbientLight(visualColor('scene-74849d'), .85));
  const sun = new T.DirectionalLight(visualColor('scene-ffce97'), 3.1); sun.position.set(-2, 4, 5); world.add(sun);
  const rim = new T.DirectionalLight(visualColor('scene-75bfd4'), 1.8); rim.position.set(3, -1, -2); world.add(rim);
  const key = new T.PointLight(visualColor('scene-ffbb78'), 35000, 1800); key.position.set(-150, 230, 350); world.add(key);
  const fill = new T.PointLight(visualColor('scene-86cddd'), 17000, 1400); fill.position.set(240, -90, 200); world.add(fill);
  let seed = 2573;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const disposables = [], modules = [], sourceNodes = new Map();
  function points(positions, color, size, opacity) {
    const geometry = new T.BufferGeometry(); geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
    const material = new T.PointsMaterial({ color, size, transparent: true, opacity, sizeAttenuation: true, depthWrite: false, blending: T.AdditiveBlending });
    disposables.push(geometry, material); return new T.Points(geometry, material);
  }
  const dust = [];
  for (let i = 0; i < 2900; i++) {
    const x = (random() - .5) * 1800;
    dust.push(x, (random() - .5) * 800 + x * .2, -150 - random() * 1300);
  }
  const stars = points(dust, visualColor('scene-b29d80'), 1.9, .7); world.add(stars);
  function line(points, color, opacity = .2) {
    const geometry = new T.BufferGeometry().setFromPoints(points);
    const material = new T.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    disposables.push(geometry, material); const object = new T.Line(geometry, material); world.add(object); return object;
  }
  const sphere = new T.SphereGeometry(2.1, 8, 6); disposables.push(sphere);
  for (const definition of EXECUTION_MODULES) {
    const center = new T.Vector3(...definition.position);
    const group = new T.Group(); group.position.copy(center); world.add(group);
    const nodes = [], coords = [];
    for (let i = 0; i < 210; i++) {
      const a = random() * Math.PI * 2, z = random() * 2 - 1, r = Math.sqrt(1 - z * z) * (26 + random() * 57);
      const p = new T.Vector3(Math.cos(a) * r, Math.sin(a) * r * .77, z * 70);
      nodes.push(p); coords.push(...p.toArray());
    }
    const cloud = points(coords, definition.color, 2.9, .7); group.add(cloud);
    const edges = [];
    nodes.forEach((p, i) => {
      const near = nodes.map((q, j) => ({ j, d: p.distanceToSquared(q) })).filter(n => n.j > i).sort((a, b) => a.d - b.d).slice(0, 2);
      near.forEach(({ j }) => { if (p.distanceTo(nodes[j]) < 40) edges.push([p, nodes[j]]); });
    });
    const edgeGeometry = new T.BufferGeometry().setFromPoints(edges.flat());
    const edgeMaterial = new T.LineBasicMaterial({ color: definition.color, transparent: true, opacity: .17, depthWrite: false });
    group.add(new T.LineSegments(edgeGeometry, edgeMaterial)); disposables.push(edgeGeometry, edgeMaterial);
    const pulses = points(new Array(18 * 3).fill(0), definition.color, 4.2, .85); group.add(pulses);
    modules.push({ ...definition, center, group, nodes, edges, cloud, pulses, edgeMaterial, activity: { running: [] } });
  }
  const conduits = [];
  for (let i = 0; i < modules.length; i++) {
    const a = modules[i].center, b = modules[(i + 1) % modules.length].center;
    const curve = new T.CubicBezierCurve3(a, a.clone().add(new T.Vector3(0, 90, -90)), b.clone().add(new T.Vector3(0, 80, -120)), b);
    const strand = line(curve.getPoints(60), visualColor('scene-ab8955'), .24);
    const pulse = new T.Mesh(sphere, new T.MeshBasicMaterial({ color: visualColor('scene-dabc84') })); disposables.push(pulse.material); world.add(pulse);
    conduits.push({ curve, strand, pulse });
  }

  // Core: the lead agent. Thin gold orbits around a dense particle heart, with
  // faint spokes to every cluster it can route to.
  const corePosition = new T.Vector3(...CORE_POSITION);
  const core = new T.Group(); core.position.copy(corePosition); world.add(core);
  const coreRings = [];
  for (let i = 0; i < 9; i++) {
    const radius = 44 + random() * 16, ring = [];
    for (let k = 0; k <= 72; k++) { const a = k / 72 * Math.PI * 2; ring.push(new T.Vector3(Math.cos(a) * radius, Math.sin(a) * radius * (.92 + random() * .1), Math.sin(a * 2 + i) * 4)); }
    const geometry = new T.BufferGeometry().setFromPoints(ring);
    const material = new T.LineBasicMaterial({ color: visualColor(i % 3 ? 'scene-ffe4a3' : 'scene-dabc84'), transparent: true, opacity: .3, depthWrite: false, blending: T.AdditiveBlending });
    const loop = new T.Line(geometry, material); loop.rotation.set(random() * Math.PI, random() * Math.PI, random() * Math.PI);
    disposables.push(geometry, material); core.add(loop); coreRings.push(loop);
  }
  const heart = [];
  for (let i = 0; i < 640; i++) { const a = random() * Math.PI * 2, z = random() * 2 - 1, r = Math.cbrt(random()) * 34; heart.push(Math.cos(a) * Math.sqrt(1 - z * z) * r, Math.sin(a) * Math.sqrt(1 - z * z) * r, z * r); }
  const coreHeart = points(heart, visualColor('scene-ffe4a3'), 2.6, .62); core.add(coreHeart);
  const spokes = modules.map(module => line([corePosition, module.center], visualColor('scene-ab8955'), .07));

  // Actors: one primary lead actor (plus echoes when the lead itself runs work
  // in several clusters at once) and one per running internal member.
  const actors = new Map();
  function actorFor(id, colors) {
    let actor = actors.get(id);
    if (actor) return actor;
    const organism = createSynapticBody(colors || undefined), body = organism.body;
    body.rotation.set(-.34, .20, 0); body.visible = false; world.add(body); disposables.push(organism);
    actor = { id, organism, body, arc: null, anchor: null, anchorKey: '', phase: 0, active: false, leaving: false };
    actors.set(id, actor); return actor;
  }
  // Beams from the core to each running member, and one-shot travelling pulses.
  const beams = new Map(), travellers = [];
  function beamFor(id, color) {
    let beam = beams.get(id);
    if (beam) return beam;
    const geometry = new T.BufferGeometry().setFromPoints(Array.from({ length: 33 }, () => new T.Vector3()));
    const material = new T.LineBasicMaterial({ color, transparent: true, opacity: .42, depthWrite: false, blending: T.AdditiveBlending });
    const strand = new T.Line(geometry, material); world.add(strand);
    const pulse = new T.Mesh(sphere, new T.MeshBasicMaterial({ color })); pulse.scale.setScalar(1.3); world.add(pulse);
    beam = { strand, pulse, curve: new T.QuadraticBezierCurve3(corePosition.clone(), new T.Vector3(), new T.Vector3()) };
    beams.set(id, beam); return beam;
  }
  function dropBeam(id) {
    const beam = beams.get(id); if (!beam) return;
    world.remove(beam.strand, beam.pulse); beam.strand.geometry.dispose(); beam.strand.material.dispose(); beam.pulse.material.dispose(); beams.delete(id);
  }
  function travel(from, to, color, seconds, delay = 0, scale = 1) {
    const mesh = new T.Mesh(sphere, new T.MeshBasicMaterial({ color, transparent: true, opacity: .95 })); mesh.scale.setScalar(scale); mesh.visible = false; world.add(mesh);
    const control = from.clone().lerp(to, .5).add(new T.Vector3(0, 60, 30));
    travellers.push({ mesh, curve: new T.QuadraticBezierCurve3(from.clone(), control, to.clone()), age: -delay, seconds });
  }

  let width = 1, height = 1, raf = 0, last = 0, elapsed = 0, frame = 0, dead = false, visible = true, open = true;
  let scene = null, focus = null, detail = [], still = false, generation = 0, zoom = 1, interactingUntil = 0;
  let hoveredModule = null, dragging = false, coreFlash = 0, coreFlashColor = 1;
  let view = { mode: 'global', yaw: 0, pitch: 0, followId: 'lead' };
  let members = [], board = false, leadSlots = [], lastEvaluation = null, lastEvaluationStage = null, lastReview = '', previousRunning = new Set();
  function hoverRegion(id) {
    if (hoveredModule === id) return;
    hoveredModule = id; onHover?.(id);
    if (!dead && (still || reduced.matches) && open && visible && !document.hidden) draw(0);
  }
  const pick = createExecutionPicker(camera, modules.map(module => ({ id: module.id, center: module.center, radius: 86 })));
  const locked = () => !!focus && !wideViewport(zoom);
  const releasePicking = bindExecutionPicking(canvas, {
    pick, enabled: () => !dead && open && visible && !document.hidden && !locked() && !dragging,
    onSelect: id => { hoverRegion(null); onSelect?.(id); }, onHover: hoverRegion,
  });
  const releaseOrbit = bindExecutionOrbit(canvas, { threshold: 6,
    enabled: () => !dead && open && visible && !document.hidden && !locked(),
    onDragStart: () => { dragging = true; hoverRegion(null); if (view.mode === 'global') { const sway = swayNow(); view = { ...view, mode: 'free', yaw: view.yaw + sway.yaw, pitch: clampPitch(view.pitch + sway.pitch) }; } },
    onRotate: (yaw, pitch) => rotate(yaw, pitch),
    onDragEnd: () => { dragging = false; onViewChange?.({ ...view }); } });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const projected = new T.Vector3();
  function project(p) { projected.copy(p).project(camera); return { x: (projected.x + 1) * width / 2, y: (1 - projected.y) * height / 2, depth: projected.z, visible: projected.z > -1 && projected.z < 1 }; }
  const swayNow = () => view.mode === 'global' && !still && !reduced.matches && !hoveredModule ? globalSway(elapsed) : { yaw: 0, pitch: 0 };
  const followActor = () => actors.get(view.followId)?.body.visible ? actors.get(view.followId) : actors.get('lead');
  function configureCamera() {
    const sway = swayNow(), follow = view.mode === 'follow' ? followActor()?.body.position.toArray() : null;
    const result = executionViewFrame(EXECUTION_MODULES, camera.aspect, { focus, zoom, mode: view.mode, yaw: view.yaw + sway.yaw, pitch: view.pitch + sway.pitch, follow });
    aim.fromArray(result.aim); cameraGoal.fromArray(result.position);
  }
  function rotate(yaw, pitch) {
    if (locked()) return false;
    if (view.mode === 'global') view = { ...view, mode: 'free' };
    view = { ...view, yaw: wrapYaw(view.yaw + yaw), pitch: clampPitch(view.pitch + pitch) };
    interactingUntil = performance.now() + 900; configureCamera();
    if (open && visible && !document.hidden && (still || reduced.matches)) draw(0);
    start(); return true;
  }
  function layoutDetails() {
    const module = modules.find(m => m.id === focus); if (!module) return;
    const cols = Math.max(2, Math.min(5, Math.floor((width - 24) / 140))), rows = Math.ceil(detail.length / cols);
    // The site cards occupy distinct rows/columns on a real plane in front of
    // the focused cluster. Their anchors interpolate out from that cluster.
    const distance = cameraGoal.z - (module.center.z + 35);
    const planeH = 2 * Math.tan(camera.fov * Math.PI / 360) * distance;
    const planeW = planeH * camera.aspect;
    detail.forEach((node, i) => {
      const object = sourceNodes.get(node.id); if (!object) return;
      const col = i % cols, row = Math.floor(i / cols), count = Math.min(cols, detail.length - row * cols);
      const top = focus === 'search' ? 88 : 45, bottom = 46;
      const pixelY = top + (row + .5) / rows * (height - top - bottom);
      object.goal.set(aim.x + ((col + .5) / count - .5) * planeW * .88,
        aim.y + (.5 - pixelY / height) * planeH, module.center.z + 35 + (i % 2) * 4);
    });
  }
  // Where the lead works right now: its own running calls and stages, never a
  // member's (job-N) call and never the router's own bookkeeping stages.
  function computeLeadSlots() {
    if (!scene || sceneFinished(scene)) return [];
    const rows = [...(scene.operations || []), ...(scene.pipeline || [])].filter(row => row.status === 'running' && !LEAD_STAGE.test(row.id));
    const ordered = [];
    for (const row of rows.slice().reverse()) { const id = row.module || 'create'; if (EXECUTION_MODULES.some(m => m.id === id) && !ordered.includes(id)) ordered.push(id); }
    return ordered;
  }
  function update(next, nextFocus, items = [], nextZoom = zoom) {
    if (scene?.runId !== next?.runId) { modules.forEach(m => { m.activity = { running: [] }; }); lastEvaluation = null; lastEvaluationStage = null; lastReview = ''; previousRunning = new Set(); for (const id of [...beams.keys()]) dropBeam(id); }
    const sameRun = scene?.runId === next?.runId;
    scene = next; focus = nextFocus; detail = items; zoom = clampZoom(nextZoom);
    if (locked()) { hoverRegion(null); canvas.style.cursor = ''; }
    for (const module of modules) module.activity = moduleActivity(scene, module.id);
    members = sceneMembers(scene); board = sceneHasBoard(scene); leadSlots = computeLeadSlots();
    // Evaluation and review moments flash the core; new or promoted candidates
    // send sparks from the search cluster. Only on change, only within a run.
    const evaluation = sceneEvaluation(scene);
    if (sameRun && evaluation.snapshot && evaluation.stageId !== lastEvaluationStage) {
      coreFlash = 1; coreFlashColor = 1;
      if (!reduced.matches && !still) evaluationChanges(lastEvaluation, evaluation.snapshot).slice(0, 8).forEach((change, i) =>
        travel(modules.find(m => m.id === 'search').center, corePosition, change.tier === 'primary' ? visualColor('scene-ffe4a3') : visualColor('scene-91b4c7'), SPARK_SECONDS, i * .12, change.tier === 'primary' ? 1.5 : 1));
    }
    lastEvaluation = evaluation.snapshot; lastEvaluationStage = evaluation.stageId;
    const review = (scene?.pipeline || []).filter(stage => /^goal-check:/.test(stage.id)).at(-1);
    const reviewKey = review ? `${review.id}:${review.status}` : '';
    if (sameRun && reviewKey && reviewKey !== lastReview && ['completed', 'failed'].includes(review.status)) { coreFlash = 1.4; coreFlashColor = review.status === 'completed' ? 1 : .45; }
    lastReview = reviewKey;
    // Members that just handed off send a pulse back to the core.
    const running = new Set(members.filter(m => m.running).map(m => m.id));
    if (sameRun && !reduced.matches && !still) for (const id of previousRunning) if (!running.has(id)) {
      const actor = actors.get('member:' + id.slice(9)); const member = members.find(m => m.id === id);
      if (actor?.body.visible) travel(actor.body.position, corePosition, roleColor(member?.role), RETURN_SECONDS, 0, 1.4);
    }
    previousRunning = running;
    const keys = new Set(items.map(n => n.id));
    for (const [id, object] of sourceNodes) if (!keys.has(id)) { world.remove(object.mesh, object.line); object.line.geometry.dispose(); object.line.material.dispose(); object.mesh.material.dispose(); sourceNodes.delete(id); }
    for (const node of items) if (!sourceNodes.has(node.id)) {
      const center = modules.find(m => m.id === focus)?.center || new T.Vector3();
      const material = new T.MeshBasicMaterial({ color: node.cited ? visualColor('scene-ffe4a3') : visualColor('scene-91b4c7') });
      const mesh = new T.Mesh(sphere, material); mesh.position.copy(center); world.add(mesh);
      const geometry = new T.BufferGeometry().setFromPoints([center, center]);
      const strand = new T.Line(geometry, new T.LineBasicMaterial({ color: visualColor('scene-a88b63'), transparent: true, opacity: .32 })); world.add(strand);
      sourceNodes.set(node.id, { mesh, goal: center.clone(), line: strand });
    }
    configureCamera(); layoutDetails(); generation++; interactingUntil = performance.now() + 900; if (open && visible && !document.hidden) draw(0); start();
  }
  const moduleCenter = id => modules.find(m => m.id === id)?.center || null;
  // Target anchors for every actor this frame. Without routing or evaluation
  // the lead keeps the original behavior: it rests at the last module.
  function plan() {
    const wanted = new Map(), pose = parseInt(scene?.restSeed || sceneKey(scene?.runId || 'idle'), 36) % 1000 / 120;
    const leadRest = board ? { key: 'core', center: corePosition, core: true } : { key: scene?.lastModule || 'compute', center: moduleCenter(scene?.lastModule) || moduleCenter('compute') };
    if (!scene) wanted.set('lead', { ...leadRest, key: 'compute', center: moduleCenter('compute'), active: false, pose });
    else if (!leadSlots.length) wanted.set('lead', { ...leadRest, active: false, pose });
    else leadSlots.forEach((id, i) => wanted.set(i ? 'lead:' + id : 'lead', { key: id, center: moduleCenter(id), active: true, pose }));
    members.filter(member => member.running).slice(0, MAX_MEMBER_ACTORS).forEach(member => wanted.set('member:' + member.index,
      { key: member.currentModule, center: moduleCenter(member.currentModule) || corePosition, active: !!member.activeOperation, member, pose }));
    return wanted;
  }
  function bezier(a, c, b, t, out) { const u = 1 - t; return out.set(u * u * a.x + 2 * u * t * c.x + t * t * b.x, u * u * a.y + 2 * u * t * c.y + t * t * b.y, u * u * a.z + 2 * u * t * c.z + t * t * b.z); }
  const scratch = new T.Vector3();
  function moveActors(dt, smoothing) {
    const wanted = plan(), instant = reduced.matches || still;
    const primary = actors.get('lead');
    for (const [id, want] of wanted) {
      const actor = actorFor(id, id.startsWith('member:') ? { thread: roleColor(want.member?.role), branch: roleColor(want.member?.role), tint: roleColor(want.member?.role) } : null);
      if (!actor.body.visible) {
        // Members are dispatched from the core; lead echoes split off the lead.
        actor.body.position.copy(id.startsWith('member:') ? corePosition : primary?.body.visible ? primary.body.position : want.center);
        actor.body.visible = true; actor.leaving = false; actor.anchorKey = '';
      }
      actor.leaving = false;
      if (actor.anchorKey !== want.key) {
        actor.anchorKey = want.key; actor.anchor = want.center.clone();
        actor.arc = instant ? null : { from: actor.body.position.clone(), control: actor.body.position.clone().lerp(want.center, .5).add(new T.Vector3(0, 70, 40)), t: 0 };
      }
      actor.active = want.active; actor.core = !!want.core;
      if (want.active) actor.phase += dt;
    }
    for (const [id, actor] of actors) {
      if (wanted.has(id) || !actor.body.visible) continue;
      // A finished member returns to the core and disappears there.
      if (!actor.leaving) { actor.leaving = true; actor.anchorKey = 'core'; actor.anchor = corePosition.clone(); actor.arc = instant || !id.startsWith('member:') ? null : { from: actor.body.position.clone(), control: actor.body.position.clone().lerp(corePosition, .5).add(new T.Vector3(0, 60, 30)), t: 0 }; }
      if (instant || !id.startsWith('member:') || !actor.arc) { actor.body.visible = false; continue; }
    }
    for (const [id, actor] of actors) {
      if (!actor.body.visible) continue;
      const index = [...actors.keys()].indexOf(id), phase = actor.active ? actor.phase : wanted.get(id)?.pose ?? 0;
      actor.organism.update(phase, elapsed, actor.active);
      const goal = actor.anchor.clone().add(actor.core || actor.leaving ? new T.Vector3(Math.sin(phase * .3 + index) * 6, 62 + Math.cos(phase * .3) * 4, 40)
        : new T.Vector3(Math.sin(phase * .42 + index) * 22, 23 + Math.cos(phase * .36 + index) * 17, 44 + Math.sin(phase * .9) * 4));
      if (actor.arc) {
        actor.arc.t = Math.min(1, actor.arc.t + dt / ARC_SECONDS);
        const eased = actor.arc.t < .5 ? 2 * actor.arc.t * actor.arc.t : 1 - (-2 * actor.arc.t + 2) ** 2 / 2;
        actor.body.position.copy(bezier(actor.arc.from, actor.arc.control, goal, eased, scratch));
        if (actor.arc.t >= 1) { actor.arc = null; if (actor.leaving) { actor.body.visible = false; continue; } }
      } else if (actor.leaving) { actor.body.visible = false; continue; }
      else actor.body.position.lerp(goal, smoothing);
      actor.body.rotation.z = Math.sin(phase * .28) * .45 + index * .36;
      const scale = id === 'lead' ? actor.core ? .72 : 1 : id.startsWith('lead:') ? .7 : 1.05; actor.body.scale.setScalar(scale);
    }
  }
  function drawBeams() {
    const running = members.filter(member => member.running).slice(0, MAX_MEMBER_ACTORS);
    const ids = new Set(running.map(member => 'member:' + member.index));
    for (const id of [...beams.keys()]) if (!ids.has(id)) dropBeam(id);
    for (const member of running) {
      const id = 'member:' + member.index, actor = actors.get(id); if (!actor?.body.visible) continue;
      const beam = beamFor(id, roleColor(member.role));
      beam.curve.v1.copy(corePosition).lerp(actor.body.position, .5).add(new T.Vector3(0, 45, 20)); beam.curve.v2.copy(actor.body.position);
      const position = beam.strand.geometry.attributes.position;
      for (let i = 0; i <= 32; i++) { beam.curve.getPoint(i / 32, scratch); position.setXYZ(i, scratch.x, scratch.y, scratch.z); }
      position.needsUpdate = true; beam.strand.geometry.computeBoundingSphere();
      beam.strand.material.opacity = member.activeOperation ? .5 : .3;
      beam.curve.getPoint((elapsed * .62 + member.index * .27) % 1, beam.pulse.position);
    }
  }
  function drawTravellers(dt) {
    for (let i = travellers.length - 1; i >= 0; i--) {
      const traveller = travellers[i]; traveller.age += dt;
      if (traveller.age < 0) continue;
      const t = traveller.age / traveller.seconds;
      if (t >= 1) { world.remove(traveller.mesh); traveller.mesh.material.dispose(); travellers.splice(i, 1); coreFlash = Math.max(coreFlash, .35); continue; }
      traveller.mesh.visible = true; traveller.curve.getPoint(t, traveller.mesh.position); traveller.mesh.material.opacity = .95 * Math.sin(Math.PI * Math.min(1, t * 1.15));
    }
  }
  function draw(dt) {
    const smoothing = reduced.matches || still ? 1 : 1 - Math.exp(-dt * (view.mode === 'follow' ? 3.2 : 6));
    if (view.mode !== 'free' || dragging) configureCamera();
    camera.position.lerp(cameraGoal, smoothing); target.lerp(aim, smoothing); camera.lookAt(target); camera.updateMatrixWorld();
    stars.rotation.y = Math.sin(elapsed * .017) * .017;
    const terminal = sceneFinished(scene);
    for (const [index, module] of modules.entries()) {
      const active = module.activity.running.length > 0, hovered = module.id === hoveredModule;
      module.cloud.material.opacity = active || hovered ? 1 : .62 + .09 * Math.sin(elapsed * .65 + index);
      module.edgeMaterial.opacity = active ? .5 : hovered ? .43 : .24;
      const positions = module.pulses.geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        const [a, b] = module.edges[(i * 7) % module.edges.length];
        const t = (elapsed * (active ? .65 : .12) + i * .133) % 1;
        projected.lerpVectors(a, b, t); positions.setXYZ(i, projected.x, projected.y, projected.z);
      }
      positions.needsUpdate = true;
    }
    moveActors(dt, smoothing); drawBeams(); drawTravellers(dt);
    // The core breathes while the lead coordinates and flashes on evaluation
    // and review; spokes brighten toward clusters that members are working in.
    coreFlash = Math.max(0, coreFlash - dt * 1.1);
    const coordinating = !terminal && members.some(member => member.running);
    core.rotation.y += dt * (coordinating ? .22 : .06); core.rotation.x = Math.sin(elapsed * .11) * .25;
    const breath = .5 + .5 * Math.sin(elapsed * (coordinating ? 2.2 : .7));
    coreRings.forEach((ring, i) => { ring.material.opacity = (board ? .26 : .14) + breath * .08 + coreFlash * .35 * coreFlashColor + (i % 3 ? 0 : .04); ring.rotation.z += dt * (.05 + i * .006); });
    coreHeart.material.opacity = (board ? .55 : .32) + coreFlash * .4 * coreFlashColor;
    const busy = new Set(members.filter(m => m.running && m.currentModule).map(m => m.currentModule));
    spokes.forEach((spoke, i) => { spoke.material.opacity = busy.has(modules[i].id) ? .22 : board ? .09 : .04; });
    conduits.forEach(({ curve, pulse }, i) => pulse.position.copy(curve.getPoint((elapsed * .065 + i * .17) % 1)));
    const labels = [];
    // When the viewer has turned the space, labels of clusters behind the
    // orbit center step back so the front ones stay readable.
    const turned = view.mode !== 'global' && (Math.abs(view.yaw) > .3 || Math.abs(view.pitch) > .25), pivot = camera.position.distanceTo(target);
    for (const module of modules) labels.push({ id: module.id, far: turned && module.center.distanceTo(camera.position) > pivot + 60, ...project(module.center.clone().add(new T.Vector3(0, module.id === 'files' ? 64 : -60, 35))) });
    labels.push({ id: 'core', core: true, ...project(corePosition.clone().add(new T.Vector3(0, -92, 30))) });
    for (const [id, actor] of actors) if (id.startsWith('member:') && actor.body.visible && !actor.leaving) labels.push({ id, actor: true, ...project(actor.body.position.clone().add(new T.Vector3(0, 30, 0))) });
    for (const [id, object] of sourceNodes) {
      object.mesh.position.lerp(object.goal, smoothing);
      const p = object.line.geometry.attributes.position; const center = modules.find(m => m.id === focus)?.center;
      if (center) { p.setXYZ(0, center.x, center.y, center.z); p.setXYZ(1, object.mesh.position.x, object.mesh.position.y, object.mesh.position.z); p.needsUpdate = true; }
      labels.push({ id, ...project(object.mesh.position), detail: true });
    }
    renderer.render(world, camera); frame++;
    host.dataset.frames = String(frame); host.dataset.camera = camera.position.toArray().map(n => n.toFixed(1)).join(',');
    host.dataset.zoom = zoom.toFixed(3); host.dataset.viewMode = view.mode; host.dataset.yaw = view.yaw.toFixed(3); host.dataset.pitch = view.pitch.toFixed(3);
    host.dataset.followId = view.mode === 'follow' ? followActor()?.id || '' : '';
    host.dataset.actors = [...actors].filter(([, actor]) => actor.body.visible).map(([id]) => id).join(',');
    host.dataset.beams = [...beams.keys()].join(',');
    host.dataset.activeModules = modules.filter(m => m.activity.running.length).map(m => m.id).join(',');
    host.dataset.mode = terminal ? 'ambient' : scene ? 'observing' : 'idle';
    onProject?.(labels, { width, height, focus, generation, locked: locked() });
  }
  function tick(now) { raf = 0; if (dead || !open || !visible || document.hidden) return;
    if (now - last >= 1000 / (now < interactingUntil || dragging ? 60 : 30) - 1) { const dt = Math.min(.1, (now - last) / 1000); last = now; if (!still && !reduced.matches) elapsed += dt; draw(dt); }
    if (!still && !reduced.matches) raf = requestAnimationFrame(tick);
  }
  function stop() { cancelAnimationFrame(raf); raf = 0; host.dataset.animating = 'false'; }
  function start() { if (dead || raf || !open || !visible || document.hidden) return; last = performance.now(); host.dataset.animating = 'true'; raf = requestAnimationFrame(tick); }
  function resize() { width = host.clientWidth; height = host.clientHeight; if (!width || !height) return;
    renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); configureCamera(); layoutDetails(); if (open && visible && !document.hidden) draw(.1); }
  const observer = new ResizeObserver(resize);
  const intersection = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting !== false; if (visible) start(); else stop(); });
  const visibility = () => { if (document.hidden) stop(); else start(); };
  const preference = () => { stop(); if (open && visible && !document.hidden) draw(.1); start(); };
  const lost = event => { event.preventDefault(); stop(); onFailure?.('三维渲染已暂停，仍可查看执行记录。'); };
  canvas.addEventListener('webglcontextlost', lost); document.addEventListener('visibilitychange', visibility); reduced.addEventListener('change', preference);
  host.append(canvas); observer.observe(host); intersection.observe(host); resize(); start();
  return { update, setOpen(value) { open = value; if (open) { resize(); start(); } else stop(); },
    setZoom(value) { zoom = clampZoom(value); configureCamera(); layoutDetails(); interactingUntil = performance.now() + 900;
      if (locked()) { hoverRegion(null); canvas.style.cursor = ''; }
      if (open && visible && !document.hidden && (still || reduced.matches)) draw(0); start(); },
    // Views: global (overview, slow sway), follow (an actor id such as lead or
    // member:2) and free (user orbit). Rotation is ignored while a detail is locked.
    setView(next = {}) {
      const mode = viewMode(next.mode ?? view.mode);
      view = { mode, yaw: wrapYaw(next.yaw ?? view.yaw), pitch: clampPitch(next.pitch ?? (mode === 'follow' && view.mode !== 'follow' ? FOLLOW_PITCH : view.pitch)), followId: typeof next.followId === 'string' ? next.followId : view.followId };
      if (mode === 'global' && next.yaw === undefined) view = { ...view, yaw: 0, pitch: 0 };
      interactingUntil = performance.now() + 1200; configureCamera();
      if (open && visible && !document.hidden && (still || reduced.matches)) draw(0); start();
    },
    rotate, getView: () => ({ ...view }),
    setStill(value) { if (still === value) return; still = value; preference(); },
    dispose() { dead = true; stop(); releasePicking(); releaseOrbit(); observer.disconnect(); intersection.disconnect(); document.removeEventListener('visibilitychange', visibility); reduced.removeEventListener('change', preference);
      for (const object of sourceNodes.values()) { object.line.geometry.dispose(); object.line.material.dispose(); object.mesh.material.dispose(); }
      for (const id of [...beams.keys()]) dropBeam(id);
      for (const traveller of travellers) traveller.mesh.material.dispose();
      for (const item of disposables) item.dispose(); renderer.dispose(); canvas.remove(); },
  };
}
