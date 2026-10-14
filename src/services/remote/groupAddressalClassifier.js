// ─── Group-chat addressal classifier ─────────────────────────────────────────
// Lightweight async LLM classifier for the gray-zone routing decision
// (score 0.30–0.55) shared between Telegram and Discord. Ask the compact
// model a single yes/no question: "is this message plausibly for the bot?"
//
// Both channels' routing gates call this identically, so keeping it in one
// module avoids divergence and leaves only the channel-specific signal
// scorers (buildTelegramReplyScore / buildDiscordReplyScore) in their own
// files.
//
// This module owns:
//   - classifyGroupMessageAddressal(incoming, recentChat, config, profile)
//     → Promise<boolean>. Returns true if the LLM thinks the message is
//     addressed to the bot (directly or implicitly), false on error or
//     clear "no". Voice-only messages with no text short-circuit to true.
//
// Extracted from desktopStore.js in the Phase 6d refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — depends only on
// createOpenAICompatibleReply (HTTP) and the shared attachment normalizer.

import { createOpenAICompatibleReply } from '../../openai.js';
import { judgeFast } from '../../judge/fastJudge.js';
import { normalizeMessageAttachments } from '../../shared/helpers.js';

/**
 * Lightweight async LLM classifier for the gray zone (score 0.30–0.55).
 * Uses the compact model and asks a single yes/no question.
 * Falls back to false on any error to avoid blocking the poll loop.
 */
export async function classifyGroupMessageAddressal(incoming, recentChat, config, profile, { signal, onDecision, judge = judgeFast } = {}) {
  const text = String(incoming?.text || '').trim();
  const hasVoice = normalizeMessageAttachments(incoming?.attachments).some(a => a.kind === 'audio');
  // Voice-only messages already scored ≥0.55 in buildTelegramReplyScore and won't reach gray zone
  if (!text && !hasVoice) return false;
  if (!text) return true; // voice note with no text — treat as bot-addressed

  // Build short conversation context (last 4 messages before this one)
  const prevMessages = (Array.isArray(recentChat?.messages) ? recentChat.messages : [])
    .slice(-4)
    .map(m => {
      const role = m?.role === 'assistant' ? 'Bot' : (m?.senderName || 'User');
      const content = String(m?.content || '').slice(0, 120);
      return `${role}: ${content}`;
    })
    .join('\n');

  const prompt = `You are a routing classifier for a group chat bot named "${profile?.name || 'Bot'}".
Decide if the NEW message is plausibly addressed to the bot assistant — either directly or as an implicit request for help.
The chat may be in Chinese, English, or a mix. Apply the same yes/no logic regardless of language.

Say "yes" if ANY of these apply:
- The message asks for help, information, translation, search, or any task a bot can do
  (e.g. Chinese: "帮我查一下", "请问", "翻译这个";
        English: "can you look this up", "tell me about …", "what's the weather", "translate this")
- The message is a greeting or check if bot is online
  (e.g. Chinese: "你好", "在吗"; English: "hey", "you there", "hi", "sup")
- The message is a follow-up to the bot's previous reply (answering bot's question, short continuation)
  (e.g. Chinese: "好的", "再说一次"; English: "ok", "say that again", "what about X", "thanks")
- The message is a short question that only the bot would plausibly answer in this group context

Say "no" if:
- The message is clearly between two humans (gossip, personal chat, scheduling meetups)
- The message @mentions a different person
- The message is a standalone opinion/reaction not requesting a response

Recent context:
${prevMessages || '(no prior messages)'}

New message from ${incoming.senderName || 'unknown'}: "${text.slice(0, 200)}"

Answer with exactly one word: "yes" or "no".`;

  if (config?.extraFast?.enabled === true) {
    const label = await judge({ config, task: 'addressal', systemPrompt: 'You are a yes/no classifier. Reply with only "yes" or "no".',
      messages: [{ role: 'user', content: prompt }], fallback: 'no', signal, onDecision });
    return label === 'yes';
  }

  try {
    const raw = await createOpenAICompatibleReply({
      authMode: config.authMode,
      apiProtocol: config.apiProtocol,
      apiKey: config.activeLlmProfileId ? config.apiKey : process.env.MELO_API_KEY || process.env.OPENAI_API_KEY || config.apiKey,
      baseUrl: config.activeLlmProfileId ? config.baseUrl : process.env.MELO_BASE_URL || process.env.OPENAI_BASE_URL || config.baseUrl,
      model: config.activeLlmProfileId ? config.model : process.env.MELO_COMPACT_MODEL || process.env.MELO_MODEL || config.model,
      systemPrompt: 'You are a yes/no classifier. Reply with only "yes" or "no".',
      messages: [{ role: 'user', content: prompt }],
      // The old maxTokens: 4 was ignored by the adapter. Keep the disabled
      // path unbounded as before; the opt-in judge above owns its own budget.
      signal,
    });
    return /^\s*yes\b/i.test(String(raw || ''));
  } catch {
    return false; // safe default: don't respond if classifier fails
  }
}
