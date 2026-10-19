/**
 * 2026-05-23 Codex C 闭环: source-level wiring guards for the two app.js
 * fixes on the media-attachment UX commit (the voice half moved to the chat
 * feature's behaviour tests in P2c; see below).  handleVoiceMessageAutoSubmit /
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
// Since P2c (2026-10-19) the composer, dictation, send pipeline and chat
// creation live in desktop-ui/features/chat/ and are pinned by behaviour
// tests there (features/chat/controller.test.js): dictation only inserts into
// the draft, the transcript entry carries the audio attachmentId, the voice
// ids are captured then cleared for a send and restored after a failure, and
// createChat / the new-chat home reset clear both voice fields. What stays
// here is the app.js wiring those tests cannot see.

test('the new-chat home and every new-chat entry go through the chat feature resets', () => {
  const home = appSource.slice(appSource.indexOf('async function handleOpenNewChatHome('), appSource.indexOf('\nasync function handleToggleChatLock('));
  assert.match(home, /chatFeature\.resetComposerForNewChatHome\(\);/, 'handleOpenNewChatHome clears the composer and both voice fields through the chat feature');
  assert.doesNotMatch(appSource, /function handleVoiceMessageAutoSubmit/);
  // Only the chat feature creates chats (its createChat resets the voice
  // fields); a second inline creator would bypass that reset.
  const chatApi = readFileSync(join(here, 'features', 'chat', 'api.js'), 'utf8');
  const chatController = readFileSync(join(here, 'features', 'chat', 'controller.js'), 'utf8');
  const posts = source => (source.match(/api\('\/api\/chats'/g) || []).length;
  assert.equal(posts(appSource) + posts(chatController), 0, 'app.js and the chat controller never POST /api/chats themselves');
  assert.equal(posts(chatApi), 1, 'the chat feature api.js is the one /api/chats creator');
  assert.match(appSource, /await chatFeature\.createChat\(/, 'palette / project new-chat entries use the chat feature');
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
