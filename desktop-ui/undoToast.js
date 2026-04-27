/**
 * Pure helpers for the soft-delete undo toast.  All of the actual DOM
 * plumbing lives in app.js's `showUndoToast` — these functions just
 * compute strings, so they're cheap to unit-test under `node:test`.
 *
 * The toast's job: after the user soft-deletes an item, show a small
 * banner at the bottom of the window with a countdown + Undo button.
 * If the timer expires, the actual destructive API call fires.  If the
 * user clicks Undo first, the timer is cancelled and the soft-delete
 * never crystallises.
 */

/**
 * Default lifetime of an undo toast.  Long enough to read the message
 * and reach for the button, short enough that an idle confirmation
 * doesn't feel laggy.
 */
export const UNDO_TOAST_DEFAULT_MS = 5000;

/**
 * Format remaining milliseconds as "Xs" rounded UP — when 4250 ms are
 * left we still want to display "5s" because the user is mentally on
 * the way down from the original 5s announcement.  Returns "0s" once
 * we cross zero so the label never goes negative even if the tick
 * fires a hair after the timeout.
 *
 * @param {number} remainingMs
 * @returns {string}
 */
export function formatUndoCountdown(remainingMs) {
  const ms = Number.isFinite(remainingMs) ? remainingMs : 0;
  if (ms <= 0) return '0s';
  return `${Math.ceil(ms / 1000)}s`;
}

/**
 * Build the toast's body string from the source message + remaining
 * time.  Kept pure so a snapshot test can pin the wording.
 *
 * @param {string} message    user-facing description, e.g. `Deleted "Foo".`
 * @param {number} remainingMs
 * @returns {string}
 */
export function formatUndoToastLabel(message, remainingMs) {
  const trimmed = String(message ?? '').trim();
  const countdown = formatUndoCountdown(remainingMs);
  if (!trimmed) return `Undo · ${countdown}`;
  return `${trimmed} Undo · ${countdown}`;
}

/**
 * Compute the next tick interval in ms so the visible countdown stays
 * accurate without firing on every animation frame.  Always at least
 * 100ms so we never busy-loop, never longer than the remaining time
 * so the label can't lag a full second behind reality.
 *
 * @param {number} remainingMs
 * @returns {number}
 */
export function nextCountdownTickMs(remainingMs) {
  const ms = Number.isFinite(remainingMs) ? remainingMs : 0;
  if (ms <= 0) return 0;
  // Sync to the next "second tick" relative to the deadline: if 3.4s
  // remain we want to wake up after 0.4s so the label flips from "4s"
  // to "3s" right at the integer boundary.
  const nextSecondBoundary = ms - Math.floor((ms - 1) / 1000) * 1000;
  return Math.max(100, Math.min(nextSecondBoundary, ms));
}
