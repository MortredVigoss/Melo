// Unit tests for the viz renderer dispatcher.
//
// The browser-facing helpers (computeVizSignature, renderVizMountHtml) are
// pure string/hash work — no DOM. They're the parts worth regression-
// testing here; the real renderers exercise canvas/SVG and live behind a
// full-browser integration harness that runs outside this test suite.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeVizSignature,
  renderVizMountHtml,
  listSupportedRenderers,
  isRenderableViz,
} from './vizRenderer.js';
import { VIZ_RENDERER_KEYS } from '../../src/services/viz/vizSpec.js';

test('frontend registry covers every backend-allowed renderer key', () => {
  const frontend = new Set(listSupportedRenderers());
  const missing = [];
  VIZ_RENDERER_KEYS.forEach(key => {
    if (!frontend.has(key)) missing.push(key);
  });
  assert.deepEqual(missing, [], `missing frontend renderer(s): ${missing.join(', ')}`);
});

test('listSupportedRenderers exposes the full set (projectile, tree, flowchart, …)', () => {
  const set = listSupportedRenderers();
  ['projectile', 'pendulum', 'wave', 'function-plot', 'tree', 'flowchart', 'timeline', 'molecule'].forEach(key => {
    assert.ok(set.includes(key), `missing ${key}`);
  });
});

test('computeVizSignature is stable across key order', () => {
  const a = computeVizSignature({ renderer: 'projectile', params: [{ id: 'v0', value: 20 }] });
  const b = computeVizSignature({ params: [{ value: 20, id: 'v0' }], renderer: 'projectile' });
  assert.equal(a, b);
});

test('computeVizSignature changes when the content changes', () => {
  const a = computeVizSignature({ renderer: 'projectile', params: [{ id: 'v0', value: 20 }] });
  const b = computeVizSignature({ renderer: 'projectile', params: [{ id: 'v0', value: 21 }] });
  assert.notEqual(a, b);
});

test('computeVizSignature returns empty string for non-objects', () => {
  assert.equal(computeVizSignature(null), '');
  assert.equal(computeVizSignature(undefined), '');
  assert.equal(computeVizSignature('string'), '');
});

test('renderVizMountHtml returns an empty string for unsupported renderers', () => {
  assert.equal(renderVizMountHtml('m1', { renderer: 'not-real' }), '');
  assert.equal(renderVizMountHtml('m1', null), '');
  assert.equal(renderVizMountHtml('m1', {}), '');
});

test('renderVizMountHtml emits a mount shell with message id + signature', () => {
  const html = renderVizMountHtml('msg-123', {
    renderer: 'projectile',
    params: [{ id: 'v0', min: 0, max: 50, default: 20, value: 20 }],
  });
  assert.match(html, /data-viz-mount/);
  assert.match(html, /data-message-id="msg-123"/);
  assert.match(html, /data-viz-signature="[a-z0-9]+"/);
});

test('renderVizMountHtml sanitizes message-id quote characters', () => {
  const html = renderVizMountHtml('id-with-"quote', { renderer: 'tree', nodes: [] });
  // Quote char must not escape the attribute.
  assert.ok(!html.includes('"quote'));
});

test('renderVizMountHtml matches the supported-renderers set', () => {
  listSupportedRenderers().forEach(renderer => {
    const html = renderVizMountHtml('any', { renderer });
    assert.match(html, /data-viz-mount/, `renderer ${renderer} should produce a mount`);
  });
});

test('renderVizMountHtml tags scene3d renderers with the scene3d family', () => {
  // The CSS uses `[data-renderer-family="scene3d"]` to reserve layout space
  // up-front so the thread doesn't bounce when the WebGL canvas hydrates a
  // tick after the first render. If this attribute regresses, the
  // scroll-bounce bug comes back.
  const html = renderVizMountHtml('m', {
    renderer: 'globe-flight',
    origin: { lat: 0, lng: 0 },
    destination: { lat: 10, lng: 10 },
  });
  assert.match(html, /data-renderer="globe-flight"/);
  assert.match(html, /data-renderer-family="scene3d"/);
});

test('renderVizMountHtml tags 2D renderers with the flat family', () => {
  const html = renderVizMountHtml('m', {
    renderer: 'projectile',
    params: [{ id: 'v0', min: 0, max: 50, default: 20 }],
  });
  assert.match(html, /data-renderer-family="flat"/);
});

// ── isRenderableViz: contract that gates the chat-render anchor scope. ──
//
// The render() loop calls captureThreadAnchor for every chat that contains
// a "renderable" viz. If this predicate disagrees with renderVizMountHtml's
// real condition, then either:
//   (a) chats with legacy/invalid metadata enable the anchor + 5-retry
//       restoreThreadAnchor loop for nothing (Codex C-grade gate flagged
//       this 2026-05-05 — was the original bug), OR
//   (b) chats with real viz cards skip the anchor and bounce on hydrate.
// These tests pin the contract so the three call sites can never drift.

test('isRenderableViz: rejects nullish / non-object / empty input', () => {
  assert.equal(isRenderableViz(null), false);
  assert.equal(isRenderableViz(undefined), false);
  assert.equal(isRenderableViz('string'), false);
  assert.equal(isRenderableViz(42), false);
  assert.equal(isRenderableViz({}), false);
});

test('isRenderableViz: rejects legacy metadata that has no renderer field', () => {
  // Legacy mermaid-style metadata is preserved by the hydration layer
  // (older threads carry it on assistant messages) but never renders to a
  // mount. Must NOT count as renderable — otherwise the anchor scope leaks
  // back to plain text chats and re-introduces the cursor-jump + jank.
  assert.equal(isRenderableViz({ type: 'mermaid', source: 'graph TD; A-->B' }), false);
  assert.equal(isRenderableViz({ source: 'foo' }), false);
});

test('isRenderableViz: rejects unknown renderer names', () => {
  assert.equal(isRenderableViz({ renderer: 'not-real' }), false);
  assert.equal(isRenderableViz({ renderer: '' }), false);
  assert.equal(isRenderableViz({ renderer: null }), false);
});

test('isRenderableViz: accepts every supported renderer in the registry', () => {
  listSupportedRenderers().forEach(renderer => {
    assert.equal(
      isRenderableViz({ renderer }),
      true,
      `renderer ${renderer} should be renderable`,
    );
  });
});

test('isRenderableViz agrees with renderVizMountHtml on every input shape', () => {
  // Cross-check: renderable === produces non-empty HTML. If these ever
  // diverge, the anchor scope gate will lie.
  const samples = [
    null,
    undefined,
    {},
    { renderer: 'not-real' },
    { type: 'mermaid', source: 'foo' },
    { renderer: 'projectile' },
    { renderer: 'tree', nodes: [] },
    { renderer: 'globe-flight', origin: { lat: 0, lng: 0 }, destination: { lat: 1, lng: 1 } },
  ];
  for (const viz of samples) {
    const renderable = isRenderableViz(viz);
    const html = renderVizMountHtml('m', viz);
    assert.equal(
      renderable,
      html !== '',
      `disagreement on ${JSON.stringify(viz)}: isRenderableViz=${renderable}, html.empty=${html === ''}`,
    );
  }
});
