// Smoke test for the dynamic `import('./tts.js')` regression that
// silently broke every voice reply (Codex audit 2026-04-29).
//
// Background: telegramPolling.js + discordPolling.js both lazy-load
// the TTS module via `await import('./tts.js')`. The relative path
// resolved from `src/services/remote/`, but `tts.js` actually lives
// at `src/tts.js`. Module resolution threw ERR_MODULE_NOT_FOUND
// inside the voice-reply branch of each polling cycle, so every
// telegram/discord voice reply failed silently — but the SERVER
// kept running, the text reply still went out, and the only sign
// of failure was a single line buried in the polling debug log.
//
// Service-layer tests stayed green because they never executed the
// dynamic-import line (no inbound message under test). This file
// exists so a future refactor that breaks the same path goes red
// statically, without needing a real telegram/discord round-trip.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Files we audit for the broken `import('./tts.js')` shape.
const POLLING_FILES = ['telegramPolling.js', 'discordPolling.js'];

test('polling files do NOT carry the broken `import(\'./tts.js\')` relative path', () => {
  // Codex audit 2026-04-29: this exact string was the regression.
  // Resolved to src/services/remote/tts.js (does not exist) instead
  // of src/tts.js (the real module). Voice replies threw silently.
  for (const file of POLLING_FILES) {
    const src = readFileSync(join(HERE, file), 'utf8');
    assert.doesNotMatch(
      src,
      /import\(\s*['"]\.\/tts\.js['"]\s*\)/,
      `${file} must not import('./tts.js') — that path resolves to src/services/remote/tts.js which does not exist; use '../../tts.js' instead`,
    );
  }
});

test('polling files DO use `import(\'../../tts.js\')` and the target exists', () => {
  // Each polling file must use the correct two-level-up relative
  // path, AND the target file must actually exist on disk so the
  // dynamic resolution succeeds at runtime.
  for (const file of POLLING_FILES) {
    const src = readFileSync(join(HERE, file), 'utf8');
    assert.match(
      src,
      /import\(\s*['"]\.\.\/\.\.\/tts\.js['"]\s*\)/,
      `${file} must import('../../tts.js') so synthesizeSpeech is reachable from the voice-reply branch`,
    );
  }
  // Static-resolve the target path from one of the polling files'
  // viewpoint and confirm it points at a real file.
  const ttsPath = resolvePath(HERE, '..', '..', 'tts.js');
  assert.ok(
    existsSync(ttsPath),
    `expected src/tts.js to exist at ${ttsPath} — both polling files import it dynamically and silently fail when it's missing`,
  );
});

test('the imported tts.js exports `synthesizeSpeech` (the symbol both pollers destructure)', async () => {
  // This is the contract the polling code expects. If the symbol
  // is renamed without updating the pollers, every voice reply
  // would throw a destructuring error after the dynamic import
  // resolved — same silent-failure shape as the bad path bug.
  const ttsModule = await import('../../tts.js');
  assert.equal(
    typeof ttsModule.synthesizeSpeech,
    'function',
    'src/tts.js must export `synthesizeSpeech` — the exact symbol both polling files destructure',
  );
});
