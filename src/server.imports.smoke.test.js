// Smoke test for server.js's `from './desktopStore.js'` import contract.
//
// Why this exists: 2026-04-27 Codex review caught a D-grade regression
// where server.js imported `restoreArtifact` + `purgeStaleSoftDeletes`
// from desktopStore.js, but the desktopStore re-export block hadn't been
// updated, so server boot would throw "does not provide an export named"
// at module-load time.  Service-layer tests stayed green because they
// imported the workspace module directly, bypassing the re-export.
//
// This test parses server.js's `from './desktopStore.js'` import block,
// dynamically imports desktopStore.js, and asserts every requested name
// is actually exported.  Any future server.js import that desktopStore
// forgets to re-export will turn this red — no more "all green but
// server doesn't boot" surprises.
//
// We do NOT actually start the HTTP server here (it would bind a port,
// open the SQLite store, and pull the whole runtime).  The contract we
// care about is purely "does the ESM module graph resolve?" which is
// fully observable from the static import list.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, 'server.js');

/**
 * Pull every named import that comes `from './desktopStore.js'` in
 * `server.js`, no matter how the source formats them (single line,
 * multi-line, `as` aliases, comments interleaved).
 *
 * Returns the *requested* names — i.e. what server.js asks for.  If
 * desktopStore aliases internally that's its own concern; we only
 * care that the binding is resolvable.
 */
function parseDesktopStoreImports(source) {
  const blocks = [];
  // Match: `import { ... } from './desktopStore.js'`.  The body uses
  // `[^}]` (not `[\s\S]*?`) so the regex can't accidentally swallow
  // an unrelated earlier import block while back-tracking — names
  // inside an ES module import list never contain `}`, so excluding
  // it is safe and keeps each import statement self-contained.
  const re = /import\s*\{([^}]*?)\}\s*from\s*['"]\.\/desktopStore\.js['"]/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    blocks.push(match[1]);
  }
  if (blocks.length === 0) return [];
  return blocks
    .join(',')
    .split(',')
    .map(raw => {
      // Strip line comments + block comments + whitespace.  Then handle
      // `name as alias` — the binding actually exposed on `server.js`'s
      // namespace is the alias, but the export it consumes from
      // desktopStore is the original name.
      const cleaned = raw
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim();
      if (!cleaned) return null;
      const [requested] = cleaned.split(/\s+as\s+/).map(s => s.trim());
      return requested;
    })
    .filter(Boolean);
}

test('parseDesktopStoreImports finds every import name (sanity check on the parser)', () => {
  const sample = `
    import {
      a,
      b as renamed,
      // comment
      c,
    } from './desktopStore.js';
  `;
  const parsed = parseDesktopStoreImports(sample);
  assert.deepEqual(parsed.sort(), ['a', 'b', 'c']);
});

test('every name server.js imports from desktopStore.js is actually re-exported', async () => {
  const source = readFileSync(SERVER_PATH, 'utf8');
  const requested = parseDesktopStoreImports(source);
  assert.ok(
    requested.length > 0,
    `parseDesktopStoreImports found 0 names — either server.js stopped importing from desktopStore (re-evaluate this test) or the parser regressed`,
  );

  const desktopStore = await import('./desktopStore.js');
  const missing = requested.filter(name => !(name in desktopStore));
  assert.deepEqual(
    missing,
    [],
    `desktopStore.js is missing re-exports server.js requires: ${missing.join(', ')}.\n` +
    `Add them to the appropriate \`export { … } from './services/...';\` block.`,
  );
});

test('server.js imports include the recently-added soft-delete bindings', async () => {
  // Defence-in-depth: even if the parser regressed, the two names that
  // tripped Codex 2026-04-27 must be reachable through desktopStore.
  // If a future refactor moves them, this test will alert us.
  const desktopStore = await import('./desktopStore.js');
  assert.equal(typeof desktopStore.restoreArtifact, 'function');
  assert.equal(typeof desktopStore.purgeStaleSoftDeletes, 'function');
});
