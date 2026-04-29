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
// pending while the user is typing, saved once autosave commits
// (which clears the secret from the draft — see the post-autosave
// secret-clear step in `scheduleConnectorAutosave`).

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

/**
 * After a successful autosave POST, sweep the credential fields off
 * the live `modelSetupDraft` so the chip flips from "● 待保存" to
 * "✓ 已保存". The catch (Codex C 第十九轮 audit 2026-04-29) is the
 * in-flight race:
 *
 *   1. user pastes KEY-A → 3s timer fires → POST(KEY-A) in-flight
 *   2. user paste KEY-B → new pending replaces KEY-A's, timer reset
 *   3. KEY-A's response lands first → without this guard we'd
 *      blindly clear `draft.minimaxApiKey` → KEY-B gone.
 *
 * Solution: only clear a credential field when the live draft value
 * STILL equals what we actually shipped. Anything else means the
 * user typed something newer in the meantime and is still waiting
 * for THAT save to complete — keep the field on the draft so the
 * chip stays yellow ("待保存") and the next autosave timer can
 * carry the newer value.
 *
 * Mutates `draft` in place. Returns the array of field names that
 * were actually cleared (handy for tests).
 *
 * @param {Object|null|undefined} draft       the live `uiState.modelSetupDraft`
 * @param {Object|null|undefined} submittedBody  the body that was just POSTed
 * @returns {string[]} fields that were cleared
 */
export function clearCommittedSecrets(draft, submittedBody) {
  if (!draft || typeof draft !== 'object') return [];
  if (!submittedBody || typeof submittedBody !== 'object') return [];
  const cleared = [];
  for (const f of CREDENTIAL_FIELDS) {
    const live = typeof draft[f] === 'string' ? draft[f] : '';
    const submitted = typeof submittedBody[f] === 'string' ? submittedBody[f] : '';
    if (!live || !submitted) continue;
    // Strict equality: any keystroke after we POSTed will have
    // changed `live` away from `submitted` and we must NOT clear.
    if (live === submitted) {
      draft[f] = '';
      cleared.push(f);
    }
  }
  return cleared;
}
