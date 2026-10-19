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
// The send pipeline (SSE tool_permission handling) moved to the chat feature (P2c).
const chatSrc = readFileSync(join(repoRoot, 'desktop-ui', 'features', 'chat', 'controller.js'), 'utf8');

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
  assert.ok(serverSrc.includes('paths: ["/api/safety/file-allowlist"]'),
    'list endpoint missing');
  assert.ok(serverSrc.includes('paths: ["/api/safety/file-allowlist/remove"]'),
    'remove endpoint missing');
});

test('the chat send pipeline (desktop-ui/features/chat) dispatches tool_permission events on payload.kind === "file_safety"', () => {
  // Pre-Phase-3a, the SSE handler destructured `{ requestId, toolId, args }`
  // and dropped any payload that lacked toolId — which was every
  // file_safety prompt. The fix branches on payload.kind. Pin it.
  assert.ok(/payload\.kind\s*===\s*['"]file_safety['"]/.test(chatSrc),
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

// ── Phase 4 — domain cookies + image-intent gate ──────────────────────

test('server.js exposes /api/settings/domain-cookies GET / upsert / remove endpoints', () => {
  assert.ok(serverSrc.includes('paths: ["/api/settings/domain-cookies"]'),
    'GET listing endpoint missing');
  assert.ok(serverSrc.includes('paths: ["/api/settings/domain-cookies/upsert"]'),
    'upsert endpoint missing');
  assert.ok(serverSrc.includes('paths: ["/api/settings/domain-cookies/remove"]'),
    'remove endpoint missing');
});

test('server.js GET endpoint omits cookie values from the response shape', () => {
  // Defence-in-depth: the listing UI must never receive the secret.
  // Pin the response uses host / length / tail only and never the
  // raw cookies map. A refactor that flips back to the full map
  // should light up red.
  //
  // We split on the next route's pathname so we don't accidentally
  // match the upsert / remove blocks below.
  const startIdx = serverSrc.indexOf('paths: ["/api/settings/domain-cookies"]');
  const endIdx = serverSrc.indexOf('paths: ["/api/settings/domain-cookies/upsert"]', startIdx);
  assert.ok(startIdx > 0 && endIdx > startIdx, 'GET endpoint block boundaries not found');
  const block = serverSrc.slice(startIdx, endIdx);
  // Identifiers in the response shape can appear as `name:` (explicit
  // property) or as bare shorthand inside `{ ..., name }` — match by
  // word boundary either way.
  assert.ok(/\bhost\b/.test(block), 'GET response shape must include host field');
  assert.ok(/\blength\b/.test(block), 'GET response shape must include length field');
  // Codex review follow-up (Phase 4 🟠 2026-05-04): the GET response
  // must use a NON-REVERSIBLE fingerprint (sha256 prefix), never a
  // tail / suffix / prefix of the raw cookie value. Pin both the
  // positive shape AND the absence of the old leaky `tail` field.
  assert.ok(/\bfingerprint\b/.test(block), 'GET response must include fingerprint field (sha256 prefix)');
  assert.ok(/createHash\(['"]sha256['"]\)/.test(block),
    'fingerprint must come from sha256, not a substring of the cookie value');
  assert.ok(!/\btail[:,]/.test(block),
    'GET endpoint must NOT include tail field — partial-secret leak');
  assert.ok(
    !/sendJson\(response, 200, \{ cookies:/.test(block),
    'GET endpoint must NOT return raw cookies map',
  );
});

test('openai.js Phase 4 gate uses latestUserMessageHasImage (not history-wide)', () => {
  // Codex review follow-up (Phase 4 🔴 2026-05-04): the broad
  // messagesHaveInputImages would let an old uploaded image re-enable
  // image_generation for unrelated CSS/theming follow-ups. Pin that
  // (a) the latest-turn-only helper exists, (b) it's the one feeding
  // the intent gate.
  const openaiSrc = readFileSync(join(repoRoot, 'src', 'openai.js'), 'utf8');
  assert.ok(
    /export function latestUserMessageHasImage\(/.test(openaiSrc),
    'latestUserMessageHasImage helper must exist as a named export',
  );
  // The intent gate must NOT use the history-wide flag — it has to
  // pull from the latest-turn helper.
  assert.ok(
    /_detectImageIntentLocal\([^)]*hasInputImage:\s*latestUserHasImage/.test(openaiSrc),
    'image-intent gate must consume latestUserHasImage, not the history-wide hasInputImage',
  );
});

test('desktop-ui/app.js wires the domain-cookie form actions + input handlers', () => {
  assert.ok(/data-action="domain-cookie-save"/.test(appSrc), 'save button missing');
  assert.ok(/data-action="domain-cookie-remove"/.test(appSrc), 'remove button missing');
  assert.ok(/data-action="refresh-domain-cookies"/.test(appSrc), 'refresh button missing');
  assert.ok(/data-domain-cookie-host/.test(appSrc), 'host input data attr missing');
  assert.ok(/data-domain-cookie-string/.test(appSrc), 'cookie input data attr missing');
});

test('openai.js wires the image-intent gate into createCodexResponsesReply', () => {
  // Phase 4 root-cause fix: image_generation is no longer always-on
  // when workspace exists. This pins (a) the gate gets passed
  // hasImageIntent and (b) extractLatestUserTextForIntent feeds it.
  // A refactor that drops the gate would re-introduce the
  // Xiaohongshu/Douyin mis-routing failure.
  const openaiSrc = readFileSync(join(repoRoot, 'src', 'openai.js'), 'utf8');
  assert.ok(/extractLatestUserTextForIntent\s*\(/.test(openaiSrc),
    'extractLatestUserTextForIntent must be called');
  assert.ok(/_detectImageIntentLocal\s*\(/.test(openaiSrc),
    'local image-intent detector must be called');
  assert.ok(/hasImageIntent\s*[:,]/.test(openaiSrc),
    'hasImageIntent must be threaded into buildCodexResponsesTools');
  // Pin the gating condition itself so a future "always-on" reversion
  // shows up red.
  assert.ok(
    /hasImageIntent\s*&&[\s\S]*?workspacePath/.test(openaiSrc),
    'image_generation must gate on hasImageIntent AND workspacePath',
  );
});
