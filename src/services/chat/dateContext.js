// Date context for the prompt (2026-10-18 bug: a reply written late on day N
// said "今天…"; the next message came after midnight and the model, seeing
// only "Current local date: N+1", apologised that its previous "today" had
// been wrong). Two pieces:
//
//   1. a standing rule next to the current date (stable prefix): earlier
//      messages were written at their own time, so a "today" in them refers
//      to that day and is not an error;
//   2. a per-turn note, only when the local date changed since the previous
//      message in the chat, saying which day that message was sent on. It
//      lives in the turn section so the cached prefix is untouched.

export function localDateString(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export const DATE_CONTINUITY_RULE =
  'Earlier messages in this conversation were written at their own time, possibly on earlier days; ' +
  'a "today", "tonight" or "tomorrow" in a previous reply referred to the day it was written and is not a mistake. ' +
  'Do not apologise for or "correct" earlier date references — just use the current date for new statements, and say explicitly when a day has changed if it matters to the answer.';

/**
 * Per-turn note when the previous message in `messages` was sent on a
 * different local day than `now`. Returns '' otherwise.
 */
export function buildDateChangeNote(messages = [], { now = new Date(), timeZone } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let latestUser = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === 'user' && !list[index]?.isToolResult) { latestUser = index; break; }
  }
  const previous = latestUser > 0 ? list[latestUser - 1] : null;
  if (!previous?.createdAt) return '';
  const previousDay = localDateString(previous.createdAt, timeZone);
  const today = localDateString(now, timeZone);
  if (!previousDay || !today || previousDay === today) return '';
  const elapsedDays = Math.round((Date.parse(today) - Date.parse(previousDay)) / 86_400_000);
  const gap = elapsedDays === 1 ? 'yesterday' : elapsedDays > 1 ? `${elapsedDays} days ago` : 'on a different day';
  return `[Date context] The previous message in this conversation was sent on ${previousDay} (${gap}); today is ${today}. ` +
    'Treat "today" in earlier messages as that earlier day. If the user\'s new message depends on the date (plans, weather, deadlines), use today\'s date and mention the change briefly; otherwise do not comment on it.';
}
