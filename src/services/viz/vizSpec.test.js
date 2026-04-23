import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIZ_RENDERER_KEYS,
  listVizRendererKeys,
  buildVizSpecInstructions,
  extractVizSpec,
} from './vizSpec.js';

test('listVizRendererKeys returns every renderer in the allow-list', () => {
  const keys = listVizRendererKeys();
  assert.equal(keys.length, VIZ_RENDERER_KEYS.size);
  assert.ok(keys.includes('projectile'));
  assert.ok(keys.includes('tree'));
  assert.ok(keys.includes('molecule'));
});

test('buildVizSpecInstructions returns empty string when Demon is off', () => {
  assert.equal(buildVizSpecInstructions({ enabled: false }), '');
  assert.equal(buildVizSpecInstructions({ enabled: false, isRemoteChannel: true }), '');
  assert.equal(buildVizSpecInstructions(), '');
});

test('buildVizSpecInstructions returns empty string for remote channels', () => {
  assert.equal(
    buildVizSpecInstructions({ enabled: true, isRemoteChannel: true }),
    '',
  );
});

test('buildVizSpecInstructions lists renderers and sets the emit rules', () => {
  const text = buildVizSpecInstructions({ enabled: true });
  assert.match(text, /Interactive visualization mode \(Demon\) is ENABLED/);
  assert.match(text, /<viz-spec>…<\/viz-spec>/);
  assert.match(text, /projectile/);
  assert.match(text, /tree/);
  // Content allow list
  assert.match(text, /drag/i);
  assert.match(text, /tree, flowchart, or timeline/);
  // Deny list
  assert.match(text, /1\+1/);
  assert.match(text, /politic/i);
});

test('extractVizSpec returns null viz when no tag present', () => {
  const result = extractVizSpec('Just a plain reply.');
  assert.equal(result.viz, null);
  assert.equal(result.text, 'Just a plain reply.');
});

test('extractVizSpec strips tag even when payload is invalid JSON', () => {
  const result = extractVizSpec('Reply.\n<viz-spec>not valid json</viz-spec>');
  assert.equal(result.viz, null);
  assert.equal(result.text, 'Reply.');
});

test('extractVizSpec strips tag for remote channels without parsing', () => {
  const raw = `Reply.\n<viz-spec>{"renderer":"tree","kind":"tree","nodes":[{"id":"r","label":"R"}]}</viz-spec>`;
  const result = extractVizSpec(raw, { isRemoteChannel: true });
  assert.equal(result.viz, null);
  assert.equal(result.text, 'Reply.');
});

test('extractVizSpec rejects unknown renderer keys', () => {
  const raw = `Reply.\n<viz-spec>{"kind":"interactive","renderer":"not-a-real-renderer","params":[{"id":"v","label":"V","min":0,"max":1,"default":0.5}]}</viz-spec>`;
  const result = extractVizSpec(raw);
  assert.equal(result.viz, null);
  assert.equal(result.text, 'Reply.');
});

test('extractVizSpec normalizes an interactive spec with parameters', () => {
  const raw = [
    'Projectile motion depends on the initial velocity and launch angle.',
    '<viz-spec>',
    JSON.stringify({
      kind: 'interactive',
      renderer: 'projectile',
      title: 'Projectile motion',
      params: [
        { id: 'v0', label: 'v0', min: 0, max: 50, default: 20, unit: 'm/s' },
        { id: 'theta', label: 'θ', min: 0, max: 90, default: 45, unit: '°' },
      ],
      formula: 'y = v0 sin(θ) t − ½gt²',
    }),
    '</viz-spec>',
  ].join('\n');

  const { text, viz } = extractVizSpec(raw);
  assert.equal(text, 'Projectile motion depends on the initial velocity and launch angle.');
  assert.ok(viz);
  assert.equal(viz.kind, 'interactive');
  assert.equal(viz.renderer, 'projectile');
  assert.equal(viz.params.length, 2);
  assert.equal(viz.params[0].id, 'v0');
  assert.equal(viz.params[0].default, 20);
  assert.equal(viz.params[1].unit, '°');
  assert.match(viz.formula, /v0 sin/);
});

test('extractVizSpec clamps an out-of-range default to the slider range', () => {
  const raw = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'function-plot',
    params: [{ id: 'a', label: 'a', min: -5, max: 5, default: 99 }],
  })}</viz-spec>`;
  const { viz } = extractVizSpec(raw);
  assert.ok(viz);
  assert.equal(viz.params[0].default, 5);
});

test('extractVizSpec drops interactive specs with no valid params', () => {
  const raw = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'projectile',
    params: [{ id: 'x', label: 'x', min: 1, max: 1, default: 1 }], // min === max
  })}</viz-spec>`;
  const { viz } = extractVizSpec(raw);
  assert.equal(viz, null);
});

test('extractVizSpec normalizes a tree spec and filters dangling child refs', () => {
  const raw = `<viz-spec>${JSON.stringify({
    kind: 'tree',
    renderer: 'tree',
    title: 'Plan',
    nodes: [
      { id: 'r', label: 'Root', children: ['a', 'b', 'ghost'] },
      { id: 'a', label: 'A', children: ['a1'] },
      { id: 'a1', label: 'A1', children: [] },
      { id: 'b', label: 'B' },
    ],
  })}</viz-spec>`;
  const { viz } = extractVizSpec(raw);
  assert.ok(viz);
  assert.equal(viz.kind, 'tree');
  assert.equal(viz.nodes.length, 4);
  const root = viz.nodes.find(node => node.id === 'r');
  assert.deepEqual(root.children, ['a', 'b']); // 'ghost' was filtered
});

test('extractVizSpec rejects tree specs exceeding the node cap', () => {
  const nodes = [];
  for (let i = 0; i < 80; i += 1) {
    nodes.push({ id: `n${i}`, label: `n${i}` });
  }
  const raw = `<viz-spec>${JSON.stringify({
    kind: 'tree',
    renderer: 'tree',
    nodes,
  })}</viz-spec>`;
  const { viz } = extractVizSpec(raw);
  assert.equal(viz, null);
});

test('extractVizSpec drops all viz-spec tags globally, not just the first', () => {
  const raw = [
    'A',
    '<viz-spec>{"bogus":true}</viz-spec>',
    'B',
    '<viz-spec>{"kind":"tree","renderer":"tree","nodes":[{"id":"r","label":"R"}]}</viz-spec>',
  ].join('\n');
  const { text } = extractVizSpec(raw);
  assert.ok(!text.includes('<viz-spec>'));
  assert.match(text, /A/);
  assert.match(text, /B/);
});

test('extractVizSpec refuses oversized payloads', () => {
  const huge = 'x'.repeat(20 * 1024);
  const raw = `<viz-spec>{"noise":"${huge}"}</viz-spec>`;
  const { viz, text } = extractVizSpec(raw);
  assert.equal(viz, null);
  assert.equal(text, '');
});

// ─── Renderer-specific data pass-through (PR3 regression) ────────────────
// The original normalizer stripped every field it didn't explicitly know
// about, which silently turned molecule/timeline/etc. specs into empty
// cards. These tests pin down that atoms/bonds/expression/shape/fieldType/
// events now round-trip through extractVizSpec.

test('extractVizSpec preserves molecule atoms and bonds', () => {
  const raw = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'molecule',
    title: 'CO2',
    atoms: [
      { id: 'c', element: 'C', x: 0, y: 0 },
      { id: 'o1', element: 'O', x: -1.2, y: 0 },
      { id: 'o2', element: 'O', x: 1.2, y: 0 },
    ],
    bonds: [
      { from: 'c', to: 'o1', order: 2 },
      { from: 'c', to: 'o2', order: 2 },
    ],
  })}</viz-spec>`;
  const { viz } = extractVizSpec(raw);
  assert.ok(viz);
  assert.equal(viz.renderer, 'molecule');
  assert.equal(viz.atoms.length, 3);
  assert.equal(viz.atoms[0].element, 'C');
  assert.equal(viz.bonds.length, 2);
  assert.equal(viz.bonds[0].order, 2);
});

test('extractVizSpec allows molecule without params', () => {
  const raw = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'molecule',
    atoms: [{ id: 'h', element: 'H', x: 0, y: 0 }],
  })}</viz-spec>`;
  const { viz } = extractVizSpec(raw);
  assert.ok(viz);
  assert.deepEqual(viz.params, []);
});

test('extractVizSpec drops molecule specs with no atoms', () => {
  const raw = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'molecule',
    atoms: [],
  })}</viz-spec>`;
  const { viz } = extractVizSpec(raw);
  assert.equal(viz, null);
});

test('extractVizSpec drops molecule bonds pointing to unknown atom ids', () => {
  const raw = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'molecule',
    atoms: [
      { id: 'a', element: 'C', x: 0, y: 0 },
      { id: 'b', element: 'O', x: 1, y: 0 },
    ],
    bonds: [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'ghost' }, // ghost id → dropped
      { from: 'a', to: 'a' },     // self-loop → dropped
    ],
  })}</viz-spec>`;
  const { viz } = extractVizSpec(raw);
  assert.ok(viz);
  assert.equal(viz.bonds.length, 1);
});

test('extractVizSpec preserves function-plot expression', () => {
  const raw = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'function-plot',
    expression: 'a*sin(x) + b',
    params: [
      { id: 'a', label: 'a', min: -5, max: 5, default: 1 },
      { id: 'b', label: 'b', min: -5, max: 5, default: 0 },
    ],
  })}</viz-spec>`;
  const { viz } = extractVizSpec(raw);
  assert.ok(viz);
  assert.equal(viz.expression, 'a*sin(x) + b');
});

test('extractVizSpec rejects function-plot expressions with forbidden characters', () => {
  // Assignments, semicolons, brackets are outside the safe character class.
  // The expression is stripped but the spec survives so the renderer can
  // fall back to its default ("a·x + b").
  const raw = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'function-plot',
    expression: 'a = 1; return x',
    params: [{ id: 'a', label: 'a', min: -1, max: 1, default: 0 }],
  })}</viz-spec>`;
  const { viz } = extractVizSpec(raw);
  assert.ok(viz);
  assert.equal(viz.expression, undefined);
});

test('extractVizSpec preserves geometry shape', () => {
  const raw = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'geometry',
    shape: 'triangle',
    params: [
      { id: 'a', label: 'a', min: 1, max: 10, default: 5 },
      { id: 'b', label: 'b', min: 1, max: 10, default: 5 },
      { id: 'c', label: 'c', min: 1, max: 10, default: 5 },
    ],
  })}</viz-spec>`;
  const { viz } = extractVizSpec(raw);
  assert.ok(viz);
  assert.equal(viz.shape, 'triangle');
});

test('extractVizSpec preserves vector-field fieldType', () => {
  const raw = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'vector-field',
    fieldType: 'swirl',
    params: [{ id: 'strength', label: 'Strength', min: 0.1, max: 3, default: 1 }],
  })}</viz-spec>`;
  const { viz } = extractVizSpec(raw);
  assert.ok(viz);
  assert.equal(viz.fieldType, 'swirl');
});

test('extractVizSpec drops unknown vector-field fieldType', () => {
  const raw = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'vector-field',
    fieldType: 'evil',
    params: [{ id: 'strength', label: 'Strength', min: 0.1, max: 3, default: 1 }],
  })}</viz-spec>`;
  const { viz } = extractVizSpec(raw);
  assert.ok(viz);
  // unknown fieldType is silently dropped — renderer falls back to 'radial'
  assert.equal(viz.fieldType, undefined);
});

test('extractVizSpec preserves timeline events', () => {
  const raw = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'timeline',
    events: [
      { date: '1978', title: '改革开放', note: '邓小平' },
      { date: '2001', title: '加入 WTO' },
    ],
  })}</viz-spec>`;
  const { viz } = extractVizSpec(raw);
  assert.ok(viz);
  assert.equal(viz.events.length, 2);
  assert.equal(viz.events[0].note, '邓小平');
});

test('extractVizSpec drops timeline specs with no events', () => {
  const raw = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'timeline',
    events: [],
  })}</viz-spec>`;
  const { viz } = extractVizSpec(raw);
  assert.equal(viz, null);
});

// ── globe-flight ────────────────────────────────────────────────────────────
// Sanity checks for the 3D-globe renderer's backend contract. The renderer
// itself runs in the browser against Three.js; here we only care that the
// spec survives (or is rejected by) the vizSpec normalizer in the ways its
// data dependencies demand.

test('extractVizSpec preserves globe-flight origin + destination + optional fields', () => {
  const raw = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'globe-flight',
    title: 'SFO → NRT',
    origin: { lat: 37.6189, lng: -122.3750, label: 'SFO' },
    destination: { lat: 35.7647, lng: 140.3863, label: 'NRT' },
    flightNumber: 'UA837',
    subtitle: 'United 837 · 11h 05m',
    autoRotate: true,
    arcDuration: 10,
  })}</viz-spec>`;
  const { viz } = extractVizSpec(raw);
  assert.ok(viz);
  assert.equal(viz.renderer, 'globe-flight');
  assert.equal(viz.origin.label, 'SFO');
  assert.equal(viz.destination.label, 'NRT');
  assert.equal(viz.flightNumber, 'UA837');
  assert.equal(viz.subtitle, 'United 837 · 11h 05m');
  assert.equal(viz.autoRotate, true);
  assert.equal(viz.arcDuration, 10);
  // globe-flight is paramless — no sliders required.
  assert.deepEqual(viz.params, []);
});

test('extractVizSpec drops globe-flight specs missing origin or destination', () => {
  const missingDest = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'globe-flight',
    origin: { lat: 0, lng: 0 },
  })}</viz-spec>`;
  assert.equal(extractVizSpec(missingDest).viz, null);

  const missingOrigin = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'globe-flight',
    destination: { lat: 0, lng: 0 },
  })}</viz-spec>`;
  assert.equal(extractVizSpec(missingOrigin).viz, null);
});

test('extractVizSpec rejects globe-flight coordinates outside [-90,90] / [-180,180]', () => {
  // Latitude 200 is absurd — the normalizer should drop the spec rather than
  // produce a malformed 3D position on the client.
  const raw = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'globe-flight',
    origin: { lat: 200, lng: 0 },
    destination: { lat: 10, lng: 10 },
  })}</viz-spec>`;
  assert.equal(extractVizSpec(raw).viz, null);

  const rawLng = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'globe-flight',
    origin: { lat: 0, lng: 0 },
    destination: { lat: 0, lng: 999 },
  })}</viz-spec>`;
  assert.equal(extractVizSpec(rawLng).viz, null);
});

test('extractVizSpec drops out-of-range arcDuration on globe-flight', () => {
  // arcDuration outside [2, 60] is silently dropped — spec survives with the
  // renderer's default pacing.
  const raw = `<viz-spec>${JSON.stringify({
    kind: 'interactive',
    renderer: 'globe-flight',
    origin: { lat: 0, lng: 0 },
    destination: { lat: 10, lng: 10 },
    arcDuration: 500,
  })}</viz-spec>`;
  const { viz } = extractVizSpec(raw);
  assert.ok(viz);
  assert.equal(viz.arcDuration, undefined);
});

test('buildVizSpecInstructions documents the globe-flight renderer', () => {
  const text = buildVizSpecInstructions({ enabled: true });
  // The renderer name, its trigger phrase, and the key fields should all
  // appear so the model actually emits the spec for flight/route queries.
  assert.match(text, /globe-flight/);
  assert.match(text, /flight, trip, or route/);
  assert.match(text, /origin/);
  assert.match(text, /destination/);
  // And the paramless rule should mention it.
  assert.match(text, /globe-flight.*params/s);
});
