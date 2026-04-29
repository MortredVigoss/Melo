// Contract tests for the masked-credential save-status chip
// (Codex audit 2026-04-29). The pure state machine drives a
// visible UI confirmation that explains away the "保存不了"
// confusion that came from password-mask hiding the saved
// value. Three states + the post-autosave "draft cleared →
// flip to saved" transition are pinned here so a future
// refactor that breaks the contract goes red immediately.

import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialChipState, CREDENTIAL_FIELDS, clearCommittedSecrets } from './credentialChip.js';

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

test('regression — autosave success clears secrets from draft → chip flips pending → saved', () => {
  // 1. User pastes a key. The form's input handler mirrors the
  //    value onto modelSetupDraft. Chip should be "pending".
  const draftAtPaste = { minimaxApiKey: 'sk-fresh-paste-12345' };
  const configBefore = { hasMinimaxKey: false, maskedMinimaxApiKey: '(not set)' };
  let chip = credentialChipState('minimaxApiKey', draftAtPaste, configBefore);
  assert.equal(chip.state, 'pending', 'paste must show pending');

  // 2. Three seconds later, autosave's timer fires, the POST
  //    succeeds, applyBootstrapPreservingDrafts swaps in the
  //    new bootstrap (now hasMinimaxKey=true, masked filled).
  //    Without the post-save secret-clear, the draft would
  //    STILL hold 'sk-fresh-paste-12345' and the chip would
  //    stay stuck on "pending" — that's exactly the regression
  //    Codex 第十八轮 caught and what this clear fixes.
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

test('regression — non-credential draft fields are NOT cleared by the autosave secret-sweep', () => {
  // The clear-step only touches CREDENTIAL_FIELDS; non-secret
  // fields like minimaxGroupId, minimaxVoiceId, baseUrl, model
  // stay on the draft because the user may still be editing them.
  const draft = {
    minimaxApiKey: 'sk-typed-then-saved',
    minimaxGroupId: 'group-being-edited',
    minimaxVoiceId: 'voice-being-edited',
    baseUrl: 'http://still-typing.local',
    model: 'gpt-5.5',
  };
  const submittedBody = { minimaxApiKey: 'sk-typed-then-saved' };
  clearCommittedSecrets(draft, submittedBody);
  assert.equal(draft.minimaxApiKey, '');
  assert.equal(draft.minimaxGroupId, 'group-being-edited');
  assert.equal(draft.minimaxVoiceId, 'voice-being-edited');
  assert.equal(draft.baseUrl, 'http://still-typing.local');
  assert.equal(draft.model, 'gpt-5.5');
});

// ─── clearCommittedSecrets — the in-flight race fix ────────────────────────

test('clearCommittedSecrets — clears a field when draft value equals submittedBody', () => {
  const draft = { minimaxApiKey: 'sk-paste-1' };
  const submitted = { minimaxApiKey: 'sk-paste-1' };
  const cleared = clearCommittedSecrets(draft, submitted);
  assert.deepEqual(cleared, ['minimaxApiKey']);
  assert.equal(draft.minimaxApiKey, '');
});

test('clearCommittedSecrets — leaves a field alone when draft has moved past submittedBody (in-flight race)', () => {
  // Codex C 第十九轮 (2026-04-29) regression: this is THE scenario
  // that breaks the naïve sweep. Sequence of events:
  //   1. user pastes KEY-A → 3s timer fires → POST(KEY-A) in-flight
  //   2. user pastes KEY-B → schedule replaces pending, draft.minimaxApiKey now KEY-B
  //   3. KEY-A's response lands first (slower than user typing)
  //   4. without the equality check we'd clear draft.minimaxApiKey
  //      to '', losing the user's KEY-B that hasn't been saved yet
  // The fix: only clear when draft still equals submittedBody.
  const draft = { minimaxApiKey: 'sk-NEWER-KEY-B' };
  const submitted = { minimaxApiKey: 'sk-OLDER-KEY-A' };
  const cleared = clearCommittedSecrets(draft, submitted);
  assert.deepEqual(cleared, [], 'must NOT clear when draft has moved to a newer value');
  assert.equal(
    draft.minimaxApiKey,
    'sk-NEWER-KEY-B',
    'newer typed key must survive an older in-flight response',
  );
});

test('clearCommittedSecrets — multi-field: only matching fields cleared, the rest survive', () => {
  // user submitted body had three credentials; while in flight,
  // user re-pasted minimaxApiKey to KEY-B but left apiKey and
  // whisperApiKey alone. Only the latter two should clear.
  const draft = {
    apiKey: 'sk-openai-A',
    whisperApiKey: 'sk-whisper-A',
    minimaxApiKey: 'sk-mini-NEWER-B',
  };
  const submitted = {
    apiKey: 'sk-openai-A',
    whisperApiKey: 'sk-whisper-A',
    minimaxApiKey: 'sk-mini-OLDER-A',
  };
  const cleared = clearCommittedSecrets(draft, submitted);
  assert.deepEqual(cleared.sort(), ['apiKey', 'whisperApiKey']);
  assert.equal(draft.apiKey, '');
  assert.equal(draft.whisperApiKey, '');
  assert.equal(draft.minimaxApiKey, 'sk-mini-NEWER-B');
});

test('clearCommittedSecrets — null/undefined inputs are no-ops (defensive)', () => {
  // App-side may invoke this even if the draft was nulled by an
  // explicit Save during the autosave's await window. Don't crash.
  for (const draft of [null, undefined]) {
    for (const submitted of [null, undefined, {}]) {
      assert.deepEqual(clearCommittedSecrets(draft, submitted), []);
    }
  }
  assert.deepEqual(clearCommittedSecrets({ apiKey: 'sk-x' }, null), []);
  assert.deepEqual(clearCommittedSecrets({ apiKey: 'sk-x' }, undefined), []);
});

test('clearCommittedSecrets — empty submittedBody field never clears (server didn\'t take it)', () => {
  // If the autosave body had blank `minimaxApiKey` (mask contract)
  // and the server kept the existing saved value, we must NOT
  // clear the draft — there's nothing to confirm.
  const draft = { minimaxApiKey: 'sk-still-typing' };
  const submitted = { minimaxApiKey: '' };
  const cleared = clearCommittedSecrets(draft, submitted);
  assert.deepEqual(cleared, []);
  assert.equal(draft.minimaxApiKey, 'sk-still-typing');
});

// ─── Behavioural order: clear MUST happen BEFORE the next chip read ────────

test('order regression — chip read BEFORE clearCommittedSecrets paints stale "pending"', () => {
  // Codex C 第二十轮 (2026-04-29): the autosave success path used
  // to be `applyBootstrapPreservingDrafts → clear`. The apply step
  // synchronously triggers render(), and the credential chip's
  // pending-vs-saved state is computed AT THAT RENDER from the
  // live draft. If clear runs AFTER the render, the chip paints
  // "pending" against the still-populated draft, and the
  // subsequent clear has no follow-up render to swap the chip
  // to "saved". This test demonstrates the broken order: even
  // though config has been updated and the secret matches what
  // was committed, the chip we'd render under WRONG ordering
  // returns "pending".
  const draft = { minimaxApiKey: 'sk-A' };
  const submitted = { minimaxApiKey: 'sk-A' };
  const configAfterSave = { hasMinimaxKey: true, maskedMinimaxApiKey: 'sk-A...A' };

  // Simulate WRONG order: read chip BEFORE clear
  const stillStaleChip = credentialChipState('minimaxApiKey', draft, configAfterSave);
  assert.equal(
    stillStaleChip.state,
    'pending',
    'reading chip before the post-save clear paints stale pending — exactly the symptom Codex caught',
  );
});

test('order correct — clearCommittedSecrets BEFORE chip read paints "saved"', () => {
  // Same inputs, correct order: clear first, then read chip.
  // This is the post-fix behaviour: clearCommittedSecrets runs
  // synchronously before applyBootstrapPreservingDrafts triggers
  // render(), so by the time the chip's pending check runs the
  // draft is empty and the config has hasMinimaxKey=true → saved.
  const draft = { minimaxApiKey: 'sk-A' };
  const submitted = { minimaxApiKey: 'sk-A' };
  const configAfterSave = { hasMinimaxKey: true, maskedMinimaxApiKey: 'sk-A...A' };

  clearCommittedSecrets(draft, submitted);
  const renderedChip = credentialChipState('minimaxApiKey', draft, configAfterSave);
  assert.equal(renderedChip.state, 'saved', 'clear-before-render flips chip pending → saved as designed');
  assert.equal(renderedChip.masked, 'sk-A...A');
});

test('clearCommittedSecrets — does not touch fields outside CREDENTIAL_FIELDS', () => {
  const draft = {
    minimaxApiKey: 'sk-secret',
    minimaxGroupId: '999',
    baseUrl: 'http://x.local',
    customField: 'should-not-clear',
  };
  const submitted = {
    minimaxApiKey: 'sk-secret',
    minimaxGroupId: '999',
    baseUrl: 'http://x.local',
    customField: 'should-not-clear',
  };
  clearCommittedSecrets(draft, submitted);
  assert.equal(draft.minimaxApiKey, '');
  assert.equal(draft.minimaxGroupId, '999');
  assert.equal(draft.baseUrl, 'http://x.local');
  assert.equal(draft.customField, 'should-not-clear');
});
