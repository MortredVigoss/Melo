import { visualColor } from '../src/shared/visualTokens.js';
import * as T from 'three';
import { EXECUTION_MODULES, moduleActivity, sceneFinished, sceneKey } from '/shared/executionScene.js';

import { createSynapticBody } from './synapticBody.js';
import { executionCameraFrame, clampZoom, wideViewport } from './executionViewport.js';
import { createExecutionPicker, bindExecutionPicking } from './executionPicking.js';

export function createExecutionScene3D(host, { onProject, onFailure, onSelect, onHover } = {}) {
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
    const organism = createSynapticBody(), body = organism.body;
    body.position.set(0, 0, 46); body.rotation.set(-.34, .20, 0);
    body.visible = false; world.add(body); disposables.push(organism);
    modules.push({ ...definition, center, group, nodes, edges, cloud, pulses, edgeMaterial, body, organism, phase: 0, activity: { running: [] } });
  }
  const conduits = [];
  for (let i = 0; i < modules.length; i++) {
    const a = modules[i].center, b = modules[(i + 1) % modules.length].center;
    const curve = new T.CubicBezierCurve3(a, a.clone().add(new T.Vector3(0, 90, -90)), b.clone().add(new T.Vector3(0, 80, -120)), b);
    const strand = line(curve.getPoints(60), visualColor('scene-ab8955'), .24);
    const pulse = new T.Mesh(sphere, new T.MeshBasicMaterial({ color: visualColor('scene-dabc84') })); disposables.push(pulse.material); world.add(pulse);
    conduits.push({ curve, strand, pulse });
  }
  let width = 1, height = 1, raf = 0, last = 0, elapsed = 0, frame = 0, dead = false, visible = true, open = true;
  let scene = null, focus = null, detail = [], still = false, generation = 0, zoom = 1, interactingUntil = 0;
  let hoveredModule = null;
  function hoverRegion(id) {
    if (hoveredModule === id) return;
    hoveredModule = id; onHover?.(id);
    if (!dead && (still || reduced.matches) && open && visible && !document.hidden) draw(0);
  }
  const pick = createExecutionPicker(camera, modules.flatMap(module => [
    { id: module.id, center: module.center, radius: 86 },
    { id: module.id, center: module.body.position, radius: 62, visible: () => module.body.visible },
  ]));
  const releasePicking = bindExecutionPicking(canvas, {
    pick, enabled: () => !dead && open && visible && !document.hidden && (!focus || wideViewport(zoom)),
    onSelect: id => { hoverRegion(null); onSelect?.(id); }, onHover: hoverRegion,
  });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const projected = new T.Vector3();
  function project(p) { projected.copy(p).project(camera); return { x: (projected.x + 1) * width / 2, y: (1 - projected.y) * height / 2, depth: projected.z, visible: projected.z > -1 && projected.z < 1 }; }
  function configureCamera() {
    const frame = executionCameraFrame(EXECUTION_MODULES, camera.aspect, focus, zoom);
    aim.fromArray(frame.aim); cameraGoal.fromArray(frame.position);
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
  function update(next, nextFocus, items = [], nextZoom = zoom) {
    if (scene?.runId !== next?.runId) modules.forEach(m => { m.phase = 0; });
    scene = next; focus = nextFocus; detail = items; zoom = clampZoom(nextZoom);
    if (focus && !wideViewport(zoom)) { hoverRegion(null); canvas.style.cursor = ''; }
    for (const module of modules) module.activity = moduleActivity(scene, module.id);
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
  function draw(dt) {
    const smoothing = reduced.matches || still ? 1 : 1 - Math.exp(-dt * 6);
    camera.position.lerp(cameraGoal, smoothing); target.lerp(aim, smoothing); camera.lookAt(target); camera.updateMatrixWorld();
    stars.rotation.y = Math.sin(elapsed * .017) * .017;
    const activeModules = modules.filter(m => m.activity.primaryRunning?.length);
    const previousBody = modules.find(m => m.body.visible)?.body;
    const previousPosition = previousBody?.position.clone();
    const terminal = sceneFinished(scene), pose = parseInt(scene?.restSeed || sceneKey(scene?.runId || 'idle'), 36) % 1000 / 120;
    for (const [index, module] of modules.entries()) {
      const active = module.activity.running.length > 0;
      const crawling = module.activity.primaryRunning?.length > 0;
      const hovered = module.id === hoveredModule;
      module.cloud.material.opacity = active || hovered ? 1 : .62 + .09 * Math.sin(elapsed * .65 + index);
      module.edgeMaterial.opacity = active ? .5 : hovered ? .43 : .24;
      const wasVisible = module.body.visible;
      module.body.visible = crawling || !activeModules.length && module.id === scene?.lastModule || !scene && index === 1;
      if (module.body.visible && !wasVisible) module.body.position.copy(previousPosition || module.center);
      if (crawling) module.phase += dt;
      const phase = crawling ? module.phase : pose;
      if (module.body.visible) {
        module.organism.update(phase, elapsed, crawling);
        const bodyGoal = module.center.clone().add(new T.Vector3(Math.sin(phase * .42 + index) * 22, 23 + Math.cos(phase * .36 + index) * 17, 44 + Math.sin(phase * .9) * 4));
        module.body.position.lerp(bodyGoal, smoothing);
        module.body.rotation.z = Math.sin(phase * .28) * .45 + index * .36;
      }
      const positions = module.pulses.geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        const [a, b] = module.edges[(i * 7) % module.edges.length];
        const t = (elapsed * (active ? .65 : .12) + i * .133) % 1;
        projected.lerpVectors(a, b, t); positions.setXYZ(i, projected.x, projected.y, projected.z);
      }
      positions.needsUpdate = true;
    }
    conduits.forEach(({ curve, pulse }, i) => pulse.position.copy(curve.getPoint((elapsed * .065 + i * .17) % 1)));
    const labels = [];
    for (const module of modules) labels.push({ id: module.id, ...project(module.center.clone().add(new T.Vector3(0, module.id === 'files' ? 64 : -60, 35))) });
    for (const [id, object] of sourceNodes) {
      object.mesh.position.lerp(object.goal, smoothing);
      const p = object.line.geometry.attributes.position; const center = modules.find(m => m.id === focus)?.center;
      if (center) { p.setXYZ(0, center.x, center.y, center.z); p.setXYZ(1, object.mesh.position.x, object.mesh.position.y, object.mesh.position.z); p.needsUpdate = true; }
      labels.push({ id, ...project(object.mesh.position), detail: true });
    }
    renderer.render(world, camera); frame++;
    host.dataset.frames = String(frame); host.dataset.camera = camera.position.toArray().map(n => n.toFixed(1)).join(',');
    host.dataset.zoom = zoom.toFixed(3);
    host.dataset.activeModules = modules.filter(m => m.activity.running.length).map(m => m.id).join(',');
    host.dataset.mode = terminal ? 'ambient' : scene ? 'observing' : 'idle';
    onProject?.(labels, { width, height, focus, generation });
  }
  function tick(now) { raf = 0; if (dead || !open || !visible || document.hidden) return;
    if (now - last >= 1000 / (now < interactingUntil ? 60 : 30) - 1) { const dt = Math.min(.1, (now - last) / 1000); last = now; if (!still && !reduced.matches) elapsed += dt; draw(dt); }
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
      if (focus && !wideViewport(zoom)) { hoverRegion(null); canvas.style.cursor = ''; }
      if (open && visible && !document.hidden && (still || reduced.matches)) draw(0); start(); },
    setStill(value) { if (still === value) return; still = value; preference(); },
    dispose() { dead = true; stop(); releasePicking(); observer.disconnect(); intersection.disconnect(); document.removeEventListener('visibilitychange', visibility); reduced.removeEventListener('change', preference);
      for (const object of sourceNodes.values()) { object.line.geometry.dispose(); object.line.material.dispose(); object.mesh.material.dispose(); }
      for (const item of disposables) item.dispose(); renderer.dispose(); canvas.remove(); },
  };
}
