/**
 * Phase 3C — pending-skill-draft registry + Telegram confirmation glue.
 *
 * When the user (from Telegram, the web UI, or the CLI) asks us to draft a
 * skill, we stash the drafted skill into a per-chatId slot. Before the bot
 * persists it we wait for the user to reply with a confirmation ("save",
 * "好", "yes"), a rejection ("discard", "不要", "no"), or an edit hint
 * ("改 systemPrompt 成 …").
 *
 * The persistence target here is in-process memory only — if the bot
 * restarts, pending drafts are lost and the user can just rerun
 * /save-as-skill. A durable queue would belong in the main state file and
 * is tracked as Phase 3D work (skill-proposals).
 *
 * This module has zero network / disk side effects of its own. Callers wire
 * it to Telegram or the REPL by passing a saveFn (which in real use is
 * createCustomSkill).
 */

// ─── Intent classifier ───────────────────────────────────────────────────────
//
// We deliberately keep this regex-based (no LLM round-trip) so the hot path
// for an incoming Telegram message is cheap. If the classifier can't pin a
// clear intent it returns 'unknown' and the main chat reply path handles
// the message normally — no surprise mutations.

const CONFIRM_PATTERNS = [
  /^\s*(y|yes|yep|yup|sure|ok(?:ay)?|save|save it|confirm|do it|go ahead)\b[\s!.]*$/i,
  /^\s*(好|好的|行|可以|保存|确认|就这个|存|存起来|存下来)\s*[!.。！]*\s*$/,
];

const REJECT_PATTERNS = [
  /^\s*(n|no|nope|nah|cancel|discard|drop|skip|never mind|nevermind|forget it)\b[\s!.]*$/i,
  /^\s*(不|不要|不用|算了|取消|别|删掉|作废)\s*[!.。！]*\s*$/,
];

const EDIT_PATTERNS = [
  /^\s*(edit|change|rename|rewrite|tweak|adjust|update|re[- ]?draft)\b/i,
  /^\s*(改|改成|改一下|重写|修改|换|调整|再来|重来)/,
];

/**
 * Classify the user's short free-text reply into one of
 *   'confirm' | 'reject' | 'edit' | 'unknown'
 *
 * 'edit' carries along the free-form edit hint after the verb so the
 * caller can feed it back into draftSkillFromConversation().
 */
export function classifySkillDraftReply(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return { intent: 'unknown' };

  for (const re of CONFIRM_PATTERNS) {
    if (re.test(s)) return { intent: 'confirm' };
  }
  for (const re of REJECT_PATTERNS) {
    if (re.test(s)) return { intent: 'reject' };
  }
  for (const re of EDIT_PATTERNS) {
    const m = s.match(re);
    if (m) {
      const hint = s.slice(m[0].length).trim();
      return { intent: 'edit', hint };
    }
  }
  return { intent: 'unknown' };
}

// ─── Pending-draft store ─────────────────────────────────────────────────────

/**
 * Create a new pending-draft store. Each pending record carries the
 * drafted skill plus a createdAt timestamp (for TTL sweeping) and an
 * agentId (so a skill drafted from Agent A can only be confirmed in Agent
 * A's chat — not accidentally saved from a different agent's Telegram
 * channel that shares the same chatId).
 *
 * A single shared module-level store is kept in the `defaultStore` export
 * for production use; tests should make their own store for isolation.
 */
export function createPendingSkillDraftStore({
  ttlMs = 30 * 60 * 1000, // 30 minutes — drafts go stale fast
  nowFn = () => Date.now(),
} = {}) {
  const byChatId = new Map();

  function sweep() {
    const cutoff = nowFn() - ttlMs;
    for (const [id, rec] of byChatId.entries()) {
      if (rec.createdAt < cutoff) byChatId.delete(id);
    }
  }

  return {
    set(chatId, record) {
      sweep();
      if (!chatId) throw new Error('pendingSkillDraftStore.set: chatId required');
      byChatId.set(String(chatId), {
        ...record,
        createdAt: nowFn(),
      });
    },
    get(chatId) {
      sweep();
      return byChatId.get(String(chatId)) || null;
    },
    clear(chatId) {
      byChatId.delete(String(chatId));
    },
    has(chatId) {
      sweep();
      return byChatId.has(String(chatId));
    },
    list() {
      sweep();
      return Array.from(byChatId.entries()).map(([chatId, rec]) => ({ chatId, ...rec }));
    },
    size() {
      sweep();
      return byChatId.size;
    },
  };
}

export const defaultPendingSkillDraftStore = createPendingSkillDraftStore();

// ─── Telegram / chat reply handler ───────────────────────────────────────────

/**
 * Handle an inbound chat message in the context of pending-skill-draft
 * confirmation.
 *
 * @param {Object}   opts
 * @param {string}   opts.chatId     - the chat the reply is coming from
 * @param {string}   opts.text       - the user's free-text reply
 * @param {string}   [opts.agentId]  - agent that requested the draft (must match)
 * @param {Function} opts.saveFn     - (skill) => Promise, persists via createCustomSkill
 * @param {Object}   [opts.store]    - defaults to defaultPendingSkillDraftStore
 * @returns {Promise<{
 *   handled: boolean,
 *   intent?: 'confirm' | 'reject' | 'edit',
 *   saved?: boolean,
 *   skill?: Object,
 *   editHint?: string,
 *   reply?: string,
 *   error?: string,
 * }>}
 *
 * `handled: true` means this message was consumed by the draft flow; the
 * caller should reply to the user with `reply` (if set) and NOT run the
 * message through the normal agent loop. `handled: false` means the user's
 * message was unrelated (e.g. no pending draft, or their reply was an
 * ordinary chat sentence) — the caller should proceed as usual.
 */
export async function handleChatSkillDraftReply({
  chatId,
  text,
  agentId = null,
  saveFn,
  store = defaultPendingSkillDraftStore,
} = {}) {
  if (!chatId) return { handled: false };

  const pending = store.get(chatId);
  if (!pending) return { handled: false };

  // Cross-agent guard — if this draft was initiated by a different agent,
  // don't consume the message. The other agent's chat thread can still use
  // the draft.
  if (agentId && pending.agentId && pending.agentId !== agentId) {
    return { handled: false };
  }

  const { intent, hint } = classifySkillDraftReply(text);

  if (intent === 'unknown') {
    // We leave the pending draft in place — the user may reply properly
    // on the next turn. This also means non-draft messages are not
    // consumed, so Telegram chat keeps flowing normally.
    return { handled: false };
  }

  if (intent === 'reject') {
    store.clear(chatId);
    return {
      handled: true,
      intent,
      reply: `Discarded the draft skill "${pending.skill?.name || pending.skill?.id || ''}".`.trim(),
    };
  }

  if (intent === 'edit') {
    // We don't re-draft here — we surface the hint back to the caller so
    // it can re-invoke draftSkillFromConversation with the edit hint.
    // Clear the old draft so we don't double-save later.
    store.clear(chatId);
    return {
      handled: true,
      intent,
      editHint: hint || '',
      skill: pending.skill,
      reply: 'Got it — re-drafting with your edits. Run /save-as-skill again to see the new proposal.',
    };
  }

  // intent === 'confirm'
  if (typeof saveFn !== 'function') {
    return {
      handled: true,
      intent,
      error: 'MISSING_SAVE_FN',
      reply: 'Internal error: no saveFn wired for confirmation.',
    };
  }

  try {
    await saveFn(pending.skill);
  } catch (err) {
    // Keep the pending draft — the user can fix the error (e.g. duplicate
    // id) and resend `save` again.
    return {
      handled: true,
      intent,
      error: err?.message || 'Save failed',
      reply: `Save failed: ${err?.message || 'unknown error'}. Reply with an edit hint or "discard" to cancel.`,
    };
  }

  store.clear(chatId);
  return {
    handled: true,
    intent,
    saved: true,
    skill: pending.skill,
    reply: `Saved skill "${pending.skill?.id}".`,
  };
}
