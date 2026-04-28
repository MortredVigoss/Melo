// Pure dispatcher for the OpenAI connector / model setup form's
// `input` event.  Lifted out of `app.js` so node:test can pin the
// "paste → draft → submit" chain end-to-end without booting a real
// DOM, and — more importantly — so the structural difference
// between the two render-trigger cases is obvious to a reviewer.
//
// 2026-04-28 follow-up to the connector audit: the first cut wired
// the input handler in but kept the trailing `render()` from the
// model-config branch.  That `render()` is synchronous — every
// keystroke (and paste) tore down the form's DOM nodes, and since
// password inputs render with `value=""` per the mask contract
// (see `connectorDraft.js`), the user's freshly-pasted key snapped
// back to empty before they could blink.  Codex caught the visible
// symptom (key appears to vanish) on the C-grade pre-pp review.
//
// The fix here is structural: only authMode actually needs an
// immediate render (it swaps the codex-vs-api-key conditional
// markup and seeds defaults).  Every other field — text inputs,
// textareas, the masked password slots — should mirror the value
// onto the shared draft and leave the DOM alone, so the browser's
// own input buffer keeps showing what the user typed.

const FORMS_THAT_USE_THIS_DRAFT = Object.freeze(['model-config', 'connector-config']);

/**
 * @param {object} args
 * @param {string|undefined|null} args.formName       value of `data-form` on the parent form
 * @param {string|undefined|null} args.fieldName      `name` attribute of the input being typed into
 * @param {string} args.value                         the input's current `target.value`
 * @param {object|null|undefined} args.currentDraft   `uiState.modelSetupDraft` snapshot
 * @param {object} args.fallbackDraft                 result of `effectiveModelSetupDraft()` —
 *                                                    used when currentDraft is empty so the
 *                                                    first keystroke doesn't drop saved-config
 *                                                    fields the user hasn't touched yet
 * @param {(authMode: string) => {baseUrl: string, model: string}} args.modelDefaultsForAuthMode
 *
 * @returns {{ nextDraft: object, shouldRender: boolean } | null}
 *   - `null` when the form isn't one we own (caller bails out).
 *   - `nextDraft` is the merged draft to assign back onto uiState.
 *   - `shouldRender === true` ONLY for authMode changes.  Every other
 *     field returns `false` so the caller skips `render()` and the
 *     user's input keeps showing in the live DOM.
 */
export function applyFormInputToDraft({
  formName,
  fieldName,
  value,
  currentDraft,
  fallbackDraft,
  modelDefaultsForAuthMode,
}) {
  if (!FORMS_THAT_USE_THIS_DRAFT.includes(formName)) {
    return null;
  }
  if (typeof fieldName !== 'string' || !fieldName) {
    return null;
  }

  const base = (currentDraft && typeof currentDraft === 'object')
    ? currentDraft
    : (fallbackDraft && typeof fallbackDraft === 'object' ? fallbackDraft : {});

  const nextDraft = { ...base, [fieldName]: value };

  if (fieldName === 'authMode') {
    const defaults = typeof modelDefaultsForAuthMode === 'function'
      ? modelDefaultsForAuthMode(value) || {}
      : {};
    if (typeof defaults.baseUrl === 'string') nextDraft.baseUrl = defaults.baseUrl;
    if (typeof defaults.model === 'string') nextDraft.model = defaults.model;
    if (value === 'codex') {
      // Codex OAuth doesn't take a manually-entered apiKey — clear so the
      // submit body doesn't carry a stale value typed under api-key mode.
      nextDraft.apiKey = '';
    }
    return { nextDraft, shouldRender: true };
  }

  return { nextDraft, shouldRender: false };
}

export const FORMS_OWNED_BY_CONNECTOR_DRAFT = FORMS_THAT_USE_THIS_DRAFT;
