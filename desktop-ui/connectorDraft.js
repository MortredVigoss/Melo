// Pure draft helper for the OpenAI connector + Settings → Model forms.
//
// app.js renders both surfaces from the same underlying config block
// (apiKey / baseUrl / model / whisper* / minimax*) and shares one
// `uiState.modelSetupDraft` to remember in-flight typing across
// background renders.  The 2026-04-28 connector audit caught the
// connector-config form silently dropping every paste in the password
// fields: the input handler was gated on `dataset.form === 'model-config'`
// only, so each `app.innerHTML = …` swap recreated the inputs with
// SSR `value=""` and `keepIfBlank` on the server then treated submit
// as "no change".  Lifting the merge here lets node:test pin the
// fallback chain — saved config + live draft + masked-secret semantics
// — without booting the app.
//
// Whitelist semantics (mirrors agentDraft.js convention):
//   - Read-only flags (hasMinimaxKey, maskedMinimaxApiKey, codexAuth, …)
//     are NOT part of this draft. They live on `selected.config` in the
//     form template because they reflect server-side state, not user
//     input. Adding them here would invite a stale draft to overwrite
//     the saved-key indicator chip.
//   - Secrets (apiKey / whisperApiKey / minimaxApiKey) start blank by
//     contract: the form input is masked; blank in the submit body is
//     interpreted by the server as "preserve current". Including them
//     in the draft is what lets a user paste-then-wait survive the
//     intervening render — but the default must still be "" so an
//     empty draft doesn't claim the user typed nothing into a still-
//     unsaved key.
//   - Non-secret editable fields (baseUrl / model / minimax{GroupId,VoiceId} /
//     whisperBaseUrl / systemPrompt) fall back to the saved config so
//     the form starts populated; the live draft overrides on top.

const DEFAULT_AUTH_MODE = 'codex';

/**
 * Build the draft object the connector / model form reads its inputs
 * from.  Pure — no DOM, no globals.  Returns a fresh object on every
 * call; callers may mutate it freely.
 *
 * @param {Object|null|undefined} config        saved settings.config
 * @param {Object|null|undefined} modelSetupDraft  in-flight typing
 * @returns {{
 *   authMode: string,
 *   baseUrl: string,
 *   model: string,
 *   systemPrompt: string,
 *   apiKey: string,
 *   whisperApiKey: string,
 *   whisperBaseUrl: string,
 *   minimaxApiKey: string,
 *   minimaxGroupId: string,
 *   minimaxVoiceId: string,
 * }}
 */
export function buildConnectorDraft(config, modelSetupDraft) {
  const cfg = (config && typeof config === 'object') ? config : {};
  const draft = (modelSetupDraft && typeof modelSetupDraft === 'object') ? modelSetupDraft : {};
  return {
    authMode: cfg.authMode || DEFAULT_AUTH_MODE,
    baseUrl: cfg.baseUrl || '',
    model: cfg.model || '',
    systemPrompt: cfg.systemPrompt || '',
    apiKey: '',
    whisperApiKey: '',
    whisperBaseUrl: cfg.whisperBaseUrl || '',
    minimaxApiKey: '',
    minimaxGroupId: cfg.minimaxGroupId || '',
    minimaxVoiceId: cfg.minimaxVoiceId || '',
    ...draft,
  };
}

/**
 * Trim-aware getter for connector form submit.  The form's password
 * inputs render with value="" so a stale FormData read can wipe a
 * key the user just pasted but didn't have time to commit.  Prefer
 * the draft for every secret-bearing field; fall back to FormData
 * for non-secret values that haven't been touched yet.
 *
 * Pure helper, exported so node:test can pin the precedence rule.
 *
 * @param {Object|null|undefined} draft   live modelSetupDraft
 * @param {FormData|null|undefined} formData
 * @param {string} name
 * @returns {string}
 */
export function pickConnectorField(draft, formData, name) {
  const fromDraft =
    draft && typeof draft[name] === 'string' ? draft[name].trim() : '';
  if (fromDraft) return fromDraft;
  if (!formData || typeof formData.get !== 'function') return '';
  return String(formData.get(name) || '').trim();
}

/**
 * Build the autosave POST body for a connector / model-config form.
 * Returns `null` when the form's effective authMode is 'codex',
 * because src/desktopStore.js::updateModelConfig forces apiKey=''
 * on any patch with authMode==='codex'. Letting an idle autosave
 * fire that patch would silently wipe a saved OpenAI API key the
 * moment the user clicks the OAuth button — credential clearing
 * must stay an explicit Save action, never a side-effect of going
 * idle for 3 seconds. (Codex audit 2026-04-28.)
 *
 * Pure — no DOM, no globals. Returns a fresh object on success.
 *
 * @param {Object|null|undefined} args
 * @param {FormData|null|undefined} args.formData
 * @param {Object|null|undefined} args.draft   live modelSetupDraft
 * @returns {Object|null}
 */
export function buildAutosaveBody({ formData, draft } = {}) {
  const pick = name => pickConnectorField(draft, formData, name);
  const authMode = pick('authMode') || 'codex';
  if (authMode === 'codex') return null;
  const body = {
    authMode,
    baseUrl: pick('baseUrl'),
    model: pick('model'),
    systemPrompt: pick('systemPrompt'),
    whisperApiKey: pick('whisperApiKey'),
    whisperBaseUrl: pick('whisperBaseUrl'),
    minimaxApiKey: pick('minimaxApiKey'),
    minimaxGroupId: pick('minimaxGroupId'),
    minimaxVoiceId: pick('minimaxVoiceId'),
  };
  const apiKey = pick('apiKey');
  if ((authMode === 'api-key' || authMode === 'local') && apiKey) {
    body.apiKey = apiKey;
  }
  return body;
}
