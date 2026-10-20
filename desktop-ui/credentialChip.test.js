// Contract tests for the masked-credential save-status chip
// (Codex audit 2026-04-29). The pure state machine drives a
// visible UI confirmation that explains away the "保存不了"
// confusion that came from password-mask hiding the saved
// value. Three states + the post-autosave "draft cleared →
// flip to saved" transition are pinned here so a future
// refactor that breaks the contract goes red immediately.

import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialChipState, CREDENTIAL_FIELDS } from './credentialChip.js';

// ─── covered fields ─────────────────────────────────────────────────────────

test('CREDENTIAL_FIELDS lists exactly the masked-input credential fields', () => {
  assert.deepEqual([...CREDENTIAL_FIELDS].sort(), [
    'apiKey',
    'minimaxApiKey',
    'whisperApiKey',
  ]);
});

// ─── pending: user is typing ────────────────────────────────────────────────

test('credentialChipState — non-empty draft for the field returns "pending"', () => {
  // The whole point of the chip during typing: the user has typed
  // something but the 3-second autosave hasn't fired yet.  Show
  // "● 待保存" so the user knows the save is queued, not that
  // their input vanished.
  for (const field of CREDENTIAL_FIELDS) {
    const draft = { [field]: 'sk-just-pasted-value' };
    const config = { hasMinimaxKey: true, maskedMinimaxApiKey: 'sk-old...4Fo' };
    const out = credentialChipState(field, draft, config);
    assert.equal(out.state, 'pending');
    assert.equal(out.masked, '');
  }
});

test('credentialChipState — whitespace-only draft is treated as no input', () => {
  // Defensive: a stale "  " in the draft must not pin the chip
  // on "pending" forever.  Trim before checking, same rule used
  // by `pickConnectorField` in connectorDraft.js.
  const draft = { minimaxApiKey: '   ' };
  const config = { hasMinimaxKey: true, maskedMinimaxApiKey: 'sk-old...4Fo' };
  const out = credentialChipState('minimaxApiKey', draft, config);
  assert.equal(out.state, 'saved');
  assert.equal(out.masked, 'sk-old...4Fo');
});

// ─── saved: server has the value, draft is empty ───────────────────────────

test('credentialChipState — empty draft + has*Key=true returns "saved" with masked value', () => {
  for (const field of CREDENTIAL_FIELDS) {
    const flagMap = {
      apiKey: { has: 'hasApiKey', mask: 'maskedApiKey' },
      whisperApiKey: { has: 'hasWhisperKey', mask: 'maskedWhisperApiKey' },
      minimaxApiKey: { has: 'hasMinimaxKey', mask: 'maskedMinimaxApiKey' },
    }[field];
    const config = { [flagMap.has]: true, [flagMap.mask]: 'sk-x...y' };
    const out = credentialChipState(field, {}, config);
    assert.equal(out.state, 'saved');
    assert.equal(out.masked, 'sk-x...y');
  }
});

test('credentialChipState — null/undefined draft is treated as empty', () => {
  const config = { hasMinimaxKey: true, maskedMinimaxApiKey: 'sk-z...y' };
  for (const draft of [null, undefined]) {
    const out = credentialChipState('minimaxApiKey', draft, config);
    assert.equal(out.state, 'saved');
    assert.equal(out.masked, 'sk-z...y');
  }
});

// ─── unconfigured: nothing on server, nothing in draft ─────────────────────

test('credentialChipState — empty draft + no saved key returns "unconfigured"', () => {
  for (const field of CREDENTIAL_FIELDS) {
    const out = credentialChipState(field, {}, {});
    assert.equal(out.state, 'unconfigured');
    assert.equal(out.masked, '');
  }
});

test('credentialChipState — null/undefined config also unconfigured (no crash)', () => {
  for (const config of [null, undefined, 42, 'string', []]) {
    const out = credentialChipState('apiKey', null, config);
    assert.equal(out.state, 'unconfigured');
  }
});

test('credentialChipState — unknown fieldName never claims saved (defensive)', () => {
  // If a future refactor adds a new credential field but forgets
  // to register its flag mapping, the chip should default to
  // "unconfigured" rather than report a phantom save state.
  const config = { hasApiKey: true, hasWhisperKey: true, hasMinimaxKey: true };
  const out = credentialChipState('unknownField', {}, config);
  assert.equal(out.state, 'unconfigured');
});

// ─── End-to-end: the post-autosave-clear transition ────────────────────────

test('regression — a successful Save that clears the secret from the draft flips the chip pending → saved', () => {
  // 1. User pastes a key. The form's input handler mirrors the
  //    value onto modelSetupDraft. Chip should be "pending".
  const draftAtPaste = { minimaxApiKey: 'sk-fresh-paste-12345' };
  const configBefore = { hasMinimaxKey: false, maskedMinimaxApiKey: '(not set)' };
  let chip = credentialChipState('minimaxApiKey', draftAtPaste, configBefore);
  assert.equal(chip.state, 'pending', 'paste must show pending');

  // 2. The explicit Save succeeds and clears the field from the
  //    draft (clearModelFormDraft); the new bootstrap has
  //    hasMinimaxKey=true. Without that clear the draft would
  //    still hold 'sk-fresh-paste-12345' and the chip would stay
  //    stuck on "pending" (Codex 第十八轮).
  const draftAfterAutosave = { ...draftAtPaste };
  for (const f of CREDENTIAL_FIELDS) {
    if (typeof draftAfterAutosave[f] === 'string' && draftAfterAutosave[f]) {
      draftAfterAutosave[f] = '';
    }
  }
  const configAfter = { hasMinimaxKey: true, maskedMinimaxApiKey: 'sk-f...2345' };
  chip = credentialChipState('minimaxApiKey', draftAfterAutosave, configAfter);
  assert.equal(chip.state, 'saved', 'after autosave clear, chip flips to saved');
  assert.equal(chip.masked, 'sk-f...2345');
});

// ─── Behavioural order: clear MUST happen BEFORE the next chip read ────────

