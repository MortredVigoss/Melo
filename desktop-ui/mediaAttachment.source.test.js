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
