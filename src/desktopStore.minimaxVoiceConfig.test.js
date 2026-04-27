/**
 * Regression for Codex C #14 fix in src/desktopStore.js — adding
 * `minimaxVoiceId` to SECRET_LIKE_CONFIG_KEYS so a blank submission
 * preserves the saved value instead of wiping it. Without this guard,
 * the TTS panel's "自定义语音" activation path could overwrite the
 * connector's saved Default Voice ID with empty string when neither
 * the localStorage cache nor any agent profile carried a voice id.
 *
 * Same MELO_HOME-isolated pattern as desktopStore.updateAgentProfile.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEMP_HOME = mkdtempSync(join(tmpdir(), 'melo-minimax-voice-cfg-test-'));
process.env.MELO_HOME = TEMP_HOME;

const { updateModelConfig } = await import('./desktopStore.js');

test('updateModelConfig: blank minimaxVoiceId preserves the saved value', async () => {
  // Seed: save a real default voice id.
  await updateModelConfig({ minimaxVoiceId: 'voice-Y' });

  // The Codex C #14 scenario: a later patch comes in with empty
  // voiceId (e.g. an old build's activate-minimax-voice path). The
  // saved value MUST stay 'voice-Y' — overwriting with '' would be
  // silent data loss.
  const bootstrap = await updateModelConfig({ minimaxVoiceId: '' });
  assert.equal(
    bootstrap.settings.config.minimaxVoiceId,
    'voice-Y',
    'blank minimaxVoiceId must preserve saved value, not wipe',
  );
});

test('updateModelConfig: explicit non-blank minimaxVoiceId still overwrites', async () => {
  await updateModelConfig({ minimaxVoiceId: 'voice-A' });
  const bootstrap = await updateModelConfig({ minimaxVoiceId: 'voice-B' });
  assert.equal(bootstrap.settings.config.minimaxVoiceId, 'voice-B');
});

test('updateModelConfig: blank minimaxApiKey / minimaxGroupId also preserve (sanity)', async () => {
  await updateModelConfig({
    minimaxApiKey: 'sk-real-key',
    minimaxGroupId: 'group-123',
  });
  const bootstrap = await updateModelConfig({ minimaxApiKey: '', minimaxGroupId: '' });
  // hasMinimaxKey reflects whether the saved key is non-empty; blank
  // patch must not wipe it.
  assert.equal(bootstrap.settings.config.hasMinimaxKey, true, 'minimaxApiKey blank must preserve');
  assert.equal(bootstrap.settings.config.minimaxGroupId, 'group-123', 'minimaxGroupId blank must preserve');
});

// Cleanup
process.on('exit', () => {
  try { rmSync(TEMP_HOME, { recursive: true, force: true }); } catch {}
});
