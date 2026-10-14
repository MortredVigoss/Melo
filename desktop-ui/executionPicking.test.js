import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { PerspectiveCamera, Vector3 } from 'three';
import { EXECUTION_MODULES } from '../src/shared/executionScene.js';
import { executionCameraFrame } from './executionViewport.js';
import { createExecutionPicker, bindExecutionPicking } from './executionPicking.js';

test('cluster picking follows camera zoom, aspect and depth, including the gaps in a wire cluster', () => {
  const regions = EXECUTION_MODULES.map(m => ({ id: m.id, center: new Vector3(...m.position), radius: 86 }));
  for (const [width, height] of [[1000, 400], [400, 650]]) for (const zoom of [.65, 1, 1.18]) {
    const camera = new PerspectiveCamera(46, width / height, 1, 3000);
    const frame = executionCameraFrame(EXECUTION_MODULES, width / height, 'search', zoom);
    camera.position.fromArray(frame.position); camera.lookAt(new Vector3(...frame.aim)); camera.updateMatrixWorld();
    const pick = createExecutionPicker(camera, regions);
    for (const region of regions) {
      const p = region.center.clone().project(camera);
      assert.equal(pick((p.x + 1) * width / 2, (1 - p.y) * height / 2, width, height), region.id);
    }
    assert.equal(pick(0, 0, width, height), null);
    assert.equal(pick(-10, 20, width, height), null);
    assert.equal(pick(0, 0, 0, 0), null);
  }
  const camera = new PerspectiveCamera(46, 1, 1, 3000); camera.position.z = 500; camera.updateMatrixWorld();
  const pick = createExecutionPicker(camera, [
    { id: 'far', center: new Vector3(0, 0, -100), radius: 50 },
    { id: 'hidden', center: new Vector3(0, 0, 200), radius: 50, visible: () => false },
    { id: 'near', center: new Vector3(0, 0, 100), radius: 50 },
  ]);
  assert.equal(pick(200, 200, 400, 400), 'near');
});

test('cluster selection accepts a primary click but rejects drags, zoom gestures and disabled detail views', t => {
  const dom = new JSDOM('<canvas></canvas>'); t.after(() => dom.window.close());
  const canvas = dom.window.document.querySelector('canvas'), selected = [];
  canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 100 });
  let enabled = true, hovered;
  const release = bindExecutionPicking(canvas, { pick: (x, y) => x >= 0 && x < 70 && y >= 0 && y < 70 ? 'search' : null,
    enabled: () => enabled, onSelect: id => selected.push(id), onHover: id => { hovered = id; } });
  const pointer = (type, x = 40, button = 0) => canvas.dispatchEvent(new dom.window.MouseEvent(type, { clientX: x, clientY: 45, button }));
  pointer('pointermove'); assert.equal(hovered, 'search'); assert.equal(canvas.style.cursor, 'pointer');
  pointer('pointerdown'); pointer('pointerup'); assert.deepEqual(selected, ['search']);
  pointer('pointerdown', 40, 2); pointer('pointerup', 40, 2);
  pointer('pointerdown'); pointer('pointermove', 55); pointer('pointerup');
  pointer('pointerdown'); canvas.dispatchEvent(new dom.window.Event('wheel')); pointer('pointerup');
  pointer('pointerdown'); canvas.dispatchEvent(new dom.window.Event('gesturestart')); pointer('pointerup');
  pointer('pointerdown'); pointer('pointercancel'); pointer('pointerup');
  enabled = false; pointer('pointerdown'); pointer('pointerup'); pointer('pointermove');
  assert.equal(hovered, null); assert.deepEqual(selected, ['search']);
  enabled = true; release(); pointer('pointerdown'); pointer('pointerup'); assert.deepEqual(selected, ['search']);
});
