import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { PerspectiveCamera, Vector3 } from 'three';
import { EXECUTION_MODULES } from '../src/shared/executionScene.js';
import { bindExecutionZoom, executionCameraFrame, MIN_ZOOM, MAX_ZOOM, DETAIL_ZOOM } from './executionViewport.js';

test('pulling back from every selection fits all five clusters, including narrow viewports', () => {
  for (const aspect of [.65, 1, 2.5, 4.5]) for (const { id } of EXECUTION_MODULES) {
    const frame = executionCameraFrame(EXECUTION_MODULES, aspect, id, 1);
    const camera = new PerspectiveCamera(46, aspect, 1, 3000);
    camera.position.fromArray(frame.position); camera.lookAt(new Vector3(...frame.aim)); camera.updateMatrixWorld();
    for (const { position } of EXECUTION_MODULES) for (const dx of [-85, 85]) for (const dy of [-70, 70]) {
      const p = new Vector3(position[0] + dx, position[1] + dy, position[2] + 70).project(camera);
      assert.ok(Math.abs(p.x) < .95 && Math.abs(p.y) < .9 && Math.abs(p.z) < 1, `${aspect} / ${id}: ${p.toArray()}`);
    }
    const close = executionCameraFrame(EXECUTION_MODULES, aspect, id, DETAIL_ZOOM);
    assert.deepEqual(close.aim, EXECUTION_MODULES.find(m => m.id === id).position);
  }
});

test('wheel, trackpad pinch and WebKit gestures share bounded zoom without hijacking nested scroll', t => {
  const dom = new JSDOM('<div id="stage" tabindex="0"><div class="execution-inspector"><pre>long output</pre></div><input></div>');
  t.after(() => dom.window.close());
  const stage = dom.window.document.querySelector('#stage');
  let zoom = DETAIL_ZOOM;
  const release = bindExecutionZoom(stage, { getZoom: () => zoom, setZoom: value => { zoom = value; }, overview: () => { zoom = 1; } });
  const wheel = (target, options) => {
    const event = new dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event); return event;
  };
  assert.ok(wheel(stage, { deltaY: 100 }).defaultPrevented); assert.ok(zoom < DETAIL_ZOOM);
  const afterOut = zoom;
  wheel(stage, { deltaY: -10, ctrlKey: true }); assert.ok(zoom > afterOut);
  const beforeNested = zoom;
  assert.equal(wheel(stage.querySelector('pre'), { deltaY: 120 }).defaultPrevented, false);
  assert.equal(wheel(stage, { deltaY: 10, deltaX: 100 }).defaultPrevented, false);
  assert.equal(zoom, beforeNested);
  const gesture = (type, scale) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'scale', { value: scale }); stage.dispatchEvent(event);
  };
  gesture('gesturestart', 1); gesture('gesturechange', .8);
  assert.equal(zoom, beforeNested * .8);
  wheel(stage, { deltaY: -30, ctrlKey: true }); assert.equal(zoom, beforeNested * .8, 'do not double-apply native pinch');
  gesture('gesturechange', .5); assert.equal(zoom, Math.max(MIN_ZOOM, beforeNested * .5));
  gesture('gestureend', .5);
  for (let i = 0; i < 60; i++) wheel(stage, { deltaY: -100, deltaMode: 1 });
  assert.equal(zoom, MAX_ZOOM);
  for (let i = 0; i < 60; i++) wheel(stage, { deltaY: 1, deltaMode: 2 });
  assert.equal(zoom, MIN_ZOOM);
  stage.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '0', bubbles: true })); assert.equal(zoom, 1);
  stage.querySelector('input').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '+', bubbles: true })); assert.equal(zoom, 1);
  release(); assert.equal(wheel(stage, { deltaY: 100 }).defaultPrevented, false); assert.equal(zoom, 1);
});

test('oversized result cards scroll for reading while pinching and the neural field retain zoom', t => {
  const dom = new JSDOM('<div class="execution-panel-viewport"><div id="stage"><a class="execution-source"><strong>Source</strong></a></div></div>');
  t.after(() => dom.window.close());
  const stage = dom.window.document.querySelector('#stage'), viewport = stage.parentElement;
  Object.defineProperty(viewport, 'clientHeight', { value: 240 });
  Object.defineProperty(viewport, 'scrollHeight', { value: 480, configurable: true });
  let zoom = DETAIL_ZOOM;
  const release = bindExecutionZoom(stage, { getZoom: () => zoom, setZoom: value => { zoom = value; }, overview: () => {} });
  t.after(release);
  const wheel = (target, ctrlKey = false) => {
    const event = new dom.window.WheelEvent('wheel', { deltaY: 40, ctrlKey, bubbles: true, cancelable: true });
    target.dispatchEvent(event); return event.defaultPrevented;
  };
  const title = stage.querySelector('strong');
  assert.equal(wheel(title), false); assert.equal(zoom, DETAIL_ZOOM);
  assert.equal(wheel(title, true), true); assert.ok(zoom < DETAIL_ZOOM);
  assert.equal(wheel(stage), true);
  Object.defineProperty(viewport, 'scrollHeight', { value: 240 });
  assert.equal(wheel(title), true, 'without overflow the whole scene remains zoomable');
});

// Plan C (2026-11-05): global / follow / free views.
import { executionViewFrame, orbitFit, orbitBasis, clampPitch, wrapYaw, viewMode, bindExecutionOrbit, globalSway, PITCH_LIMIT, ROTATE_STEP } from './executionViewport.js';
const projectAll = (frame, aspect) => {
  const camera = new PerspectiveCamera(46, aspect, 1, 3000);
  camera.position.fromArray(frame.position); camera.lookAt(new Vector3(...frame.aim)); camera.updateMatrixWorld();
  return point => new Vector3(...point).project(camera);
};

test('without rotation every view mode reproduces the existing frame exactly', () => {
  for (const aspect of [.65, 1, 2.5]) for (const focus of [null, ...EXECUTION_MODULES.map(m => m.id)]) for (const zoom of [MIN_ZOOM, 1, 1.2]) for (const mode of ['global', 'free', 'follow']) {
    const old = executionCameraFrame(EXECUTION_MODULES, aspect, focus, zoom);
    const view = executionViewFrame(EXECUTION_MODULES, aspect, { focus, zoom, mode });
    assert.deepEqual(view.aim, old.aim); assert.deepEqual(view.position, old.position);
  }
  assert.equal(orbitFit(EXECUTION_MODULES, 1.6), executionCameraFrame(EXECUTION_MODULES, 1.6, null, 1).position[2]);
});

test('rotated global and free views keep every cluster and its halo in frame', () => {
  for (const aspect of [.65, 1, 2.5]) for (let yaw = -Math.PI; yaw <= Math.PI; yaw += Math.PI / 6) for (const pitch of [-PITCH_LIMIT, -.3, 0, .3, PITCH_LIMIT]) {
    const frame = executionViewFrame(EXECUTION_MODULES, aspect, { mode: 'free', yaw, pitch, zoom: 1 });
    const project = projectAll(frame, aspect);
    for (const { position } of EXECUTION_MODULES) for (const d of [[-85, -70, 0], [85, 70, 0], [0, 0, 70], [0, 0, -70]]) {
      const p = project([position[0] + d[0], position[1] + d[1], position[2] + d[2]]);
      assert.ok(Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && Math.abs(p.z) < 1, `aspect ${aspect} yaw ${yaw.toFixed(2)} pitch ${pitch}: ${p.toArray()}`);
    }
    const { f, r, u } = orbitBasis(yaw, pitch);
    for (const [a, b] of [[f, r], [f, u], [r, u]]) assert.ok(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) < 1e-9, 'orthonormal basis');
  }
  for (const seconds of [0, 10, 40, 120, 600]) { const { yaw, pitch } = globalSway(seconds); assert.ok(Math.abs(yaw) <= .38 && Math.abs(pitch) <= .07); }
});

test('a zoomed-in detail is always straight on; follow chases its target and honors zoom', () => {
  for (const { id, position } of EXECUTION_MODULES) for (const mode of ['global', 'free', 'follow']) {
    const view = executionViewFrame(EXECUTION_MODULES, 1.5, { focus: id, zoom: DETAIL_ZOOM, mode, yaw: 1.2, pitch: .8, follow: [1, 2, 3] });
    assert.equal(view.locked, true); assert.equal(view.yaw, 0); assert.deepEqual(view.aim, position);
    assert.deepEqual(view.position, executionCameraFrame(EXECUTION_MODULES, 1.5, id, DETAIL_ZOOM).position);
  }
  const target = [-225, 81, 64];
  const near = executionViewFrame(EXECUTION_MODULES, 1.5, { mode: 'follow', follow: target, zoom: 1, yaw: .4, pitch: .22 });
  const nearer = executionViewFrame(EXECUTION_MODULES, 1.5, { mode: 'follow', follow: target, zoom: 2, yaw: .4, pitch: .22 });
  const distance = frame => Math.hypot(...frame.position.map((v, i) => v - frame.aim[i]));
  assert.deepEqual(near.aim, target); assert.ok(distance(near) < orbitFit(EXECUTION_MODULES, 1.5) * .5 && distance(near) >= 220);
  assert.ok(Math.abs(distance(nearer) - distance(near) / 2) < 1e-6);
  const project = projectAll(near, 1.5); const center = project(target);
  assert.ok(Math.abs(center.x) < 1e-6 && Math.abs(center.y) < 1e-6, 'the followed actor stays centered');
  assert.deepEqual(executionViewFrame(EXECUTION_MODULES, 1.5, { mode: 'follow', follow: [NaN, 0, 0] }).aim, executionCameraFrame(EXECUTION_MODULES, 1.5, null, 1).aim, 'no valid target falls back to the overview');
  assert.equal(clampPitch(5), PITCH_LIMIT); assert.equal(clampPitch(-5), -PITCH_LIMIT); assert.equal(clampPitch(NaN), 0);
  assert.ok(Math.abs(wrapYaw(Math.PI * 3) - Math.PI) < 1e-9 || Math.abs(wrapYaw(Math.PI * 3) + Math.PI) < 1e-9); assert.equal(wrapYaw(.5), .5);
  assert.equal(viewMode('cinematic'), 'global'); assert.equal(viewMode('follow'), 'follow');
});

test('pointer drags orbit past the threshold, clicks stay with the picker, arrows rotate only when allowed', t => {
  const dom = new JSDOM('<div id="stage" tabindex="0"><canvas></canvas></div>');
  t.after(() => dom.window.close());
  const stage = dom.window.document.querySelector('#stage'), canvas = stage.querySelector('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: 800 }); Object.defineProperty(canvas, 'clientHeight', { value: 400 });
  let enabled = true; const turns = []; let starts = 0, ends = 0;
  const release = bindExecutionOrbit(canvas, { enabled: () => enabled, onRotate: (yaw, pitch) => turns.push([yaw, pitch]), onDragStart: () => starts++, onDragEnd: () => ends++ });
  const fire = (type, x, y, extra = {}) => canvas.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, ...extra }));
  assert.equal(canvas.style.touchAction, 'pan-y');
  fire('pointerdown', 100, 100); fire('pointermove', 103, 102); fire('pointerup', 103, 102);
  assert.deepEqual(turns, []); assert.equal(starts, 0); assert.equal(ends, 0);
  fire('pointerdown', 100, 100); fire('pointermove', 140, 100); fire('pointermove', 180, 80); fire('pointerup', 180, 80);
  assert.equal(starts, 1); assert.equal(ends, 1); assert.ok(turns.length >= 1);
  assert.ok(turns.reduce((sum, [yaw]) => sum + yaw, 0) < 0, 'dragging right turns the view'); assert.ok(turns.at(-1)[1] < 0, 'dragging up tilts');
  enabled = false; turns.length = 0;
  fire('pointerdown', 100, 100); fire('pointermove', 200, 100); fire('pointerup', 200, 100);
  assert.deepEqual(turns, []);
  release();
  let zoom = 1; const rotations = []; let allow = true;
  const unbind = bindExecutionZoom(stage, { getZoom: () => zoom, setZoom: v => { zoom = v; }, overview: () => {}, rotate: (y, p) => { if (!allow) return false; rotations.push([y, p]); } });
  const key = k => { const event = new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); stage.dispatchEvent(event); return event; };
  assert.equal(key('ArrowRight').defaultPrevented, true); assert.equal(key('ArrowUp').defaultPrevented, true);
  assert.deepEqual(rotations, [[ROTATE_STEP, 0], [0, ROTATE_STEP]]);
  allow = false; assert.equal(key('ArrowLeft').defaultPrevented, false, 'a locked detail leaves arrows to the page');
  unbind();
  const plain = bindExecutionZoom(stage, { getZoom: () => zoom, setZoom: v => { zoom = v; }, overview: () => {} });
  assert.equal(key('ArrowLeft').defaultPrevented, false, 'without rotation wiring arrows behave as before'); plain();
});
