// ─── Group relationship graph helpers ────────────────────────────────────────
// Track who talks to whom inside a group chat so the system prompt can
// surface social context (who's the "current speaker", who do they usually
// reply to, who else has been active). Applies equally to Telegram groups
// and Discord channels; the chat object's shape is identical.
//
// This module owns:
//   - updateGroupRelationshipGraph(chat, incoming, addressedToBot) — mutate
//     chat.groupGraph in place: bump per-sender counters, record recent
//     topic snippets, track frequent reply partners
//   - buildGroupRelationshipSummary(graph, currentSenderId) — render a
//     compact, prompt-ready summary of the top ~6 participants
//   - collectBystanderContext(chat, limit) — pull the most recent N
//     messages flagged `meta.bystanderMessage` (not replied to by the bot)
//     for injection as ambient group context
//   - collectKnownTelegramParticipants(chat, limit) — unique recent
//     user-side display labels, used when the UI / prompt needs a short
//     roster of who's been speaking
//
// Extracted from desktopStore.js in the Phase 9f refactor (see
// _refactor-backup/REFACTOR_PLAN.md). Pure module — only depends on the
// shared `nowIso` helper. Mutates chat.groupGraph in-place (the only side
// effect) — everything else is read-only.

import { nowIso } from '../../shared/helpers.js';

export function updateGroupRelationshipGraph(chat, incoming, addressedToBot) {
  const senderId = String(incoming?.senderId || '').trim();
  if (!senderId) return;

  if (!chat.groupGraph || typeof chat.groupGraph !== 'object') {
    chat.groupGraph = {};
  }

  const existing = chat.groupGraph[senderId] || {
    name: '',
    username: '',
    messageCount: 0,
    botAddressCount: 0,
    otherAddressCount: 0,
    lastSeenAt: null,
    recentTopics: [],
    frequentPartners: [],
  };

  existing.name     = incoming.senderName     || existing.name;
  existing.username = incoming.senderUsername || existing.username;
  existing.messageCount += 1;
  existing.lastSeenAt = incoming.receivedAt || nowIso();

  if (addressedToBot) {
    existing.botAddressCount += 1;
  } else {
    existing.otherAddressCount += 1;
  }

  // Track a short topic snippet for each message
  const snippet = String(incoming.text || '').trim().slice(0, 60);
  if (snippet) {
    existing.recentTopics = [snippet, ...existing.recentTopics].slice(0, 5);
  }

  // Track who this person is replying to (frequent partner detection)
  // If this message is a reply and we know who was replied to, log that interaction
  if (incoming.repliedToSenderId && String(incoming.repliedToSenderId) !== senderId) {
    const partnerId = String(incoming.repliedToSenderId);
    if (!existing.frequentPartners.includes(partnerId)) {
      existing.frequentPartners = [partnerId, ...existing.frequentPartners].slice(0, 3);
    }
  }

  chat.groupGraph[senderId] = existing;
}

/**
 * Build a concise summary of the group relationship graph for injection
 * into the system prompt. Focuses on the current sender's position within
 * the group and the overall interaction pattern.
 *
 * @param {Object} graph       - chat.groupGraph
 * @param {string} currentSenderId
 * @returns {string}
 */
export function buildGroupRelationshipSummary(graph, currentSenderId) {
  if (!graph || !Object.keys(graph).length) return '';

  const entries = Object.entries(graph)
    .map(([id, data]) => ({ id, ...data }))
    .sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));

  const lines = ['Group relationship graph:'];

  for (const entry of entries.slice(0, 6)) {
    const label = entry.username ? `@${entry.username}` : (entry.name || entry.id);
    const total = entry.messageCount || 0;
    const botRatio = total > 0
      ? ((entry.botAddressCount || 0) / total * 100).toFixed(0)
      : '0';
    const marker = entry.id === currentSenderId ? ' ← current speaker' : '';
    const lastTopic = entry.recentTopics?.[0] ? ` | last: "${entry.recentTopics[0]}"` : '';
    lines.push(`  ${label}: ${total} msgs, ${botRatio}% to bot${lastTopic}${marker}`);
  }

  return lines.join('\n');
}

/**
 * Collect the most recent N bystander messages (messages NOT replied to by the bot)
 * tagged with bystanderMessage: true, for injection as group context.
 *
 * @param {Object} chat
 * @param {number} limit
 * @returns {Array<{ senderLabel: string, text: string }>}
 */
export function collectBystanderContext(chat, limit = 6) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const results = [];

  for (let i = messages.length - 1; i >= 0 && results.length < limit; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== 'user') continue;
    if (!msg?.meta?.bystanderMessage) continue;
    const text = String(msg.content || '').trim().slice(0, 120);
    if (!text) continue;
    const label = msg.senderUsername
      ? `@${msg.senderUsername}`
      : (msg.senderName || 'unknown');
    results.unshift({ senderLabel: label, text });
  }

  return results;
}

export function collectKnownTelegramParticipants(chat, limit = 8) {
  const seen = new Set();
  const participants = [];

  for (const message of Array.isArray(chat?.messages) ? chat.messages : []) {
    if (message?.role !== 'user') {
      continue;
    }

    const label =
      String(message?.senderName || '').trim() ||
      String(message?.senderUsername || '').trim() ||
      (message?.senderId ? `user_${message.senderId}` : '');
    const key = String(message?.senderId || '').trim() || label.toLowerCase();
    if (!label || !key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    participants.push(label);
    if (participants.length >= limit) {
      break;
    }
  }

  return participants;
}
