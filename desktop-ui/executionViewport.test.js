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
