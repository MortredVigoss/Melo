// Channel-route system-prompt block — sub-phase 7d-5γ commit 3 of the
// desktopStore decomposition. byte-for-byte port (CLAUDE.md §5).
//
// Builds the per-turn system-prompt fragment that tells the agent which
// remote channel (Telegram / Discord) the reply is going to and what
// formatting / addressing rules apply (group prefix discipline, reply
// pronoun resolution, group-bystander context, etc).
//
// All five upstream deps the original definition referenced were already
// in dedicated leaf modules:
//   • normalizeAgentChannels  ← services/agent/agentChannels.js
//   • collectKnownTelegramParticipants
//   • buildGroupRelationshipSummary
//   • collectBystanderContext  ← services/remote/groupRelationship.js
//   • normalizeConversationSnippet  ← memory/heuristics.js
// so this is a true zero-LOCAL leaf despite the function being long.

import { normalizeAgentChannels } from '../agent/agentChannels.js';
import {
  buildGroupRelationshipSummary,
  collectBystanderContext,
  collectKnownTelegramParticipants,
} from './groupRelationship.js';
import { normalizeConversationSnippet } from '../../memory/heuristics.js';

export function buildChannelRoutePrompt({ chat, channelContext, profile }) {
  const channelId =
    channelContext?.channelId ||
    (chat?.source === 'telegram' || chat?.source === 'discord' ? chat.source : '');

  if (!channelId) {
    return '';
  }

  const channel = normalizeAgentChannels(profile?.channels)?.[channelId];
  if (!channel?.enabled) {
    return '';
  }

  if (channelId === 'telegram') {
    const isGroupChat =
      (channelContext?.chatType || chat?.chatType) === 'group' ||
      (channelContext?.chatType || chat?.chatType) === 'supergroup';

    if (isGroupChat) {
      const participants = collectKnownTelegramParticipants(chat);
      const currentSenderId = String(channelContext?.senderId || '').trim();
      const currentSenderName = channelContext?.senderName || '';
      const currentSenderUsername = channelContext?.senderUsername
        ? `@${channelContext.senderUsername}`
        : '';
      // Prefer @username as the address form so Telegram notifies the person;
      // fall back to display name if no username is set.
      const addressForm = currentSenderUsername || currentSenderName;

      // Group relationship graph summary
      const graphSummary = chat?.groupGraph
        ? buildGroupRelationshipSummary(chat.groupGraph, currentSenderId)
        : '';

      // Recent bystander messages (not addressed to bot) for passive context
      const bystanderCtx = collectBystanderContext(chat, 5);
      const bystanderBlock = bystanderCtx.length
        ? [
            '## Recent group context (not addressed to you — background only)',
            ...bystanderCtx.map(b => `${b.senderLabel}: ${b.text}`),
            '(Use this context to answer questions about what others said, but do not respond to these lines.)',
          ].join('\n')
        : '';

      return [
        'Channel route: Telegram',
        '- This reply is being prepared for a Telegram group thread.',
        '- Keep the tone conversational and plain-text first.',
        '- Avoid decorative markdown, headings, and heavy formatting.',
        '- Keep the final answer chunk-friendly for Telegram delivery.',
        '- This is a multi-person conversation.',
        '- User messages may be prefixed as [SenderName]: to show who said what.',
        participants.length
          ? `- Known participants in this thread so far: ${participants.join(', ')}`
          : '',
        '- CRITICAL: Messages from different [SenderName] prefixes are different people.',
        '- Never merge their statements, facts, preferences, or requests into one person.',
        '- If there is any risk of confusion, attribute claims and preferences to the specific speaker by name.',
        '- Resolve first-person pronouns like "I", "me", "my", "我", "我的", "她", "他" against the speaker of the latest user message unless the conversation explicitly says otherwise.',
        addressForm
          ? `- The current message is from ${addressForm}. Begin your reply with "${addressForm}," (or their first name alone if that reads more naturally) so it is immediately clear in the group who you are talking to. Skip the name prefix only if you just addressed them in your immediately preceding reply.`
          : '',
        '- The routing layer already decided this message is plausibly directed at you. Do not second-guess that routing by refusing to answer.',
        '- If the latest message is genuinely ambiguous about who or what it refers to, ask one short clarification question instead of guessing.',
        '- If the latest message is clearly addressed to another person in the group, stay brief and only add something if it is genuinely useful.',
        '- When the latest message continues your previous answer without a new addressee, treat it as a follow-up to you and answer normally.',
        channelContext?.isReplyToBot
          ? '- The latest user message is an explicit reply to your earlier bot message.'
          : '- The latest user message may be a fresh mention, a reply, or a natural follow-up inside the same group topic.',
        channelContext?.repliedToText
          ? `- The user replied to this earlier message: ${normalizeConversationSnippet(
              channelContext.repliedToText,
              180,
            )}`
          : '',
        channelContext?.remoteChatId
          ? `- Active Telegram chat id: ${channelContext.remoteChatId}`
          : '',
        graphSummary || '',
        bystanderBlock || '',
      ]
        .filter(Boolean)
        .join('\n');
    }

    return [
      'Channel route: Telegram',
      '- This reply is being prepared for a Telegram thread.',
      '- Keep the tone conversational and plain-text first.',
      '- Avoid decorative markdown, headings, and heavy formatting.',
      '- Keep the final answer chunk-friendly for Telegram delivery.',
      channelContext?.remoteChatId
        ? `- Active Telegram chat id: ${channelContext.remoteChatId}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (channelId === 'discord') {
    return [
      'Channel route: Discord',
      '- This reply is being prepared for a Discord thread.',
      '- Keep the tone conversational and compact.',
      '- Prefer short paragraphs over long walls of text.',
      '- Avoid decorative markdown unless structure is genuinely necessary.',
      channelContext?.remoteChatId
        ? `- Active Discord route id: ${channelContext.remoteChatId}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return '';
}
