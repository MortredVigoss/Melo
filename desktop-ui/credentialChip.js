// Status chip beside masked credential inputs (OpenAI apiKey,
// Whisper apiKey, MiniMax apiKey).  Codex audit 2026-04-29: the
// password mask hides the value once saved, so users have no
// visible confirmation that the form's last Save actually
// landed.  This helper computes the chip state from
//   - the live `modelSetupDraft` (does the user have unsaved
//     typing in this field right now?)
//   - the bootstrap config flags (`hasApiKey`, `hasWhisperKey`,
//     `hasMinimaxKey`) and their masked counterparts
//
// Lifted into its own module so node:test can pin the contract:
// pending while the user is typing, saved once the explicit Save
// commits and clears the field from the draft (clearModelFormDraft).

const FIELD_TO_FLAG = Object.freeze({
  apiKey: { hasFlag: 'hasApiKey', maskedFlag: 'maskedApiKey' },
  whisperApiKey: { hasFlag: 'hasWhisperKey', maskedFlag: 'maskedWhisperApiKey' },
  minimaxApiKey: { hasFlag: 'hasMinimaxKey', maskedFlag: 'maskedMinimaxApiKey' },
});

/**
 * Pure state-machine for the credential save-status chip.
 *
 * @param {string} fieldName  one of: apiKey | whisperApiKey | minimaxApiKey
 * @param {Object|null|undefined} draft   live `uiState.modelSetupDraft`
 * @param {Object|null|undefined} config  `selected.config` from the
 *   bootstrap (must carry `has*Key` booleans + their `masked*` mask)
 * @returns {{ state: 'pending' | 'saved' | 'unconfigured', masked: string }}
 */
export function credentialChipState(fieldName, draft, config) {
  const draftValue =
    draft && typeof draft[fieldName] === 'string' ? draft[fieldName].trim() : '';
  if (draftValue) {
    return { state: 'pending', masked: '' };
  }

  const meta = FIELD_TO_FLAG[fieldName];
  const cfg = config && typeof config === 'object' ? config : {};
  if (meta && cfg[meta.hasFlag]) {
    return {
      state: 'saved',
      masked: typeof cfg[meta.maskedFlag] === 'string' ? cfg[meta.maskedFlag] : '',
    };
  }

  return { state: 'unconfigured', masked: '' };
}

export const CREDENTIAL_FIELDS = Object.freeze(['apiKey', 'whisperApiKey', 'minimaxApiKey']);

