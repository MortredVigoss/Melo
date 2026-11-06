import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import { SIZE, LAYOUT, WEB, layoutFor, placeLocal, outline, stageMargin, frameStage, projectToStage } from './warRoomLayout.js';
import { neuralCluster } from './warRoomCluster.js';

// The regions exactly as the scene builds them: same seeds, node counts
// (phones draw 560 nodes), tilts and scale.
const FOV = 42, CORE_R = 120 * 1.25;
const regionNodes = phone => Object.fromEntries(Object.entries(WEB).map(([id, web]) => {
  const cluster = neuralCluster({ color: '#d9a441', seed: web.seed, ganglia: web.ganglia, nodes: phone ? 560 : 1000, dust: 16, sprite: null });
  return [id, cluster.positions.map(p => placeLocal([p.x, p.y, p.z], web.tilt, SIZE))];
}));
const nodes = { wide: regionNodes(false), tall: regionNodes(true) };
const hulls = Object.fromEntries(Object.entries(nodes).map(([key, all]) => [key, Object.fromEntries(Object.entries(all).map(([id, list]) => [id, outline(list)]))]));
const place = (key, id, list) => list.map(p => [p[0] + LAYOUT[key][id][0], p[1] + LAYOUT[key][id][1], p[2] + LAYOUT[key][id][2]]);
const dirFrom = (yaw, pitch) => [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
// Stages the war room gets: desktop windows from small to large (the band and
// bars take ~300 px of height) and phones, upright and turned.
const STAGES = [[1024, 420], [1180, 460], [1280, 503], [1440, 603], [1512, 685], [1728, 820], [1920, 783], [2560, 1100], [393, 560], [393, 470], [430, 600], [360, 440], [852, 250]];
const frame = (key, width, height, dir, regions = hulls[key]) => frameStage({ points: Object.entries(regions).flatMap(([id, list]) => place(key, id, list)), spheres: [{ c: [0, 0, 0], r: CORE_R }], dir, fov: FOV, width, height });

test('a region is tilted exactly as three tilts its group', () => {
  for (const [id, web] of Object.entries(WEB)) {
    const euler = new T.Euler(...web.tilt);
    for (const p of [[83, 0, 0], [0, 64, 0], [0, 0, 70], [-40, 25, 61], [12, -50, -33]]) {
      const expected = new T.Vector3(...p).applyEuler(euler).multiplyScalar(SIZE).toArray(), actual = placeLocal(p, web.tilt, SIZE);
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(actual[i] - expected[i]) < 1e-9, `${id} ${p}: ${actual} vs ${expected}`);
    }
  }
});

test('a region outline encloses every one of its nodes, seen from any direction', () => {
  const directions = Array.from({ length: 4000 }, (_, i) => { const u = 2 * (i + .5) / 4000 - 1, a = i * 2.399963, ring = Math.sqrt(1 - u * u); return [Math.cos(a) * ring, u, Math.sin(a) * ring]; });
  for (const key of ['wide', 'tall']) for (const [id, list] of Object.entries(nodes[key])) {
    const hull = hulls[key][id];
    assert.ok(hull.length >= 20 && hull.length <= 160, `${key} ${id}: ${hull.length} outline points`);
    for (const d of directions) {
      const along = p => p[0] * d[0] + p[1] * d[1] + p[2] * d[2];
      assert.ok(Math.max(...hull.map(along)) >= Math.max(...list.map(along)), `${key} ${id}: a node lies outside the outline toward ${d.map(v => v.toFixed(2))}`);
    }
  }
});

test('the global view keeps every node of all five regions on the stage, with room kept for labels, at any window size and sway', () => {
  for (const [width, height] of STAGES) {
    const key = layoutFor(width / height), margin = stageMargin(width, height);
    // The global view sways ±0.18 rad of yaw and ±0.06 of pitch around 0.14.
    for (const yaw of [-.18, -.09, 0, .09, .18]) for (const pitch of [.08, .14, .2]) {
      const dir = dirFrom(yaw, pitch), camera = { ...frame(key, width, height, dir), dir, fov: FOV, width, height };
      for (const [id, list] of Object.entries(nodes[key])) {
        for (const [x, y] of projectToStage(place(key, id, list), camera)) {
          assert.ok(x >= 0 && x <= width && y >= 0 && y <= height, `${width}×${height} yaw ${yaw} pitch ${pitch}: ${id} node at ${x.toFixed(1)},${y.toFixed(1)}`);
        }
        for (const [x, y] of projectToStage(place(key, id, hulls[key][id]), camera)) {
          assert.ok(x >= margin.x - .5 && x <= width - margin.x + .5 && y >= margin.y - .5 && y <= height - margin.y + .5, `${width}×${height}: ${id} outline inside the label margin`);
        }
      }
    }
  }
});

test('turned by hand (free view), the framing still holds every region on the stage', () => {
  for (const [width, height] of [[1280, 503], [1440, 603], [393, 560]]) {
    const key = layoutFor(width / height);
    for (let yaw = -Math.PI; yaw < Math.PI; yaw += Math.PI / 6) for (const pitch of [-1, -.5, 0, .5, 1]) {
      const dir = dirFrom(yaw, pitch), camera = { ...frame(key, width, height, dir), dir, fov: FOV, width, height };
      for (const [id, list] of Object.entries(nodes[key])) for (const [x, y] of projectToStage(place(key, id, list), camera)) {
        assert.ok(x >= 0 && x <= width && y >= 0 && y <= height, `${width}×${height} yaw ${yaw.toFixed(2)} pitch ${pitch}: ${id} at ${x.toFixed(0)},${y.toFixed(0)}`);
      }
    }
  }
});

test('the framing uses the stage: the outlines reach its margin on at least one side', () => {
  for (const [width, height] of STAGES) {
    const key = layoutFor(width / height), margin = stageMargin(width, height), dir = dirFrom(0, .14);
    const camera = { ...frame(key, width, height, dir), dir, fov: FOV, width, height };
    const points = projectToStage(Object.entries(hulls[key]).flatMap(([id, list]) => place(key, id, list)), camera);
    const left = Math.min(...points.map(p => p[0])), right = Math.max(...points.map(p => p[0])), top = Math.min(...points.map(p => p[1])), bottom = Math.max(...points.map(p => p[1]));
    const slackX = Math.min(left - margin.x, width - margin.x - right), slackY = Math.min(top - margin.y, height - margin.y - bottom);
    assert.ok(Math.min(slackX / width, slackY / height) < .02, `${width}×${height}: ${slackX.toFixed(1)} px / ${slackY.toFixed(1)} px to spare`);
    assert.ok(Math.abs((left + right) / 2 - width / 2) < width * .02 && Math.abs((top + bottom) / 2 - height / 2) < height * .02, `${width}×${height}: centred`);
  }
});

test('framing nominal spheres (the old way) ran regions to the stage edge with no room for their labels', () => {
  // What the outline framing fixes, on the same geometry: the old fit took each
  // region as a sphere of 0.9 × its shell radius and kept 4% / 7% of the stage
  // free, so as the view swayed a region's nodes came within a few pixels of
  // the edge (dust and glow beyond them were cut) and its label was pushed
  // back over it. The new framing keeps every outline inside the label margin.
  let closest = Infinity;
  for (const [width, height] of STAGES.filter(([w, h]) => w / h >= 1.1)) for (const yaw of [-.18, 0, .18]) {
    const key = 'wide', dir = dirFrom(yaw, .14);
    const fit = frameStage({ points: [], spheres: [{ c: [0, 0, 0], r: CORE_R }, ...Object.keys(WEB).map(id => ({ c: LAYOUT[key][id], r: 83 * SIZE * .9 }))], dir, fov: FOV, width, height, margin: { x: width * .04, y: height * .07 } });
    const camera = { ...fit, dir, fov: FOV, width, height };
    for (const [id, list] of Object.entries(nodes[key])) for (const [x] of projectToStage(place(key, id, list), camera)) closest = Math.min(closest, Math.min(x, width - x) / width);
  }
  assert.ok(closest < .01, `the old framing left ${(closest * 100).toFixed(2)}% of the width at the closest edge`);
});
