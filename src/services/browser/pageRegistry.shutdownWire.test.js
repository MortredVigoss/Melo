/**
 * Static wire-up guard for pageRegistry.closeAllPages → server.js shutdown().
 *
 * 2026-05-21 audit finding #2: pageRegistry exported closeAllPages but no
 * production code called it.  The doc string self-described the shutdown
 * integration ("Used by shutdown hooks (server.js onClose) and test
 * cleanup") but nobody actually wired it.  Stage 3 landed a week earlier
 * and every browser_open since then had been leaking a Browser handle +
 * WS connection on process exit.
 *
 * This test pins the wire-up at the file/string level rather than running
 * a real shutdown — the actual shutdown path is signal-driven (SIGTERM /
 * SIGINT) and tightly bound to process.exit(), making it impractical to
 * exercise in a unit test.  The static grep below is the cheapest possible
 * guard that catches the next "声明 ≠ 接入" regression (per MEMORY.md
 * feedback_must_wire_after_declare).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SERVER_PATH = join(__dirname, '..', '..', 'server.js');

test('server.js imports closeAllPages from pageRegistry', () => {
  const src = readFileSync(SERVER_PATH, 'utf8');
  assert.match(
    src,
    /import\s*\{\s*[^}]*closeAllPages[^}]*\}\s*from\s*['"]\.\/services\/browser\/pageRegistry\.js['"]/,
    'server.js must import closeAllPages from pageRegistry — without the import the wire-up below cannot exist',
  );
});

test('server.js shutdown() invokes closeAllPages', () => {
  const src = readFileSync(SERVER_PATH, 'utf8');
  // Scope the search to the shutdown() function body — any closeAllPages
  // call must live inside that function.  We find the shutdown function
  // start and slice forward until the next top-level `function ` or `// ─`
  // section divider.
  const shutdownIdx = src.indexOf('function shutdown(');
  assert.ok(shutdownIdx > -1, 'shutdown() function must exist in server.js');
  const tail = src.slice(shutdownIdx);
  // Look for the call inside shutdown's body — be liberal about whitespace
  // and surrounding statements (await / .catch / pageRegistryShutdown =).
  assert.match(
    tail,
    /closeAllPages\s*\(\s*\)/,
    'shutdown() must call closeAllPages() to release CDP page+browser handles',
  );
});

test('server.js wires pageRegistry teardown into the Promise.allSettled shutdown sequence', () => {
  // The wire pattern is: `const pageRegistryShutdown = closeAllPages().catch(...)`
  // then added to the `Promise.allSettled([...])` list alongside telegram /
  // discord / server-lock release.  This test enforces that pattern so a
  // future refactor that creates the promise but forgets to add it to
  // allSettled (so shutdown() returns before pages finish closing) fails
  // loudly.
  const src = readFileSync(SERVER_PATH, 'utf8');
  // 1) The promise variable exists
  assert.match(
    src,
    /pageRegistryShutdown\s*=\s*closeAllPages\(\)/,
    'shutdown() must capture closeAllPages() result in a named variable so it can be awaited',
  );
  // 2) It's included in the allSettled list — same shape as voiceShutdown
  // and the lock releases.  We slice from the allSettled call to its
  // closing bracket to scope the search.
  const allSettledStart = src.indexOf('Promise.allSettled([');
  assert.ok(allSettledStart > -1, 'shutdown() must use Promise.allSettled for teardown');
  const allSettledEnd = src.indexOf('])', allSettledStart);
  assert.ok(allSettledEnd > allSettledStart);
  const block = src.slice(allSettledStart, allSettledEnd);
  assert.match(
    block,
    /pageRegistryShutdown/,
    'pageRegistryShutdown must be added to Promise.allSettled so shutdown waits for CDP teardown before exit',
  );
});
