/**
 * 2026-05-23 Codex C 闭环: source-level wiring guards for the two app.js
 * fixes on the media-attachment UX commit.  handleVoiceMessageAutoSubmit /
 * the global click+keydown delegation are DOM- and network-coupled, so they
 * can't be unit-run without a heavy harness — these grep the source for the
 * exact wiring, matching the established desktop-ui/*.source.test.js pattern
 * (memoryPane.source.test.js).  The behavioral half (status rendering) is
 * covered by videoStatus.test.js's describeAudioExtractionStatus cases.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, 'app.js'), 'utf8');

// ─── Fix #1: voice transcript ↔ audio attachment id linkage ────────────────

test('voice auto-submit assigns a stable id to the audio attachment', () => {
  // The voice attachment must get an id like every other attachment path
  // (queueComposerFiles uses crypto.randomUUID()).  Pre-fix it had none, so
  // describeAudioExtractionStatus could never match its transcript.
  assert.match(
    appSource,
    /const voiceAttachmentId = crypto\.randomUUID\(\);[\s\S]*?id: voiceAttachmentId,[\s\S]*?kind: 'audio'/,
    'handleVoiceMessageAutoSubmit must generate a voiceAttachmentId and put it on the audio attachment',
  );
});

test('voice transcript entry references the audio attachment id (attachmentId linkage)', () => {
  // The prefilled extractedMedia transcript entry must carry attachmentId =
  // the same voice attachment id, so describeAudioExtractionStatus matches.
  assert.match(
    appSource,
    /attachmentId: voiceAttachmentId[\s\S]*?kind: 'transcript'[\s\S]*?source: 'speech-recognition'/,
    'the prefilled voice transcript entry must link attachmentId to the audio attachment',
  );
});

test('voice attachment id is captured-then-cleared in the send path (parallel to voiceTranscript)', () => {
  assert.match(
    appSource,
    /const voiceAttachmentId = uiState\.composerVoiceAttachmentId \|\| null;\s*\n\s*uiState\.composerVoiceAttachmentId = null;/,
    'send path must capture + clear composerVoiceAttachmentId, mirroring composerVoiceTranscript',
  );
});

// 2026-06-04 audit闭环: handleCreateChat + handleOpenNewChatHome must each
// reset BOTH voice fields, else a recorded-but-unsent voice message leaks a
// stale extractedMedia transcript (orphan attachmentId) into the next
// plain-text send. Codex C round-2: lock the SPECIFIC function bodies — a
// global string count can't catch "removed the clear from one path but
// another path has two clears". Extract each function body and assert.

function functionBody(src, declRegex) {
  // Slice from the function declaration to the next top-level `async function`
  // / `function ` at column 0 (the next sibling). Good enough to scope the
  // assertions to one function — these are all module-level functions.
  const start = src.search(declRegex);
  if (start < 0) return '';
  const rest = src.slice(start + 1);
  const nextDecl = rest.search(/\n(async function |function )/);
  return nextDecl < 0 ? rest : rest.slice(0, nextDecl);
}

test('handleCreateChat clears BOTH pending voice fields (entry-point-specific)', () => {
  const body = functionBody(appSource, /async function handleCreateChat\(/);
  assert.ok(body, 'handleCreateChat must exist');
  assert.match(body, /uiState\.composerVoiceTranscript = null;/,
    'handleCreateChat must clear composerVoiceTranscript');
  assert.match(body, /uiState\.composerVoiceAttachmentId = null;/,
    'handleCreateChat must clear composerVoiceAttachmentId');
});

test('handleOpenNewChatHome clears BOTH pending voice fields (entry-point-specific)', () => {
  const body = functionBody(appSource, /async function handleOpenNewChatHome\(/);
  assert.ok(body, 'handleOpenNewChatHome must exist');
  assert.match(body, /uiState\.composerVoiceTranscript = null;/,
    'handleOpenNewChatHome must clear composerVoiceTranscript');
  assert.match(body, /uiState\.composerVoiceAttachmentId = null;/,
    'handleOpenNewChatHome must clear composerVoiceAttachmentId');
});

test('all callers of new-chat route through the two reset functions (no unguarded new-chat entry)', () => {
  // The leak is fixed at the FUNCTION level, so every new-chat trigger must
  // go through handleCreateChat / handleOpenNewChatHome rather than inlining
  // its own chat-creation + composer reset. This guards against a future
  // entry point that creates a chat inline and re-introduces the leak.
  // Heuristic: there must be no inline POST to /api/chats outside
  // handleCreateChat.
  const chatPosts = (appSource.match(/api\('\/api\/chats'/g) || []).length;
  assert.equal(chatPosts, 1,
    `only handleCreateChat may POST /api/chats; found ${chatPosts} sites — a second inline creator would bypass the voice-field reset`);
});

// ─── Fix #2: keyboard activation for focusable link/PDF cards ───────────────

test('link/PDF card has a keydown activation path (not click-only) for role=link a11y', () => {
  // The card is rendered as <div role="link" tabindex="0" data-external-url>.
  // A focusable role=link MUST activate on Enter — pre-fix only click was
  // delegated, so keyboard users could focus but not open it.
  assert.match(
    appSource,
    /addEventListener\('keydown'[\s\S]*?data-external-url[\s\S]*?activateExternalCardElement/,
    'a keydown listener must route [data-external-url] activation (Enter/Space)',
  );
});

test('click and keydown share one activator (no drift between the two paths)', () => {
  // Both paths must go through activateExternalCardElement so the routing
  // logic can never diverge — the anti-drift point the architecture audit
  // cares about.
  const activatorDef = /function activateExternalCardElement\(externalCard\)/.test(appSource);
  assert.ok(activatorDef, 'activateExternalCardElement helper must exist');
  // Click path delegates to it too.
  assert.match(
    appSource,
    /const externalCard = event\.target\.closest\('\[data-external-url\]'\);[\s\S]*?activateExternalCardElement\(externalCard\)/,
    'the click delegation must call activateExternalCardElement (shared with keydown)',
  );
});

test('Enter is handled (native role=link semantics), not click-only', () => {
  assert.match(
    appSource,
    /event\.key !== 'Enter'/,
    'keydown handler must gate on Enter (role=link activation key)',
  );
});
