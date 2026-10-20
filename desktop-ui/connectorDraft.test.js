// Contract tests for the OpenAI / connector form draft helpers.
// The 2026-04-28 connector audit caught the connector-config form
// silently dropping every paste in its password fields: the input
// handler was gated on `dataset.form === 'model-config'` only, so
// each background `app.innerHTML = …` swap recreated the inputs
// with SSR `value=""` and `keepIfBlank` on the server then treated
// the submit body as "no change". These tests pin the draft +
// FormData fallback chain that powers the fix.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConnectorDraft, pickConnectorField } from './connectorDraft.js';

// ─── buildConnectorDraft ────────────────────────────────────────────────────

test('buildConnectorDraft returns every editable field even on empty input', () => {
  const draft = buildConnectorDraft(undefined, undefined);
  assert.deepEqual(Object.keys(draft).sort(), [
    'apiKey',
    'authMode',
    'baseUrl',
    'minimaxApiKey',
    'minimaxGroupId',
    'minimaxVoiceId',
    'model',
    'systemPrompt',
    'whisperApiKey',
    'whisperBaseUrl',
  ]);
});

test('buildConnectorDraft defaults authMode to codex when nothing is saved', () => {
  const d = buildConnectorDraft(null, null);
  assert.equal(d.authMode, 'codex');
});

test('buildConnectorDraft falls back to saved config for non-secret fields', () => {
  const config = {
    authMode: 'api-key',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    systemPrompt: 'be terse',
    whisperBaseUrl: 'http://127.0.0.1:11434/v1',
    minimaxGroupId: '12345',
    minimaxVoiceId: 'moss_audio_abc',
  };
  const d = buildConnectorDraft(config, undefined);
  assert.equal(d.authMode, 'api-key');
  assert.equal(d.baseUrl, 'https://api.openai.com/v1');
  assert.equal(d.model, 'gpt-5.5');
  assert.equal(d.systemPrompt, 'be terse');
  assert.equal(d.whisperBaseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(d.minimaxGroupId, '12345');
  assert.equal(d.minimaxVoiceId, 'moss_audio_abc');
});

test('buildConnectorDraft keeps secret fields blank by default (masked-input contract)', () => {
  // The form's password inputs render with value="" so the server's
  // keepIfBlank semantics treats blank submissions as "no change".
  // The default draft must echo that — saved keys stay saved, the
  // user only opts in by typing into the masked input.
  const config = {
    apiKey: 'sk-real-already-saved-key',
    whisperApiKey: 'sk-real-whisper',
    minimaxApiKey: 'sk-real-minimax',
  };
  const d = buildConnectorDraft(config, undefined);
  assert.equal(d.apiKey, '');
  assert.equal(d.whisperApiKey, '');
  assert.equal(d.minimaxApiKey, '');
});

test('buildConnectorDraft surfaces in-flight typing through modelSetupDraft', () => {
  // This is the regression fix: a user pastes a key, a background
  // render fires (mcpAuthSurface poll, undo-toast tick, autosave
  // response) that recreates the masked input with SSR value="",
  // but the draft still carries what was typed so the next submit
  // pulls from there.
  const config = { authMode: 'codex' };
  const draftFromTyping = {
    minimaxApiKey: 'sk-just-pasted-by-user',
    minimaxGroupId: '99999',
  };
  const d = buildConnectorDraft(config, draftFromTyping);
  assert.equal(d.minimaxApiKey, 'sk-just-pasted-by-user');
  assert.equal(d.minimaxGroupId, '99999');
  // saved authMode still wins when the user hasn't touched it
  assert.equal(d.authMode, 'codex');
});

test('buildConnectorDraft returns a fresh object — caller mutations do not bleed back', () => {
  const config = { baseUrl: 'http://a.local' };
  const a = buildConnectorDraft(config, null);
  a.baseUrl = 'http://b.local';
  const b = buildConnectorDraft(config, null);
  assert.equal(b.baseUrl, 'http://a.local');
});

test('buildConnectorDraft tolerates non-object inputs without throwing', () => {
  for (const bad of [42, 'string', true, [], () => {}]) {
    const d = buildConnectorDraft(bad, bad);
    assert.equal(typeof d, 'object');
    assert.equal(d.authMode, 'codex'); // still gets the default
  }
});

// ─── pickConnectorField ─────────────────────────────────────────────────────

function fakeFormData(map = {}) {
  return {
    get: name => (name in map ? map[name] : null),
  };
}

test('pickConnectorField prefers a non-empty draft value over FormData', () => {
  // The masked-input case: form.value is '' but the user's typed
  // key still lives on the draft. Pick draft so the submit body
  // carries the real key.
  const draft = { minimaxApiKey: 'sk-from-draft' };
  const fd = fakeFormData({ minimaxApiKey: '' });
  assert.equal(pickConnectorField(draft, fd, 'minimaxApiKey'), 'sk-from-draft');
});

test('pickConnectorField trims whitespace from draft values', () => {
  const draft = { baseUrl: '  http://x.local  ' };
  assert.equal(pickConnectorField(draft, null, 'baseUrl'), 'http://x.local');
});

test('pickConnectorField falls back to FormData when draft is empty / whitespace / missing', () => {
  const fd = fakeFormData({ baseUrl: '  http://from-form.local  ' });
  assert.equal(pickConnectorField({}, fd, 'baseUrl'), 'http://from-form.local');
  assert.equal(pickConnectorField({ baseUrl: '   ' }, fd, 'baseUrl'), 'http://from-form.local');
  assert.equal(pickConnectorField(null, fd, 'baseUrl'), 'http://from-form.local');
  assert.equal(pickConnectorField(undefined, fd, 'baseUrl'), 'http://from-form.local');
});

test('pickConnectorField rejects non-string draft values and falls back to FormData', () => {
  const fd = fakeFormData({ port: '9000' });
  // Numbers / booleans on the draft are not the user's typing — they
  // could be sentinel values from upstream code that survived a stale
  // merge. Treat them as "not provided" and read FormData.
  assert.equal(pickConnectorField({ port: 8080 }, fd, 'port'), '9000');
  assert.equal(pickConnectorField({ port: true }, fd, 'port'), '9000');
});

test('pickConnectorField returns "" when neither draft nor FormData supply the field', () => {
  assert.equal(pickConnectorField({}, fakeFormData({}), 'minimaxApiKey'), '');
  assert.equal(pickConnectorField(null, null, 'minimaxApiKey'), '');
});

test('pickConnectorField tolerates a FormData-like object with a missing get()', () => {
  // Defensive: real FormData always has .get, but app.js may pass
  // null when the form isn't reachable. Should not throw.
  const draft = { authMode: 'codex' };
  assert.equal(pickConnectorField(draft, {}, 'authMode'), 'codex');
  assert.equal(pickConnectorField(draft, {}, 'baseUrl'), '');
});

// ─── End-to-end regression: paste-then-render-then-submit ──────────────────

test('regression — paste a MiniMax key, simulate a background render, submit picks the right value', () => {
  // 1. User opens Customize → Connectors → OpenAI. Saved config
  //    has no MiniMax key yet.
  let config = { authMode: 'codex', model: 'gpt-5.5' };
  let modelSetupDraft = null;

  // 2. Initial render: form picks up config defaults via the helper.
  let d = buildConnectorDraft(config, modelSetupDraft);
  assert.equal(d.minimaxApiKey, '');

  // 3. User pastes a key. The form's input event mirrors it onto
  //    modelSetupDraft (the live draft).
  modelSetupDraft = { ...modelSetupDraft, minimaxApiKey: 'sk-fresh-key-12345' };

  // 4. A background render fires (mcpAuthSurface poll, autosave, …).
  //    The input is rebuilt with SSR value="" — the form is the same
  //    DOM template as before. The draft still holds the key.
  d = buildConnectorDraft(config, modelSetupDraft);
  assert.equal(d.minimaxApiKey, 'sk-fresh-key-12345');

  // 5. User clicks Save. handleSaveConnectorConfig reads from the
  //    draft first, FormData second. Even though the password field
  //    submits as '' (mask), pickConnectorField pulls from the draft.
  const fd = fakeFormData({ minimaxApiKey: '' /* masked input always */ });
  assert.equal(
    pickConnectorField(modelSetupDraft, fd, 'minimaxApiKey'),
    'sk-fresh-key-12345',
  );
});
