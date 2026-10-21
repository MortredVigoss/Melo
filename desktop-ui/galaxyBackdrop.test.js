import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { galaxyParticles, RING_RADIUS } from './galaxyBackdrop.js';

test('the galaxy is the same on every launch: a bright centre and an outer ring with a quiet gap', () => {
  const first = galaxyParticles(), second = galaxyParticles();
  assert.deepEqual(first, second, 'seeded: identical sky each launch');
  assert.notDeepEqual(galaxyParticles({ seed: 7 }).slice(0, 5), first.slice(0, 5));
  assert.equal(first.length, 14000);
  for (const point of first) {
    assert.ok(Math.hypot(point.x, point.y) <= 1.0001, 'inside the unit disc');
    assert.ok(point.size > 0 && point.alpha > 0 && point.alpha <= 1);
    assert.equal(point.color.length, 3);
  }
  // Stars per unit area in a band of radii (x,y back to round coordinates).
  const density = (from, to) => first.filter(p => { const r = Math.hypot(p.x, p.y / (p.part === 'halo' ? 1 : 0.9)); return r >= from && r < to; }).length / (to * to - from * from);
  const centre = density(0, 0.15), gap = density(0.3, 0.45), ring = density(RING_RADIUS - 0.06, RING_RADIUS + 0.06), outside = density(0.82, 1);
  assert.ok(centre > ring * 2, `the centre is the densest (${centre} vs ring ${ring})`);
  assert.ok(ring > gap * 4, `the ring stands out from the gap (${ring} vs ${gap})`);
  assert.ok(ring > outside * 4, `and from the space outside it (${ring} vs ${outside})`);
});

test('the galaxy assets load after the surface they replace and never block clicks', () => {
  const css = readFileSync(new URL('./galaxyBackdrop.css', import.meta.url), 'utf8');
  assert.equal((css.match(/pointer-events: none/g) || []).length, 2);
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('/galaxyBackdrop.css') > html.indexOf('/surfaceUnify.css'), 'loaded after the surface it replaces');
  assert.match(html, /<script type="module" src="\/galaxyBackdrop\.js"><\/script>/);
});
