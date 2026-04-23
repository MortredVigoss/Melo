// ─── Offline backlog filter ──────────────────────────────────────────────────
// When the desktop app has been offline for a while and then reconnects,
// Telegram / Discord `getUpdates` returns every message that arrived since our
// last acknowledged update_id. Without any filter, the bot would then
// machine-gun the group with late replies to every message it "missed" — very
// spammy and nearly always unhelpful because the conversation already moved on.
//
// Detection: any polling cycle whose persisted lastPolledAt is older than
// OFFLINE_BACKLOG_THRESHOLD_MS (or missing entirely on first boot) is treated
// as a backlog cycle. Normal polling happens every few seconds, so a 60s gap
// reliably means the runtime was stopped (crash, quit, put-to-sleep).
//
// Filter (group chats only — private DMs are always processed because the user
// is clearly talking to the bot):
//   (a) explicit @mention of the bot, OR
//   (b) Telegram/Discord-native reply targeting the bot's last message, OR
//   (c) the previous 5 messages in the same chat show active bot context
//       (either the bot spoke, or a user message was marked as addressed to
//       the bot rather than a bystander) — this catches clear follow-ups
//       where the user didn't retype the bot's name.
// Everything else in the backlog is stored as a bystander via
// recordTelegram/DiscordMessageWithoutReply and not replied to.
//
// Extracted from desktopStore.js in the Phase 1 refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module with no state dependencies.

export const OFFLINE_BACKLOG_THRESHOLD_MS = 60_000;
export const BACKLOG_CONTEXT_LOOKBACK = 5;

export function isBacklogPollCycle(persistedChannel) {
  const lastPolledAt = Date.parse(persistedChannel?.lastPolledAt || 0);
  if (!Number.isFinite(lastPolledAt) || lastPolledAt <= 0) {
    return true; // never polled before → treat first-boot fetch as backlog too
  }
  return Date.now() - lastPolledAt > OFFLINE_BACKLOG_THRESHOLD_MS;
}

/**
 * @param {Object} recentChat — chat record (for prior message context lookup)
 * @returns {boolean} — true if the prior BACKLOG_CONTEXT_LOOKBACK messages show
 *   an active conversation with the bot (so this message can still be treated
 *   as a follow-up worth replying to during a backlog sweep).
 */
export function recentChatHasBotContext(recentChat) {
  const messages = Array.isArray(recentChat?.messages) ? recentChat.messages : [];
  if (!messages.length) return false;
  const prior = messages.slice(-BACKLOG_CONTEXT_LOOKBACK);
  return prior.some(
    msg =>
      msg?.role === 'assistant' ||
      (msg?.role === 'user' && msg?.meta?.bystanderMessage !== true),
  );
}

/**
 * Stricter filter applied to every group message fetched during a backlog
 * cycle. Returns true iff the message should proceed through the normal
 * routing/scoring pipeline. See OFFLINE_BACKLOG_THRESHOLD_MS doc above.
 *
 * mentionPredicate is platform-specific: Telegram uses text-level "@username",
 * Discord inspects the message.mentions[] array against our botUserId.
 */
export function passesOfflineBacklogFilter({ incoming, recentChat, mentionPredicate }) {
  if (incoming?.chatType === 'private') return true;
  if (incoming?.isReplyToBot) return true;
  if (typeof mentionPredicate === 'function' && mentionPredicate(incoming)) return true;
  return recentChatHasBotContext(recentChat);
}
