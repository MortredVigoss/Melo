// Contract tests for the OpenAI connector / model setup form's
// `input` event dispatcher.
//
// The Codex C-grade pre-pp review (2026-04-28) flagged that the
// connector-config form was *visibly* losing freshly-pasted MiniMax
// API keys — the user typed/pasted, the value flashed away, the
// next Save submitted "" anyway.  These tests pin the structural
// fix: only `authMode` triggers a re-render; every other field
// mirrors onto the draft and leaves the live DOM alone, so the
// browser's input buffer keeps showing the user's typing.
//
// We also exercise the full paste → background render → save
// regression using the pure helpers from `connectorDraft.js` to
// prove the chain holds without booting a real DOM:
//   1. user pastes a key (input event)
//   2. dispatcher mirrors onto modelSetupDraft, returns shouldRender=false
//   3. a *background* render fires anyway (bootstrap refresh, MCP poll)
//      — this is the path that re-renders the form template
//   4. password input rebuilt with SSR value="" per the mask contract
//   5. user clicks Save → handleSaveConnectorConfig calls
//      pickConnectorField(draft, formData, name) → reads the still-
//      live draft → submit body carries the real key

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFormInputToDraft, FORMS_OWNED_BY_CONNECTOR_DRAFT } from './connectorDraftDispatch.js';
import { buildConnectorDraft, pickConnectorField } from './connectorDraft.js';

// Stand-in for app.js::modelDefaultsForAuthMode — the dispatcher only
// reads { baseUrl, model } off the return value.
const FAKE_MODE_DEFAULTS = {
  codex: { baseUrl: 'https://chatgpt.com/backend-api', model: 'gpt-5.5' },
  'api-key': { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5' },
  local: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1' },
};
const fakeModeDefaults = mode => FAKE_MODE_DEFAULTS[mode] || FAKE_MODE_DEFAULTS.codex;

// ─── ownership ──────────────────────────────────────────────────────────────

test('FORMS_OWNED_BY_CONNECTOR_DRAFT covers exactly model-config and connector-config', () => {
  // Both surfaces edit the same underlying config block — Settings →
  // Model and Customize → Connectors → OpenAI. The dispatcher must
  // own both.
  assert.deepEqual([...FORMS_OWNED_BY_CONNECTOR_DRAFT].sort(), [
    'connector-config',
    'model-config',
  ]);
});

test('applyFormInputToDraft returns null for forms it does not own', () => {
  for (const formName of ['agent-profile-update', 'task-create', 'undefined-form', '', undefined]) {
    const result = applyFormInputToDraft({
      formName,
      fieldName: 'minimaxApiKey',
      value: 'sk-x',
      currentDraft: null,
      fallbackDraft: {},
      modelDefaultsForAuthMode: fakeModeDefaults,
    });
    assert.equal(result, null, `formName=${JSON.stringify(formName)} must bail out`);
  }
});

test('applyFormInputToDraft returns null when fieldName is missing', () => {
  for (const fieldName of [undefined, null, '', 42, {}]) {
    const result = applyFormInputToDraft({
      formName: 'connector-config',
      fieldName,
      value: 'whatever',
      currentDraft: null,
      fallbackDraft: {},
      modelDefaultsForAuthMode: fakeModeDefaults,
    });
    assert.equal(result, null);
  }
});

// ─── render gate — the regression core ─────────────────────────────────────

test('non-authMode field changes return shouldRender=false', () => {
  // This is the bug fix: pasting into a password input must NOT
  // trigger render(); render() rebuilds the DOM and the mask
  // contract resets value="" → the user sees their paste vanish.
  for (const field of [
    'minimaxApiKey',
    'minimaxGroupId',
    'minimaxVoiceId',
    'whisperApiKey',
    'whisperBaseUrl',
    'baseUrl',
    'model',
    'systemPrompt',
    'apiKey',
  ]) {
    const result = applyFormInputToDraft({
      formName: 'connector-config',
      fieldName: field,
      value: 'sk-fresh-paste',
      currentDraft: null,
      fallbackDraft: { authMode: 'codex' },
      modelDefaultsForAuthMode: fakeModeDefaults,
    });
    assert.ok(result, `${field} must produce a result`);
    assert.equal(result.shouldRender, false, `${field} must not trigger render`);
    assert.equal(result.nextDraft[field], 'sk-fresh-paste');
  }
});

test('authMode change DOES return shouldRender=true and seeds defaults', () => {
  // authMode is the one field that legitimately needs a re-render —
  // it switches the codex-vs-api-key conditional markup and seeds
  // baseUrl/model defaults the user hasn't typed yet.
  const result = applyFormInputToDraft({
    formName: 'connector-config',
    fieldName: 'authMode',
    value: 'api-key',
    currentDraft: { authMode: 'codex', baseUrl: 'old-url' },
    fallbackDraft: { authMode: 'codex' },
    modelDefaultsForAuthMode: fakeModeDefaults,
  });
  assert.equal(result.shouldRender, true);
  assert.equal(result.nextDraft.authMode, 'api-key');
  assert.equal(result.nextDraft.baseUrl, 'https://api.openai.com/v1');
  assert.equal(result.nextDraft.model, 'gpt-5.5');
});

test('authMode → codex clears apiKey so a stale api-key value does not bleed into OAuth submit', () => {
  const result = applyFormInputToDraft({
    formName: 'model-config',
    fieldName: 'authMode',
    value: 'codex',
    currentDraft: { authMode: 'api-key', apiKey: 'sk-was-typed-before' },
    fallbackDraft: { authMode: 'api-key' },
    modelDefaultsForAuthMode: fakeModeDefaults,
  });
  assert.equal(result.nextDraft.authMode, 'codex');
  assert.equal(result.nextDraft.apiKey, '');
});

// ─── draft merge ───────────────────────────────────────────────────────────

test('applyFormInputToDraft preserves prior draft fields, only overlays the new field', () => {
  const result = applyFormInputToDraft({
    formName: 'connector-config',
    fieldName: 'minimaxApiKey',
    value: 'sk-paste',
    currentDraft: { minimaxGroupId: '12345', model: 'gpt-5.5' },
    fallbackDraft: { authMode: 'codex' },
    modelDefaultsForAuthMode: fakeModeDefaults,
  });
  assert.equal(result.nextDraft.minimaxApiKey, 'sk-paste');
  assert.equal(result.nextDraft.minimaxGroupId, '12345', 'unrelated draft field survives');
  assert.equal(result.nextDraft.model, 'gpt-5.5', 'unrelated draft field survives');
});

test('applyFormInputToDraft falls back to effective draft when currentDraft is null', () => {
  // First keystroke after the page renders has no currentDraft yet;
  // we still need to populate the merged draft with the saved-config
  // baseline so subsequent reads see baseUrl / model / authMode.
  const result = applyFormInputToDraft({
    formName: 'connector-config',
    fieldName: 'minimaxApiKey',
    value: 'sk-paste',
    currentDraft: null,
    fallbackDraft: {
      authMode: 'codex',
      baseUrl: 'https://chatgpt.com/backend-api',
      model: 'gpt-5.5',
      minimaxGroupId: 'saved-group',
    },
    modelDefaultsForAuthMode: fakeModeDefaults,
  });
  assert.equal(result.nextDraft.minimaxApiKey, 'sk-paste');
  assert.equal(result.nextDraft.minimaxGroupId, 'saved-group');
  assert.equal(result.nextDraft.authMode, 'codex');
});

test('applyFormInputToDraft tolerates missing modelDefaultsForAuthMode for non-authMode fields', () => {
  // Defensive: tests / smaller helpers may skip the resolver.
  const result = applyFormInputToDraft({
    formName: 'connector-config',
    fieldName: 'minimaxApiKey',
    value: 'sk-x',
    currentDraft: null,
    fallbackDraft: {},
    modelDefaultsForAuthMode: undefined,
  });
  assert.equal(result.shouldRender, false);
  assert.equal(result.nextDraft.minimaxApiKey, 'sk-x');
});

// ─── End-to-end regression: paste → render → save (the user-visible bug) ──

test('regression — paste MiniMax key, simulate background render, Save still carries the key', () => {
  // 1. Page just mounted. Saved config has no MiniMax credentials yet.
  let bootstrapConfig = { authMode: 'codex', model: 'gpt-5.5' };
  let modelSetupDraft = null;

  // 2. Initial render: form template reads from buildConnectorDraft.
  let formDraft = buildConnectorDraft(bootstrapConfig, modelSetupDraft);
  assert.equal(formDraft.minimaxApiKey, '', 'mask: secrets start blank');
  assert.equal(formDraft.minimaxGroupId, '', 'group id starts blank');

  // 3. User pastes a real key into the masked password input.
  //    The browser fires a single `input` event synchronously.
  const pasteResult = applyFormInputToDraft({
    formName: 'connector-config',
    fieldName: 'minimaxApiKey',
    value: 'sk-real-paste-99999',
    currentDraft: modelSetupDraft,
    fallbackDraft: formDraft,
    modelDefaultsForAuthMode: fakeModeDefaults,
  });
  // The whole point of the fix:
  assert.equal(pasteResult.shouldRender, false,
    'paste must not trigger sync render — that DOM rebuild is what was wiping the input');
  modelSetupDraft = pasteResult.nextDraft;
  assert.equal(modelSetupDraft.minimaxApiKey, 'sk-real-paste-99999');

  // 4. User pastes a Group ID right after — same path.
  const paste2 = applyFormInputToDraft({
    formName: 'connector-config',
    fieldName: 'minimaxGroupId',
    value: '2043976794868035719',
    currentDraft: modelSetupDraft,
    fallbackDraft: formDraft,
    modelDefaultsForAuthMode: fakeModeDefaults,
  });
  assert.equal(paste2.shouldRender, false);
  modelSetupDraft = paste2.nextDraft;

  // 5. A *background* render fires (mcpAuthSurface poll, undo-toast
  //    tick, autosave response). The form template is rebuilt; the
  //    password input goes back to value="" per the mask contract.
  //    We don't simulate the DOM here — what matters is that
  //    modelSetupDraft is unaffected by render() side effects.
  formDraft = buildConnectorDraft(bootstrapConfig, modelSetupDraft);
  assert.equal(formDraft.minimaxApiKey, 'sk-real-paste-99999',
    'effective draft still carries the paste — render did not touch modelSetupDraft');
  assert.equal(formDraft.minimaxGroupId, '2043976794868035719');

  // 6. User clicks Save. handleSaveConnectorConfig builds the submit
  //    body via pickConnectorField(draft, formData, name). The
  //    masked password input's FormData.value is "" (mask contract);
  //    pickConnectorField MUST pull from the draft instead.
  const fdSnapshot = {
    get: name => {
      // Simulate a FormData where the masked password input contributes
      // an empty string and non-secret fields contribute their typed
      // values (browser shows them in the live DOM).
      if (name === 'minimaxApiKey') return ''; // mask
      if (name === 'minimaxGroupId') return '2043976794868035719';
      if (name === 'authMode') return 'codex';
      return null;
    },
  };
  const submitMinimaxApiKey = pickConnectorField(modelSetupDraft, fdSnapshot, 'minimaxApiKey');
  const submitMinimaxGroupId = pickConnectorField(modelSetupDraft, fdSnapshot, 'minimaxGroupId');
  const submitAuthMode = pickConnectorField(modelSetupDraft, fdSnapshot, 'authMode');

  assert.equal(submitMinimaxApiKey, 'sk-real-paste-99999',
    'Save body carries the freshly-pasted MiniMax key');
  assert.equal(submitMinimaxGroupId, '2043976794868035719');
  assert.equal(submitAuthMode, 'codex');
});

test('regression — multi-field paste sequence does not lose any field along the way', () => {
  // User pastes API key, then Group ID, then Voice ID. Between any two
  // of those a background render could fire. Every paste must be
  // additive on the draft.
  let modelSetupDraft = null;
  const fallback = { authMode: 'codex', model: 'gpt-5.5' };

  const fields = [
    ['minimaxApiKey', 'sk-key-aaa'],
    ['minimaxGroupId', '111-group'],
    ['minimaxVoiceId', 'moss_audio_zzz'],
  ];

  for (const [fieldName, value] of fields) {
    const result = applyFormInputToDraft({
      formName: 'connector-config',
      fieldName,
      value,
      currentDraft: modelSetupDraft,
      fallbackDraft: fallback,
      modelDefaultsForAuthMode: fakeModeDefaults,
    });
    assert.equal(result.shouldRender, false);
    modelSetupDraft = result.nextDraft;
  }

  for (const [fieldName, value] of fields) {
    assert.equal(modelSetupDraft[fieldName], value, `${fieldName} retained`);
  }
});
