// fileSafetyGate.production.test.js — pin the production wiring so a
// future refactor cannot silently drop it.
//
// Why this exists: Phase 2A/2B/2C/2D drove fileSafetyGate.js through 13
// rounds of Codex review on backend behaviour, but the entire production
// path (server.js route + desktop-ui SSE handler) was missing — the gate
// fired prompts that nothing was listening for. Phase 3a wired it up.
// This test pins the wiring as a static-source contract: rip out the
// dispatch and the test goes red, exactly the signal we needed during
// the missing-wiring period.
//
// We do NOT boot the server / spin up the UI here. The risk we're
// guarding against is a refactor that loses the discriminator branch,
// which is fully observable from the source text itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const serverSrc = readFileSync(join(repoRoot, 'src', 'server.js'), 'utf8');
const appSrc = readFileSync(join(repoRoot, 'desktop-ui', 'app.js'), 'utf8');

test('server.js imports resolveFileSafety from fileSafetyGate', () => {
  const ok = /import\s*\{\s*resolveFileSafety\s*\}\s*from\s*['"]\.\/safety\/fileSafetyGate\.js['"]/.test(serverSrc);
  assert.ok(ok, 'server.js must import { resolveFileSafety } from ./safety/fileSafetyGate.js');
});

test('server.js permission-response route branches on kind === "file_safety"', () => {
  // The production-wiring gap was that the route only ever called
  // resolvePermission. The fix routes file_safety prompts to a
  // separate resolver. Pin the dispatch so a refactor can't quietly
  // collapse the branches.
  const branchRe = /if\s*\(\s*kind\s*===\s*['"]file_safety['"]\s*\)/;
  assert.ok(branchRe.test(serverSrc), 'permission-response must branch on kind === "file_safety"');
  assert.ok(/resolveFileSafety\s*\(\s*requestId\s*,/.test(serverSrc),
    'kind=file_safety branch must call resolveFileSafety(requestId, ...)');
});

test('server.js forwards confirmInput and persistent fields to resolveFileSafety', () => {
  // confirmInput unlocks delete stage 2; persistent unlocks Phase 3b
  // "always allow" rules. If a later edit drops either field from the
  // route body deconstruction, file-safety dialogs lose features
  // silently. Cheap to pin.
  assert.ok(/confirmInput\s*=\s*['"]?['"]?/.test(serverSrc),
    'route must accept confirmInput in the response body');
  assert.ok(/persistent\s*=\s*false/.test(serverSrc),
    'route must accept persistent flag (default false)');
});

test('server.js exposes /api/safety/file-allowlist GET + remove endpoints', () => {
  assert.ok(serverSrc.includes("url.pathname === '/api/safety/file-allowlist'"),
    'list endpoint missing');
  assert.ok(serverSrc.includes("url.pathname === '/api/safety/file-allowlist/remove'"),
    'remove endpoint missing');
});

test('desktop-ui/app.js dispatches tool_permission events on payload.kind === "file_safety"', () => {
  // Pre-Phase-3a, the SSE handler destructured `{ requestId, toolId, args }`
  // and dropped any payload that lacked toolId — which was every
  // file_safety prompt. The fix branches on payload.kind. Pin it.
  assert.ok(/payload\.kind\s*===\s*['"]file_safety['"]/.test(appSrc),
    'SSE handler must branch on payload.kind === "file_safety"');
});

test('desktop-ui/app.js sends kind: "file_safety" back through permission-response', () => {
  // The response side mirrors the discriminator. Without it the server
  // route falls through to the legacy resolvePermission path and
  // file-safety prompts never resolve.
  assert.ok(/kind:\s*['"]file_safety['"]/.test(appSrc),
    'file-safety responses must carry kind: "file_safety" so the server routes them correctly');
});

test('desktop-ui/app.js renders a file-safety dialog for kind === "file_safety" entries', () => {
  // The permission queue holds two shapes (tool-runner + file_safety).
  // The renderer must dispatch on entry.kind so file_safety prompts
  // get the file-safety layout instead of the legacy tool-runner one.
  assert.ok(/entry\.kind\s*===\s*['"]file_safety['"]/.test(appSrc),
    'renderToolPermissionDialog must dispatch to renderFileSafetyDialog for file_safety entries');
});

test('desktop-ui/app.js exposes the Safety customize section + Refresh/Revoke actions', () => {
  // Phase 3c management UI. If a future Customize-pane refactor drops
  // the section button, users lose the only path to revoke persistent
  // grants short of editing config.json.
  assert.ok(/data-section="safety"/.test(appSrc), 'safety section button missing');
  assert.ok(/refresh-safety-allowlist/.test(appSrc), 'refresh-safety-allowlist action missing');
  assert.ok(/safety-allowlist-remove/.test(appSrc), 'safety-allowlist-remove action missing');
});
