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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyFormInputToDraft, FORMS_OWNED_BY_CONNECTOR_DRAFT } from './connectorDraftDispatch.js';
import { buildConnectorDraft, pickConnectorField } from './connectorDraft.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_SRC = readFileSync(join(HERE, 'app.js'), 'utf8');

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

// ─── Wiring assertion — Codex C 建议的"真实事件路径"覆盖 ────────────────────

test('wiring — applyFormInputToDraft is invoked inside the document `input` listener', () => {
  // Codex C 第六轮（2026-04-28）抓到的本质 bug：上一刀虽然抽了
  // pure helper 并加了 paste→Save 端到端测试，但 helper 实际
  // 只挂在 `addEventListener('change', …)` 里 — 用户在密码框
  // 粘贴时 input event 同步触发，change 要等 blur，所以 paste
  // 后任何 background render 都能在 draft 写入前抢跑、把 SSR
  // value="" 推回去清空可见值。helper 单测 100% 假绿。
  //
  // 这条 wiring 断言专治这种"helper 写好但没接线"的回归：直接
  // 读 app.js 源码，找到 `addEventListener('input', …)` 注册
  // 的范围，确认 connector-config / model-config 那条 dispatch
  // 路径在范围内。脆但便宜，比起 jsdom 全套 paste→DOM event 仿
  // 真，这层"接线静态检查"已经够抓死。
  const inputStart = APP_SRC.indexOf("addEventListener('input'");
  assert.ok(inputStart >= 0, "expected an `addEventListener('input', …)` registration in app.js");

  // Find the matching closing `});` by tracking brace depth from the
  // opening `(` of addEventListener.
  const openParen = APP_SRC.indexOf('(', inputStart);
  let depth = 0;
  let inputEnd = -1;
  for (let i = openParen; i < APP_SRC.length; i += 1) {
    const c = APP_SRC[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) { inputEnd = i; break; }
    }
  }
  assert.ok(inputEnd > inputStart, 'failed to locate the close of the `input` listener body');

  const inputBody = APP_SRC.slice(inputStart, inputEnd);
  assert.match(
    inputBody,
    /applyFormInputToDraft/,
    'applyFormInputToDraft must be invoked inside the `input` listener — '
      + 'wiring it only inside `change` (blur-triggered) lets pasted password '
      + 'values vanish before draft is written',
  );

  // And specifically inside a connector-config / model-config gate so we
  // don't accidentally run the dispatcher on every keystroke in every
  // form. Looser regex tolerates whitespace + alternative ordering.
  assert.match(
    inputBody,
    /(connector-config|model-config)[^]*?applyFormInputToDraft/,
    'the dispatcher should be guarded by a connector-config / model-config form check',
  );
});

test('wiring — scheduleConnectorAutosave is invoked inside both input and change listeners', () => {
  // After the dispatcher writes the draft, the same paths must also
  // schedule the 3-second idle autosave so a user who pastes a key
  // and walks away (page switch, tab close) doesn't lose the value.
  // Both listeners must opt in: input handles text/password/textarea;
  // change handles the authMode <select> (which doesn't fire input).
  const inputStart = APP_SRC.indexOf("addEventListener('input'");
  const changeStart = APP_SRC.indexOf("addEventListener('change'");
  assert.ok(inputStart >= 0 && changeStart > inputStart);

  const findEnd = startIdx => {
    const openParen = APP_SRC.indexOf('(', startIdx);
    let depth = 0;
    for (let i = openParen; i < APP_SRC.length; i += 1) {
      const c = APP_SRC[i];
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  };

  const inputBody = APP_SRC.slice(inputStart, findEnd(inputStart));
  const changeBody = APP_SRC.slice(changeStart, findEnd(changeStart));

  assert.match(
    inputBody,
    /scheduleConnectorAutosave\(/,
    'input listener must call scheduleConnectorAutosave so paste-typed keys land on server after 3s idle',
  );
  assert.match(
    changeBody,
    /scheduleConnectorAutosave\(/,
    'change listener must call scheduleConnectorAutosave so authMode <select> changes also autosave',
  );
});

test('wiring — flushPendingConnectorAutosaveOnUnload is registered on pagehide / beforeunload', () => {
  // sendBeacon flush — closing the window mid-paste must still ship
  // the typed key to the server. Mirrors the agent autosave flush
  // pattern (line 5256-ish).
  assert.match(
    APP_SRC,
    /flushAllPendingAutosavesOnUnload|flushPendingConnectorAutosaveOnUnload/,
    'unload flush helper must be defined',
  );
  assert.match(
    APP_SRC,
    /addEventListener\('pagehide',\s*flush(All|Pending)/,
    "pagehide must call the unified or connector-specific autosave flush",
  );
});

test('wiring — set-model-auth-mode button enters the same autosave pipeline', () => {
  // Codex C 第七轮（2026-04-28）：Settings → Model 用按钮切 Local /
  // API key / OAuth（不是 <select>），所以 input/change listener 都
  //不触发新增的 connector autosave。"切到 api-key 等 3 秒后切走"
  // 的场景需要这个 action 也调 scheduleConnectorAutosave。
  const caseStart = APP_SRC.indexOf("case 'set-model-auth-mode':");
  assert.ok(caseStart >= 0, 'set-model-auth-mode case must exist');
  const caseSnippet = APP_SRC.slice(caseStart, caseStart + 1500);
  assert.match(
    caseSnippet,
    /scheduleConnectorAutosave\(/,
    'set-model-auth-mode action must schedule the autosave so button-driven authMode swaps still persist after 3s idle',
  );
});

test('wiring — autosave unload flush beacons BOTH pending and inflight bodies', () => {
  // The earlier single-snapshot design lost configs when the user
  // closed the window during the 3-second window between fetch()
  // start and response land — the snapshot was nulled the moment
  // the POST started, so unload flush had nothing to beacon. The
  // fix splits state into pending vs inflight; both must be sent
  // on unload so neither path drops the user's typed key.
  assert.match(
    APP_SRC,
    /pendingConnectorAutosave/,
    'must declare a pending snapshot',
  );
  assert.match(
    APP_SRC,
    /inflightConnectorAutosave/,
    'must declare an inflight snapshot',
  );
  // The flush function should iterate both snapshots — easiest
  // structural check is that the function body mentions both names.
  const fnStart = APP_SRC.indexOf('function flushPendingConnectorAutosaveOnUnload');
  assert.ok(fnStart >= 0);
  const fnSnippet = APP_SRC.slice(fnStart, fnStart + 2500);
  assert.match(
    fnSnippet,
    /pendingConnectorAutosave/,
    'unload flush must read pending snapshot',
  );
  assert.match(
    fnSnippet,
    /inflightConnectorAutosave/,
    'unload flush must read inflight snapshot too — otherwise closing during the 3s POST loses the body',
  );
  assert.match(
    fnSnippet,
    /sendBeacon/,
    'unload flush must use sendBeacon (or keepalive fetch) so the request survives unload',
  );
});

test('wiring — handleLoadModelOptions reads via pickConnectorField, not raw FormData', () => {
  // Codex B-grade follow-up (2026-04-28): the "Read available models"
  // button used `FormData.get('apiKey')` directly, so any background
  // render between paste and click would drop the key. Save path was
  // already fixed; this asserts the load path uses the same helper.
  const fnStart = APP_SRC.indexOf('async function handleLoadModelOptions');
  assert.ok(fnStart >= 0, 'handleLoadModelOptions must exist');
  // Look at roughly the next ~40 lines — the body is small.
  const fnSnippet = APP_SRC.slice(fnStart, fnStart + 2000);
  assert.match(
    fnSnippet,
    /pickConnectorField\(/,
    'handleLoadModelOptions must use pickConnectorField for the same draft-first read as the save path',
  );
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
