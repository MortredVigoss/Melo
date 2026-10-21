import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { galaxyParticles } from './galaxyBackdrop.js';

test('the galaxy is the same on every launch and stays inside its square', () => {
  const first = galaxyParticles(), second = galaxyParticles();
  assert.deepEqual(first, second, 'seeded: identical sky each launch');
  assert.notDeepEqual(galaxyParticles({ seed: 7 }).slice(0, 5), first.slice(0, 5));
  assert.equal(first.length, 5200);
  for (const point of first) {
    assert.ok(Math.hypot(point.x, point.y) <= 1.0001, 'inside the unit disc');
    assert.ok(point.size > 0 && point.alpha > 0 && point.alpha <= 1.2);
    assert.equal(point.color.length, 3);
  }
  // A bright core: far more stars near the centre than in an equal-area outer ring.
  const inner = first.filter(p => Math.hypot(p.x, p.y) < 0.2).length;
  const outer = first.filter(p => { const r = Math.hypot(p.x, p.y); return r > 0.8 && r < Math.sqrt(0.64 + 0.04); }).length;
  assert.ok(inner > outer * 3, `core ${inner} vs ring ${outer}`);
});

test('the galaxy assets load after the surface they replace and never block clicks', () => {
  const css = readFileSync(new URL('./galaxyBackdrop.css', import.meta.url), 'utf8');
  assert.equal((css.match(/pointer-events: none/g) || []).length, 2);
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('/galaxyBackdrop.css') > html.indexOf('/surfaceUnify.css'), 'loaded after the surface it replaces');
  assert.match(html, /<script type="module" src="\/galaxyBackdrop\.js"><\/script>/);
});
