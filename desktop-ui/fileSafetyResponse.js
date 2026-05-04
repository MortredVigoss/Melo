// fileSafetyResponse.js — pure decision logic for what to do with a
// pending file-safety dialog after the server responds. Extracted from
// app.js so the retry/banner contract from the Phase 3 Codex follow-up
// can be unit-tested without standing up a full DOM.
//
// Caller responsibility split:
//   - The caller (app.js handleFileSafetyResponse) owns the queue
//     mutation + render() side-effects.
//   - This module owns the decision: given the entry that was in the
//     queue when the request fired, the server response (or thrown
//     error), should the entry be removed, kept-with-error-banner, or
//     left alone (already-removed-optimistically)?
//
// Action contract:
//   { action: 'remove_optimistic',  removeBeforeAwait: true  }
//     Non-confirm stage: caller should drop the entry and render
//     BEFORE awaiting the network call, like the legacy tool-runner
//     dialog.
//   { action: 'remove' }
//     Confirm stage that resolved cleanly (or got rejected by the gate
//     for a non-recoverable reason): drop the entry.
//   { action: 'mark_error', message }
//     Confirm stage that hit a recoverable mismatch / network failure:
//     keep the entry, set confirmError so the dialog re-renders with
//     a banner, let the user retry the input.
//   { action: 'noop' }
//     Non-confirm stage on the post-await path: nothing to do, the
//     pre-await branch already removed the entry.

export function isFileSafetyConfirmStage(entry) {
  return !!(
    entry &&
    entry.kind === 'file_safety' &&
    entry.operation === 'delete' &&
    entry.payload &&
    entry.payload.stage === 'confirm'
  );
}

// Decide what to do BEFORE awaiting the network call. For non-confirm
// stages we keep the legacy optimistic-remove behaviour so the
// successful path doesn't flash a stale dialog while the round-trip
// is in flight.
export function decideFileSafetyPreflight(entry) {
  if (isFileSafetyConfirmStage(entry)) {
    return { action: 'noop' };
  }
  return { action: 'remove_optimistic' };
}

// Decide what to do AFTER awaiting. `error` is set if the network call
// threw; otherwise `response` is the JSON body. Confirm-stage mismatch
// is the only recoverable case.
export function decideFileSafetyResponseAction({ entry, response = null, error = null }) {
  const confirmStage = isFileSafetyConfirmStage(entry);

  if (error) {
    if (confirmStage) {
      return {
        action: 'mark_error',
        message: error.message || 'Request failed; try again.',
      };
    }
    // Non-confirm stages already had the entry removed pre-await; the
    // legacy contract is to swallow the error (server already resolved
    // or timed out, so retrying doesn't help). Caller still logs it.
    return { action: 'noop' };
  }

  if (!confirmStage) {
    // Already removed pre-await; nothing left to do.
    return { action: 'noop' };
  }

  if (response && response.ok === false && response.reason === 'CONFIRMATION_MISMATCH') {
    const expected = typeof response.expected === 'string' ? response.expected : '';
    return {
      action: 'mark_error',
      message: `Typed value did not match "${expected}". Try again.`,
    };
  }

  return { action: 'remove' };
}
