// Charts of earlier conversations, mounted with the shape the server stores.
//
// New replies no longer carry charts (finalizeNode passes `enabled: false`),
// but messages that have one keep it and still mount it. Four renderers read
// fields the stored data never had, so those charts were broken every time:
// the projectile sliders threw, timeline events had no title, tree nodes no
// hover text, flowcharts no arrows. Nothing mounted a renderer in a test.
//
// Each fixture below goes through the real server-side validator first, so
// the test cannot drift from what is stored.

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { extractVizSpec } from '../../../src/services/viz/vizSpec.js';

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
// What a browser has. Deliberately only `escape`: a call to anything else on
// `CSS` throws here exactly as it does in WebKit.
globalThis.CSS = { escape: value => String(value).replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`) };
// Charts animate with requestAnimationFrame; nothing needs to be drawn here.
dom.window.requestAnimationFrame = () => 1;
dom.window.cancelAnimationFrame = () => {};

const { default: mountProjectile } = await import('./projectile.js');
const { default: mountTimeline } = await import('./timeline.js');
const { default: mountTree } = await import('./tree.js');
const { default: mountFlowchart } = await import('./flowchart.js');

// The spec exactly as the server would have stored it for this reply.
function stored(spec) {
  const { viz } = extractVizSpec(`text\n<viz-spec>${JSON.stringify(spec)}</viz-spec>`, { enabled: true });
  assert.ok(viz, `the server accepts this ${spec.renderer} spec`);
  return viz;
}

function host() {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

test('projectile: moving a slider updates its value, the readout and the trajectory', () => {
  const viz = stored({
    kind: 'interactive', renderer: 'projectile', title: 'Throw',
    params: [
      { id: 'v0', label: 'Speed', min: 1, max: 60, default: 20, unit: 'm/s' },
      { id: 'theta', label: 'Angle', min: 5, max: 85, default: 45, unit: '°' },
    ],
  });
  const element = host();
  const mounted = mountProjectile(element, viz);
  const readout = () => element.querySelector('[data-role="viz-readout"]').textContent;
  const before = readout();
  assert.match(before, /^Range \d/);

  const slider = element.querySelector('input.viz-param-slider[data-param-id="v0"]');
  slider.value = '40';
  // Before the fix this dispatch threw (TypeError: CSS.escapeHtml is not a
  // function) and nothing below it ran.
  slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(element.querySelector('[data-param-value-for="v0"]').textContent, '40.00 m/s');
  assert.notEqual(readout(), before, 'the trajectory was recomputed');
  assert.match(readout(), /^Range 163\.\d m/, 'v0 = 40 m/s at 45° lands about 163 m away');
  mounted.dispose();
});

test('timeline: every event shows its title', () => {
  const viz = stored({
    kind: 'timeline', renderer: 'timeline', title: 'Project',
    events: [
      { date: '2024-01-10', title: 'Kickoff', note: 'first meeting' },
      { date: '2024-03-02', title: 'Beta' },
      { date: '2024-06-20', title: 'Launch <now>' },
    ],
  });
  const element = host();
  mountTimeline(element, viz);
  const titles = [...element.querySelectorAll('.viz-timeline-title')].map(node => node.textContent);
  assert.deepEqual(titles, ['Kickoff', 'Beta', 'Launch <now>']);
  assert.ok(!element.innerHTML.includes('<now>'), 'titles are escaped');
});

test('tree: a node with a description gets its hover text', () => {
  const viz = stored({
    kind: 'tree', renderer: 'tree', title: 'Animals',
    nodes: [
      { id: 'root', label: 'Animals', children: ['cat', 'dog'] },
      { id: 'cat', label: 'Cat', desc: 'Sleeps all day', children: [] },
      { id: 'dog', label: 'Dog', children: [] },
    ],
  });
  const element = host();
  mountTree(element, viz);
  const hover = id => element.querySelector(`[data-node-id="${id}"] > title`)?.textContent;
  assert.equal(hover('cat'), 'Sleeps all day');
  assert.equal(hover('dog'), undefined, 'a node without a description has none');
});

test('flowchart: the steps are joined by arrows and stand in order, one row per step', () => {
  const viz = stored({
    kind: 'tree', renderer: 'flowchart', title: 'Review',
    nodes: [
      { id: 'write', label: 'Write', children: ['review'] },
      { id: 'review', label: 'Review', children: ['merge', 'write'] },
      { id: 'merge', label: 'Merge', children: [] },
    ],
  });
  assert.equal(viz.edges, undefined, 'what is stored has children, not edges');
  const element = host();
  mountFlowchart(element, viz);
  assert.equal(element.querySelectorAll('.viz-flow-edge').length, 3, 'one arrow per stored link');
  const rowOf = label => {
    const node = [...element.querySelectorAll('.viz-flow-node')].find(group => group.querySelector('text').textContent === label);
    return Number(node.querySelector('rect').getAttribute('y'));
  };
  // The link back from Review to Write is drawn, but must not push the first step down.
  assert.ok(rowOf('Write') < rowOf('Review'), 'Write stands above Review');
  assert.ok(rowOf('Review') < rowOf('Merge'), 'Review stands above Merge');
});

test('flowchart layout: a chart that is one loop starts at its first step; branches share a row; a later, longer path wins', () => {
  const rows = spec => {
    const element = host();
    mountFlowchart(element, spec);
    return Object.fromEntries([...element.querySelectorAll('.viz-flow-node')].map(group => [group.querySelector('text').textContent, Number(group.querySelector('rect, ellipse, polygon').getAttribute('y') ?? group.querySelector('ellipse')?.getAttribute('cy'))]));
  };
  const loop = rows({ nodes: [{ id: 'a', label: 'A', children: ['b'] }, { id: 'b', label: 'B', children: ['c'] }, { id: 'c', label: 'C', children: ['a'] }] });
  assert.ok(loop.A < loop.B && loop.B < loop.C, 'A, B, C from top to bottom');

  const branch = rows({ nodes: [{ id: 's', label: 'S', children: ['l', 'r'] }, { id: 'l', label: 'L', children: ['e'] }, { id: 'r', label: 'R', children: ['e'] }, { id: 'e', label: 'E', children: [] }] });
  assert.equal(branch.L, branch.R, 'the two branches stand side by side');
  assert.ok(branch.S < branch.L && branch.L < branch.E);

  // E is reached directly from S and through M; it belongs below M, and what follows E below E.
  const longer = rows({ nodes: [{ id: 's', label: 'S', children: ['e', 'm'] }, { id: 'e', label: 'E', children: ['z'] }, { id: 'm', label: 'M', children: ['e'] }, { id: 'z', label: 'Z', children: [] }] });
  assert.ok(longer.S < longer.M && longer.M < longer.E && longer.E < longer.Z);

  const unlinked = rows({ nodes: [{ id: 'x', label: 'X', children: [] }, { id: 'y', label: 'Y', children: [] }] });
  assert.equal(unlinked.X, unlinked.Y, 'steps without any link stay in one row, as before');
});

test('flowchart: a spec that does carry edges is drawn from them', () => {
  const element = host();
  mountFlowchart(element, {
    nodes: [{ id: 'a', label: 'A', children: ['b'] }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
    edges: [{ from: 'a', to: 'c', label: 'skip' }],
  });
  assert.equal(element.querySelectorAll('.viz-flow-edge').length, 1);
  assert.equal(element.querySelector('.viz-flow-edge-label').textContent, 'skip');
});
