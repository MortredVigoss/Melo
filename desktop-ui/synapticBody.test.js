import test from 'node:test';
import assert from 'node:assert/strict';
import { createSynapticBody, synapticStrokes } from './synapticBody.js';

test('resting strokes continuously lift and lower only one or two arms across long sessions', () => {
  const visited = new Set();
  for (let t = 0; t < 200; t += .05) {
    const strokes = synapticStrokes(t), active = strokes.map((n, i) => n > 1e-6 ? i : -1).filter(i => i >= 0);
    assert.ok(active.length >= 1 && active.length <= 2);
    active.forEach(i => visited.add(i));
    assert.ok(strokes.every(n => Number.isFinite(n) && n >= 0 && n <= 1));
  }
  assert.equal(visited.size, 7);
  assert.equal(synapticStrokes(0)[0], 0);
  assert.ok(synapticStrokes(2.35)[0] > .999);
  assert.ok(synapticStrokes(4.7)[0] < 1e-10);
});

test('completed body moves actual branch geometry while roots and whole-body position stay fixed', t => {
  const organism = createSynapticBody(); t.after(() => organism.dispose());
  const { body } = organism;
  const positions = () => body.children.map(item => Array.from(item.geometry.attributes.position.array));
  organism.update(2, 0, false); const before = positions();
  organism.update(2, 2, false); const after = positions();
  let moved = 0, fixed = 0;
  before.forEach((layer, l) => {
    for (let i = 0; i < layer.length; i += 3) {
      const distance = Math.hypot(...layer.slice(i, i + 3).map((n, j) => after[l][i + j] - n));
      assert.ok(Number.isFinite(distance) && distance < 20);
      if (Math.hypot(layer[i], layer[i + 1]) < 16) assert.equal(distance, 0, 'central junction must remain anchored');
      if (distance > .001) moved++; else fixed++;
    }
  });
  assert.ok(moved > 20 && fixed > moved, `${moved} moved / ${fixed} fixed`);
  assert.deepEqual(body.position.toArray(), [0, 0, 0]);
  const versions = body.children.map(item => item.geometry.attributes.position.version);
  organism.update(2, 2, false);
  assert.deepEqual(body.children.map(item => item.geometry.attributes.position.version), versions, 'paused clock must avoid geometry uploads');
  organism.update(2, 25.2, false);
  positions().forEach((layer, l) => layer.forEach((value, i) => assert.ok(Math.abs(value - before[l][i]) < 1e-4, 'cycle returns smoothly to the same pose')));
});

test('an active region uses the same sparse strokes instead of waving every arm together', t => {
  const organism = createSynapticBody(); t.after(() => organism.dispose());
  const positions = () => Array.from(organism.body.children[1].geometry.attributes.position.array);
  organism.update(1, 1, true); const before = positions();
  organism.update(4, 1, true);
  assert.deepEqual(positions(), before, 'execution phase alone does not wave all resting branches');
  organism.update(5, 3, true);
  assert.notDeepEqual(positions(), before, 'ambient clock still strokes real geometry during execution');
});
